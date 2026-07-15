//! Per-user zero-knowledge connection store (ADR 0011 phase 3).
//!
//! A shared server keeps each user's connections as an opaque client-encrypted
//! blob (`v1.iv.ct`, AES-256-GCM under the user's vault key). Every row is scoped
//! by `user_id`; the server never parses `blob`, so it cannot read the host,
//! credentials, or even the connection name — true zero-knowledge + per-user
//! isolation. The client (the trusted local server, or a browser vault) does all
//! encryption/decryption. Separate from the single-vault `connections` table.

use anyhow::Result;
use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

/// One stored connection blob (the plaintext lives only client-side).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultConnection {
    pub id: String,
    pub blob: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// List a user's connection blobs, newest first.
pub async fn list(db: &SqlitePool, user_id: &str) -> Result<Vec<VaultConnection>> {
    let rows: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT id, blob, created_at, updated_at FROM vault_connections
         WHERE user_id = ? ORDER BY created_at DESC",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, blob, created_at, updated_at)| VaultConnection {
            id,
            blob,
            created_at,
            updated_at,
        })
        .collect())
}

/// Store a new connection blob for a user.
pub async fn create(db: &SqlitePool, user_id: &str, blob: &str) -> Result<VaultConnection> {
    let id = Uuid::new_v4().to_string();
    let ts = now();
    sqlx::query(
        "INSERT INTO vault_connections (id, user_id, blob, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(blob)
    .bind(ts)
    .bind(ts)
    .execute(db)
    .await?;
    Ok(VaultConnection {
        id,
        blob: blob.to_string(),
        created_at: ts,
        updated_at: ts,
    })
}

/// Replace a user's connection blob. Scoped by `user_id` so a user can never
/// touch another's row. Returns false if no such row belongs to the user.
pub async fn update(db: &SqlitePool, user_id: &str, id: &str, blob: &str) -> Result<bool> {
    let affected = sqlx::query(
        "UPDATE vault_connections SET blob = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    )
    .bind(blob)
    .bind(now())
    .bind(id)
    .bind(user_id)
    .execute(db)
    .await?
    .rows_affected();
    Ok(affected > 0)
}

/// Delete a user's connection blob. Scoped by `user_id`.
pub async fn delete(db: &SqlitePool, user_id: &str, id: &str) -> Result<bool> {
    let affected =
        sqlx::query("DELETE FROM vault_connections WHERE id = ? AND user_id = ?")
            .bind(id)
            .bind(user_id)
            .execute(db)
            .await?
            .rows_affected();
    Ok(affected > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::server_auth::{KdfParams, Role, VaultKey, create_user};

    async fn user(db: &SqlitePool, name: &str) -> String {
        let vault = VaultKey {
            master_salt: vec![1, 2, 3, 4],
            protected_user_key: "v1.x.y".to_string(),
        };
        create_user(db, name, b"salt", KdfParams::recommended(), "hash", Role::User, &vault)
            .await
            .unwrap()
            .id
    }

    #[tokio::test]
    async fn per_user_isolation() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::new(&dir.path().join("v.db")).await.unwrap();
        let pool = db.pool();
        let ua = user(pool, "user-a").await;
        let ub = user(pool, "user-b").await;

        let a = create(pool, &ua, "v1.aaa.bbb").await.unwrap();
        create(pool, &ub, "v1.ccc.ddd").await.unwrap();

        let a_list = list(pool, &ua).await.unwrap();
        assert_eq!(a_list.len(), 1);
        assert_eq!(a_list[0].blob, "v1.aaa.bbb");
        // user-b never sees user-a's row.
        assert_eq!(list(pool, &ub).await.unwrap().len(), 1);

        // user-b cannot update or delete user-a's row.
        assert!(!update(pool, &ub, &a.id, "hacked").await.unwrap());
        assert!(!delete(pool, &ub, &a.id).await.unwrap());
        // owner can.
        assert!(update(pool, &ua, &a.id, "v1.new.blob").await.unwrap());
        assert!(delete(pool, &ua, &a.id).await.unwrap());
        assert_eq!(list(pool, &ua).await.unwrap().len(), 0);
    }
}
