/**
 * Local Terminal Module
 *
 * Manages local shell sessions using portable-pty
 */
use anyhow::{Result, anyhow};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::events::SharedEvents;
use crate::terminal::SessionCommand;

pub type SessionId = String;

/// What a local PTY runs.
///
/// Three callers, three needs, and the difference is not cosmetic: it is whether a shell
/// gets to re-read the command before the kernel does.
pub enum LocalProgram {
    /// An interactive shell. A terminal pane.
    Shell,
    /// A mini-script for the user's shell, fail-fast on posix shells. The pre-connect
    /// hook: it is written as shell, so it is run as shell.
    Script(String),
    /// One program and its arguments, reaching `execvp` as written, with no shell in
    /// between. What an agent adapter's resume command needs (ADR 0022 §4, §7.2): the
    /// argv comes from a vendor's CLI and a project path, so a space or a quote in it is
    /// data, not syntax. Through `-c` the shell would re-parse both.
    Argv(Vec<String>),
}

/// Represents an active local terminal session
pub struct LocalSession {
    pub id: SessionId,
    /// The shell's own process id, kept so its working directory can be read later.
    ///
    /// `None` when the platform would not say — see [`shell_cwd`]. It is the SHELL's pid
    /// and not a child it spawned, so the directory read from it is the one the prompt
    /// shows, not wherever a running `vim` happened to chdir.
    pub pid: Option<u32>,
    command_tx: mpsc::Sender<SessionCommand>,
    /// Buffer for initial shell output (prompt, fastfetch, etc.).
    /// `Some(bytes)` = buffering; `None` = streaming mode (frontend has claimed).
    /// Uses std::sync::Mutex because the PTY reader runs in spawn_blocking.
    initial_buffer: Arc<StdMutex<Option<Vec<u8>>>>,
}

impl LocalSession {
    /// Create a new local terminal session
    ///
    /// Spawns a local shell (bash/zsh/fish) using portable-pty
    pub async fn spawn(
        events: SharedEvents,
        shell: Option<String>,
        cwd: Option<PathBuf>,
    ) -> Result<Self> {
        Self::spawn_inner(events, shell, LocalProgram::Shell, cwd).await
    }

    /// Run a one-shot local command (the pre-connect hook) in a PTY.
    ///
    /// The command is executed fail-fast (`set -e`) in the user's shell; it is a
    /// full PTY session so interactive helpers (`aws sso login`, `kinit`, a
    /// passphrase prompt) can read input and render normally. When the command
    /// finishes, a `terminal-exit` event carries its exit code — 0 means the
    /// caller may proceed to open the ssh session.
    pub async fn run_command(events: SharedEvents, command: String) -> Result<Self> {
        // A pre-connect hook runs wherever the shell starts: it is the connection's
        // business, not a pane's, so it inherits nothing.
        Self::spawn_inner(events, None, LocalProgram::Script(command), None).await
    }

    /// Run one program in a PTY, with its arguments passed through unchanged.
    ///
    /// The interactive half of ADR 0022 §7: an agent is a PTY running a vendor's CLI, so
    /// it needs what a shell session has — a tty, no timeout — while being a *command*
    /// rather than a shell. The exit arrives as `terminal-exit` like any other session's.
    ///
    /// `cwd` is where the program starts, and it is checked rather than trusted for the
    /// reason `spawn` checks it: a project directory can be gone by the time someone
    /// resumes a conversation about it, and failing the spawn would lose the session
    /// instead of its starting point.
    pub async fn run_program(
        events: SharedEvents,
        argv: Vec<String>,
        cwd: Option<PathBuf>,
    ) -> Result<Self> {
        Self::spawn_inner(events, None, LocalProgram::Argv(argv), cwd).await
    }

    /// Where the shell of `pid` currently is, or `None` when it cannot be known.
    ///
    /// Reads `/proc/<pid>/cwd`, which is how tmux answers the same question. That path is
    /// LINUX ONLY, so this returns `None` everywhere else and a new pane opens where it
    /// would have — the feature degrades rather than guessing. macOS would need `libproc`;
    /// shelling out to `lsof` would make a default depend on a tool being installed, which
    /// is not something a shipped default may assume.
    pub fn shell_cwd(pid: u32) -> Option<PathBuf> {
        if !cfg!(target_os = "linux") {
            return None;
        }
        let link = std::fs::read_link(format!("/proc/{pid}/cwd")).ok()?;
        // A deleted directory reads back as `/some/path (deleted)`, and handing that to
        // `cwd()` fails the spawn outright — so an unusable answer is no answer.
        link.is_dir().then_some(link)
    }

    async fn spawn_inner(
        events: SharedEvents,
        shell: Option<String>,
        program: LocalProgram,
        cwd: Option<PathBuf>,
    ) -> Result<Self> {
        let session_id = Uuid::new_v4().to_string();
        tracing::info!("Creating local session: {}", session_id);

        // An argv program is not a shell and must not borrow a shell's resolution: the
        // fallback list below would silently answer "/bin/sh" for a missing binary, and a
        // resume command that cannot run has to say so rather than open a shell instead.
        if let LocalProgram::Argv(argv) = &program {
            let mut parts = argv.iter();
            let exe = parts
                .next()
                .filter(|a| !a.is_empty())
                .ok_or_else(|| anyhow!("A program needs a name"))?;
            let mut cmd = CommandBuilder::new(exe);
            for arg in parts {
                cmd.arg(arg);
            }
            tracing::info!("Running {} directly, {} argument(s)", exe, argv.len() - 1);
            return Self::spawn_built(events, session_id, cmd, cwd, None).await;
        }

        // Determine which shell to use with intelligent fallback
        let requested_shell = shell.unwrap_or_else(|| {
            std::env::var("SHELL").unwrap_or_else(|_| {
                if cfg!(target_os = "windows") {
                    "powershell.exe".to_string()
                } else {
                    "/bin/bash".to_string()
                }
            })
        });

        // Try requested shell first, then fallback to available shells
        let shell_cmd = if std::path::Path::new(&requested_shell).exists() {
            requested_shell
        } else {
            tracing::warn!(
                "Requested shell not found: {}, trying fallbacks...",
                requested_shell
            );

            // Fallback list: try $SHELL, common shell paths
            let fallbacks = vec![
                std::env::var("SHELL").ok(),
                Some("/usr/bin/bash".to_string()),
                Some("/usr/bin/fish".to_string()),
                Some("/usr/bin/sh".to_string()),
                Some("/bin/bash".to_string()), // Legacy path fallback
                Some("/bin/sh".to_string()),   // Legacy path fallback
            ];

            fallbacks
                .into_iter()
                .flatten()
                .find(|path| std::path::Path::new(path).exists())
                .ok_or_else(|| anyhow!("No usable shell found on system"))?
        };

        tracing::info!("Using shell: {}", shell_cmd);

        let mut cmd = CommandBuilder::new(&shell_cmd);
        let shell_name = shell_cmd.split('/').next_back().unwrap_or("");

        match &program {
            LocalProgram::Script(run_cmd) => {
                tracing::debug!("Running one-shot command via {}", shell_name);
                // Fail-fast so a mini-script stops on the first error. fish uses a
                // different option syntax, so only enable errexit on posix shells.
                cmd.arg("-c");
                if shell_name == "fish" {
                    cmd.arg(run_cmd);
                } else {
                    cmd.arg(format!("set -e\n{run_cmd}"));
                }
            }
            LocalProgram::Shell => {
                tracing::debug!("Launching {} as interactive shell", shell_name);
            }
            // Returned above, before any shell was resolved.
            LocalProgram::Argv(_) => unreachable!("an argv program takes the direct path"),
        }

        Self::spawn_built(events, session_id, cmd, cwd, Some(shell_name)).await
    }

    /// Open a PTY, start the command in it, and keep it pumping until it exits.
    ///
    /// Shared by every program kind, because everything from here down is the SESSION and
    /// not the command: where it starts, what it is told about the terminal, and the
    /// reader that turns its bytes into events. `shell_name` is `None` when the program is
    /// not a shell — the fish workarounds below are then neither needed nor honest.
    async fn spawn_built(
        events: SharedEvents,
        session_id: SessionId,
        mut cmd: CommandBuilder,
        cwd: Option<PathBuf>,
        shell_name: Option<&str>,
    ) -> Result<Self> {
        let pty_system = NativePtySystem::default();
        let pty_size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system
            .openpty(pty_size)
            .map_err(|e| anyhow!("Failed to create PTY: {}", e))?;

        // Start where the caller asked, when it is still a directory. A pane may be
        // duplicated, or an agent resumed, long after the directory was removed, and the
        // session must survive that: start, and be wrong about where.
        //
        // The check is NOT load-bearing on Linux. Measured against portable-pty 0.9:
        // `spawn_command` with a `cwd` that does not exist returns `Ok` and the child
        // simply starts in this process's directory. It is load-bearing on Windows, where
        // `CreateProcessW` refuses an unusable `lpCurrentDirectory` outright — so the
        // guard makes one platform's behaviour the rule on both, rather than leaving a
        // desktop client to fail a spawn that works everywhere else.
        if let Some(dir) = cwd.as_ref().filter(|d| d.is_dir()) {
            cmd.cwd(dir);
        }

        // Configure shell-specific environment variables
        if shell_name == Some("fish") {
            cmd.env("fish_features", "no-query-term");
        }

        // What any program in a PTY is entitled to know.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        // The rest are fish workarounds, so they are set for a shell and for nothing else.
        // They tell fish what the terminal supports instead of letting it ask by DA query,
        // and the last two are a LIE fish happens to trust — which is why they must not
        // reach an arbitrary program. A CLI that reads `TERM_PROGRAM` would tailor its
        // output to an editor that is not running it.
        if shell_name.is_some() {
            cmd.env("fish_term24bit", "1"); // Terminal supports 24-bit color
            cmd.env("fish_wcwidth_version", "3"); // Unicode width version
            cmd.env("fish_ambiguous_width", "1"); // Width of ambiguous-width chars
            cmd.env("TERM_PROGRAM", "vscode"); // Pretend we're VSCode (fish trusts it)
            cmd.env("TERM_PROGRAM_VERSION", "1.0.0"); // Version for compatibility
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| anyhow!("Failed to spawn the session's program: {}", e))?;
        // Read before the child is moved into the reader thread: after that there is
        // nothing left to ask, and this is the only handle on where the shell is.
        let pid = child.process_id();

        tracing::debug!("Session program spawned successfully");

        // Create command channel
        let (command_tx, mut command_rx) = mpsc::channel::<SessionCommand>(100);

        // Buffer for initial shell output (prompt, fastfetch, etc.).
        // Same rationale as SshSession: the shell starts writing immediately when
        // the PTY opens, before the React frontend has had time to mount the
        // Terminal component and register its event listener. We buffer everything
        // until the frontend calls claim_session_output(), which drains the buffer
        // and switches to streaming mode.
        let initial_buffer: Arc<StdMutex<Option<Vec<u8>>>> =
            Arc::new(StdMutex::new(Some(Vec::new())));
        let initial_buffer_clone = Arc::clone(&initial_buffer);

        // Clone reader before taking writer
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| anyhow!("Failed to clone PTY reader: {}", e))?;

        // Clone writer for input, keep master for resizing
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| anyhow!("Failed to take PTY writer: {}", e))?;
        let writer_mutex = Arc::new(StdMutex::new(writer));
        let master_mutex = Arc::new(StdMutex::new(pair.master));

        let session_id_clone = session_id.clone();
        let writer_mutex_clone = writer_mutex.clone();
        let master_mutex_clone = master_mutex.clone();

        // Spawn task for handling commands (input, resize, close)
        tokio::spawn(async move {
            while let Some(cmd) = command_rx.recv().await {
                match cmd {
                    SessionCommand::SendInput(data) => match writer_mutex_clone.lock() {
                        Ok(mut writer) => {
                            if let Err(e) = writer.write_all(&data) {
                                tracing::error!("Failed to write to PTY: {}", e);
                                break;
                            }
                            if let Err(e) = writer.flush() {
                                tracing::error!("Failed to flush PTY: {}", e);
                            }
                        }
                        _ => {
                            tracing::error!("Failed to lock writer mutex");
                        }
                    },
                    SessionCommand::Resize { cols, rows } => {
                        tracing::debug!("Resizing terminal to cols={}, rows={}", cols, rows);
                        match master_mutex_clone.lock() {
                            Ok(master) => {
                                let new_size = PtySize {
                                    rows: rows as u16,
                                    cols: cols as u16,
                                    pixel_width: 0,
                                    pixel_height: 0,
                                };
                                match master.resize(new_size) {
                                    Err(e) => {
                                        tracing::error!("Failed to resize PTY: {}", e);
                                    }
                                    _ => {
                                        tracing::debug!("Terminal resized successfully");
                                    }
                                }
                            }
                            _ => {
                                tracing::error!("Failed to lock master PTY mutex for resize");
                            }
                        }
                    }
                    SessionCommand::Close => {
                        tracing::debug!("Closing session {}", session_id_clone);
                        break;
                    }
                }
            }
            tracing::debug!("Command handler exiting");
        });

        // Spawn separate task for reading PTY output
        let session_id_clone2 = session_id.clone();
        tokio::task::spawn_blocking(move || {
            tracing::debug!("PTY reader loop starting for session {}", session_id_clone2);
            let mut buffer = [0u8; 8192];

            loop {
                match reader.read(&mut buffer) {
                    Ok(n) if n > 0 => {
                        let mut buf_guard = initial_buffer_clone.lock().unwrap();
                        if let Some(ref mut buf) = *buf_guard {
                            // Buffering mode: accumulate until frontend calls claim.
                            buf.extend_from_slice(&buffer[..n]);
                        } else {
                            // Streaming mode: frontend has claimed the buffer.
                            events.terminal_data(&session_id_clone2, &buffer[..n]);
                        }
                    }
                    Ok(_) => {
                        tracing::info!("PTY EOF detected for session {}", session_id_clone2);
                        break;
                    }
                    Err(e) => {
                        tracing::error!("Failed to read from PTY: {}", e);
                        break;
                    }
                }
            }

            // Wait for child process to exit
            match child.wait() {
                Ok(exit_status) => {
                    tracing::info!("Shell exited with status: {:?}", exit_status);
                    events.terminal_exit(&session_id_clone2, exit_status.exit_code());
                }
                Err(e) => {
                    tracing::error!("Failed to wait for shell: {}", e);
                }
            }

            events.terminal_closed(&session_id_clone2);

            tracing::debug!("PTY reader exiting");
        });

        Ok(Self {
            id: session_id,
            pid,
            command_tx,
            initial_buffer,
        })
    }

    /// Drain the initial output buffer and switch to streaming mode.
    /// Returns all bytes received before the frontend registered its listener.
    /// After this call, new PTY data is emitted as `terminal-data` events.
    pub fn claim_initial_output(&self) -> Vec<u8> {
        let mut guard = self.initial_buffer.lock().unwrap();
        guard.take().unwrap_or_default()
    }

    /// Send input to the local terminal
    pub async fn send_input(&self, data: &[u8]) -> Result<()> {
        self.command_tx
            .send(SessionCommand::SendInput(data.to_vec()))
            .await
            .map_err(|_| anyhow!("Session closed"))?;
        Ok(())
    }

    /// Resize the terminal
    pub async fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        self.command_tx
            .send(SessionCommand::Resize { cols, rows })
            .await
            .map_err(|_| anyhow!("Session closed"))?;
        Ok(())
    }

    /// Close the session
    pub async fn close(self) -> Result<()> {
        self.command_tx
            .send(SessionCommand::Close)
            .await
            .map_err(|_| anyhow!("Session already closed"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_shell_reports_the_directory_it_is_in() {
        // Asked about THIS process, which is a real pid with a real cwd — the same
        // mechanism a pane uses to ask about the shell it is splitting.
        let me = std::process::id();
        let answer = LocalSession::shell_cwd(me);

        if cfg!(target_os = "linux") {
            let dir = answer.expect("/proc should answer for our own pid on Linux");
            assert_eq!(
                dir.canonicalize().unwrap(),
                std::env::current_dir().unwrap().canonicalize().unwrap(),
                "the directory read back is the one we are in"
            );
        } else {
            // Not a gap to fill later by guessing: `/proc` is Linux, and the alternative
            // on macOS is `libproc` or shelling out to `lsof` — which would make a
            // shipped default depend on a tool being installed. A pane opens where it
            // would have, which is the honest outcome.
            assert!(answer.is_none(), "only Linux is expected to answer");
        }
    }

    #[test]
    fn a_pid_that_is_not_running_reports_nothing() {
        // The pane being split may have exited between the click and the spawn. Nothing
        // is the right answer: the new pane opens where a shell normally would, rather
        // than failing because its starting point went away.
        //
        // Chosen above the system's maximum so it cannot be a live process. Reading the
        // limit rather than picking a big number, because a number that happens to be in
        // use would make this test fail for a reason that is not the code's.
        let max = std::fs::read_to_string("/proc/sys/kernel/pid_max")
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(4_194_304);
        assert!(LocalSession::shell_cwd(max.saturating_add(1)).is_none());
    }

    #[test]
    fn pid_zero_reports_nothing() {
        // `process_id()` returning 0 would otherwise be read as "the kernel", and
        // `/proc/0` does not exist — so this is the shape of a missing pid, not a lookup.
        assert!(LocalSession::shell_cwd(0).is_none());
    }
}
