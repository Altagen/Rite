/**
 * Known Hosts Module
 *
 * Manages SSH server host key verification for MITM protection
 */
use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use russh::keys::key::PublicKey;
use russh_keys::PublicKeyBase64;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownHost {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key_data: Vec<u8>,
    pub added_at: i64,
    pub last_seen_at: i64,
}

/// Result of host key verification
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status")]
pub enum HostKeyVerificationResult {
    /// Host is known and key matches
    #[serde(rename = "accepted")]
    Accepted,
    /// Host is unknown (first connection)
    #[serde(rename = "unknown")]
    Unknown {
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
    },
    /// Host is known but key has changed (potential MITM attack)
    #[serde(rename = "changed")]
    Changed {
        host: String,
        port: u16,
        key_type: String,
        old_fingerprint: String,
        new_fingerprint: String,
    },
}

/// Get current Unix timestamp in seconds
fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// Calculate SHA256 fingerprint of a public key
fn calculate_fingerprint(public_key: &PublicKey) -> Result<String> {
    use sha2::{Digest, Sha256};

    // Serialize public key to bytes
    let key_bytes = public_key.public_key_bytes();

    // Calculate SHA256 hash
    let mut hasher = Sha256::new();
    hasher.update(&key_bytes);
    let hash = hasher.finalize();

    // Format as SHA256:base64 (standard SSH fingerprint format)
    Ok(format!("SHA256:{}", BASE64.encode(hash)))
}

/// Get the key type string from a PublicKey
fn get_key_type(public_key: &PublicKey) -> String {
    public_key.name().to_string()
}

/// Verify a server's host key
pub async fn verify_host_key(
    db: &SqlitePool,
    host: &str,
    port: u16,
    server_public_key: &PublicKey,
) -> Result<HostKeyVerificationResult> {
    tracing::info!("[known_hosts] Verifying host key for {}:{}", host, port);

    let fingerprint = calculate_fingerprint(server_public_key)?;
    let key_type = get_key_type(server_public_key);

    // Check if host is already known
    let existing = sqlx::query_as::<_, (String, String, Vec<u8>)>(
        "SELECT id, fingerprint, public_key_data FROM known_hosts WHERE host = ? AND port = ?",
    )
    .bind(host)
    .bind(port as i64)
    .fetch_optional(db)
    .await?;

    match existing {
        Some((id, old_fingerprint, _old_key_data)) => {
            // Host is known, check if key matches
            if fingerprint == old_fingerprint {
                // Key matches, update last_seen_at
                tracing::info!("[known_hosts] Host key verified successfully");
                update_last_seen(db, &id).await?;
                Ok(HostKeyVerificationResult::Accepted)
            } else {
                // Key has changed - potential MITM attack!
                tracing::warn!("[known_hosts] HOST KEY CHANGED for {}:{}", host, port);
                tracing::warn!("[known_hosts] Old fingerprint: {}", old_fingerprint);
                tracing::warn!("[known_hosts] New fingerprint: {}", fingerprint);
                Ok(HostKeyVerificationResult::Changed {
                    host: host.to_string(),
                    port,
                    key_type,
                    old_fingerprint,
                    new_fingerprint: fingerprint,
                })
            }
        }
        None => {
            // Host is unknown (first connection)
            tracing::info!("[known_hosts] Unknown host {}:{}", host, port);
            Ok(HostKeyVerificationResult::Unknown {
                host: host.to_string(),
                port,
                key_type,
                fingerprint,
            })
        }
    }
}

/// Add or update a host key (after user confirmation)
pub async fn add_host_key(
    db: &SqlitePool,
    host: &str,
    port: u16,
    server_public_key: &PublicKey,
) -> Result<()> {
    tracing::info!(
        "[known_hosts] Adding/updating host key for {}:{}",
        host,
        port
    );

    let fingerprint = calculate_fingerprint(server_public_key)?;
    let key_type = get_key_type(server_public_key);
    let public_key_data = server_public_key.public_key_bytes();
    let now = current_timestamp();

    // Delete existing entry if any (REPLACE doesn't work with UNIQUE constraint)
    sqlx::query("DELETE FROM known_hosts WHERE host = ? AND port = ?")
        .bind(host)
        .bind(port as i64)
        .execute(db)
        .await?;

    // Insert new entry
    sqlx::query(
        "INSERT INTO known_hosts (id, host, port, key_type, fingerprint, public_key_data, added_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(Uuid::new_v4().to_string())
    .bind(host)
    .bind(port as i64)
    .bind(key_type)
    .bind(fingerprint)
    .bind(&public_key_data)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;

    tracing::info!("[known_hosts] Host key added successfully");
    Ok(())
}

/// Update last_seen_at timestamp for a known host
async fn update_last_seen(db: &SqlitePool, id: &str) -> Result<()> {
    let now = current_timestamp();
    sqlx::query("UPDATE known_hosts SET last_seen_at = ? WHERE id = ?")
        .bind(now)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Remove a host key from known_hosts
pub async fn remove_host_key(db: &SqlitePool, host: &str, port: u16) -> Result<()> {
    tracing::info!("[known_hosts] Removing host key for {}:{}", host, port);

    sqlx::query("DELETE FROM known_hosts WHERE host = ? AND port = ?")
        .bind(host)
        .bind(port as i64)
        .execute(db)
        .await?;

    Ok(())
}

/// List all known hosts
pub async fn list_known_hosts(db: &SqlitePool) -> Result<Vec<KnownHost>> {
    let rows = sqlx::query_as::<_, (String, String, i64, String, String, Vec<u8>, i64, i64)>(
        "SELECT id, host, port, key_type, fingerprint, public_key_data, added_at, last_seen_at
         FROM known_hosts ORDER BY host, port",
    )
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(id, host, port, key_type, fingerprint, public_key_data, added_at, last_seen_at)| {
                KnownHost {
                    id,
                    host,
                    port: port as u16,
                    key_type,
                    fingerprint,
                    public_key_data,
                    added_at,
                    last_seen_at,
                }
            },
        )
        .collect())
}
