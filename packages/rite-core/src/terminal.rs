/**
 * Terminal Module
 *
 * Manages SSH terminal sessions with russh
 */
use anyhow::{Result, anyhow};
use russh::ChannelMsg;
use russh::client::{self};
use russh::keys::{PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
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

/// Bound the connect + handshake (per hop) so an unreachable/filtered host fails
/// with a clear error instead of hanging on the OS TCP timeout (~2 min).
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

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
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // russh 0.63 widened this to let a host present an OpenSSH certificate instead of
        // a bare key. Rite verifies a host by its key — trust on first use, recorded in
        // known_hosts — and holds no CA to validate a certificate against. Reading the key
        // out of a certificate and verifying that would quietly turn "I recognise this host"
        // into "I trust whoever signed for it", which is not the promise the user was shown
        // when they clicked Trust. So a certificate is refused until there is a CA-trust
        // decision to implement.
        //
        // In practice this arm is unreachable: a server only presents a certificate when the
        // client advertises `*-cert-v01@openssh.com`, which lives in `Preferred::
        // host_key_certificates` and is empty in `Config::default()` — what we build below.
        // The refusal is here so that widening the advertised algorithms some day fails
        // closed, with a log line saying why, instead of inheriting a trust decision nobody
        // made.
        let server_public_key = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key,
            PublicKeyOrCertificate::Certificate(_) => {
                tracing::warn!(
                    "[terminal.rs] {}:{} offered an OpenSSH certificate; Rite verifies host keys only",
                    self.host,
                    self.port
                );
                return Ok(false);
            }
        };

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
    /// Jump-host `Handle`s for a ProxyJump chain, held so the tunnels carrying this
    /// session stay up for its whole life; they drop with the session. Empty for a
    /// direct connection.
    _jump_handles: Vec<client::Handle<SshClientHandler>>,
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

/// Authenticate a freshly-connected session with `auth_method`, running the
/// keyboard-interactive fallthrough (2FA / PAM / the method the server actually
/// wants) when the primary method doesn't fully authenticate. Errors on failure.
/// Used for the target *and* for every jump host in a ProxyJump chain — each hop
/// authenticates independently, end-to-end (a bastion never sees the target's
/// credentials, and the target never sees a bastion's).
async fn authenticate_session(
    session: &mut client::Handle<SshClientHandler>,
    username: &str,
    auth_method: &AuthMethod,
    interactive: Option<&SharedInteractive>,
) -> Result<()> {
    let auth_result = match auth_method {
        AuthMethod::Password { password } => {
            session.authenticate_password(username, password).await?
        }
        AuthMethod::PublicKey {
            key_path,
            passphrase,
        } => {
            let key_data = tokio::fs::read(key_path).await?;
            let key = russh::keys::decode_secret_key(
                &String::from_utf8(key_data)?,
                passphrase.as_deref(),
            )?;
            // RSA keys must be signed with rsa-sha2-256/512: modern OpenSSH rejects
            // the legacy SHA-1 "ssh-rsa" signature. Non-RSA keys ignore the hash.
            let hash_alg = if matches!(key.algorithm(), russh::keys::Algorithm::Rsa { .. }) {
                session.best_supported_rsa_hash().await?.flatten()
            } else {
                None
            };
            session
                .authenticate_publickey(
                    username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await?
        }
        AuthMethod::Agent { identity, .. } => {
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
            // Try each candidate; stop on full success, or on a *partial* success
            // (accepted as one factor, server wants another) so the caller runs the
            // keyboard-interactive exchange (agent + 2FA).
            let mut result: Option<russh::client::AuthResult> = None;
            for key in candidates {
                let hash_alg = if matches!(key.algorithm(), russh::keys::Algorithm::Rsa { .. }) {
                    session.best_supported_rsa_hash().await?.flatten()
                } else {
                    None
                };
                match session
                    .authenticate_publickey_with(username, key, hash_alg, &mut agent)
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
        tracing::info!("[terminal.rs] Primary auth incomplete, trying keyboard-interactive");
        let stored_password = match auth_method {
            AuthMethod::Password { password } => Some(password.as_str()),
            _ => None,
        };
        let authed =
            keyboard_interactive_auth(session, username, stored_password, interactive).await?;
        if !authed {
            return Err(anyhow!("Authentication failed"));
        }
    }
    Ok(())
}

/// Establish the tunnelled transport to `(target_host, target_port)` through an
/// ordered chain of jump hosts (outermost / TCP-facing first). The first hop is
/// reached over TCP; each subsequent hop rides a `direct-tcpip` channel opened on
/// the previous hop; finally a `direct-tcpip` channel to the target yields the
/// stream the target's SSH handshake runs over. Returns that stream plus the jump
/// `Handle`s — the caller keeps them alive for the tunnel's lifetime.
async fn open_jump_tunnel(
    jumps: &[(Connection, AuthMethod)],
    target_host: &str,
    target_port: u16,
    db_pool: Arc<SqlitePool>,
    events: SharedEvents,
    force_accept_host_key: bool,
) -> Result<(
    russh::ChannelStream<client::Msg>,
    Vec<client::Handle<SshClientHandler>>,
)> {
    let mut handles: Vec<client::Handle<SshClientHandler>> = Vec::new();
    for (i, (conn, auth)) in jumps.iter().enumerate() {
        let config = Arc::new(client::Config::default());
        // Each bastion's host key is verified like any host (its own known_hosts
        // entry); an unknown one prompts the user, same as the target.
        let handler = SshClientHandler {
            db: db_pool.clone(),
            host: conn.hostname.clone(),
            port: conn.port,
            events: events.clone(),
            force_accept_host_key,
        };
        let mut handle = if i == 0 {
            let addr = format!("{}:{}", conn.hostname, conn.port);
            match tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, &addr, handler))
                .await
            {
                Ok(result) => result?,
                Err(_) => {
                    return Err(anyhow!(
                        "Connection to jump host {} timed out after {}s",
                        addr,
                        CONNECT_TIMEOUT.as_secs()
                    ));
                }
            }
        } else {
            let prev = handles.last().expect("previous hop exists for i > 0");
            let channel = prev
                .channel_open_direct_tcpip(conn.hostname.clone(), conn.port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| {
                    anyhow!(
                        "Failed to open tunnel to jump host {}: {}",
                        conn.hostname,
                        e
                    )
                })?;
            client::connect_stream(config, channel.into_stream(), handler).await?
        };
        authenticate_session(&mut handle, &conn.username, auth, None)
            .await
            .map_err(|e| anyhow!("Jump host {} authentication failed: {}", conn.hostname, e))?;
        handles.push(handle);
    }

    let last = handles.last().expect("jump chain is non-empty");
    let channel = last
        .channel_open_direct_tcpip(target_host.to_string(), target_port as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| {
            anyhow!(
                "Failed to open tunnel to {}:{}: {}",
                target_host,
                target_port,
                e
            )
        })?;
    Ok((channel.into_stream(), handles))
}

/// Establish an authenticated SSH `Handle` to the target — directly over TCP or
/// tunnelled through a jump-host chain — and authenticate it end-to-end. Returns
/// the target handle plus the retained jump handles (kept alive to hold the tunnel
/// open). Shared by interactive sessions (which then open a shell channel) and
/// port forwards (which open direct-tcpip channels).
#[allow(clippy::too_many_arguments)]
async fn establish_authenticated_handle(
    connection: &Connection,
    auth_method: &AuthMethod,
    events: SharedEvents,
    db_pool: Arc<SqlitePool>,
    keep_alive_interval: Option<u64>,
    force_accept_host_key: bool,
    interactive: Option<&SharedInteractive>,
    jumps: &[(Connection, AuthMethod)],
) -> Result<(
    client::Handle<SshClientHandler>,
    Vec<client::Handle<SshClientHandler>>,
)> {
    // Native SSH keepalive (keepalive@openssh.com), not an app-level heartbeat.
    let mut config = client::Config::default();
    if let Some(secs) = keep_alive_interval {
        config.keepalive_interval = Some(std::time::Duration::from_secs(secs));
        config.keepalive_max = 3;
    }
    let config = Arc::new(config);
    // Host-key verification runs per hop in each handler.check_server_key().
    let handler = SshClientHandler {
        db: db_pool.clone(),
        host: connection.hostname.clone(),
        port: connection.port,
        events: events.clone(),
        force_accept_host_key,
    };
    let mut jump_handles: Vec<client::Handle<SshClientHandler>> = Vec::new();
    let mut session = if jumps.is_empty() {
        let addr = format!("{}:{}", connection.hostname, connection.port);
        tracing::info!("[terminal.rs] Attempting TCP connection to {}...", addr);
        match tokio::time::timeout(CONNECT_TIMEOUT, client::connect(config, &addr, handler)).await {
            Ok(result) => result?,
            Err(_) => {
                return Err(anyhow!(
                    "Connection to {} timed out after {}s",
                    addr,
                    CONNECT_TIMEOUT.as_secs()
                ));
            }
        }
    } else {
        tracing::info!(
            "[terminal.rs] Reaching {}:{} through {} jump host(s)",
            connection.hostname,
            connection.port,
            jumps.len()
        );
        let (stream, handles) = open_jump_tunnel(
            jumps,
            &connection.hostname,
            connection.port,
            db_pool.clone(),
            events.clone(),
            force_accept_host_key,
        )
        .await?;
        jump_handles = handles;
        client::connect_stream(config, stream, handler).await?
    };
    tracing::info!("[terminal.rs] Transport to target established");

    // Authenticate to the target end-to-end (through any tunnel — the target never
    // sees a jump host's credentials, nor a jump the target's).
    authenticate_session(&mut session, &connection.username, auth_method, interactive).await?;
    tracing::info!("[terminal.rs] Authentication successful");
    Ok((session, jump_handles))
}

/// Rebuild a `Connection` from its stored row plus the already-decrypted auth method.
fn connection_from_row(
    row: &crate::db::ConnectionRow,
    auth_method: AuthMethod,
) -> Result<Connection> {
    Ok(Connection {
        id: row.id.clone(),
        name: row.name.clone(),
        protocol: crate::connection::Protocol::from_str(&row.protocol)?,
        hostname: row.hostname.clone(),
        port: row.port as u16,
        username: row.username.clone(),
        auth_method,
        metadata: crate::connection::ConnectionMetadata {
            color: row.color.clone(),
            icon: row.icon.clone(),
            folder: row.folder.clone(),
            notes: row.notes.clone(),
        },
        ssh_keep_alive_override: row.ssh_keep_alive_override.clone(),
        ssh_keep_alive_interval: row.ssh_keep_alive_interval,
        preconnect: row.preconnect.clone(),
        jump: row.jump.clone(),
        forwards: Vec::new(),
        last_used_at: row.last_used_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

impl SshSession {
    /// Create a new SSH session by connecting to a remote server
    #[allow(clippy::too_many_arguments)]
    pub async fn connect(
        connection: Connection,
        auth_method: AuthMethod,
        events: SharedEvents,
        db_pool: Arc<SqlitePool>,
        keep_alive_interval: Option<u64>, // Keep-alive interval in seconds (None = disabled)
        force_accept_host_key: bool,      // For Quick SSH: bypass host key verification
        interactive: Option<SharedInteractive>, // Collects keyboard-interactive answers (2FA/PAM)
        jumps: Vec<(Connection, AuthMethod)>, // Jump-host chain (outermost/TCP first); empty = direct
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

        // Establish the authenticated transport (direct or through a jump chain).
        // Jump handles are retained on the session so the tunnel stays up for its life.
        let (session, jump_handles) = establish_authenticated_handle(
            &connection,
            &auth_method,
            events.clone(),
            db_pool,
            keep_alive_interval,
            force_accept_host_key,
            interactive.as_ref(),
            &jumps,
        )
        .await?;

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
            _jump_handles: jump_handles,
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

/// A running local port forward: a bound TCP listener whose accepted connections
/// are tunnelled over SSH (a direct-tcpip channel per connection) to
/// `remote_host:remote_port` as seen from the SSH host — through the connection's
/// jump chain too, if it has one.
struct PortForward {
    info: PortForwardInfo,
    /// The accept loop; aborted on stop.
    accept_task: tokio::task::JoinHandle<()>,
    /// The SSH session carrying the tunnel, and its jump handles. Held here so the
    /// tunnel stays up for the forward's life and closes when it's dropped.
    _session: Arc<client::Handle<SshClientHandler>>,
    _jump_handles: Vec<client::Handle<SshClientHandler>>,
}

/// Serializable description of a running port forward (for the frontend list).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInfo {
    pub id: String,
    pub connection_id: String,
    pub bind_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

/// Captured output of a one-shot remote command (agentless dashboard detection:
/// `docker ps`, `systemctl list-units`, …). Ran over its own short-lived SSH exec
/// channel — never touches an interactive session.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommandOutput {
    pub stdout: String,
    pub stderr: String,
    /// The command's exit status, or `None` if the channel closed without one.
    pub exit_status: Option<u32>,
}

/// A one-shot remote command has this long to run before we give up (dashboard
/// probes are quick; a hang shouldn't wedge the UI).
const REMOTE_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Establish an authenticated handle, run one command over an exec channel (no PTY),
/// and collect its output. The handle + any jump tunnel are dropped on return.
async fn exec_remote_command(
    connection: &Connection,
    auth_method: &AuthMethod,
    events: SharedEvents,
    db_pool: Arc<SqlitePool>,
    jumps: &[(Connection, AuthMethod)],
    force_accept_host_key: bool,
    command: &str,
) -> Result<RemoteCommandOutput> {
    let (session, _jump_handles) = establish_authenticated_handle(
        connection,
        auth_method,
        events,
        db_pool,
        None, // no keepalive for a one-shot exec
        force_accept_host_key,
        None, // no keyboard-interactive on the exec path
        jumps,
    )
    .await?;

    let mut channel = session.channel_open_session().await?;
    channel.exec(true, command).await?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_status = None;
    let collect = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
                ChannelMsg::ExtendedData { ref data, ext } => {
                    // ext == 1 is stderr; fold anything else into stdout.
                    if ext == 1 {
                        stderr.extend_from_slice(data);
                    } else {
                        stdout.extend_from_slice(data);
                    }
                }
                ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    tokio::time::timeout(REMOTE_COMMAND_TIMEOUT, collect)
        .await
        .map_err(|_| {
            anyhow!(
                "Command timed out after {}s",
                REMOTE_COMMAND_TIMEOUT.as_secs()
            )
        })?;

    Ok(RemoteCommandOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_status,
    })
}

/// Manages all active terminal sessions
#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<SessionId, Session>>>,
    /// Running local port forwards, keyed by forward id.
    forwards: Arc<Mutex<HashMap<String, PortForward>>>,
    db: Database,
    auth: crate::auth::AuthManager,
}

impl SessionManager {
    pub fn new(db: Database, auth: crate::auth::AuthManager) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            forwards: Arc::new(Mutex::new(HashMap::new())),
            db,
            auth,
        }
    }

    /// Resolve a saved machine by id, from either local store.
    ///
    /// A vault keeps machines two ways during the ADR 0018 transition: the legacy
    /// `connections` table, and — the model going forward — encrypted items inside
    /// collections. Item ids are UUIDs, so an id alone is unambiguous and callers
    /// (connect, jump-chain resolution, one-shot exec, port forwards) need not know
    /// which store holds a machine. Decryption happens here, in Rust, with the
    /// master key; credentials never travel to the webview.
    async fn resolve_saved(&self, id: &str) -> Result<(Connection, AuthMethod)> {
        let master_key = self.auth.get_master_key().await?;

        if let Some(row) = self.db.get_connection(id).await? {
            let auth = Connection::decrypt_credentials(
                &row.encrypted_credentials,
                &row.nonce,
                &master_key,
            )?;
            let mut connection = connection_from_row(&row, auth.clone())?;
            connection.forwards =
                crate::connections_manager::parse_forwards(row.forwards.as_deref());
            return Ok((connection, auth));
        }

        let key = *master_key.as_bytes();
        if let Some((_, record)) =
            crate::local_collections::find_machine(self.db.pool(), &key, id).await?
        {
            let auth = record.auth_method.clone();
            return Ok((record.to_connection(id)?, auth));
        }

        Err(anyhow!("Connection not found"))
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

        // Resolve the machine from whichever local store holds it (ADR 0018): the
        // legacy connections table, or an encrypted item inside a collection.
        let (connection, auth_method) = self.resolve_saved(&connection_id).await?;
        tracing::info!(
            "[terminal.rs] Connection loaded: {} ({}:{})",
            connection.name,
            connection.hostname,
            connection.port
        );

        // Determine keep-alive settings (per-connection only, no global fallback)
        tracing::debug!("[terminal.rs] Determining keep-alive settings...");
        let keep_alive_interval = match connection.ssh_keep_alive_override.as_deref() {
            Some("disabled") | None => {
                tracing::info!("[terminal.rs] Keep-alive disabled");
                None
            }
            Some("enabled") => {
                // Use connection-specific interval, default to 30 seconds
                let interval = connection.ssh_keep_alive_interval.unwrap_or(30) as u64;
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

        // Resolve the jump-host chain (ProxyJump): follow this connection's `jump`
        // reference, decrypting each bastion's credentials, until a direct one — so
        // the transport can tunnel through them. Cycle- and depth-guarded.
        let jumps = self.resolve_jump_chain(connection.jump.as_deref()).await?;

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
            jumps,
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

        // Stamp "last used" in whichever store holds this machine. A legacy row has
        // the column; a collection item has a row beside it (migration 023), so the
        // encrypted blob is not rewritten just to record a connect. Never fatal —
        // a timestamp is not worth failing a working session over.
        let stamped = match self
            .db
            .update_connection_last_used(&connection_id, now)
            .await
        {
            Ok(true) => Ok(()),
            // No legacy row matched, so this is a collection machine.
            Ok(false) => {
                crate::local_collections::touch_machine(self.db.pool(), &connection_id, now).await
            }
            Err(e) => Err(e),
        };
        if let Err(e) = stamped {
            tracing::warn!(
                "[terminal.rs] Failed to update last_used_at for {}: {}",
                connection_id,
                e
            );
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

    /// Resolve a jump-host chain into decrypted `(Connection, AuthMethod)` hops in
    /// establishment order (outermost / TCP-facing first). Follows each hop's own
    /// `jump` reference, so a bastion-behind-a-bastion is built automatically;
    /// guards against reference cycles and pathological depth.
    async fn resolve_jump_chain(
        &self,
        first_jump: Option<&str>,
    ) -> Result<Vec<(Connection, AuthMethod)>> {
        const MAX_HOPS: usize = 10;
        let mut hops: Vec<(Connection, AuthMethod)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut next = first_jump.map(|s| s.to_string());

        while let Some(id) = next {
            if !seen.insert(id.clone()) {
                return Err(anyhow!("Jump-host chain has a cycle at connection {}", id));
            }
            if hops.len() >= MAX_HOPS {
                return Err(anyhow!("Jump-host chain too deep (> {} hops)", MAX_HOPS));
            }
            // A hop is just another saved machine, so it resolves from whichever
            // store holds it — a bastion may be a collection item like any other.
            let (conn, auth) = self
                .resolve_saved(&id)
                .await
                .map_err(|_| anyhow!("Jump-host connection {} not found", id))?;
            next = conn.jump.clone();
            hops.push((conn, auth));
        }

        // `hops` is nearest-jump-first (target.jump, then ITS jump, …). The transport
        // establishes the outermost (TCP-facing) hop first, so reverse into that order.
        hops.reverse();
        Ok(hops)
    }

    /// Start a local port forward for a saved connection: bind `bind_host:local_port`
    /// and tunnel each accepted TCP connection over SSH to `remote_host:remote_port`
    /// (through the connection's jump chain, if any). Establishes a dedicated headless
    /// session — no PTY — so a forward works without a terminal open. Returns the info.
    #[allow(clippy::too_many_arguments)]
    pub async fn start_local_forward(
        &self,
        connection_id: &str,
        bind_host: &str,
        local_port: u16,
        remote_host: &str,
        remote_port: u16,
        events: SharedEvents,
    ) -> Result<PortForwardInfo> {
        // Resolve + decrypt the machine and its jump chain, as for a terminal, from
        // whichever local store holds it.
        let (connection, auth_method) = self.resolve_saved(connection_id).await?;
        let jumps = self.resolve_jump_chain(connection.jump.as_deref()).await?;

        // A long-lived tunnel benefits from keepalive to notice a dead peer; default 30s.
        let keep_alive = match connection.ssh_keep_alive_override.as_deref() {
            Some("enabled") => Some(connection.ssh_keep_alive_interval.unwrap_or(30) as u64),
            _ => Some(30),
        };

        self.spawn_local_forward(
            connection_id,
            &connection,
            &auth_method,
            &jumps,
            keep_alive,
            false,
            bind_host,
            local_port,
            remote_host,
            remote_port,
            events,
        )
        .await
    }

    /// Start a local port forward for an ad-hoc target the caller already decrypted
    /// (accounts/collections client-execute — the server holds no record of it, so
    /// there is nothing to look up by id). `jumps` is the already-resolved chain in
    /// outermost-first order; the host key is accepted like Quick SSH.
    #[allow(clippy::too_many_arguments)]
    pub async fn start_quick_local_forward(
        &self,
        connection: Connection,
        auth_method: AuthMethod,
        jumps: Vec<(Connection, AuthMethod)>,
        bind_host: &str,
        local_port: u16,
        remote_host: &str,
        remote_port: u16,
        events: SharedEvents,
    ) -> Result<PortForwardInfo> {
        let connection_id = connection.id.clone();
        let keep_alive = match connection.ssh_keep_alive_override.as_deref() {
            Some("enabled") => Some(connection.ssh_keep_alive_interval.unwrap_or(30) as u64),
            _ => Some(30),
        };
        self.spawn_local_forward(
            &connection_id,
            &connection,
            &auth_method,
            &jumps,
            keep_alive,
            true, // ad-hoc target → accept the host key like quick SSH
            bind_host,
            local_port,
            remote_host,
            remote_port,
            events,
        )
        .await
    }

    /// Bind the local port and pump accepted TCP connections over SSH. Shared by the
    /// vault path (`start_local_forward`) and the ad-hoc one (`start_quick_local_forward`),
    /// which differ only in how they obtain the connection, its auth and its jump chain.
    #[allow(clippy::too_many_arguments)]
    async fn spawn_local_forward(
        &self,
        connection_id: &str,
        connection: &Connection,
        auth_method: &AuthMethod,
        jumps: &[(Connection, AuthMethod)],
        keep_alive: Option<u64>,
        force_accept_host_key: bool,
        bind_host: &str,
        local_port: u16,
        remote_host: &str,
        remote_port: u16,
        events: SharedEvents,
    ) -> Result<PortForwardInfo> {
        // Headless authenticated session (no PTY). MVP forwards use non-interactive
        // auth (key/agent/password) — there's no 2FA UI bridge on this path yet.
        let (session, jump_handles) = establish_authenticated_handle(
            connection,
            auth_method,
            events.clone(),
            Arc::new(self.db.pool().clone()),
            keep_alive,
            force_accept_host_key,
            None,
            jumps,
        )
        .await?;
        let session = Arc::new(session);

        // Bind before reporting success, so a port clash is a clear immediate error.
        let listener = tokio::net::TcpListener::bind((bind_host, local_port))
            .await
            .map_err(|e| anyhow!("Could not bind {}:{}: {}", bind_host, local_port, e))?;
        // Resolve the actual port (in case local_port was 0 = "pick one").
        let local_port = listener
            .local_addr()
            .map(|a| a.port())
            .unwrap_or(local_port);

        let forward_id = Uuid::new_v4().to_string();
        let info = PortForwardInfo {
            id: forward_id.clone(),
            connection_id: connection_id.to_string(),
            bind_host: bind_host.to_string(),
            local_port,
            remote_host: remote_host.to_string(),
            remote_port,
        };

        // Accept loop: one direct-tcpip channel + byte pump per accepted connection.
        let task_session = session.clone();
        let remote_host_owned = remote_host.to_string();
        let accept_task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((mut socket, _peer)) => {
                        let s = task_session.clone();
                        let rh = remote_host_owned.clone();
                        tokio::spawn(async move {
                            match s
                                .channel_open_direct_tcpip(
                                    rh.clone(),
                                    remote_port as u32,
                                    "127.0.0.1",
                                    0,
                                )
                                .await
                            {
                                Ok(channel) => {
                                    let mut stream = channel.into_stream();
                                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream)
                                        .await;
                                }
                                Err(e) => tracing::warn!(
                                    "[terminal.rs] forward: channel to {}:{} failed: {}",
                                    rh,
                                    remote_port,
                                    e
                                ),
                            }
                        });
                    }
                    Err(e) => {
                        tracing::warn!("[terminal.rs] forward: accept error: {}", e);
                        break;
                    }
                }
            }
        });

        self.forwards.lock().await.insert(
            forward_id,
            PortForward {
                info: info.clone(),
                accept_task,
                _session: session,
                _jump_handles: jump_handles,
            },
        );
        tracing::info!(
            "[terminal.rs] Local forward {}:{} → {}:{} started",
            info.bind_host,
            info.local_port,
            info.remote_host,
            info.remote_port
        );
        Ok(info)
    }

    /// Stop a running port forward (aborts the accept loop; the tunnel session drops).
    pub async fn stop_forward(&self, forward_id: &str) -> Result<()> {
        if let Some(fwd) = self.forwards.lock().await.remove(forward_id) {
            fwd.accept_task.abort();
            tracing::info!("[terminal.rs] Forward {} stopped", forward_id);
        }
        Ok(())
    }

    /// List all running port forwards.
    pub async fn list_forwards(&self) -> Vec<PortForwardInfo> {
        self.forwards
            .lock()
            .await
            .values()
            .map(|f| f.info.clone())
            .collect()
    }

    /// Run a pre-connect hook: a one-shot local command executed (in a PTY) before
    /// the ssh session opens. The returned session streams the command's output and
    /// emits `terminal-exit` with its exit code — the caller opens ssh only on 0.
    pub async fn run_preconnect(&self, events: SharedEvents, command: String) -> Result<SessionId> {
        tracing::info!("[terminal.rs] run_preconnect called");

        let local_session =
            crate::local_terminal::LocalSession::run_command(events, command).await?;
        let session_id = local_session.id.clone();
        tracing::info!("[terminal.rs] Pre-connect session created: {}", session_id);

        let session = Session::Local(local_session);
        let mut sessions = self.sessions.lock().await;
        sessions.insert(session_id.clone(), session);

        Ok(session_id)
    }

    /// Run a one-shot command on a saved connection (vault path) and return its output.
    /// Agentless machine-dashboard detection (`docker ps`, `systemctl …`): decrypts the
    /// connection like `create_session`, follows its jump chain, execs over its own
    /// short-lived channel, and never registers an interactive session.
    pub async fn run_remote_command(
        &self,
        connection_id: &str,
        events: SharedEvents,
        command: &str,
    ) -> Result<RemoteCommandOutput> {
        let (connection, auth_method) = self.resolve_saved(connection_id).await?;
        let jumps = self.resolve_jump_chain(connection.jump.as_deref()).await?;
        exec_remote_command(
            &connection,
            &auth_method,
            events,
            Arc::new(self.db.pool().clone()),
            &jumps,
            false, // saved connection → verify the host key
            command,
        )
        .await
    }

    /// Run a one-shot command on an ad-hoc (accounts client-execute) target: the caller
    /// already decrypted it in the browser. Host key is accepted (mirrors quick SSH);
    /// jump chain is not carried on this path yet (deferred, like quick-ssh).
    pub async fn run_quick_remote_command(
        &self,
        connection: Connection,
        auth_method: AuthMethod,
        events: SharedEvents,
        command: &str,
        jumps: &[(Connection, AuthMethod)],
    ) -> Result<RemoteCommandOutput> {
        exec_remote_command(
            &connection,
            &auth_method,
            events,
            Arc::new(self.db.pool().clone()),
            jumps,
            true, // ad-hoc → accept the host key like quick SSH
            command,
        )
        .await
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
        jumps: Vec<(Connection, AuthMethod)>,
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
            // Quick SSH proper passes an empty chain; the accounts path passes the
            // hops it decrypted client-side, since the server holds no record of them.
            jumps,
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
