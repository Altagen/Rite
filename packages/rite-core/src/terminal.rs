/**
 * Terminal Module
 *
 * Manages SSH terminal sessions with russh
 */
use anyhow::{Result, anyhow};
use russh::ChannelMsg;
use russh::client::{self};
use russh::keys::{PrivateKeyWithHashAlg, PublicKey};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

use crate::connection::{AuthMethod, Connection};
use crate::db::Database;
use crate::events::{KbdPrompt, SharedEvents, SharedInteractive};
use crate::known_hosts::{self, HostKeyVerificationResult};

/// Unique identifier for a terminal session
pub type SessionId = String;

/// Cap on the pre-claim initial-output buffer. If the frontend never claims a
/// session (its terminal pane never mounts), a chatty server could otherwise
/// grow it without bound; we keep only the most recent bytes so memory stays
/// bounded and, when the pane does attach, it shows the current state.
const MAX_INITIAL_BUFFER: usize = 1024 * 1024; // 1 MiB

/// Commands that can be sent to a terminal session
pub enum SessionCommand {
    SendInput(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// A public identity held by the SSH agent, for the connection form's picker.
/// Read-only and non-secret: public keys, fingerprints and comments only.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdentityInfo {
    /// The agent's comment for the key, or its fingerprint when blank.
    pub name: String,
    /// SHA256 fingerprint (the value used to pin an identity).
    pub fingerprint: String,
    /// Key algorithm, e.g. "ssh-ed25519" or "sk-ssh-ed25519@openssh.com".
    pub algo: String,
    /// A hardware-backed FIDO key (sk-*).
    pub hardware: bool,
}

/// List the public identities the local SSH agent holds (`SSH_AUTH_SOCK`).
/// Powers the connection form's identity picker; certificates are skipped.
pub async fn list_agent_identities() -> Result<Vec<AgentIdentityInfo>> {
    let mut agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| anyhow!("No SSH agent available (is SSH_AUTH_SOCK set?): {}", e))?;
    let ids = agent
        .request_identities()
        .await
        .map_err(|e| anyhow!("Failed to list SSH agent identities: {}", e))?;
    Ok(ids
        .into_iter()
        .filter_map(|id| match id {
            russh::keys::agent::AgentIdentity::PublicKey { key, comment } => {
                let fingerprint = key.fingerprint(russh::keys::HashAlg::Sha256).to_string();
                let algo = key.algorithm().to_string();
                let hardware = algo.starts_with("sk-");
                let name = if comment.trim().is_empty() {
                    fingerprint.clone()
                } else {
                    comment
                };
                Some(AgentIdentityInfo {
                    name,
                    fingerprint,
                    algo,
                    hardware,
                })
            }
            _ => None,
        })
        .collect())
}

/// SSH Client Handler with host key verification
struct SshClientHandler {
    db: Arc<SqlitePool>,
    host: String,
    port: u16,
    events: SharedEvents,
    force_accept_host_key: bool, // For Quick SSH: bypass host key verification
}

impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        tracing::info!(
            "[terminal.rs] Verifying host key for {}:{}",
            self.host,
            self.port
        );

        // Quick SSH: force accept all host keys (similar to ssh -o StrictHostKeyChecking=no)
        if self.force_accept_host_key {
            tracing::info!("[terminal.rs] Quick SSH mode: auto-accepting host key (TOFU)");

            // Save the host key to known_hosts for future use
            if let Err(e) =
                known_hosts::add_host_key(&self.db, &self.host, self.port, server_public_key).await
            {
                tracing::warn!("[terminal.rs] Failed to save host key for Quick SSH: {}", e);
                // Don't fail the connection if we can't save the key
            }

            return Ok(true);
        }

        // Get the host key verification mode from settings
        let verification_mode = match sqlx::query_scalar::<_, String>(
            "SELECT value FROM settings WHERE key = 'host_key_verification_mode'",
        )
        .fetch_optional(&*self.db)
        .await
        {
            Ok(Some(mode)) => mode,
            Ok(None) => {
                tracing::warn!(
                    "[terminal.rs] No host_key_verification_mode setting found, defaulting to 'strict'"
                );
                "strict".to_string()
            }
            Err(e) => {
                tracing::error!(
                    "[terminal.rs] Failed to read host_key_verification_mode: {}",
                    e
                );
                "strict".to_string() // Default to strict on error for security
            }
        };

        tracing::info!(
            "[terminal.rs] Host key verification mode: {}",
            verification_mode
        );

        // Verify the host key using our known_hosts system
        match known_hosts::verify_host_key(&self.db, &self.host, self.port, server_public_key).await
        {
            Ok(HostKeyVerificationResult::Accepted) => {
                tracing::info!("[terminal.rs] Host key accepted (known host)");
                Ok(true)
            }
            Ok(HostKeyVerificationResult::Unknown {
                host,
                port,
                key_type,
                fingerprint,
            }) => {
                tracing::warn!("[terminal.rs] Unknown host {}:{}", host, port);
                tracing::warn!(
                    "[terminal.rs] Key type: {}, Fingerprint: {}",
                    key_type,
                    fingerprint
                );

                match verification_mode.as_str() {
                    "strict" => {
                        // Strict mode: stash the offered key, emit the event, and
                        // REJECT. The user accepts it via the modal, which promotes
                        // the pending key to a known host; the next connect succeeds.
                        tracing::warn!(
                            "[terminal.rs] Strict mode: Rejecting connection and requesting user confirmation"
                        );

                        if let Err(e) = known_hosts::store_pending_host_key(
                            &self.db,
                            &host,
                            port,
                            server_public_key,
                        )
                        .await
                        {
                            tracing::error!(
                                "[terminal.rs] Failed to store pending host key: {}",
                                e
                            );
                        }

                        self.events
                            .host_key_unknown(&host, port, &key_type, &fingerprint);

                        Err(russh::Error::Disconnect)
                    }
                    "warn" => {
                        // Warn mode: Accept the key but notify the user
                        tracing::info!("[terminal.rs] Warn mode: Accepting key and notifying user");

                        if let Err(e) =
                            known_hosts::add_host_key(&self.db, &host, port, server_public_key)
                                .await
                        {
                            tracing::error!("[terminal.rs] Failed to save host key: {}", e);
                        }

                        self.events
                            .host_key_added(&host, port, &key_type, &fingerprint);

                        Ok(true)
                    }
                    _ => {
                        // Accept mode (or default): Silent TOFU
                        tracing::info!(
                            "[terminal.rs] Accept mode: Silently accepting and saving key (TOFU)"
                        );

                        if let Err(e) =
                            known_hosts::add_host_key(&self.db, &host, port, server_public_key)
                                .await
                        {
                            tracing::error!("[terminal.rs] Failed to save host key: {}", e);
                        }

                        Ok(true)
                    }
                }
            }
            Ok(HostKeyVerificationResult::Changed {
                host,
                port,
                old_fingerprint,
                new_fingerprint,
                ..
            }) => {
                // Host key changed - potential MITM attack!
                // ALWAYS reject regardless of mode (security critical)
                tracing::error!("[terminal.rs] ⚠️  WARNING: HOST KEY HAS CHANGED! ⚠️");
                tracing::error!("[terminal.rs] Host: {}:{}", host, port);
                tracing::error!("[terminal.rs] Old fingerprint: {}", old_fingerprint);
                tracing::error!("[terminal.rs] New fingerprint: {}", new_fingerprint);
                tracing::error!("[terminal.rs] This could indicate a Man-in-the-Middle attack!");
                tracing::error!("[terminal.rs] Connection REJECTED for security");

                // Notify the UI of the changed key
                self.events
                    .host_key_changed(&host, port, &old_fingerprint, &new_fingerprint);

                Err(russh::Error::Disconnect)
            }
            Err(e) => {
                tracing::error!("[terminal.rs] Host key verification error: {}", e);
                // On error, reject the connection for security
                Err(russh::Error::Disconnect)
            }
        }
    }
}

/// Represents an active SSH terminal session
pub struct SshSession {
    pub id: SessionId,
    command_tx: mpsc::Sender<SessionCommand>,
    /// Buffer for the initial SSH output (MOTD, welcome message, first prompt).
    /// `Some(bytes)` = still buffering; `None` = streaming mode (frontend has claimed).
    initial_buffer: Arc<Mutex<Option<Vec<u8>>>>,
}

/// Drive a server-issued keyboard-interactive exchange (2FA / OTP / PAM) to
/// completion. A masked prompt whose text mentions "password" is auto-answered
/// with `stored_password` — so the user is never asked for something Rite
/// already holds — and every other prompt (OTPs, live challenges) is collected
/// from `interactive`. Handles any number of prompts across any number of
/// rounds. Returns whether authentication succeeded.
async fn keyboard_interactive_auth(
    session: &mut client::Handle<SshClientHandler>,
    username: &str,
    stored_password: Option<&str>,
    interactive: Option<&SharedInteractive>,
) -> Result<bool> {
    use russh::client::KeyboardInteractiveAuthResponse as Kir;

    let mut response = session
        .authenticate_keyboard_interactive_start(username.to_string(), None)
        .await?;

    loop {
        match response {
            Kir::Success => return Ok(true),
            Kir::Failure { .. } => return Ok(false),
            Kir::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                // Auto-answer masked "password" prompts from what Rite holds;
                // leave everything else (OTPs, live challenges) for the UI.
                let mut answers: Vec<Option<String>> = prompts
                    .iter()
                    .map(|p| {
                        if !p.echo && p.prompt.to_lowercase().contains("password") {
                            stored_password.map(|pw| pw.to_string())
                        } else {
                            None
                        }
                    })
                    .collect();

                let need_ui: Vec<usize> = answers
                    .iter()
                    .enumerate()
                    .filter(|(_, a)| a.is_none())
                    .map(|(i, _)| i)
                    .collect();

                if !need_ui.is_empty() {
                    let ui_prompts: Vec<KbdPrompt> = need_ui
                        .iter()
                        .map(|&i| KbdPrompt {
                            prompt: prompts[i].prompt.clone(),
                            echo: prompts[i].echo,
                        })
                        .collect();
                    let provided = match interactive {
                        Some(provider) => match provider
                            .keyboard_interactive(&name, &instructions, &ui_prompts)
                            .await
                        {
                            Some(a) => a,
                            None => return Ok(false), // user cancelled
                        },
                        None => {
                            return Err(anyhow!(
                                "This server requires interactive input (keyboard-interactive) that this session can't collect"
                            ));
                        }
                    };
                    if provided.len() != need_ui.len() {
                        return Err(anyhow!(
                            "keyboard-interactive: expected {} answer(s), got {}",
                            need_ui.len(),
                            provided.len()
                        ));
                    }
                    for (slot, ans) in need_ui.into_iter().zip(provided) {
                        answers[slot] = Some(ans);
                    }
                }

                let final_answers: Vec<String> =
                    answers.into_iter().map(|a| a.unwrap_or_default()).collect();
                response = session
                    .authenticate_keyboard_interactive_respond(final_answers)
                    .await?;
            }
        }
    }
}

impl SshSession {
    /// Create a new SSH session by connecting to a remote server
    pub async fn connect(
        connection: Connection,
        auth_method: AuthMethod,
        events: SharedEvents,
        db_pool: Arc<SqlitePool>,
        keep_alive_interval: Option<u64>, // Keep-alive interval in seconds (None = disabled)
        force_accept_host_key: bool,      // For Quick SSH: bypass host key verification
        interactive: Option<SharedInteractive>, // Collects keyboard-interactive answers (2FA/PAM)
    ) -> Result<Self> {
        let session_id = Uuid::new_v4().to_string();
        tracing::info!(
            "[terminal.rs] SshSession::connect - Session ID: {}",
            session_id
        );
        tracing::info!(
            "[terminal.rs] Connecting to {}:{} as {}",
            connection.hostname,
            connection.port,
            connection.username
        );

        // Create SSH client configuration. Use russh's native SSH keepalive
        // (keepalive@openssh.com) instead of an app-level heartbeat, so we never
        // fight the real terminal size and the transport itself detects a dead peer.
        let mut config = client::Config::default();
        if let Some(secs) = keep_alive_interval {
            config.keepalive_interval = Some(std::time::Duration::from_secs(secs));
            config.keepalive_max = 3;
        }
        let config = Arc::new(config);
        let handler = SshClientHandler {
            db: db_pool,
            host: connection.hostname.clone(),
            port: connection.port,
            events: events.clone(),
            force_accept_host_key,
        };

        // Connect to SSH server (host key verification happens in handler.check_server_key())
        let addr = format!("{}:{}", connection.hostname, connection.port);
        tracing::info!("[terminal.rs] Attempting TCP connection to {}...", addr);
        // Bound the connect + handshake so an unreachable/filtered host fails with
        // a clear error instead of hanging on the OS TCP timeout (~2 min).
        const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
        let mut session =
            match tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, &addr, handler))
                .await
            {
                Ok(result) => result?,
                Err(_) => {
                    return Err(anyhow!(
                        "Connection to {} timed out after {}s",
                        addr,
                        CONNECT_TIMEOUT.as_secs()
                    ));
                }
            };
        tracing::info!("[terminal.rs] TCP connection established");

        // Authenticate
        tracing::info!("[terminal.rs] Authenticating...");
        let auth_result = match auth_method {
            AuthMethod::Password { ref password } => {
                tracing::debug!("[terminal.rs] Using password authentication");
                session
                    .authenticate_password(&connection.username, password)
                    .await?
            }
            AuthMethod::PublicKey {
                ref key_path,
                ref passphrase,
            } => {
                tracing::debug!(
                    "[terminal.rs] Using public key authentication from: {}",
                    key_path
                );
                // Load private key
                let key_data = tokio::fs::read(key_path).await?;
                let key = russh::keys::decode_secret_key(
                    &String::from_utf8(key_data)?,
                    passphrase.as_deref(),
                )?;

                // RSA keys must be signed with rsa-sha2-256/512: OpenSSH >= 8.8
                // rejects the legacy SHA-1 "ssh-rsa" signature that a `None` hash
                // produces, so we ask the server which RSA hash it accepts. Non-RSA
                // keys (ed25519/ecdsa) ignore the hash algorithm.
                let hash_alg = if matches!(key.algorithm(), russh::keys::Algorithm::Rsa { .. }) {
                    session.best_supported_rsa_hash().await?.flatten()
                } else {
                    None
                };

                session
                    .authenticate_publickey(
                        &connection.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                    )
                    .await?
            }
            AuthMethod::Agent { ref identity, .. } => {
                tracing::debug!("[terminal.rs] Using SSH agent authentication");
                let mut agent = russh::keys::agent::client::AgentClient::connect_env()
                    .await
                    .map_err(|e| {
                        anyhow!(
                            "No SSH agent available (is ssh-agent running and SSH_AUTH_SOCK set?): {}",
                            e
                        )
                    })?;
                let identities = agent
                    .request_identities()
                    .await
                    .map_err(|e| anyhow!("Failed to list SSH agent identities: {}", e))?;
                // Extract plain public keys (certificates aren't handled here) and,
                // if the user pinned one by SHA256 fingerprint, offer only that;
                // otherwise offer every key the agent holds, like `ssh`.
                let candidates: Vec<PublicKey> = identities
                    .into_iter()
                    .filter_map(|id| match id {
                        russh::keys::agent::AgentIdentity::PublicKey { key, .. } => Some(key),
                        _ => None,
                    })
                    .filter(|k| match identity {
                        Some(fp) if !fp.is_empty() => {
                            k.fingerprint(russh::keys::HashAlg::Sha256).to_string() == *fp
                        }
                        _ => true,
                    })
                    .collect();
                if candidates.is_empty() {
                    return Err(anyhow!(
                        "SSH agent has no usable identities (add one with `ssh-add`)"
                    ));
                }
                // Try each candidate. Stop on full success — or on a *partial*
                // success (the server accepted the key as one factor and wants
                // another): return that result so the outer flow runs the
                // keyboard-interactive exchange (agent + 2FA).
                let mut result: Option<russh::client::AuthResult> = None;
                for key in candidates {
                    // RSA keys must be signed with rsa-sha2 against modern servers.
                    let hash_alg = if matches!(key.algorithm(), russh::keys::Algorithm::Rsa { .. })
                    {
                        session.best_supported_rsa_hash().await?.flatten()
                    } else {
                        None
                    };
                    match session
                        .authenticate_publickey_with(
                            &connection.username,
                            key,
                            hash_alg,
                            &mut agent,
                        )
                        .await
                    {
                        Ok(r) => {
                            let stop = matches!(
                                &r,
                                russh::client::AuthResult::Success
                                    | russh::client::AuthResult::Failure {
                                        partial_success: true,
                                        ..
                                    }
                            );
                            result = Some(r);
                            if stop {
                                break;
                            }
                        }
                        Err(e) => tracing::warn!("[terminal.rs] agent key auth error: {}", e),
                    }
                }
                match result {
                    Some(r) => r,
                    None => {
                        return Err(anyhow!(
                            "SSH agent authentication failed for all identities"
                        ));
                    }
                }
            }
        };

        if !auth_result.success() {
            // The primary method didn't fully authenticate. The server may want a
            // keyboard-interactive exchange — either a 2FA second factor (partial
            // success) or the method it actually accepts. Attempt it, auto-answering
            // a password Rite already holds and asking the UI for the rest.
            tracing::info!("[terminal.rs] Primary auth incomplete, trying keyboard-interactive");
            let stored_password = match &auth_method {
                AuthMethod::Password { password } => Some(password.as_str()),
                _ => None,
            };
            let authed = keyboard_interactive_auth(
                &mut session,
                &connection.username,
                stored_password,
                interactive.as_ref(),
            )
            .await?;
            if !authed {
                tracing::error!("[terminal.rs] Authentication failed!");
                return Err(anyhow!("Authentication failed"));
            }
        }
        tracing::info!("[terminal.rs] Authentication successful");

        // Open a channel with PTY
        tracing::info!("[terminal.rs] Opening channel...");
        let mut channel = session.channel_open_session().await?;
        tracing::info!("[terminal.rs] Channel opened");

        // Agent forwarding (opt-in, agent auth only): let the remote host reuse the
        // local agent to hop onward. Non-fatal — a server that refuses it shouldn't
        // block the session.
        if let AuthMethod::Agent { forward: true, .. } = &auth_method {
            tracing::info!("[terminal.rs] Requesting SSH agent forwarding");
            if let Err(e) = channel.agent_forward(true).await {
                tracing::warn!("[terminal.rs] Agent forwarding request failed: {}", e);
            }
        }

        // Request PTY
        tracing::info!("[terminal.rs] Requesting PTY (xterm-256color, 80x24)...");
        channel
            .request_pty(
                true,
                "xterm-256color",
                80,  // cols
                24,  // rows
                0,   // pix_width
                0,   // pix_height
                &[], // terminal modes
            )
            .await?;
        tracing::info!("[terminal.rs] PTY allocated");

        // Create command channel BEFORE spawning the listener
        // This ensures we can send commands immediately
        let (command_tx, mut command_rx) = mpsc::channel::<SessionCommand>(100);

        // Buffer for initial SSH output (MOTD, welcome message, first prompt).
        // Emitting events before the frontend has registered its listener causes those
        // events to be silently dropped. Instead we buffer all data until the frontend
        // calls claim_session_output(), which atomically drains the buffer and switches
        // to streaming mode. No timing hacks needed.
        let initial_buffer: Arc<Mutex<Option<Vec<u8>>>> = Arc::new(Mutex::new(Some(Vec::new())));
        let initial_buffer_clone = Arc::clone(&initial_buffer);

        // Spawn task to manage the SSH channel BEFORE requesting shell
        // This ensures the listener is active when MOTD arrives
        let session_id_clone = session_id.clone();
        tokio::spawn(async move {
            // Request shell (PTY was already allocated above)
            tracing::info!("[terminal.rs] Requesting shell...");
            if let Err(e) = channel.request_shell(true).await {
                tracing::error!("[terminal.rs] Failed to request shell: {}", e);
                events.terminal_error(&session_id_clone, &format!("Failed to start shell: {}", e));
                return;
            }
            tracing::info!("[terminal.rs] Shell started, buffering initial output");

            // Event loop: russh drives keepalive internally (see Config above), so
            // here we only pump commands to the channel and channel output back.
            loop {
                tokio::select! {
                    // Handle commands from SessionManager
                    Some(cmd) = command_rx.recv() => {
                        match cmd {
                            SessionCommand::SendInput(data) => {
                                if let Err(e) = channel.data(&data[..]).await {
                                    // Never drop the user's keystrokes silently — surface it.
                                    tracing::error!("[terminal.rs] Failed to send input: {}", e);
                                    events.terminal_error(
                                        &session_id_clone,
                                        &format!("Failed to send input: {}", e),
                                    );
                                    events.connection_dead(&session_id_clone, "Input send failed");
                                    break;
                                }
                            }
                            SessionCommand::Resize { cols, rows } => {
                                if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
                                    tracing::warn!("[terminal.rs] Failed to resize terminal: {}", e);
                                }
                            }
                            SessionCommand::Close => {
                                let _ = channel.eof().await;
                                let _ = session.disconnect(russh::Disconnect::ByApplication, "", "").await;
                                break;
                            }
                        }
                    }
                    // Read output from SSH channel
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { ref data }) => {
                                let mut buf_guard = initial_buffer_clone.lock().await;
                                if let Some(ref mut buf) = *buf_guard {
                                    // Buffering mode: accumulate until frontend calls claim,
                                    // but keep only the most recent MAX_INITIAL_BUFFER bytes so
                                    // an unclaimed session can't grow the buffer without bound.
                                    buf.extend_from_slice(data);
                                    if buf.len() > MAX_INITIAL_BUFFER {
                                        let overflow = buf.len() - MAX_INITIAL_BUFFER;
                                        buf.drain(0..overflow);
                                    }
                                } else {
                                    // Streaming mode: frontend has already claimed the buffer.
                                    events.terminal_data(&session_id_clone, &data[..]);
                                }
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => {
                                events.terminal_exit(&session_id_clone, exit_status);
                                break;
                            }
                            Some(ChannelMsg::Eof) => {
                                events.terminal_closed(&session_id_clone);
                                break;
                            }
                            None => {
                                // The channel/session ended without a clean EOF or exit
                                // status — the connection dropped (network loss, or russh's
                                // keepalive gave up). Tell the UI instead of dying silently.
                                events.connection_dead(&session_id_clone, "Connection lost");
                                events.terminal_closed(&session_id_clone);
                                break;
                            }
                            other => {
                                tracing::warn!("[terminal.rs] Unhandled channel message: {:?}", other);
                            }
                        }
                    }
                }
            }
        });

        Ok(Self {
            id: session_id,
            command_tx,
            initial_buffer,
        })
    }

    /// Drain the initial output buffer and switch to streaming mode.
    /// Returns all bytes received before the frontend registered its listener.
    /// After this call, new SSH data is emitted as `terminal-data` events.
    pub async fn claim_initial_output(&self) -> Vec<u8> {
        let mut guard = self.initial_buffer.lock().await;
        guard.take().unwrap_or_default()
    }

    /// Send input to the SSH channel
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

/// Unified session type that can be either SSH or Local
pub enum Session {
    Ssh(SshSession),
    Local(crate::local_terminal::LocalSession),
}

impl Session {
    /// Claim the initial output buffer (SSH and local terminals).
    pub async fn claim_initial_output(&self) -> Vec<u8> {
        match self {
            Session::Ssh(s) => s.claim_initial_output().await,
            Session::Local(s) => s.claim_initial_output(),
        }
    }

    /// Send input to the session
    pub async fn send_input(&self, data: &[u8]) -> Result<()> {
        match self {
            Session::Ssh(s) => s.send_input(data).await,
            Session::Local(s) => s.send_input(data).await,
        }
    }

    /// Resize the session
    pub async fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        match self {
            Session::Ssh(s) => s.resize(cols, rows).await,
            Session::Local(s) => s.resize(cols, rows).await,
        }
    }

    /// Close the session
    pub async fn close(self) -> Result<()> {
        match self {
            Session::Ssh(s) => s.close().await,
            Session::Local(s) => s.close().await,
        }
    }
}

/// Manages all active terminal sessions
#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<SessionId, Session>>>,
    db: Database,
    auth: crate::auth::AuthManager,
}

impl SessionManager {
    pub fn new(db: Database, auth: crate::auth::AuthManager) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            db,
            auth,
        }
    }

    /// Create a new SSH session
    pub async fn create_session(
        &self,
        connection_id: String,
        events: SharedEvents,
        interactive: Option<SharedInteractive>,
    ) -> Result<SessionId> {
        tracing::info!(
            "[terminal.rs] create_session called for connection_id: {}",
            connection_id
        );

        // Load connection from database
        tracing::debug!("[terminal.rs] Loading connection from database...");
        let row = self
            .db
            .get_connection(&connection_id)
            .await?
            .ok_or_else(|| anyhow!("Connection not found"))?;
        tracing::info!(
            "[terminal.rs] Connection loaded: {} ({}:{})",
            row.name,
            row.hostname,
            row.port
        );

        // Determine keep-alive settings (per-connection only, no global fallback)
        tracing::debug!("[terminal.rs] Determining keep-alive settings...");
        let keep_alive_interval = match row.ssh_keep_alive_override.as_deref() {
            Some("disabled") | None => {
                tracing::info!("[terminal.rs] Keep-alive disabled");
                None
            }
            Some("enabled") => {
                // Use connection-specific interval, default to 30 seconds
                let interval = row.ssh_keep_alive_interval.unwrap_or(30) as u64;
                tracing::info!(
                    "[terminal.rs] Keep-alive enabled with interval: {} seconds",
                    interval
                );
                Some(interval)
            }
            Some(other) => {
                tracing::warn!(
                    "[terminal.rs] Unknown ssh_keep_alive_override value: '{}', disabling keep-alive",
                    other
                );
                None
            }
        };

        // Get master key (requires application to be unlocked)
        tracing::debug!("[terminal.rs] Getting master key...");
        let master_key = self.auth.get_master_key().await?;
        tracing::debug!("[terminal.rs] Master key obtained");

        // Decrypt auth method
        tracing::debug!("[terminal.rs] Decrypting credentials...");
        let auth_method =
            Connection::decrypt_credentials(&row.encrypted_credentials, &row.nonce, &master_key)?;
        tracing::info!("[terminal.rs] Credentials decrypted successfully");

        // Build Connection object
        let connection = Connection {
            id: row.id.clone(),
            name: row.name.clone(),
            protocol: crate::connection::Protocol::from_str(&row.protocol)?,
            hostname: row.hostname.clone(),
            port: row.port as u16,
            username: row.username.clone(),
            auth_method: auth_method.clone(),
            metadata: crate::connection::ConnectionMetadata {
                color: row.color.clone(),
                icon: row.icon.clone(),
                folder: row.folder.clone(),
                notes: row.notes.clone(),
            },
            ssh_keep_alive_override: row.ssh_keep_alive_override.clone(),
            ssh_keep_alive_interval: row.ssh_keep_alive_interval,
            preconnect: row.preconnect.clone(),
            last_used_at: row.last_used_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };

        // Create SSH session
        tracing::info!(
            "[terminal.rs] Creating SSH session for {}...",
            connection.name
        );
        let ssh_session = SshSession::connect(
            connection,
            auth_method,
            events,
            Arc::new(self.db.pool().clone()),
            keep_alive_interval,
            false,
            interactive,
        )
        .await?;
        let session_id = ssh_session.id.clone();
        tracing::info!("[terminal.rs] SSH session created with ID: {}", session_id);

        // Wrap in Session enum
        let session = Session::Ssh(ssh_session);

        // Update last_used_at timestamp in database
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        match self
            .db
            .update_connection_last_used(&connection_id, now)
            .await
        {
            Err(e) => {
                tracing::warn!(
                    "[terminal.rs] Failed to update last_used_at for connection {}: {}",
                    connection_id,
                    e
                );
                // Don't fail the connection if we can't update the timestamp
            }
            _ => {
                tracing::debug!(
                    "[terminal.rs] Updated last_used_at timestamp for connection {}",
                    connection_id
                );
            }
        }

        // Store session
        let mut sessions = self.sessions.lock().await;
        sessions.insert(session_id.clone(), session);
        tracing::info!("[terminal.rs] Session stored in SessionManager");

        Ok(session_id)
    }

    /// Create a new local terminal session
    ///
    /// Spawns a local shell (bash/zsh/fish) based on $SHELL env variable
    pub async fn create_local_session(
        &self,
        events: SharedEvents,
        shell: Option<String>,
    ) -> Result<SessionId> {
        tracing::info!("[terminal.rs] create_local_session called");

        // Create local session
        let local_session = crate::local_terminal::LocalSession::spawn(events, shell).await?;
        let session_id = local_session.id.clone();
        tracing::info!(
            "[terminal.rs] Local session created with ID: {}",
            session_id
        );

        // Wrap in Session enum
        let session = Session::Local(local_session);

        // Store session
        let mut sessions = self.sessions.lock().await;
        sessions.insert(session_id.clone(), session);
        tracing::info!("[terminal.rs] Local session stored in SessionManager");

        Ok(session_id)
    }

    /// Create a quick SSH session (no unlock required, credentials not saved)
    ///
    /// For ad-hoc SSH connections that don't need to be saved to the vault
    pub async fn create_quick_ssh_session(
        &self,
        connection: Connection,
        auth_method: AuthMethod,
        events: SharedEvents,
        interactive: Option<SharedInteractive>,
    ) -> Result<SessionId> {
        tracing::info!(
            "[terminal.rs] create_quick_ssh_session called for {}",
            connection.name
        );

        // Determine keep-alive settings (use connection override or disable)
        let keep_alive_interval = match connection.ssh_keep_alive_override.as_deref() {
            Some("enabled") => {
                let interval = connection.ssh_keep_alive_interval.unwrap_or(30) as u64;
                tracing::info!(
                    "[terminal.rs] Keep-alive enabled with interval: {} seconds",
                    interval
                );
                Some(interval)
            }
            _ => {
                tracing::info!("[terminal.rs] Keep-alive disabled");
                None
            }
        };

        // Create SSH session (no database save, no master key needed)
        // force_accept_host_key = true: bypass host key verification for Quick SSH
        tracing::info!(
            "[terminal.rs] Creating quick SSH session for {}...",
            connection.name
        );
        let ssh_session = SshSession::connect(
            connection,
            auth_method,
            events,
            Arc::new(self.db.pool().clone()),
            keep_alive_interval,
            true,
            interactive,
        )
        .await?;
        let session_id = ssh_session.id.clone();
        tracing::info!(
            "[terminal.rs] Quick SSH session created with ID: {}",
            session_id
        );

        // Wrap in Session enum
        let session = Session::Ssh(ssh_session);

        // Store session (no database update for quick connects)
        let mut sessions = self.sessions.lock().await;
        sessions.insert(session_id.clone(), session);
        tracing::info!("[terminal.rs] Quick SSH session stored in SessionManager");

        Ok(session_id)
    }

    /// Claim the initial output buffer for a session.
    /// Returns all SSH data buffered before the frontend registered its listener,
    /// and switches the session to streaming mode (future data emitted as events).
    pub async fn claim_session_output(&self, session_id: &str) -> Vec<u8> {
        let sessions = self.sessions.lock().await;
        match sessions.get(session_id) {
            Some(session) => session.claim_initial_output().await,
            None => Vec::new(),
        }
    }

    /// Send input to a session
    pub async fn send_input(&self, session_id: &str, data: Vec<u8>) -> Result<()> {
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("Session not found"))?;

        session.send_input(&data).await?;
        Ok(())
    }

    /// Resize a terminal session
    pub async fn resize_terminal(&self, session_id: &str, cols: u32, rows: u32) -> Result<()> {
        let sessions = self.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| anyhow!("Session not found"))?;

        session.resize(cols, rows).await?;
        Ok(())
    }

    /// Close a session
    pub async fn close_session(&self, session_id: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().await;
        let session = sessions
            .remove(session_id)
            .ok_or_else(|| anyhow!("Session not found"))?;

        session.close().await?;
        Ok(())
    }

    /// Get all active session IDs
    pub async fn list_sessions(&self) -> Vec<SessionId> {
        let sessions = self.sessions.lock().await;
        sessions.keys().cloned().collect()
    }

    /// Whether this manager owns `session_id` (used by the multiplexer to route a
    /// control request to the local client-execute session vs. proxying it).
    pub async fn has_session(&self, session_id: &str) -> bool {
        self.sessions.lock().await.contains_key(session_id)
    }
}
