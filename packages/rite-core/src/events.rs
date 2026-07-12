//! Session event sink.
//!
//! rite-core runs terminal/SSH sessions but must not know how their output
//! reaches a UI. It emits through this trait; the shell provides the transport:
//! the Tauri app implements it with `app_handle.emit(...)`, and rite-server will
//! implement it with a WebSocket. `terminal_data` receives raw bytes — the sink
//! decides the wire encoding (the Tauri sink base64-encodes for its JSON event).

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
