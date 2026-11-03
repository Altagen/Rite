//! Per-user encrypted marks blob (ADR 0022 §6).
//!
//! The account's copy of the names a person gave to conversations. Sealed by the client
//! under the user's key, so the server holds machine names and first messages it cannot
//! read. One row per user: two machines editing at once means the second write wins, with
//! no merge — the same bargain the layouts blob beside it makes.

use anyhow::Result;
use sqlx::SqlitePool;

/// Fetch a user's marks blob and when it was last written, if any.
pub async fn get(db: &SqlitePool, user_id: &str) -> Result<Option<(String, i64)>> {
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT blob, updated_at FROM user_marks WHERE user_id = ?1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    Ok(row)
}

/// Store (upsert) a user's marks blob.
pub async fn set(db: &SqlitePool, user_id: &str, blob: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO user_marks (user_id, blob, updated_at) \
         VALUES (?1, ?2, unixepoch()) \
         ON CONFLICT(user_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at",
    )
    .bind(user_id)
    .bind(blob)
    .execute(db)
    .await?;
    Ok(())
}
