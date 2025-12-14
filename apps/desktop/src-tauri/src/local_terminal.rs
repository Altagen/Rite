/**
 * Local Terminal Module
 *
 * Manages local shell sessions using portable-pty
 */
use anyhow::{anyhow, Result};
use base64::Engine as _;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::terminal::SessionCommand;

pub type SessionId = String;

/// Represents an active local terminal session
pub struct LocalSession {
    pub id: SessionId,
    command_tx: mpsc::Sender<SessionCommand>,
}

impl LocalSession {
    /// Create a new local terminal session
    ///
    /// Spawns a local shell (bash/zsh/fish) using portable-pty
    pub async fn spawn(app_handle: AppHandle, shell: Option<String>) -> Result<Self> {
        let session_id = Uuid::new_v4().to_string();
        tracing::info!("Creating local session: {}", session_id);

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
            tracing::warn!("Requested shell not found: {}, trying fallbacks...", requested_shell);

            // Fallback list: try $SHELL, common shell paths
            let fallbacks = vec![
                std::env::var("SHELL").ok(),
                Some("/usr/bin/bash".to_string()),
                Some("/usr/bin/fish".to_string()),
                Some("/usr/bin/sh".to_string()),
                Some("/bin/bash".to_string()),  // Legacy path fallback
                Some("/bin/sh".to_string()),    // Legacy path fallback
            ];

            fallbacks
                .into_iter()
                .flatten()
                .find(|path| std::path::Path::new(path).exists())
                .ok_or_else(|| anyhow!("No usable shell found on system"))?
        };

        tracing::info!("Using shell: {}", shell_cmd);

        // Create PTY system
        let pty_system = NativePtySystem::default();
        let pty_size = PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        };

        // Spawn PTY with shell
        let pair = pty_system
            .openpty(pty_size)
            .map_err(|e| anyhow!("Failed to create PTY: {}", e))?;

        let mut cmd = CommandBuilder::new(&shell_cmd);
        let shell_name = shell_cmd.split('/').next_back().unwrap_or("");

        tracing::debug!("Launching {} as interactive shell", shell_name);

        // Configure shell-specific environment variables
        if shell_name == "fish" {
            cmd.env("fish_features", "no-query-term");
        }

        // Set common terminal environment variables
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        // Fish-specific: Tell fish about terminal capabilities to avoid DA queries
        // These env vars inform fish what the terminal supports without needing to query
        cmd.env("fish_term24bit", "1");              // Terminal supports 24-bit color
        cmd.env("fish_wcwidth_version", "3");        // Unicode width version
        cmd.env("fish_ambiguous_width", "1");        // Width of ambiguous-width chars
        cmd.env("TERM_PROGRAM", "vscode");           // Pretend we're VSCode (fish trusts it)
        cmd.env("TERM_PROGRAM_VERSION", "1.0.0");    // Version for compatibility

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| anyhow!("Failed to spawn shell: {}", e))?;

        tracing::debug!("Shell spawned successfully");

        // Create command channel
        let (command_tx, mut command_rx) = mpsc::channel::<SessionCommand>(100);

        // Clone reader before taking writer
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| anyhow!("Failed to clone PTY reader: {}", e))?;

        // Clone writer for input, keep master for resizing
        let writer = pair.master.take_writer()
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
                    SessionCommand::SendInput(data) => {
                        if let Ok(mut writer) = writer_mutex_clone.lock() {
                            if let Err(e) = writer.write_all(&data) {
                                tracing::error!("Failed to write to PTY: {}", e);
                                break;
                            }
                            if let Err(e) = writer.flush() {
                                tracing::error!("Failed to flush PTY: {}", e);
                            }
                        } else {
                            tracing::error!("Failed to lock writer mutex");
                        }
                    }
                    SessionCommand::Resize { cols, rows } => {
                        tracing::debug!("Resizing terminal to cols={}, rows={}", cols, rows);
                        if let Ok(master) = master_mutex_clone.lock() {
                            let new_size = PtySize {
                                rows: rows as u16,
                                cols: cols as u16,
                                pixel_width: 0,
                                pixel_height: 0,
                            };
                            if let Err(e) = master.resize(new_size) {
                                tracing::error!("Failed to resize PTY: {}", e);
                            } else {
                                tracing::debug!("Terminal resized successfully");
                            }
                        } else {
                            tracing::error!("Failed to lock master PTY mutex for resize");
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
        let app_handle_clone2 = app_handle.clone();
        tokio::task::spawn_blocking(move || {
            tracing::debug!("PTY reader loop starting for session {}", session_id_clone2);
            let mut buffer = [0u8; 8192];

            loop {
                match reader.read(&mut buffer) {
                    Ok(n) if n > 0 => {
                        // Encode raw bytes as base64 to preserve all data (including ANSI codes)
                        let data_base64 = base64::engine::general_purpose::STANDARD.encode(&buffer[..n]);

                        let _ = app_handle_clone2.emit(
                            "terminal-data",
                            serde_json::json!({
                                "sessionId": session_id_clone2,
                                "data": data_base64,
                            }),
                        );
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
                    let _ = app_handle_clone2.emit(
                        "terminal-exit",
                        serde_json::json!({
                            "sessionId": session_id_clone2,
                            "exitStatus": exit_status.exit_code(),
                        }),
                    );
                }
                Err(e) => {
                    tracing::error!("Failed to wait for shell: {}", e);
                }
            }

            let _ = app_handle_clone2.emit(
                "terminal-closed",
                serde_json::json!({
                    "sessionId": session_id_clone2,
                }),
            );

            tracing::debug!("PTY reader exiting");
        });

        Ok(Self {
            id: session_id,
            command_tx,
        })
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
