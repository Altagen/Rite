//! Server-mode accounts, authentication and sessions (ADR 0010).
//!
//! Only used when rite-server runs in server mode. The server **never sees the
//! password**: the client derives an auth hash from `Argon2id(password, salt,
//! params)` and sends only that; the server stores an Argon2id *verifier of the
//! auth hash*. Sessions are opaque bearer tokens; only their SHA-256 is stored.

use anyhow::{Result, anyhow};
use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use rite_crypto::generate_salt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

/// Session lifetime.
const SESSION_TTL_SECS: i64 = 60 * 60 * 24 * 7; // 7 days

/// Account role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    User,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::User => "user",
        }
    }
    fn parse(s: &str) -> Role {
        match s {
            "admin" => Role::Admin,
            _ => Role::User,
        }
    }
}

/// A server account (never carries the verifier or vault key).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    pub role: Role,
    pub status: String,
    pub created_at: i64,
}

/// Argon2id parameters the client uses to derive its auth hash.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub mem: u32,  // memory in KiB
    pub iter: u32, // iterations
    pub par: u32,  // parallelism
}

impl KdfParams {
    /// OWASP-recommended Argon2id baseline.
    pub fn recommended() -> Self {
        KdfParams {
            mem: 19_456,
            iter: 2,
            par: 1,
        }
    }
}

/// What `prelogin` returns so the client can derive its auth hash.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreloginInfo {
    pub salt: String, // hex-encoded
    pub params: KdfParams,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Result<Vec<u8>> {
    if s.len() % 2 != 0 {
        return Err(anyhow!("odd-length hex"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| anyhow!("bad hex: {e}")))
        .collect()
}

/// Argon2id verifier (PHC string) of the client-supplied auth hash.
fn hash_auth(auth_hash: &str) -> Result<String> {
    let salt = generate_salt();
    let salt_string = SaltString::encode_b64(&salt).map_err(|e| anyhow!("salt: {e}"))?;
    Ok(Argon2::default()
        .hash_password(auth_hash.as_bytes(), &salt_string)
        .map_err(|e| anyhow!("hash: {e}"))?
        .to_string())
}

fn verify_auth(auth_hash: &str, verifier: &str) -> bool {
    match PasswordHash::new(verifier) {
        Ok(parsed) => Argon2::default()
            .verify_password(auth_hash.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

fn token_hash(token: &str) -> String {
    to_hex(&Sha256::digest(token.as_bytes()))
}

/// True once at least one account exists (used to gate bootstrap).
pub async fn has_any_user(db: &SqlitePool) -> Result<bool> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(db)
        .await?;
    Ok(count > 0)
}

/// Create an account. `salt` is the client KDF salt; `auth_hash` is the client's
/// derived hash (never the password).
pub async fn create_user(
    db: &SqlitePool,
    username: &str,
    salt: &[u8],
    params: KdfParams,
    auth_hash: &str,
    role: Role,
) -> Result<User> {
    let id = Uuid::new_v4().to_string();
    let verifier = hash_auth(auth_hash)?;
    let ts = now();
    sqlx::query(
        "INSERT INTO users (id, username, kdf_salt, kdf_mem, kdf_iter, kdf_par, auth_verifier, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
    )
    .bind(&id)
    .bind(username)
    .bind(salt)
    .bind(params.mem as i64)
    .bind(params.iter as i64)
    .bind(params.par as i64)
    .bind(&verifier)
    .bind(role.as_str())
    .bind(ts)
    .bind(ts)
    .execute(db)
    .await?;

    Ok(User {
        id,
        username: username.to_string(),
        role,
        status: "active".to_string(),
        created_at: ts,
    })
}

/// Derive the client-equivalent Argon2id auth hash (hex) from a plaintext
/// password. This MUST match the browser's `hash-wasm` derivation (same
/// algorithm + params + salt) so that a later browser login verifies against the
/// stored verifier. Used only by the env-based admin bootstrap — the interactive
/// first-run stays zero-knowledge (the server never sees the password there).
pub fn derive_auth_hash(password: &str, salt: &[u8], params: KdfParams) -> Result<String> {
    let p = argon2::Params::new(params.mem, params.iter, params.par, Some(32))
        .map_err(|e| anyhow!("argon2 params: {e}"))?;
    let argon = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, p);
    let mut out = [0u8; 32];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| anyhow!("argon2 derive: {e}"))?;
    Ok(to_hex(&out))
}

/// Create the first admin from a plaintext password (server-side derivation).
/// For the non-interactive env bootstrap of a headless deploy.
pub async fn bootstrap_admin(db: &SqlitePool, username: &str, password: &str) -> Result<()> {
    let salt = generate_salt();
    let params = KdfParams::recommended();
    let auth_hash = derive_auth_hash(password, &salt, params)?;
    create_user(db, username, &salt, params, &auth_hash, Role::Admin).await?;
    Ok(())
}

/// KDF salt + params for a username. Unknown users get stable benign defaults
/// (derived from the username) so responses don't reveal whether an account
/// exists.
pub async fn prelogin(db: &SqlitePool, username: &str) -> Result<PreloginInfo> {
    let row: Option<(Vec<u8>, i64, i64, i64)> =
        sqlx::query_as("SELECT kdf_salt, kdf_mem, kdf_iter, kdf_par FROM users WHERE username = ?")
            .bind(username)
            .fetch_optional(db)
            .await?;

    Ok(match row {
        Some((salt, mem, iter, par)) => PreloginInfo {
            salt: to_hex(&salt),
            params: KdfParams {
                mem: mem as u32,
                iter: iter as u32,
                par: par as u32,
            },
        },
        None => PreloginInfo {
            // Deterministic decoy salt from the username — stable across calls,
            // indistinguishable from a real one.
            salt: to_hex(&Sha256::digest(username.as_bytes())[..16]),
            params: KdfParams::recommended(),
        },
    })
}

/// A fixed verifier used to equalise login timing for unknown users (so response
/// time can't reveal whether an account exists). Computed once.
fn timing_equaliser() -> &'static str {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DUMMY.get_or_init(|| hash_auth("rite-timing-equaliser").unwrap_or_default())
}

/// Verify a login. Returns the user on success (active accounts only). Runs one
/// Argon2 verify on every path (including unknown/disabled users) so it does not
/// leak account existence via timing.
pub async fn verify_login(
    db: &SqlitePool,
    username: &str,
    auth_hash: &str,
) -> Result<Option<User>> {
    let row: Option<(String, String, String, String, i64)> = sqlx::query_as(
        "SELECT id, auth_verifier, role, status, created_at FROM users WHERE username = ?",
    )
    .bind(username)
    .fetch_optional(db)
    .await?;

    let Some((id, verifier, role, status, created_at)) = row else {
        // Unknown user: still spend a verify against a dummy, then fail.
        verify_auth(auth_hash, timing_equaliser());
        return Ok(None);
    };

    // Always run verify (no short-circuit) so disabled users cost the same.
    let ok = verify_auth(auth_hash, &verifier);
    if status != "active" || !ok {
        return Ok(None);
    }
    Ok(Some(User {
        id,
        username: username.to_string(),
        role: Role::parse(&role),
        status,
        created_at,
    }))
}

/// Open a session for a user; returns the opaque bearer token (only its hash is
/// stored).
pub async fn create_session(db: &SqlitePool, user_id: &str) -> Result<String> {
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let ts = now();
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(token_hash(&token))
    .bind(user_id)
    .bind(ts)
    .bind(ts + SESSION_TTL_SECS)
    .bind(ts)
    .execute(db)
    .await?;
    Ok(token)
}

/// Resolve a session token to its user, if valid and unexpired. Bumps last_seen.
pub async fn validate_session(db: &SqlitePool, token: &str) -> Result<Option<User>> {
    let hash = token_hash(token);
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?")
            .bind(&hash)
            .fetch_optional(db)
            .await?;

    let Some((user_id, expires_at)) = row else {
        return Ok(None);
    };
    if now() >= expires_at {
        // Expired: drop it.
        let _ = sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(&hash)
            .execute(db)
            .await;
        return Ok(None);
    }

    let user: Option<(String, String, String, String, i64)> =
        sqlx::query_as("SELECT id, username, role, status, created_at FROM users WHERE id = ?")
            .bind(&user_id)
            .fetch_optional(db)
            .await?;
    let Some((id, username, role, status, created_at)) = user else {
        return Ok(None);
    };
    if status != "active" {
        return Ok(None);
    }

    let _ = sqlx::query("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
        .bind(now())
        .bind(&hash)
        .execute(db)
        .await;

    Ok(Some(User {
        id,
        username,
        role: Role::parse(&role),
        status,
        created_at,
    }))
}

/// Revoke a session (logout).
pub async fn revoke_session(db: &SqlitePool, token: &str) -> Result<()> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
        .bind(token_hash(token))
        .execute(db)
        .await?;
    Ok(())
}

/// All accounts (admin surface, phase 3).
pub async fn list_users(db: &SqlitePool) -> Result<Vec<User>> {
    let rows: Vec<(String, String, String, String, i64)> = sqlx::query_as(
        "SELECT id, username, role, status, created_at FROM users ORDER BY created_at",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, username, role, status, created_at)| User {
            id,
            username,
            role: Role::parse(&role),
            status,
            created_at,
        })
        .collect())
}

/// Enable/disable an account. Disabling also drops its live sessions. Returns
/// `true` if a user was affected.
pub async fn set_user_status(db: &SqlitePool, user_id: &str, status: &str) -> Result<bool> {
    let affected = sqlx::query("UPDATE users SET status = ?, updated_at = ? WHERE id = ?")
        .bind(status)
        .bind(now())
        .bind(user_id)
        .execute(db)
        .await?
        .rows_affected();
    if status != "active" {
        sqlx::query("DELETE FROM sessions WHERE user_id = ?")
            .bind(user_id)
            .execute(db)
            .await?;
    }
    Ok(affected > 0)
}

/// Delete an account (its sessions cascade). Returns `true` if it existed.
pub async fn delete_user(db: &SqlitePool, user_id: &str) -> Result<bool> {
    let affected = sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(user_id)
        .execute(db)
        .await?
        .rows_affected();
    Ok(affected > 0)
}

pub fn parse_hex_salt(s: &str) -> Result<Vec<u8>> {
    from_hex(s)
}
