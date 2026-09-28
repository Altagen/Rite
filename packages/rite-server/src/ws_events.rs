//! WebSocket implementation of rite-core's `SessionEvents`.
//!
//! rite-core emits session/host-key events through the `SessionEvents` trait,
//! and this broadcasts them to every connected WebSocket client as
//! `{ "event": <name>, "payload": {...} }` JSON — the exact shapes the React
//! frontend consumes, so one frontend works over HTTP+WS everywhere.

use async_trait::async_trait;
use base64::Engine as _;
use rite_core::events::{InteractiveAuth, KbdPrompt, SessionEvents};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, oneshot};

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

/// A keyboard-interactive challenge awaiting the client's answer.
pub struct KbdPending {
    /// The user who triggered the connect — only they may answer.
    pub owner: String,
    pub tx: oneshot::Sender<Option<Vec<String>>>,
}

/// Pending keyboard-interactive challenges, keyed by a random challenge id.
pub type KbdRegistry = Arc<Mutex<HashMap<String, KbdPending>>>;

/// Bridges rite-core's keyboard-interactive prompts to the connecting client over
/// the WebSocket: broadcast the challenge (with a random id), then await the
/// answers the client POSTs back to `/api/ssh/kbd-interactive/respond`.
pub struct WsInteractiveAuth {
    tx: broadcast::Sender<String>,
    registry: KbdRegistry,
    owner: String,
}

impl WsInteractiveAuth {
    pub fn new(tx: broadcast::Sender<String>, registry: KbdRegistry, owner: String) -> Self {
        Self {
            tx,
            registry,
            owner,
        }
    }
}

#[async_trait]
impl InteractiveAuth for WsInteractiveAuth {
    async fn keyboard_interactive(
        &self,
        name: &str,
        instructions: &str,
        prompts: &[KbdPrompt],
    ) -> Option<Vec<String>> {
        let challenge_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.registry.lock().unwrap().insert(
            challenge_id.clone(),
            KbdPending {
                owner: self.owner.clone(),
                tx,
            },
        );

        let prompts_json: Vec<_> = prompts
            .iter()
            .map(|p| json!({ "prompt": p.prompt, "echo": p.echo }))
            .collect();
        let msg = json!({
            "event": "ssh:kbd-interactive",
            "payload": {
                "challengeId": challenge_id,
                "name": name,
                "instructions": instructions,
                "prompts": prompts_json,
            }
        })
        .to_string();
        let _ = self.tx.send(msg);

        // Await the client's answer; a lost or ignored challenge must not hang the
        // connect forever.
        let result = tokio::time::timeout(std::time::Duration::from_secs(120), rx).await;
        // Drop any leftover entry (timeout, or the receiver went away).
        self.registry.lock().unwrap().remove(&challenge_id);
        match result {
            Ok(Ok(answers)) => answers, // Some(answers), or None if the user cancelled
            _ => None,                  // timed out or the sender was dropped
        }
    }
}
