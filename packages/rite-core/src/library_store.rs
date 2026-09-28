//! Per-user encrypted "library tree" blob (ADR 0016 view hierarchy).
//!
//! The client stores its personal folder tree + collection placement here,
//! encrypted with the user's key. The server only ever sees the opaque blob —
//! it never learns folder names or the structure (zero-knowledge).

use anyhow::Result;
use sqlx::SqlitePool;

/// Fetch a user's library blob, if any.
pub async fn get(db: &SqlitePool, user_id: &str) -> Result<Option<String>> {
    let blob: Option<String> =
        sqlx::query_scalar("SELECT blob FROM user_library WHERE user_id = ?1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    Ok(blob)
}

/// Store (upsert) a user's library blob.
pub async fn set(db: &SqlitePool, user_id: &str, blob: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO user_library (user_id, blob, updated_at) \
         VALUES (?1, ?2, unixepoch()) \
         ON CONFLICT(user_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at",
    )
    .bind(user_id)
    .bind(blob)
    .execute(db)
    .await?;
    Ok(())
}
