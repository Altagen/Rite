//! Tauri implementation of rite-core's `SessionEvents`.
//!
//! Forwards terminal-session and SSH host-key events to the frontend via
//! `app_handle.emit(...)`, preserving the exact event names and JSON payload
//! shapes the React frontend listens for. rite-core stays transport-agnostic;
//! this is the desktop shell's transport.

use base64::Engine as _;
use rite_core::events::SessionEvents;
use tauri::{AppHandle, Emitter};

pub struct TauriSessionEvents {
    app_handle: AppHandle,
}

impl TauriSessionEvents {
    pub fn new(app_handle: AppHandle) -> Self {
        Self { app_handle }
    }
}

impl SessionEvents for TauriSessionEvents {
    fn terminal_data(&self, session_id: &str, data: &[u8]) {
        let data_base64 = base64::engine::general_purpose::STANDARD.encode(data);
        let _ = self.app_handle.emit(
            "terminal-data",
            serde_json::json!({ "sessionId": session_id, "data": data_base64 }),
        );
    }

    fn terminal_exit(&self, session_id: &str, exit_status: u32) {
        let _ = self.app_handle.emit(
            "terminal-exit",
            serde_json::json!({ "sessionId": session_id, "exitStatus": exit_status }),
        );
    }

    fn terminal_closed(&self, session_id: &str) {
        let _ = self.app_handle.emit(
            "terminal-closed",
            serde_json::json!({ "sessionId": session_id }),
        );
    }

    fn terminal_error(&self, session_id: &str, error: &str) {
        let _ = self.app_handle.emit(
            "terminal-error",
            serde_json::json!({ "sessionId": session_id, "error": error }),
        );
    }

    fn connection_dead(&self, session_id: &str, reason: &str) {
        let _ = self.app_handle.emit(
            "connection-dead",
            serde_json::json!({ "sessionId": session_id, "reason": reason }),
        );
    }

    fn host_key_unknown(&self, host: &str, port: u16, key_type: &str, fingerprint: &str) {
        let _ = self.app_handle.emit(
            "ssh:host-key-unknown",
            serde_json::json!({
                "host": host, "port": port, "keyType": key_type, "fingerprint": fingerprint,
            }),
        );
    }

    fn host_key_added(&self, host: &str, port: u16, key_type: &str, fingerprint: &str) {
        let _ = self.app_handle.emit(
            "ssh:host-key-added",
            serde_json::json!({
                "host": host, "port": port, "keyType": key_type, "fingerprint": fingerprint,
            }),
        );
    }

    fn host_key_changed(
        &self,
        host: &str,
        port: u16,
        old_fingerprint: &str,
        new_fingerprint: &str,
    ) {
        let _ = self.app_handle.emit(
            "ssh:host-key-changed",
            serde_json::json!({
                "host": host, "port": port,
                "oldFingerprint": old_fingerprint, "newFingerprint": new_fingerprint,
            }),
        );
    }
}
