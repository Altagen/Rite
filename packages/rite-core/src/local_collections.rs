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
use crate::connection::{AuthMethod, PortForwardConfig};
use crate::local_user::{self, LOCAL_USER_ID};

/// The encrypted `{name, color}` header. Field order matters — it is part of the
/// cross-implementation contract with the browser (see `collection_crypto`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Header {
    name: String,
    color: Option<String>,
}

/// A machine as it is stored inside a collection item.
///
/// This is the browser's `StoredRecord` (accountsConnectionsSource.ts) field for
/// field. The whole point of ADR 0018 is one storage model, so a blob written by
/// rite-core must be readable by the web shell and the other way round — the shape
/// is a contract, not an internal detail, and `machine_record_matches_the_browser`
/// pins it against JSON the browser produced.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineRecord {
    pub name: String,
    pub protocol: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub ssh_keep_alive_override: Option<String>,
    #[serde(default)]
    pub ssh_keep_alive_interval: Option<i64>,
    #[serde(default)]
    pub preconnect: Option<String>,
    #[serde(default)]
    pub jump: Option<String>,
    #[serde(default)]
    pub forwards: Vec<PortForwardConfig>,
    /// Health-check opt-out (ADR 0017): `Some(false)` ⇒ never actively probe.
    #[serde(default)]
    pub hc: Option<bool>,
}

/// A machine read back out of a collection, with the item id that addresses it.
#[derive(Debug, Clone)]
pub struct StoredMachine {
    pub id: String,
    pub record: MachineRecord,
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

/// Every machine in a collection, decrypted.
pub async fn list_machines(
    db: &SqlitePool,
    master_key: &[u8; KEY_LEN],
    collection_id: &str,
) -> Result<Vec<StoredMachine>> {
    let key = items_key(db, master_key, collection_id).await?;
    let mut out = Vec::new();
    for item in collection_store::list_items(db, collection_id).await? {
        // One unreadable item must not take the whole collection down with it.
        match decrypt_field::<MachineRecord>(&key, &item.blob) {
            Ok(record) => out.push(StoredMachine {
                id: item.id,
                record,
            }),
            Err(e) => tracing::warn!("skipping unreadable item {}: {}", item.id, e),
        }
    }
    Ok(out)
}

/// Add a machine to a collection. Returns its item id.
pub async fn create_machine(
    db: &SqlitePool,
    master_key: &[u8; KEY_LEN],
    collection_id: &str,
    record: &MachineRecord,
) -> Result<String> {
    let key = items_key(db, master_key, collection_id).await?;
    Ok(
        collection_store::create_item(db, collection_id, &encrypt_field(&key, record)?)
            .await?
            .id,
    )
}

/// Replace a machine's record wholesale.
pub async fn update_machine(
    db: &SqlitePool,
    master_key: &[u8; KEY_LEN],
    collection_id: &str,
    item_id: &str,
    record: &MachineRecord,
) -> Result<bool> {
    let key = items_key(db, master_key, collection_id).await?;
    collection_store::update_item(db, collection_id, item_id, &encrypt_field(&key, record)?).await
}

/// Remove a machine from a collection.
pub async fn delete_machine(db: &SqlitePool, collection_id: &str, item_id: &str) -> Result<bool> {
    collection_store::delete_item(db, collection_id, item_id).await
}

/// A collection's Board, decrypted.
///
/// The core deliberately does not model the cards. A board is a list of typed
/// cards whose shape belongs to the UI (`utils/board.ts`); re-declaring it here
/// would duplicate a frontend concern and give two places to keep in step for no
/// gain. What matters at this layer is that the document is encrypted with the
/// collection's itemsKey and that the key never leaves Rust — so it travels as an
/// opaque JSON value.
///
/// `None` when the collection has no board yet.
pub async fn read_board(
    db: &SqlitePool,
    master_key: &[u8; KEY_LEN],
    collection_id: &str,
) -> Result<Option<serde_json::Value>> {
    let Some(blob) = collection_store::get_board_enc(db, collection_id).await? else {
        return Ok(None);
    };
    let key = items_key(db, master_key, collection_id).await?;
    Ok(Some(decrypt_field(&key, &blob)?))
}

/// Replace a collection's Board. An empty array clears it, matching the browser,
/// so "no cards" and "no board" stay the same state on both sides.
pub async fn write_board(
    db: &SqlitePool,
    master_key: &[u8; KEY_LEN],
    collection_id: &str,
    cards: &serde_json::Value,
) -> Result<bool> {
    let empty = cards.as_array().map(|a| a.is_empty()).unwrap_or(false);
    if cards.is_null() || empty {
        return collection_store::set_board_enc(db, collection_id, None).await;
    }
    let key = items_key(db, master_key, collection_id).await?;
    let blob = encrypt_field(&key, cards)?;
    collection_store::set_board_enc(db, collection_id, Some(&blob)).await
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

    fn a_machine() -> MachineRecord {
        MachineRecord {
            name: "web-01".into(),
            protocol: "ssh".into(),
            hostname: "10.0.0.5".into(),
            port: 22,
            username: "deploy".into(),
            auth_method: AuthMethod::PublicKey {
                key_path: "/home/u/.ssh/id_ed25519".into(),
                passphrase: None,
            },
            color: None,
            icon: None,
            folder: Some("Web servers".into()),
            notes: None,
            ssh_keep_alive_override: None,
            ssh_keep_alive_interval: None,
            preconnect: None,
            jump: Some("bastion".into()),
            forwards: vec![PortForwardConfig {
                forward_type: "local".into(),
                bind_host: None,
                local_port: 8080,
                remote_host: "10.0.0.9".into(),
                remote_port: 80,
            }],
            hc: None,
        }
    }

    /// The contract that makes one storage model real: a record the browser wrote
    /// must load here unchanged, and ours must go back in the same spelling.
    /// Captured from `StoredRecord` in accountsConnectionsSource.ts.
    #[test]
    fn machine_record_matches_the_browser() {
        const FROM_BROWSER: &str = r#"{"name":"web-01","protocol":"ssh","hostname":"10.0.0.5","port":22,"username":"deploy","authMethod":{"type":"publicKey","keyPath":"/home/u/.ssh/id_ed25519"},"color":null,"icon":null,"folder":"Web servers","notes":null,"sshKeepAliveOverride":null,"sshKeepAliveInterval":null,"preconnect":null,"jump":"bastion","forwards":[{"forwardType":"local","bindHost":null,"localPort":8080,"remoteHost":"10.0.0.9","remotePort":80}],"hc":null}"#;
        let parsed: MachineRecord =
            serde_json::from_str(FROM_BROWSER).expect("a browser record must load");
        assert_eq!(parsed, a_machine());

        let ours = serde_json::to_value(&parsed).unwrap();
        let theirs: serde_json::Value = serde_json::from_str(FROM_BROWSER).unwrap();
        assert_eq!(ours, theirs, "core and browser must agree field for field");
    }

    #[tokio::test]
    async fn machines_round_trip_inside_a_collection() {
        let (_d, db, mk) = vault_db().await;
        let c = create(db.pool(), &mk, "Home lab", None).await.unwrap();

        let id = create_machine(db.pool(), &mk, &c.id, &a_machine())
            .await
            .unwrap();
        let all = list_machines(db.pool(), &mk, &c.id).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].record, a_machine());

        // Unlike the legacy connections table, the hostname is not on disk in clear.
        let blob: (String,) = sqlx::query_as("SELECT blob FROM collection_items WHERE id = ?")
            .bind(&id)
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert!(!blob.0.contains("10.0.0.5"));
        assert!(!blob.0.contains("web-01"));

        let mut edited = a_machine();
        edited.name = "web-02".into();
        assert!(
            update_machine(db.pool(), &mk, &c.id, &id, &edited)
                .await
                .unwrap()
        );
        assert_eq!(
            list_machines(db.pool(), &mk, &c.id).await.unwrap()[0]
                .record
                .name,
            "web-02"
        );

        assert!(delete_machine(db.pool(), &c.id, &id).await.unwrap());
        assert!(
            list_machines(db.pool(), &mk, &c.id)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn a_board_round_trips_and_clears() {
        let (_d, db, mk) = vault_db().await;
        let c = create(db.pool(), &mk, "Home lab", None).await.unwrap();
        assert!(read_board(db.pool(), &mk, &c.id).await.unwrap().is_none());

        let cards = serde_json::json!([
            {"id": "b1", "type": "link", "title": "Grafana", "url": "http://192.168.1.10:3000"},
            {"id": "b2", "type": "note", "title": "Disks", "text": "scrub on sunday"},
        ]);
        assert!(write_board(db.pool(), &mk, &c.id, &cards).await.unwrap());
        assert_eq!(
            read_board(db.pool(), &mk, &c.id).await.unwrap(),
            Some(cards)
        );

        // The board is a member-readable document, not server-readable data.
        let stored: (Option<String>,) =
            sqlx::query_as("SELECT board_enc FROM collections WHERE id = ?")
                .bind(&c.id)
                .fetch_one(db.pool())
                .await
                .unwrap();
        let blob = stored.0.unwrap();
        assert!(blob.starts_with("v1."));
        assert!(!blob.contains("Grafana"));

        // An empty array clears it, as it does in the browser.
        write_board(db.pool(), &mk, &c.id, &serde_json::json!([]))
            .await
            .unwrap();
        assert!(read_board(db.pool(), &mk, &c.id).await.unwrap().is_none());
    }

    /// The board rides the itemsKey, so it follows the machines: a collection whose
    /// items you cannot read has no readable board either.
    #[tokio::test]
    async fn a_board_needs_this_vaults_key() {
        let (_d, db, mk) = vault_db().await;
        let c = create(db.pool(), &mk, "Home lab", None).await.unwrap();
        write_board(
            db.pool(),
            &mk,
            &c.id,
            &serde_json::json!([{"id":"b1","type":"note"}]),
        )
        .await
        .unwrap();
        let other = vault::generate_user_key();
        assert!(read_board(db.pool(), &other, &c.id).await.is_err());
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
