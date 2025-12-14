/// Pending Host Keys Manager
///
/// Manages temporary acceptance of unknown SSH host keys in strict mode

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
pub struct PendingHostKeyInfo {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key_data: Vec<u8>,
}

/// Manager for pending host key acceptances
#[derive(Clone)]
pub struct PendingHostKeysManager {
    /// Map of (host, port) -> PendingHostKeyInfo
    pending: Arc<RwLock<HashMap<(String, u16), PendingHostKeyInfo>>>,
    /// Map of (host, port) -> accepted (with timestamp)
    accepted: Arc<RwLock<HashMap<(String, u16), std::time::Instant>>>,
}

impl PendingHostKeysManager {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(RwLock::new(HashMap::new())),
            accepted: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Add a pending host key
    pub async fn add_pending(&self, info: PendingHostKeyInfo) {
        let key = (info.host.clone(), info.port);
        let mut pending = self.pending.write().await;
        pending.insert(key, info);
    }

    /// Mark a host key as accepted temporarily (30 seconds TTL)
    pub async fn accept(&self, host: &str, port: u16) -> Option<PendingHostKeyInfo> {
        let key = (host.to_string(), port);

        // Get the pending info
        let mut pending = self.pending.write().await;
        let info = pending.remove(&key)?;

        // Add to accepted with timestamp
        let mut accepted = self.accepted.write().await;
        accepted.insert(key, std::time::Instant::now());

        Some(info)
    }

    /// Check if a host key is temporarily accepted (and not expired)
    pub async fn is_accepted(&self, host: &str, port: u16) -> bool {
        let key = (host.to_string(), port);
        let mut accepted = self.accepted.write().await;

        if let Some(timestamp) = accepted.get(&key) {
            // Check if still valid (30 seconds TTL)
            if timestamp.elapsed().as_secs() < 30 {
                return true;
            } else {
                // Expired, remove it
                accepted.remove(&key);
            }
        }

        false
    }

    /// Remove a pending host key (when rejected)
    pub async fn reject(&self, host: &str, port: u16) {
        let key = (host.to_string(), port);
        let mut pending = self.pending.write().await;
        pending.remove(&key);
    }

    /// Clean up expired acceptances
    pub async fn cleanup_expired(&self) {
        let mut accepted = self.accepted.write().await;
        accepted.retain(|_, timestamp| timestamp.elapsed().as_secs() < 30);
    }
}
