//! Per-user encrypted layouts blob (ADR 0027).
//!
//! The account's copy of the workspace file. Sealed by the client under the user's key, so
//! the server holds machine names it cannot read. One row per user: two machines editing at
//! once means the second write wins, with no merge.

use anyhow::Result;
use sqlx::SqlitePool;

/// Fetch a user's layouts blob and when it was last written, if any.
///
/// The timestamp rides along because one row serves every machine on the account: the
/// editor shows when the other one wrote, which is all this holds against a lost edit.
pub async fn get(db: &SqlitePool, user_id: &str) -> Result<Option<(String, i64)>> {
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT blob, updated_at FROM user_layouts WHERE user_id = ?1")
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    Ok(row)
}

/// Store (upsert) a user's layouts blob.
pub async fn set(db: &SqlitePool, user_id: &str, blob: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO user_layouts (user_id, blob, updated_at) \
         VALUES (?1, ?2, unixepoch()) \
         ON CONFLICT(user_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at",
    )
    .bind(user_id)
    .bind(blob)
    .execute(db)
    .await?;
    Ok(())
}
