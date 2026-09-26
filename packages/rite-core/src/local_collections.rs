//! Collections in a local vault (ADR 0018).
//!
//! A vault holds collections exactly as a server does — same tables, same blob
//! format — so there is one storage model rather than two. What differs is who
//! decrypts and how a key is protected:
//!
//! - **Server**: the client decrypts; each member's copy of the key is sealed to
//!   their X25519 public key, and the server holds nothing readable.
//! - **Vault**: rite-core decrypts with the master key, and the key is *wrapped*
//!   with that master key — there are no members to seal to, and the webview never
//!   receives credentials.
//!
//! So this module composes what already exists — `collection_store` for the rows
//! (it takes protected keys as opaque strings, so master-key-wrapped ones drop
//! straight in), `collection_crypto` for the envelope, `local_user` for ownership —
//! and exposes plaintext to its caller, which is the trusted local process itself.
//!
//! There is no Personal collection here: it exists on a server only because *other*
//! collections can be shared, so with nothing shareable it would be an arbitrary
//! special case. A fresh vault simply has no collections.

use anyhow::{Result, anyhow};
use rite_crypto::vault::KEY_LEN;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::collection_crypto::{
    decrypt_field, encrypt_field, generate_collection_keys, unwrap_key_local, wrap_key_local,
};
use crate::collection_store::{self, CollectionRole};
use crate::local_user::{self, LOCAL_USER_ID};

/// The encrypted `{name, color}` header. Field order matters — it is part of the
/// cross-implementation contract with the browser (see `collection_crypto`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Header {
    name: String,
    color: Option<String>,
}

/// A collection as the local UI sees it: decrypted, no membership, no role.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCollection {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub created_at: i64,
    /// Whether this collection has a board stored (the blob itself is read separately).
    pub has_board: bool,
}

/// Create a collection. Generates its key pair, wraps both with the master key and
/// records the local owner. Returns the decrypted view of what was stored.
pub async fn create(
    db: &SqlitePool,
    master_key: &[u8; KEY_LEN],
    name: &str,
    color: Option<&str>,
) -> Result<LocalCollection> {
    local_user::ensure(db).await?;

    let keys = generate_collection_keys();
    let header = Header {
        name: name.to_string(),
        color: color.map(str::to_string),
    };
    let id = collection_store::create_collection(
        db,
        &encrypt_field(&keys.meta_key, &header)?,
        LOCAL_USER_ID,
        &wrap_key_local(master_key, &keys.meta_key)?,
        &wrap_key_local(master_key, &keys.items_key)?,
    )
    .await?;

    Ok(LocalCollection {
        id,
        name: header.name,
        color: header.color,
        created_at: chrono::Utc::now().timestamp(),
        has_board: false,
    })
}

/// Every collection in the vault, decrypted. Ordered by creation, oldest first.
pub async fn list(db: &SqlitePool, master_key: &[u8; KEY_LEN]) -> Result<Vec<LocalCollection>> {
    let rows = collection_store::list_collections_for_user(db, LOCAL_USER_ID).await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let meta_key = unwrap_key_local(master_key, &row.protected_meta_key)?;
        let header: Header = decrypt_field(&meta_key, &row.name_enc)?;
        out.push(LocalCollection {
            id: row.id,
            name: header.name,
            color: header.color,
            created_at: row.created_at,
            has_board: row.board_enc.is_some(),
        });
    }
    out.sort_by_key(|c| c.created_at);
    Ok(out)
}

/// Rename / recolour a collection by rewriting its encrypted header.
pub async fn update(
    db: &SqlitePool,
    master_key: &[u8; KEY_LEN],
    id: &str,
    name: &str,
    color: Option<&str>,
) -> Result<bool> {
    let meta_key = meta_key_of(db, master_key, id).await?;
    let header = Header {
        name: name.to_string(),
        color: color.map(str::to_string),
    };
    collection_store::set_name_enc(db, id, &encrypt_field(&meta_key, &header)?).await
}

/// Delete a collection and, by cascade, its members and items.
pub async fn delete(db: &SqlitePool, id: &str) -> Result<bool> {
    collection_store::delete_collection(db, id).await
}

/// The itemsKey of a local collection, unwrapped — for machines and the board.
pub async fn items_key(
    db: &SqlitePool,
    master_key: &[u8; KEY_LEN],
    id: &str,
) -> Result<[u8; KEY_LEN]> {
    let row = row_of(db, id).await?;
    let protected = row
        .protected_items_key
        .ok_or_else(|| anyhow!("collection {id} has no items key"))?;
    unwrap_key_local(master_key, &protected)
}

async fn meta_key_of(
    db: &SqlitePool,
    master_key: &[u8; KEY_LEN],
    id: &str,
) -> Result<[u8; KEY_LEN]> {
    unwrap_key_local(master_key, &row_of(db, id).await?.protected_meta_key)
}

async fn row_of(db: &SqlitePool, id: &str) -> Result<collection_store::UserCollection> {
    collection_store::list_collections_for_user(db, LOCAL_USER_ID)
        .await?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| anyhow!("collection {id} not found in this vault"))
}

/// The local owner owns everything it can see, so role checks are a formality here;
/// exposed so callers can assert the invariant rather than assume it.
pub async fn role(db: &SqlitePool, id: &str) -> Result<Option<CollectionRole>> {
    collection_store::collection_role(db, id, LOCAL_USER_ID).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use rite_crypto::vault;

    async fn vault_db() -> (tempfile::TempDir, Database, [u8; KEY_LEN]) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::new(&dir.path().join("t.db")).await.unwrap();
        (dir, db, vault::generate_user_key())
    }

    #[tokio::test]
    async fn a_fresh_vault_has_no_collections() {
        let (_d, db, mk) = vault_db().await;
        assert!(
            list(db.pool(), &mk).await.unwrap().is_empty(),
            "no Personal"
        );
    }

    #[tokio::test]
    async fn collections_round_trip_and_stay_encrypted_on_disk() {
        let (_d, db, mk) = vault_db().await;
        let made = create(db.pool(), &mk, "Home lab", Some("#9ece6a"))
            .await
            .unwrap();

        let all = list(db.pool(), &mk).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Home lab");
        assert_eq!(all[0].color.as_deref(), Some("#9ece6a"));
        assert!(!all[0].has_board);

        // The name is not readable in the database — unlike the legacy `connections`
        // table, which kept hostnames and folders in plaintext columns.
        let stored: (String,) = sqlx::query_as("SELECT name_enc FROM collections WHERE id = ?")
            .bind(&made.id)
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert!(stored.0.starts_with("v1."));
        assert!(!stored.0.contains("Home lab"));
    }

    #[tokio::test]
    async fn only_this_vaults_master_key_opens_it() {
        let (_d, db, mk) = vault_db().await;
        create(db.pool(), &mk, "Edge sites", None).await.unwrap();
        let other = vault::generate_user_key();
        assert!(
            list(db.pool(), &other).await.is_err(),
            "another master key must not decrypt this vault"
        );
    }

    #[tokio::test]
    async fn update_and_delete() {
        let (_d, db, mk) = vault_db().await;
        let c = create(db.pool(), &mk, "Old", None).await.unwrap();
        assert!(
            update(db.pool(), &mk, &c.id, "New", Some("#f7768e"))
                .await
                .unwrap()
        );
        let all = list(db.pool(), &mk).await.unwrap();
        assert_eq!(all[0].name, "New");
        assert_eq!(all[0].color.as_deref(), Some("#f7768e"));

        assert_eq!(
            role(db.pool(), &c.id).await.unwrap(),
            Some(CollectionRole::Owner)
        );
        assert!(delete(db.pool(), &c.id).await.unwrap());
        assert!(list(db.pool(), &mk).await.unwrap().is_empty());
    }

    /// Deleting must take the items with it — the blobs are the machines, and a
    /// deleted collection leaving ciphertext behind is a retention problem.
    #[tokio::test]
    async fn delete_cascades_to_items() {
        let (_d, db, mk) = vault_db().await;
        let c = create(db.pool(), &mk, "Home lab", None).await.unwrap();
        let ik = items_key(db.pool(), &mk, &c.id).await.unwrap();
        collection_store::create_item(db.pool(), &c.id, &encrypt_field(&ik, &"a machine").unwrap())
            .await
            .unwrap();
        assert_eq!(
            collection_store::list_items(db.pool(), &c.id)
                .await
                .unwrap()
                .len(),
            1
        );

        delete(db.pool(), &c.id).await.unwrap();
        let left: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM collection_items WHERE collection_id = ?")
                .bind(&c.id)
                .fetch_one(db.pool())
                .await
                .unwrap();
        assert_eq!(left.0, 0, "items must not outlive their collection");
    }
}
