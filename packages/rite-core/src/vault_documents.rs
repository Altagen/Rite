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

/// The instance vocabulary's name in this table.
///
/// A LOCAL VAULT IS AN INSTANCE OF RITE, with collections under it — so the scope that
/// exists "above the collections" exists here too, and a word declared once does not have
/// to be redeclared in each collection. There is no organisation and no administrator, so
/// the only reader is the owner: it is sealed, like their marks, rather than kept in the
/// clear the way a server's is (where every member reads it and sealing it under a key
/// they all hold would buy a rotation path and no secrecy).
pub const LABELS: &str = "labels";

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

/// Every document, re-sealed from the old master key under the new one.
///
/// CALLED IN THE SAME BREATH AS A PASSWORD CHANGE, exactly as `local_collections`'
/// `rewrapped_keys` is, and for the identical reason its comment gives: these blobs are
/// sealed DIRECTLY with the master key, so a change that did not visit them would succeed
/// and leave a person's names and their vocabulary permanently unreadable, in silence.
///
/// Returns the new blobs rather than writing them, so the whole re-key lands in one
/// transaction with the connections, the collection keys and the password hash. A
/// password change that half-applied would be worse than one that failed.
///
/// A blob that will not open with the OLD key stops the change. It is not skipped: a
/// document that cannot be read is not a document that may be dropped, and the honest
/// outcome is a refused password change the person can act on.
pub async fn resealed(
    db: &SqlitePool,
    old_key: &[u8; KEY_LEN],
    new_key: &[u8; KEY_LEN],
) -> Result<Vec<(String, String)>> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT name, blob FROM vault_documents")
        .fetch_all(db)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (name, blob) in rows {
        let text: String = decrypt_field(old_key, &blob)?;
        out.push((name, encrypt_field(new_key, &text)?));
    }
    Ok(out)
}

/// The instance's label vocabulary, on a server: one row, in the clear.
///
/// IN THE CLEAR DELIBERATELY. Every member reads this list — that is what the scope means
/// — so sealing it under a key they all hold would buy a key rotation path and no secrecy.
/// What is secret is WHICH MACHINE wears a word, and that stays inside the collection's
/// encrypted item under a key this process never holds.
///
/// A local vault has the same scope and does not come here: there the only reader is the
/// owner, so the list rides `get`/`set` above, sealed under the master key like their
/// marks. Two supports because the readers differ, not because the feature does.
pub mod instance {
    use anyhow::Result;
    use sqlx::SqlitePool;

    /// The words, or `None` when nothing has been declared.
    pub async fn get(db: &SqlitePool) -> Result<Option<String>> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT words FROM instance_labels WHERE id = 1")
                .fetch_optional(db)
                .await?;
        Ok(row.map(|(w,)| w))
    }

    /// Declare the whole list. One row, so this replaces rather than appends.
    pub async fn set(db: &SqlitePool, words: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO instance_labels (id, words, updated_at) \
             VALUES (1, ?1, unixepoch()) \
             ON CONFLICT(id) DO UPDATE SET words = excluded.words, updated_at = excluded.updated_at",
        )
        .bind(words)
        .execute(db)
        .await?;
        Ok(())
    }
}
