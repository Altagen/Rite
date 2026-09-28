//! The implicit local user (ADR 0018).
//!
//! A local vault has no accounts: the master password is the only credential, and
//! there is no login, no session and no prelogin. Collections, however, are *owned* —
//! `collection_members.user_id` is a real foreign key into `users`, and sqlx turns
//! foreign keys on, so ownership cannot be faked with a dangling id.
//!
//! So a vault materialises exactly one row to own its collections. It is deliberately
//! not a server account: the authentication columns hold sentinels because nothing
//! ever reads them (no code path can log this user in), and its collection keys are
//! wrapped with the vault's master key rather than sealed to a public key, since
//! there is nobody to seal to. Whoever holds the master password *is* this user.

use anyhow::Result;
use sqlx::SqlitePool;

/// The single local owner. A fixed id rather than a UUID: there is only ever one
/// per vault, and a readable id makes a local `.db` easy to reason about.
pub const LOCAL_USER_ID: &str = "local";

/// Ensure the local owner exists. Idempotent — safe to call on every unlock.
pub async fn ensure(db: &SqlitePool) -> Result<()> {
    let ts = chrono::Utc::now().timestamp();
    // Sentinels, not credentials: a local vault authenticates with its master
    // password (the `master_password` table), never through these columns.
    sqlx::query(
        "INSERT OR IGNORE INTO users \
         (id, username, kdf_salt, kdf_mem, kdf_iter, kdf_par, auth_verifier, role, status, created_at, updated_at) \
         VALUES (?, 'local', X'', 0, 0, 0, '', 'admin', 'active', ?, ?)",
    )
    .bind(LOCAL_USER_ID)
    .bind(ts)
    .bind(ts)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    async fn db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::new(&dir.path().join("t.db")).await.unwrap();
        (dir, db)
    }

    #[tokio::test]
    async fn ensure_is_idempotent() {
        let (_d, db) = db().await;
        ensure(db.pool()).await.unwrap();
        ensure(db.pool()).await.unwrap();
        let n: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert_eq!(n.0, 1, "the local owner must be a single row");
    }

    /// The point of the row: collection ownership is a real foreign key, so without
    /// it a local collection cannot be created at all.
    #[tokio::test]
    async fn collection_ownership_requires_the_row() {
        let (_d, db) = db().await;
        let unowned = crate::collection_store::create_collection(
            db.pool(),
            "v1.x.y",
            LOCAL_USER_ID,
            "v1.a.b",
            "v1.c.d",
        )
        .await;
        assert!(
            unowned.is_err(),
            "a dangling owner must be rejected by the foreign key"
        );

        ensure(db.pool()).await.unwrap();
        crate::collection_store::create_collection(
            db.pool(),
            "v1.x.y",
            LOCAL_USER_ID,
            "v1.a.b",
            "v1.c.d",
        )
        .await
        .expect("with the owner present the collection is created");
    }
}
