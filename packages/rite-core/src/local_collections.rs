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
use crate::connection::{AuthMethod, Connection, PortForwardConfig};
use crate::local_user::{self, LOCAL_USER_ID};

/// A folder declared inside a collection. Machines reference one by name via their
/// own `folder` field; declaring it here is what lets an *empty* folder survive.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CollectionFolder {
    pub name: String,
    pub color: Option<String>,
}

/// The collection's encrypted header — the browser's `CollectionHeader`
/// (utils/collectionHeader.ts) field for field, for the same reason `MachineRecord`
/// mirrors `StoredRecord`: both sides must read the same blob. Optional fields are
/// omitted rather than written as null, matching JSON.stringify.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct Header {
    name: String,
    color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    folders: Option<Vec<CollectionFolder>>,
    /// Collection-wide active health-check opt-out (ADR 0017).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hc: Option<bool>,
    /// Marks the auto-provisioned server "Personal" collection. Never set locally —
    /// a local vault has no Personal (ADR 0018) — but carried so a header written by
    /// the browser survives a round-trip here unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    personal: Option<bool>,
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
/// The timestamps come from the row, not the blob — they are not secret and do
/// not belong inside ciphertext that would then be rewritten on every edit.
#[derive(Debug, Clone)]
pub struct StoredMachine {
    pub id: String,
    pub record: MachineRecord,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A collection as the local UI sees it: decrypted, no membership, no role.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCollection {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub created_at: i64,
    /// Declared folders, including empty ones (machines point at them by name).
    pub folders: Vec<CollectionFolder>,
    /// Collection-wide active health-check opt-out (ADR 0017).
    pub hc: Option<bool>,
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
        folders: None,
        hc: None,
        personal: None,
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
        folders: Vec::new(),
        hc: None,
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
            folders: header.folders.unwrap_or_default(),
            hc: header.hc,
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
    folders: Option<Vec<CollectionFolder>>,
    hc: Option<Option<bool>>,
) -> Result<bool> {
    let meta_key = meta_key_of(db, master_key, id).await?;
    // Read-modify-write: a rename must not silently drop folders or the
    // health-check opt-out, which live in the same header blob.
    let current: Header = decrypt_field(&meta_key, &row_of(db, id).await?.name_enc)?;
    let header = Header {
        name: name.to_string(),
        color: color.map(str::to_string),
        folders: folders.or(current.folders),
        hc: match hc {
            Some(v) => v,
            None => current.hc,
        },
        personal: current.personal,
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
                created_at: item.created_at,
                updated_at: item.updated_at,
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

/// A partial edit of a machine.
///
/// The UI never receives credentials — a machine comes back with `authType` and
/// nothing else — so it cannot send a whole record back. Every field is optional
/// and absent means "leave what is stored", which is the only way an edit that
/// does not touch the password can keep it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachinePatch {
    pub name: Option<String>,
    pub protocol: Option<String>,
    pub hostname: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub auth_method: Option<AuthMethod>,
    pub color: Option<Option<String>>,
    pub icon: Option<Option<String>>,
    pub folder: Option<Option<String>>,
    pub notes: Option<Option<String>>,
    pub ssh_keep_alive_override: Option<Option<String>>,
    pub ssh_keep_alive_interval: Option<Option<i64>>,
    pub preconnect: Option<Option<String>>,
    pub jump: Option<Option<String>>,
    pub forwards: Option<Vec<PortForwardConfig>>,
    pub hc: Option<Option<bool>>,
}

/// Apply a partial edit to a machine, keeping everything the caller left out.
pub async fn patch_machine(
    db: &SqlitePool,
    master_key: &[u8; KEY_LEN],
    collection_id: &str,
    item_id: &str,
    patch: MachinePatch,
) -> Result<bool> {
    let key = items_key(db, master_key, collection_id).await?;
    let item = collection_store::list_items(db, collection_id)
        .await?
        .into_iter()
        .find(|i| i.id == item_id)
        .ok_or_else(|| anyhow!("machine {item_id} not found"))?;
    let mut record: MachineRecord = decrypt_field(&key, &item.blob)?;

    if let Some(v) = patch.name {
        record.name = v;
    }
    if let Some(v) = patch.protocol {
        record.protocol = v;
    }
    if let Some(v) = patch.hostname {
        record.hostname = v;
    }
    if let Some(v) = patch.port {
        record.port = v;
    }
    if let Some(v) = patch.username {
        record.username = v;
    }
    if let Some(v) = patch.auth_method {
        record.auth_method = v;
    }
    if let Some(v) = patch.color {
        record.color = v;
    }
    if let Some(v) = patch.icon {
        record.icon = v;
    }
    if let Some(v) = patch.folder {
        record.folder = v;
    }
    if let Some(v) = patch.notes {
        record.notes = v;
    }
    if let Some(v) = patch.ssh_keep_alive_override {
        record.ssh_keep_alive_override = v;
    }
    if let Some(v) = patch.ssh_keep_alive_interval {
        record.ssh_keep_alive_interval = v;
    }
    if let Some(v) = patch.preconnect {
        record.preconnect = v;
    }
    if let Some(v) = patch.jump {
        record.jump = v;
    }
    if let Some(v) = patch.forwards {
        record.forwards = v;
    }
    if let Some(v) = patch.hc {
        record.hc = v;
    }

    update_machine(db, master_key, collection_id, item_id, &record).await
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

impl MachineRecord {
    /// Build the in-memory connection the transport takes. `id` is the collection
    /// item's id, which is what the UI addresses a machine by.
    pub fn to_connection(&self, id: &str) -> Result<Connection> {
        Ok(Connection {
            id: id.to_string(),
            name: self.name.clone(),
            protocol: crate::connection::Protocol::from_str(&self.protocol)?,
            hostname: self.hostname.clone(),
            port: self.port,
            username: self.username.clone(),
            auth_method: self.auth_method.clone(),
            metadata: crate::connection::ConnectionMetadata {
                color: self.color.clone(),
                icon: self.icon.clone(),
                folder: self.folder.clone(),
                notes: self.notes.clone(),
            },
            ssh_keep_alive_override: self.ssh_keep_alive_override.clone(),
            ssh_keep_alive_interval: self.ssh_keep_alive_interval,
            preconnect: self.preconnect.clone(),
            jump: self.jump.clone(),
            forwards: self.forwards.clone(),
            last_used_at: None,
            created_at: 0,
            updated_at: 0,
        })
    }
}

/// Find a machine anywhere in the vault by its item id.
///
/// Item ids are UUIDs and unique across collections, so the UI can address a
/// machine by id alone — it does not have to know which collection holds it, and
/// neither does the transport when it resolves a jump host.
pub async fn find_machine(
    db: &SqlitePool,
    master_key: &[u8; KEY_LEN],
    item_id: &str,
) -> Result<Option<(String, MachineRecord)>> {
    for c in list(db, master_key).await? {
        let key = items_key(db, master_key, &c.id).await?;
        for item in collection_store::list_items(db, &c.id).await? {
            if item.id != item_id {
                continue;
            }
            return Ok(Some((
                c.id,
                decrypt_field::<MachineRecord>(&key, &item.blob)?,
            )));
        }
    }
    Ok(None)
}

/// Stamp a machine as just used. Beside the item rather than inside it — see
/// migration 023 for why the blob is not rewritten for this.
pub async fn touch_machine(db: &SqlitePool, item_id: &str, at: i64) -> Result<()> {
    sqlx::query(
        "INSERT INTO machine_last_used (item_id, last_used_at) VALUES (?, ?) \
         ON CONFLICT(item_id) DO UPDATE SET last_used_at = excluded.last_used_at",
    )
    .bind(item_id)
    .bind(at)
    .execute(db)
    .await?;
    Ok(())
}

/// Last-used timestamps for a collection's machines, keyed by item id.
pub async fn last_used(
    db: &SqlitePool,
    collection_id: &str,
) -> Result<std::collections::HashMap<String, i64>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT l.item_id, l.last_used_at FROM machine_last_used l \
         JOIN collection_items i ON i.id = l.item_id WHERE i.collection_id = ?",
    )
    .bind(collection_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Re-wrap every local collection key for a new master key.
///
/// A local collection's keys are wrapped with the master key, so changing the
/// master password must re-wrap them or the whole vault becomes unreadable — the
/// items would still be there, encrypted with keys nobody can unwrap any more.
/// This only computes the new values; the caller writes them in the same
/// transaction as the password change, so a crash in between cannot leave the two
/// out of step.
pub async fn rewrapped_keys(
    db: &SqlitePool,
    old_master: &[u8; KEY_LEN],
    new_master: &[u8; KEY_LEN],
) -> Result<Vec<(String, String, Option<String>)>> {
    let mut out = Vec::new();
    for row in collection_store::list_collections_for_user(db, LOCAL_USER_ID).await? {
        let meta = unwrap_key_local(old_master, &row.protected_meta_key)?;
        let items = match &row.protected_items_key {
            Some(p) => Some(unwrap_key_local(old_master, p)?),
            None => None,
        };
        out.push((
            row.id,
            wrap_key_local(new_master, &meta)?,
            items.map(|k| wrap_key_local(new_master, &k)).transpose()?,
        ));
    }
    Ok(out)
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
            update(db.pool(), &mk, &c.id, "New", Some("#f7768e"), None, None)
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

    /// The header is a shared blob too, so it gets the same treatment as the
    /// machine record: a header the browser wrote must survive a round-trip here.
    #[test]
    fn header_matches_the_browser() {
        // r##"…"## because a hex colour contains `"#`, which would end an r#"…"# literal.
        const FROM_BROWSER: &str = r##"{"name":"Production","color":"#f7768e","folders":[{"name":"Web servers","color":"#7c9cf5"},{"name":"Cache","color":null}],"hc":false}"##;
        let parsed: Header = serde_json::from_str(FROM_BROWSER).expect("browser header must load");
        assert_eq!(parsed.name, "Production");
        assert_eq!(parsed.folders.as_ref().unwrap().len(), 2);
        assert_eq!(parsed.hc, Some(false));
        let ours = serde_json::to_value(&parsed).unwrap();
        let theirs: serde_json::Value = serde_json::from_str(FROM_BROWSER).unwrap();
        assert_eq!(ours, theirs, "header must round-trip field for field");
    }

    /// A rename must not quietly discard the folders stored in the same blob.
    #[tokio::test]
    async fn renaming_keeps_folders_and_the_health_check_opt_out() {
        let (_d, db, mk) = vault_db().await;
        let c = create(db.pool(), &mk, "Home lab", None).await.unwrap();
        let folders = vec![
            CollectionFolder {
                name: "Hypervisors".into(),
                color: Some("#7c9cf5".into()),
            },
            CollectionFolder {
                name: "Empty".into(),
                color: None,
            },
        ];
        update(
            db.pool(),
            &mk,
            &c.id,
            "Home lab",
            None,
            Some(folders.clone()),
            Some(Some(false)),
        )
        .await
        .unwrap();

        // Rename only — folders and hc are untouched.
        update(db.pool(), &mk, &c.id, "Lab", None, None, None)
            .await
            .unwrap();
        let got = &list(db.pool(), &mk).await.unwrap()[0];
        assert_eq!(got.name, "Lab");
        assert_eq!(
            got.folders, folders,
            "an empty folder must survive a rename"
        );
        assert_eq!(got.hc, Some(false));
    }

    #[tokio::test]
    async fn a_machine_is_findable_by_item_id_alone() {
        let (_d, db, mk) = vault_db().await;
        let a = create(db.pool(), &mk, "Home lab", None).await.unwrap();
        let b = create(db.pool(), &mk, "Edge sites", None).await.unwrap();
        create_machine(db.pool(), &mk, &a.id, &a_machine())
            .await
            .unwrap();
        let wanted = create_machine(db.pool(), &mk, &b.id, &a_machine())
            .await
            .unwrap();

        let (coll, rec) = find_machine(db.pool(), &mk, &wanted)
            .await
            .unwrap()
            .expect("the machine must be found without naming its collection");
        assert_eq!(coll, b.id, "and it must report which collection holds it");
        assert_eq!(rec, a_machine());

        assert!(
            find_machine(db.pool(), &mk, "no-such-id")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_found_machine_becomes_a_connection() {
        let (_d, db, mk) = vault_db().await;
        let c = create(db.pool(), &mk, "Home lab", None).await.unwrap();
        let id = create_machine(db.pool(), &mk, &c.id, &a_machine())
            .await
            .unwrap();
        let (_, rec) = find_machine(db.pool(), &mk, &id).await.unwrap().unwrap();
        let conn = rec.to_connection(&id).unwrap();
        assert_eq!(conn.id, id);
        assert_eq!(conn.hostname, "10.0.0.5");
        assert_eq!(conn.jump.as_deref(), Some("bastion"));
        assert_eq!(conn.forwards.len(), 1);
    }

    #[tokio::test]
    async fn last_used_is_recorded_beside_the_item() {
        let (_d, db, mk) = vault_db().await;
        let c = create(db.pool(), &mk, "Home lab", None).await.unwrap();
        let id = create_machine(db.pool(), &mk, &c.id, &a_machine())
            .await
            .unwrap();

        let before: (String,) = sqlx::query_as("SELECT blob FROM collection_items WHERE id = ?")
            .bind(&id)
            .fetch_one(db.pool())
            .await
            .unwrap();

        touch_machine(db.pool(), &id, 1_700_000_000).await.unwrap();
        touch_machine(db.pool(), &id, 1_700_000_500).await.unwrap();
        assert_eq!(
            last_used(db.pool(), &c.id).await.unwrap().get(&id),
            Some(&1_700_000_500)
        );

        // The point of the side table: the ciphertext is untouched by a connect.
        let after: (String,) = sqlx::query_as("SELECT blob FROM collection_items WHERE id = ?")
            .bind(&id)
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert_eq!(
            before.0, after.0,
            "connecting must not rewrite the machine blob"
        );
    }

    /// A deleted machine must not leave a timestamp behind pointing at nothing.
    #[tokio::test]
    async fn last_used_goes_with_the_machine() {
        let (_d, db, mk) = vault_db().await;
        let c = create(db.pool(), &mk, "Home lab", None).await.unwrap();
        let id = create_machine(db.pool(), &mk, &c.id, &a_machine())
            .await
            .unwrap();
        touch_machine(db.pool(), &id, 1_700_000_000).await.unwrap();

        delete_machine(db.pool(), &c.id, &id).await.unwrap();
        let left: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM machine_last_used WHERE item_id = ?")
                .bind(&id)
                .fetch_one(db.pool())
                .await
                .unwrap();
        assert_eq!(left.0, 0);
    }

    /// The edit that matters: renaming a machine must not lose its password, since
    /// the UI never had it to send back.
    #[tokio::test]
    async fn a_patch_keeps_the_credentials_it_was_not_given() {
        let (_d, db, mk) = vault_db().await;
        let c = create(db.pool(), &mk, "Home lab", None).await.unwrap();
        let mut original = a_machine();
        original.auth_method = AuthMethod::Password {
            password: "s3cret".into(),
        };
        let id = create_machine(db.pool(), &mk, &c.id, &original)
            .await
            .unwrap();

        let patch = MachinePatch {
            name: Some("renamed".into()),
            ..Default::default()
        };
        assert!(
            patch_machine(db.pool(), &mk, &c.id, &id, patch)
                .await
                .unwrap()
        );

        let got = &list_machines(db.pool(), &mk, &c.id).await.unwrap()[0].record;
        assert_eq!(got.name, "renamed");
        assert_eq!(
            got.auth_method,
            AuthMethod::Password {
                password: "s3cret".into()
            },
            "an edit that never saw the password must not erase it"
        );
        assert_eq!(
            got.jump.as_deref(),
            Some("bastion"),
            "and must keep the rest"
        );
    }

    /// A nested Option means "set it to nothing" is expressible, not just "leave it".
    #[tokio::test]
    async fn a_patch_can_clear_a_field() {
        let (_d, db, mk) = vault_db().await;
        let c = create(db.pool(), &mk, "Home lab", None).await.unwrap();
        let id = create_machine(db.pool(), &mk, &c.id, &a_machine())
            .await
            .unwrap();

        patch_machine(
            db.pool(),
            &mk,
            &c.id,
            &id,
            MachinePatch {
                jump: Some(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            list_machines(db.pool(), &mk, &c.id).await.unwrap()[0]
                .record
                .jump,
            None
        );
    }

    /// The vault must survive a master-password change. Without re-wrapping, the
    /// collection keys stay wrapped under the old key and everything becomes
    /// permanently unreadable — silently, since the ciphertext is all still there.
    #[tokio::test]
    async fn keys_can_be_rewrapped_for_a_new_master_key() {
        let (_d, db, old) = vault_db().await;
        let c = create(db.pool(), &old, "Home lab", Some("#9ece6a"))
            .await
            .unwrap();
        let id = create_machine(db.pool(), &old, &c.id, &a_machine())
            .await
            .unwrap();

        let new = vault::generate_user_key();
        // Before re-wrapping, the new key opens nothing.
        assert!(list(db.pool(), &new).await.is_err());

        for (coll, meta, items) in rewrapped_keys(db.pool(), &old, &new).await.unwrap() {
            collection_store::add_member(
                db.pool(),
                &coll,
                LOCAL_USER_ID,
                CollectionRole::Owner,
                &meta,
                items.as_deref().unwrap_or_default(),
            )
            .await
            .unwrap();
        }

        // After, everything reads exactly as before — name, colour and machines.
        let all = list(db.pool(), &new).await.unwrap();
        assert_eq!(all[0].name, "Home lab");
        assert_eq!(all[0].color.as_deref(), Some("#9ece6a"));
        let machines = list_machines(db.pool(), &new, &c.id).await.unwrap();
        assert_eq!(machines[0].id, id);
        assert_eq!(machines[0].record, a_machine());
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
