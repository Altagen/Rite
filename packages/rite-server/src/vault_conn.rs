//! Multiplexer transform for per-user encrypted connections (ADR 0011 phase 3c).
//!
//! When a remote context is active, the local (trusted) server is the crypto
//! boundary: it fetches the user's opaque ciphertext blobs from the remote's
//! `/api/vault/connections`, decrypts them with the held vault key, and serves
//! plaintext `ConnectionInfo` to the webview over loopback — and encrypts on the
//! way back. The remote only ever sees ciphertext (`v1.iv.ct`). The webview's
//! connection UI is unchanged; the encryption is invisible to it.

use anyhow::{Result, anyhow};
use axum::http::header;
use rite_core::connection::{
    AuthMethod, Connection, ConnectionInfo, ConnectionMetadata, CreateConnectionInput, Protocol,
    UpdateConnectionInput,
};
use rite_crypto::vault;
use serde::Deserialize;

use crate::{RemoteServer, ServerState};

/// Build an in-memory `Connection` (+ its auth) from a decrypted vault record,
/// for client-execute: the local server opens SSH from these creds (ADR 0011 §4).
pub fn to_connection(id: &str, input: CreateConnectionInput) -> Result<(Connection, AuthMethod)> {
    let ts = now();
    let auth = input.auth_method.clone();
    let conn = Connection {
        id: id.to_string(),
        name: input.name,
        protocol: Protocol::from_str(&input.protocol)?,
        hostname: input.hostname,
        port: input.port,
        username: input.username,
        auth_method: input.auth_method,
        metadata: ConnectionMetadata {
            color: input.color,
            icon: input.icon,
            folder: input.folder,
            notes: input.notes,
        },
        ssh_keep_alive_override: input.ssh_keep_alive_override,
        ssh_keep_alive_interval: input.ssh_keep_alive_interval,
        created_at: ts,
        updated_at: ts,
        last_used_at: None,
    };
    Ok((conn, auth))
}

/// A stored blob row as returned by the remote's `/api/vault/connections`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobRow {
    id: String,
    blob: String,
    created_at: i64,
    updated_at: i64,
}

fn auth_type(a: &AuthMethod) -> &'static str {
    match a {
        AuthMethod::Password { .. } => "password",
        AuthMethod::PublicKey { .. } => "publicKey",
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Public helper: `ConnectionInfo` for an updated record (updated_at = now).
pub fn info_for(id: String, input: &CreateConnectionInput, created_at: i64) -> ConnectionInfo {
    to_info(id, input, created_at, now())
}

/// Apply an `UpdateConnectionInput` onto the existing decrypted connection.
pub fn merge_update(mut c: CreateConnectionInput, u: UpdateConnectionInput) -> CreateConnectionInput {
    if let Some(v) = u.name {
        c.name = v;
    }
    if let Some(v) = u.protocol {
        c.protocol = v;
    }
    if let Some(v) = u.hostname {
        c.hostname = v;
    }
    if let Some(v) = u.port {
        c.port = v;
    }
    if let Some(v) = u.username {
        c.username = v;
    }
    if let Some(v) = u.auth_method {
        c.auth_method = v;
    }
    if let Some(v) = u.color {
        c.color = Some(v);
    }
    if let Some(v) = u.icon {
        c.icon = Some(v);
    }
    if let Some(v) = u.folder {
        c.folder = Some(v);
    }
    if let Some(v) = u.notes {
        c.notes = Some(v);
    }
    // Nested Option: outer Some = the field was provided (inner may be None = clear).
    if let Some(v) = u.ssh_keep_alive_override {
        c.ssh_keep_alive_override = v;
    }
    if let Some(v) = u.ssh_keep_alive_interval {
        c.ssh_keep_alive_interval = v;
    }
    c
}

/// Build the frontend-safe `ConnectionInfo` from a decrypted input + row id/times.
fn to_info(id: String, input: &CreateConnectionInput, created_at: i64, updated_at: i64) -> ConnectionInfo {
    ConnectionInfo {
        id,
        name: input.name.clone(),
        protocol: input.protocol.clone(),
        hostname: input.hostname.clone(),
        port: input.port,
        username: input.username.clone(),
        auth_type: auth_type(&input.auth_method).to_string(),
        color: input.color.clone(),
        icon: input.icon.clone(),
        folder: input.folder.clone(),
        notes: input.notes.clone(),
        ssh_keep_alive_override: input.ssh_keep_alive_override.clone(),
        ssh_keep_alive_interval: input.ssh_keep_alive_interval,
        created_at,
        updated_at,
        last_used_at: None,
    }
}

fn remote_token(state: &ServerState) -> Result<String> {
    state
        .remote_token()
        .ok_or_else(|| anyhow!("no remote session"))
}

/// GET the user's blobs from the remote and decrypt them (with secrets).
/// Returns `(id, input, created_at, updated_at)` newest-first.
pub async fn list_raw(
    state: &ServerState,
    server: &RemoteServer,
    key: &[u8; 32],
) -> Result<Vec<(String, CreateConnectionInput, i64, i64)>> {
    let token = remote_token(state)?;
    let rows: Vec<BlobRow> = state
        .http_client()
        .get(format!("{}/api/vault/connections", server.url))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let pt = vault::decrypt_string(key, &r.blob)?;
        let input: CreateConnectionInput = serde_json::from_slice(&pt)?;
        out.push((r.id, input, r.created_at, r.updated_at));
    }
    Ok(out)
}

/// Fetch and decrypt a single connection by id (with its secrets) for
/// client-execute (ADR 0011 phase 4). `None` if the user has no such connection.
pub async fn get_input(
    state: &ServerState,
    server: &RemoteServer,
    key: &[u8; 32],
    id: &str,
) -> Result<Option<CreateConnectionInput>> {
    Ok(list_raw(state, server, key)
        .await?
        .into_iter()
        .find(|(cid, ..)| cid == id)
        .map(|(_, input, ..)| input))
}

/// GET the user's blobs and decrypt them to frontend-safe `ConnectionInfo`.
pub async fn list(
    state: &ServerState,
    server: &RemoteServer,
    key: &[u8; 32],
) -> Result<Vec<ConnectionInfo>> {
    Ok(list_raw(state, server, key)
        .await?
        .into_iter()
        .map(|(id, input, created, updated)| to_info(id, &input, created, updated))
        .collect())
}

/// Encrypt a new connection and POST the blob to the remote.
pub async fn create(
    state: &ServerState,
    server: &RemoteServer,
    key: &[u8; 32],
    input: &CreateConnectionInput,
) -> Result<ConnectionInfo> {
    let blob = vault::encrypt_string(key, &serde_json::to_vec(input)?)?;
    let token = remote_token(state)?;
    let row: BlobRow = state
        .http_client()
        .post(format!("{}/api/vault/connections", server.url))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({ "blob": blob }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(to_info(row.id, input, row.created_at, row.updated_at))
}

/// Re-encrypt a connection and PUT the blob to the remote.
pub async fn update(
    state: &ServerState,
    server: &RemoteServer,
    key: &[u8; 32],
    id: &str,
    input: &CreateConnectionInput,
) -> Result<()> {
    let blob = vault::encrypt_string(key, &serde_json::to_vec(input)?)?;
    let token = remote_token(state)?;
    state
        .http_client()
        .put(format!("{}/api/vault/connections/{id}", server.url))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({ "blob": blob }))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

/// DELETE a connection blob on the remote.
pub async fn delete(state: &ServerState, server: &RemoteServer, id: &str) -> Result<()> {
    let token = remote_token(state)?;
    state
        .http_client()
        .delete(format!("{}/api/vault/connections/{id}", server.url))
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}
