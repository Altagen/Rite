/**
 * Terminal Module
 *
 * Manages SSH terminal sessions with russh
 */
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use base64::Engine as _;
use russh::client::{self};
use russh::keys::key;
use russh::ChannelMsg;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use crate::connection::{AuthMethod, Connection};
use crate::db::Database;
use crate::known_hosts::{self, HostKeyVerificationResult};
use crate::AppState;

/// Unique identifier for a terminal session
pub type SessionId = String;

/// Commands that can be sent to a terminal session
pub enum SessionCommand {
    SendInput(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// SSH Client Handler with host key verification
struct SshClientHandler {
    db: Arc<SqlitePool>,
    host: String,
    port: u16,
    app_handle: AppHandle,
    force_accept_host_key: bool, // For Quick SSH: bypass host key verification
}

#[async_trait]
impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        tracing::info!("[terminal.rs] Verifying host key for {}:{}", self.host, self.port);

        // Quick SSH: force accept all host keys (similar to ssh -o StrictHostKeyChecking=no)
        if self.force_accept_host_key {
            tracing::info!("[terminal.rs] Quick SSH mode: auto-accepting host key (TOFU)");

            // Save the host key to known_hosts for future use
            if let Err(e) = known_hosts::add_host_key(&self.db, &self.host, self.port, server_public_key).await {
                tracing::warn!("[terminal.rs] Failed to save host key for Quick SSH: {}", e);
                // Don't fail the connection if we can't save the key
            }

            return Ok(true);
        }

        // Get the host key verification mode from settings
        let verification_mode = match sqlx::query_scalar::<_, String>(
            "SELECT value FROM settings WHERE key = 'host_key_verification_mode'"
        )
        .fetch_optional(&*self.db)
        .await
        {
            Ok(Some(mode)) => mode,
            Ok(None) => {
                tracing::warn!("[terminal.rs] No host_key_verification_mode setting found, defaulting to 'strict'");
                "strict".to_string()
            }
            Err(e) => {
                tracing::error!("[terminal.rs] Failed to read host_key_verification_mode: {}", e);
                "strict".to_string() // Default to strict on error for security
            }
        };

        tracing::info!("[terminal.rs] Host key verification mode: {}", verification_mode);

        // Verify the host key using our known_hosts system
        match known_hosts::verify_host_key(&self.db, &self.host, self.port, server_public_key).await {
            Ok(HostKeyVerificationResult::Accepted) => {
                tracing::info!("[terminal.rs] Host key accepted (known host)");
                Ok(true)
            }
            Ok(HostKeyVerificationResult::Unknown { host, port, key_type, fingerprint }) => {
                tracing::warn!("[terminal.rs] Unknown host {}:{}", host, port);
                tracing::warn!("[terminal.rs] Key type: {}, Fingerprint: {}", key_type, fingerprint);

                match verification_mode.as_str() {
                    "strict" => {
                        // Strict mode: Emit event and REJECT connection
                        // User must explicitly accept the key via the modal
                        tracing::warn!("[terminal.rs] Strict mode: Rejecting connection and requesting user confirmation");

                        let _ = self.app_handle.emit("ssh:host-key-unknown", serde_json::json!({
                            "host": host,
                            "port": port,
                            "keyType": key_type,
                            "fingerprint": fingerprint,
                        }));

                        Err(russh::Error::Disconnect)
                    }
                    "warn" => {
                        // Warn mode: Accept the key but notify the user
                        tracing::info!("[terminal.rs] Warn mode: Accepting key and notifying user");

                        if let Err(e) = known_hosts::add_host_key(&self.db, &host, port, server_public_key).await {
                            tracing::error!("[terminal.rs] Failed to save host key: {}", e);
                        }

                        let _ = self.app_handle.emit("ssh:host-key-added", serde_json::json!({
                            "host": host,
                            "port": port,
                            "keyType": key_type,
                            "fingerprint": fingerprint,
                        }));

                        Ok(true)
                    }
                    _ => {
                        // Accept mode (or default): Silent TOFU
                        tracing::info!("[terminal.rs] Accept mode: Silently accepting and saving key (TOFU)");

                        if let Err(e) = known_hosts::add_host_key(&self.db, &host, port, server_public_key).await {
                            tracing::error!("[terminal.rs] Failed to save host key: {}", e);
                        }

                        Ok(true)
                    }
                }
            }
            Ok(HostKeyVerificationResult::Changed { host, port, old_fingerprint, new_fingerprint, .. }) => {
                // Host key changed - potential MITM attack!
                // ALWAYS reject regardless of mode (security critical)
                tracing::error!("[terminal.rs] ⚠️  WARNING: HOST KEY HAS CHANGED! ⚠️");
                tracing::error!("[terminal.rs] Host: {}:{}", host, port);
                tracing::error!("[terminal.rs] Old fingerprint: {}", old_fingerprint);
                tracing::error!("[terminal.rs] New fingerprint: {}", new_fingerprint);
                tracing::error!("[terminal.rs] This could indicate a Man-in-the-Middle attack!");
                tracing::error!("[terminal.rs] Connection REJECTED for security");

                // Emit event to notify frontend of changed key
                let _ = self.app_handle.emit("ssh:host-key-changed", serde_json::json!({
                    "host": host,
                    "port": port,
                    "oldFingerprint": old_fingerprint,
                    "newFingerprint": new_fingerprint,
                }));

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
    pub connection_id: String,
    pub connection_name: String,
    command_tx: mpsc::Sender<SessionCommand>,
}

impl SshSession {
    /// Create a new SSH session by connecting to a remote server
    pub async fn connect(
        connection: Connection,
        auth_method: AuthMethod,
        app_handle: AppHandle,
        keep_alive_interval: Option<u64>, // Keep-alive interval in seconds (None = disabled)
        force_accept_host_key: bool, // For Quick SSH: bypass host key verification
    ) -> Result<Self> {
        let session_id = Uuid::new_v4().to_string();
        tracing::info!("[terminal.rs] SshSession::connect - Session ID: {}", session_id);
        tracing::info!("[terminal.rs] Connecting to {}:{} as {}", connection.hostname, connection.port, connection.username);

        // Get database for host key verification
        let state = app_handle.state::<AppState>();
        let db = state.db.pool().clone();

        // Create SSH client configuration
        let config = Arc::new(client::Config::default());
        let handler = SshClientHandler {
            db: Arc::new(db),
            host: connection.hostname.clone(),
            port: connection.port,
            app_handle: app_handle.clone(),
            force_accept_host_key,
        };

        // Connect to SSH server (host key verification happens in handler.check_server_key())
        let addr = format!("{}:{}", connection.hostname, connection.port);
        tracing::info!("[terminal.rs] Attempting TCP connection to {}...", addr);
        let mut session = client::connect(config, &addr, handler).await?;
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
                tracing::debug!("[terminal.rs] Using public key authentication from: {}", key_path);
                // Load private key
                let key_data = tokio::fs::read(key_path).await?;
                let key = if let Some(pass) = passphrase {
                    russh_keys::decode_secret_key(&String::from_utf8(key_data)?, Some(pass))?
                } else {
                    russh_keys::decode_secret_key(&String::from_utf8(key_data)?, None)?
                };

                session
                    .authenticate_publickey(&connection.username, Arc::new(key))
                    .await?
            }
        };

        if !auth_result {
            tracing::error!("[terminal.rs] Authentication failed!");
            return Err(anyhow!("Authentication failed"));
        }
        tracing::info!("[terminal.rs] Authentication successful");

        // Open a channel with PTY
        tracing::info!("[terminal.rs] Opening channel...");
        let mut channel = session.channel_open_session().await?;
        tracing::info!("[terminal.rs] Channel opened");

        // Request PTY
        tracing::info!("[terminal.rs] Requesting PTY (xterm-256color, 80x24)...");
        channel
            .request_pty(
                true,
                "xterm-256color",
                80, // cols
                24, // rows
                0,  // pix_width
                0,  // pix_height
                &[], // terminal modes
            )
            .await?;
        tracing::info!("[terminal.rs] PTY allocated");

        // Create command channel BEFORE spawning the listener
        // This ensures we can send commands immediately
        let (command_tx, mut command_rx) = mpsc::channel::<SessionCommand>(100);

        // Spawn task to manage the SSH channel BEFORE requesting shell
        // This ensures the listener is active when MOTD arrives
        let session_id_clone = session_id.clone();
        tokio::spawn(async move {
            // Request shell (PTY was already allocated above)
            tracing::info!("[terminal.rs] Requesting shell...");
            if let Err(e) = channel.request_shell(true).await {
                tracing::error!("[terminal.rs] Failed to request shell: {}", e);
                let _ = app_handle.emit(
                    "terminal-error",
                    serde_json::json!({
                        "sessionId": session_id_clone,
                        "error": format!("Failed to start shell: {}", e),
                    }),
                );
                return;
            }
            tracing::info!("[terminal.rs] Shell started, listener is now active");

            // WORKAROUND: Send command to start a login shell
            // This is a workaround because russh's request_shell() doesn't support login shell flag
            // The shell command will replace the current shell with a login shell
            tracing::info!("[terminal.rs] Sending command to start login shell...");
            let login_cmd = "exec $SHELL -l\n";
            if let Err(e) = channel.data(login_cmd.as_bytes()).await {
                tracing::error!("[terminal.rs] Failed to send login shell command: {}", e);
            }

            // CRITICAL FIX: Give frontend time to configure event listeners
            // React needs ~200ms to mount the Terminal component and setup listeners
            // Without this delay, early events (MOTD) are lost in Quick SSH mode
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

            // Start the event loop immediately to capture all output including MOTD
            // Keep-alive timer will be initialized on first tick
            let mut keep_alive_timer: Option<tokio::time::Interval> = None;
            let mut keep_alive_initialized = false;

            // CRITICAL FIX: Ignore all data until we see the login shell starting
            // The first shell outputs a prompt before we send exec $SHELL -l
            // We need to skip that initial prompt and only start sending data
            // AFTER the login shell has started (when we see the MOTD)
            let mut login_shell_started = false;

            loop {
                // Initialize keep-alive on first loop iteration (after we're already listening)
                if !keep_alive_initialized {
                    keep_alive_timer = if let Some(interval_secs) = keep_alive_interval {
                        tracing::info!("[terminal.rs] Keep-alive enabled: {} seconds", interval_secs);
                        Some(tokio::time::interval(std::time::Duration::from_secs(interval_secs)))
                    } else {
                        tracing::info!("[terminal.rs] Keep-alive disabled");
                        None
                    };
                    keep_alive_initialized = true;
                }

                tokio::select! {
                    // Keep-alive timer
                    _ = async {
                        match &mut keep_alive_timer {
                            Some(timer) => timer.tick().await,
                            None => std::future::pending().await, // Never completes if disabled
                        }
                    } => {
                        tracing::trace!("[terminal.rs] Sending keep-alive...");
                        // Try to send a window size query as a keep-alive heartbeat
                        // If this fails, the connection is likely dead
                        if let Err(e) = channel.window_change(80, 24, 0, 0).await {
                            tracing::error!("[terminal.rs] Keep-alive failed: {}. Connection appears dead.", e);
                            let _ = app_handle.emit(
                                "connection-dead",
                                serde_json::json!({
                                    "sessionId": session_id_clone,
                                    "reason": "Keep-alive failed",
                                }),
                            );
                            let _ = app_handle.emit(
                                "terminal-closed",
                                serde_json::json!({
                                    "sessionId": session_id_clone,
                                }),
                            );
                            break;
                        }
                    }
                    // Handle commands from SessionManager
                    Some(cmd) = command_rx.recv() => {
                        match cmd {
                            SessionCommand::SendInput(data) => {
                                if let Err(e) = channel.data(&data[..]).await {
                                    eprintln!("Error sending input: {}", e);
                                    break;
                                }
                            }
                            SessionCommand::Resize { cols, rows } => {
                                if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
                                    eprintln!("Error resizing terminal: {}", e);
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
                                let preview = String::from_utf8_lossy(data);

                                // Skip initial prompt until login shell starts
                                // Detect login shell start by looking for typical MOTD content (> 200 bytes)
                                // or typical MOTD markers like "Linux", "Welcome", etc.
                                if !login_shell_started {
                                    if data.len() > 200 || preview.contains("Linux ") || preview.contains("Debian ") || preview.contains("Ubuntu ") {
                                        login_shell_started = true;
                                    } else {
                                        continue; // Skip this data, don't send to frontend
                                    }
                                }

                                // Filter out the echo of our "exec $SHELL -l" command
                                // This command is sent to start a login shell and gets echoed back by the shell
                                if preview.contains("exec $SHELL") {
                                    continue;
                                }

                                // Encode raw bytes as base64 to preserve all data (including ANSI codes)
                                // This prevents UTF-8 conversion from corrupting terminal control sequences
                                let data_base64 = base64::engine::general_purpose::STANDARD.encode(data);

                                let _ = app_handle.emit(
                                    "terminal-data",
                                    serde_json::json!({
                                        "sessionId": session_id_clone,
                                        "data": data_base64,
                                    }),
                                );
                            }
                            Some(ChannelMsg::ExitStatus { exit_status }) => {
                                let _ = app_handle.emit(
                                    "terminal-exit",
                                    serde_json::json!({
                                        "sessionId": session_id_clone,
                                        "exitStatus": exit_status,
                                    }),
                                );
                                break;
                            }
                            Some(ChannelMsg::Eof) => {
                                let _ = app_handle.emit(
                                    "terminal-closed",
                                    serde_json::json!({
                                        "sessionId": session_id_clone,
                                    }),
                                );
                                break;
                            }
                            None => break,
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
            connection_id: connection.id,
            connection_name: connection.name,
            command_tx,
        })
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

    /// Get the session ID
    pub fn id(&self) -> &str {
        match self {
            Session::Ssh(s) => &s.id,
            Session::Local(s) => &s.id,
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
        app_handle: AppHandle,
    ) -> Result<SessionId> {
        tracing::info!("[terminal.rs] create_session called for connection_id: {}", connection_id);

        // Load connection from database
        tracing::debug!("[terminal.rs] Loading connection from database...");
        let row = self
            .db
            .get_connection(&connection_id)
            .await?
            .ok_or_else(|| anyhow!("Connection not found"))?;
        tracing::info!("[terminal.rs] Connection loaded: {} ({}:{})", row.name, row.hostname, row.port);

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
                tracing::info!("[terminal.rs] Keep-alive enabled with interval: {} seconds", interval);
                Some(interval)
            }
            Some(other) => {
                tracing::warn!("[terminal.rs] Unknown ssh_keep_alive_override value: '{}', disabling keep-alive", other);
                None
            }
        };

        // Get master key (requires application to be unlocked)
        tracing::debug!("[terminal.rs] Getting master key...");
        let master_key = self.auth.get_master_key().await?;
        tracing::debug!("[terminal.rs] Master key obtained");

        // Decrypt auth method
        tracing::debug!("[terminal.rs] Decrypting credentials...");
        let auth_method = Connection::decrypt_credentials(
            &row.encrypted_credentials,
            &row.nonce,
            &master_key,
        )?;
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
            last_used_at: row.last_used_at,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };

        // Create SSH session
        tracing::info!("[terminal.rs] Creating SSH session for {}...", connection.name);
        let ssh_session = SshSession::connect(connection, auth_method, app_handle, keep_alive_interval, false).await?;
        let session_id = ssh_session.id.clone();
        tracing::info!("[terminal.rs] SSH session created with ID: {}", session_id);

        // Wrap in Session enum
        let session = Session::Ssh(ssh_session);

        // Update last_used_at timestamp in database
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        if let Err(e) = self.db.update_connection_last_used(&connection_id, now).await {
            tracing::warn!("[terminal.rs] Failed to update last_used_at for connection {}: {}", connection_id, e);
            // Don't fail the connection if we can't update the timestamp
        } else {
            tracing::debug!("[terminal.rs] Updated last_used_at timestamp for connection {}", connection_id);
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
        app_handle: AppHandle,
        shell: Option<String>,
    ) -> Result<SessionId> {
        tracing::info!("[terminal.rs] create_local_session called");

        // Create local session
        let local_session = crate::local_terminal::LocalSession::spawn(app_handle, shell).await?;
        let session_id = local_session.id.clone();
        tracing::info!("[terminal.rs] Local session created with ID: {}", session_id);

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
        app_handle: AppHandle,
    ) -> Result<SessionId> {
        tracing::info!("[terminal.rs] create_quick_ssh_session called for {}", connection.name);

        // Determine keep-alive settings (use connection override or disable)
        let keep_alive_interval = match connection.ssh_keep_alive_override.as_deref() {
            Some("enabled") => {
                let interval = connection.ssh_keep_alive_interval.unwrap_or(30) as u64;
                tracing::info!("[terminal.rs] Keep-alive enabled with interval: {} seconds", interval);
                Some(interval)
            }
            _ => {
                tracing::info!("[terminal.rs] Keep-alive disabled");
                None
            }
        };

        // Create SSH session (no database save, no master key needed)
        // force_accept_host_key = true: bypass host key verification for Quick SSH
        tracing::info!("[terminal.rs] Creating quick SSH session for {}...", connection.name);
        let ssh_session = SshSession::connect(connection, auth_method, app_handle, keep_alive_interval, true).await?;
        let session_id = ssh_session.id.clone();
        tracing::info!("[terminal.rs] Quick SSH session created with ID: {}", session_id);

        // Wrap in Session enum
        let session = Session::Ssh(ssh_session);

        // Store session (no database update for quick connects)
        let mut sessions = self.sessions.lock().await;
        sessions.insert(session_id.clone(), session);
        tracing::info!("[terminal.rs] Quick SSH session stored in SessionManager");

        Ok(session_id)
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

    /// Close all sessions
    pub async fn close_all_sessions(&self) -> Result<()> {
        let mut sessions = self.sessions.lock().await;
        let session_ids: Vec<_> = sessions.keys().cloned().collect();

        for session_id in session_ids {
            if let Some(session) = sessions.remove(&session_id) {
                let _ = session.close().await; // Best effort
            }
        }

        Ok(())
    }
}
