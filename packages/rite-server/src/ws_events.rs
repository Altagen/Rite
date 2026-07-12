//! WebSocket implementation of rite-core's `SessionEvents`.
//!
//! The server counterpart of the desktop `TauriSessionEvents`: rite-core emits
//! session/host-key events through the trait, and this broadcasts them to every
//! connected WebSocket client as `{ "event": <name>, "payload": {...} }` JSON —
//! the exact shapes the React frontend already consumes over Tauri, so one
//! frontend works over either transport.

use base64::Engine as _;
use rite_core::events::SessionEvents;
use serde_json::json;
use tokio::sync::broadcast;

pub struct WsSessionEvents {
    tx: broadcast::Sender<String>,
}

impl WsSessionEvents {
    pub fn new(tx: broadcast::Sender<String>) -> Self {
        Self { tx }
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        let msg = json!({ "event": event, "payload": payload }).to_string();
        // Ignore send errors: no subscribers just means nobody is listening yet.
        let _ = self.tx.send(msg);
    }
}

impl SessionEvents for WsSessionEvents {
    fn terminal_data(&self, session_id: &str, data: &[u8]) {
        let data_base64 = base64::engine::general_purpose::STANDARD.encode(data);
        self.emit(
            "terminal-data",
            json!({ "sessionId": session_id, "data": data_base64 }),
        );
    }

    fn terminal_exit(&self, session_id: &str, exit_status: u32) {
        self.emit(
            "terminal-exit",
            json!({ "sessionId": session_id, "exitStatus": exit_status }),
        );
    }

    fn terminal_closed(&self, session_id: &str) {
        self.emit("terminal-closed", json!({ "sessionId": session_id }));
    }

    fn terminal_error(&self, session_id: &str, error: &str) {
        self.emit(
            "terminal-error",
            json!({ "sessionId": session_id, "error": error }),
        );
    }

    fn connection_dead(&self, session_id: &str, reason: &str) {
        self.emit(
            "connection-dead",
            json!({ "sessionId": session_id, "reason": reason }),
        );
    }

    fn host_key_unknown(&self, host: &str, port: u16, key_type: &str, fingerprint: &str) {
        self.emit(
            "ssh:host-key-unknown",
            json!({ "host": host, "port": port, "keyType": key_type, "fingerprint": fingerprint }),
        );
    }

    fn host_key_added(&self, host: &str, port: u16, key_type: &str, fingerprint: &str) {
        self.emit(
            "ssh:host-key-added",
            json!({ "host": host, "port": port, "keyType": key_type, "fingerprint": fingerprint }),
        );
    }

    fn host_key_changed(
        &self,
        host: &str,
        port: u16,
        old_fingerprint: &str,
        new_fingerprint: &str,
    ) {
        self.emit(
            "ssh:host-key-changed",
            json!({
                "host": host, "port": port,
                "oldFingerprint": old_fingerprint, "newFingerprint": new_fingerprint,
            }),
        );
    }
}
