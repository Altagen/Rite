//! Session event sink.
//!
//! rite-core runs terminal/SSH sessions but must not know how their output
//! reaches a UI. It emits through this trait; the shell provides the transport:
//! rite-server implements it by broadcasting over a WebSocket. `terminal_data`
//! receives raw bytes — the sink decides the wire encoding (the WS sink
//! base64-encodes for its JSON event).

use std::sync::Arc;

pub trait SessionEvents: Send + Sync {
    /// Output bytes from a session (SSH channel data or local PTY output).
    fn terminal_data(&self, session_id: &str, data: &[u8]);
    /// The remote process/shell reported an exit status.
    fn terminal_exit(&self, session_id: &str, exit_status: u32);
    /// The session ended (EOF / closed).
    fn terminal_closed(&self, session_id: &str);
    /// A fatal error while starting or running the session.
    fn terminal_error(&self, session_id: &str, error: &str);
    /// A keep-alive/heartbeat failed; the connection is presumed dead.
    fn connection_dead(&self, session_id: &str, reason: &str);

    /// First connection to an unknown host (strict mode asks the user).
    fn host_key_unknown(&self, host: &str, port: u16, key_type: &str, fingerprint: &str);
    /// A host key was accepted and saved (warn/accept mode).
    fn host_key_added(&self, host: &str, port: u16, key_type: &str, fingerprint: &str);
    /// A known host presented a different key — potential MITM.
    fn host_key_changed(&self, host: &str, port: u16, old_fingerprint: &str, new_fingerprint: &str);
}

/// Shared, transport-agnostic events sink.
pub type SharedEvents = Arc<dyn SessionEvents>;

/// A single keyboard-interactive prompt from the server (RFC 4256).
#[derive(Debug, Clone)]
pub struct KbdPrompt {
    /// The text the server wants shown, e.g. "Verification code:".
    pub prompt: String,
    /// Whether the typed characters should be visible (usernames) or hidden
    /// (passwords, OTPs). Rite masks the field when this is false.
    pub echo: bool,
}

/// Collects answers to a server-driven keyboard-interactive challenge (2FA /
/// OTP / PAM). rite-core runs the auth exchange but can't reach a UI; the shell
/// implements this (rite-server bridges it to the client over the WebSocket).
/// A password Rite already holds is auto-answered before this is ever called,
/// so it only fires for things Rite can't know (a one-time code, a live prompt).
#[async_trait::async_trait]
pub trait InteractiveAuth: Send + Sync {
    /// Return exactly one answer per prompt, or `None` to abort the connection.
    async fn keyboard_interactive(
        &self,
        name: &str,
        instructions: &str,
        prompts: &[KbdPrompt],
    ) -> Option<Vec<String>>;
}

/// Shared, transport-agnostic keyboard-interactive prompt provider.
pub type SharedInteractive = Arc<dyn InteractiveAuth>;
