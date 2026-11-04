//! Documents Rite keeps for one person, sealed under the vault's master key.
//!
//! THE MIDDLE ROW OF ADR 0022 §6's TABLE, which was the one not built. A mark went to a
//! sealed blob on a server account, and to a JSON file in the clear everywhere else —
//! including with a local vault open, where a key exists and the core is holding it. A
//! local vault is a vault, and a labelled conversation names a project and a customer.
//!
//! Named rather than one table per document, so the workspace document can follow without
//! a migration of its own. One row per name, last write wins, no merge: the same bargain
//! `user_marks` and `user_layouts` make, and for the same reason — two windows editing one
//! person's filing is not a case worth a merge algorithm.
//!
//! The sealing is `collection_crypto`'s, so there is exactly one place in this crate that
//! knows how a blob is made.

use crate::collection_crypto::{decrypt_field, encrypt_field};
use anyhow::Result;
use rite_crypto::vault::KEY_LEN;
use sqlx::SqlitePool;

/// The marks document's name in this table.
pub const MARKS: &str = "marks";

/// Read one document, or `None` when nothing has been written under that name.
///
/// A blob that will not open is an ERROR and not an empty document: answering "nothing
/// held" to a failed decrypt would invite the caller to write over what it could not
/// read, which is how a person loses their filing to a bug.
pub async fn get(db: &SqlitePool, key: &[u8; KEY_LEN], name: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT blob FROM vault_documents WHERE name = ?1")
        .bind(name)
        .fetch_optional(db)
        .await?;
    match row {
        Some((blob,)) => Ok(Some(decrypt_field(key, &blob)?)),
        None => Ok(None),
    }
}

/// Write one document, sealed.
pub async fn set(db: &SqlitePool, key: &[u8; KEY_LEN], name: &str, text: &str) -> Result<()> {
    let blob = encrypt_field(key, &text.to_string())?;
    sqlx::query(
        "INSERT INTO vault_documents (name, blob, updated_at) \
         VALUES (?1, ?2, unixepoch()) \
         ON CONFLICT(name) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at",
    )
    .bind(name)
    .bind(blob)
    .execute(db)
    .await?;
    Ok(())
}
