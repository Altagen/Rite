//! Collections (ADR 0016) — the unit of sharing.
//!
//! A collection is an autonomous object: `{ encrypted items } + { explicit member
//! list, each holding the collection key sealed to their X25519 public key } +
//! { per-member role }`. It generalises the personal vault and team connections
//! (kept as optimised special cases for now). The server stores only opaque blobs;
//! the collection NAME itself is encrypted with the collection key, so the server
//! never learns it. This module is the data + authz-primitive layer; endpoint
//! authorization is composed in rite-server. Teams and collections are orthogonal.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

/// A member's role in a collection (RBAC on top of holding the key). Every member
/// holds the key (can decrypt); the role governs what they may DO.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CollectionRole {
    /// Manage sharing/members/roles, rename, delete, transfer. Multiple allowed (≥1).
    Owner,
    /// Add/edit/delete items (re-encrypts for all).
    Editor,
    /// Read-only: can connect, cannot change items.
    Viewer,
}

impl CollectionRole {
    pub fn as_str(self) -> &'static str {
        match self {
            CollectionRole::Owner => "owner",
            CollectionRole::Editor => "editor",
            CollectionRole::Viewer => "viewer",
        }
    }
    pub fn parse(s: &str) -> CollectionRole {
        match s {
            "owner" => CollectionRole::Owner,
            "viewer" => CollectionRole::Viewer,
            _ => CollectionRole::Editor,
        }
    }
    /// May add/edit/delete items.
    pub fn can_write(self) -> bool {
        matches!(self, CollectionRole::Owner | CollectionRole::Editor)
    }
    /// May manage membership/roles and delete the collection.
    pub fn can_manage(self) -> bool {
        matches!(self, CollectionRole::Owner)
    }
}

/// A collection the current user belongs to, with their role + their sealed key
/// (unwrapped client-side with their private key) + the encrypted name.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserCollection {
    pub id: String,
    pub name_enc: String,
    pub role: CollectionRole,
    /// The collection's metaKey (name/colour) sealed to this member (ADR 0016 split).
    pub protected_meta_key: String,
    /// The collection's itemsKey (machines/credentials) sealed to this member, or
    /// `None` for a roster-only member (admin meta-add) until a member seals machine
    /// access.
    pub protected_items_key: Option<String>,
    pub created_at: i64,
    /// If offered to a team for discovery (ADR 0016): the team it's offered to and the
    /// plaintext discovery label (both `None` when not offered). Neither is cryptographic.
    pub team_id: Option<String>,
    pub discovery_label: Option<String>,
}

/// A member of a collection (for the member list / manage UI). Carries the user's
/// X25519 public key so an owner can (re-)seal the collection key to them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionMember {
    pub user_id: String,
    pub username: String,
    pub role: CollectionRole,
    pub public_key: Option<String>,
    /// Whether this member holds the itemsKey (machine access). `false` for a
    /// roster-only member (admin meta-add) awaiting a member to seal it.
    pub has_items_key: bool,
}

/// An encrypted item (a machine/connection) in a collection.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionItem {
    pub id: String,
    pub blob: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A pending access request on a collection the caller can grant (owner/editor inbox). Carries
/// the requester + which team offer they discovered it through (for context in the UI).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingRequest {
    pub collection_id: String,
    pub user_id: String,
    pub username: String,
    pub public_key: Option<String>,
    pub team_name: Option<String>,
    pub created_at: i64,
}

/// Governance summary of a collection for the admin console — counts only, no key
/// needed. The name stays encrypted (the server never learns it); admins govern
/// membership and lifecycle. Ordered newest first.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSummary {
    pub id: String,
    pub created_at: i64,
    pub member_count: i64,
    pub item_count: i64,
    /// The encrypted name/colour blob — opaque to the server, but an admin holding the
    /// group escrow can decrypt it (via `meta_key_group_enc`).
    pub name_enc: String,
    /// The collection's metaKey sealed to the Admin-group public key (escrow), or
    /// `None` for collections not escrowed (pre-split, or created before any admin
    /// bootstrapped the group key). An admin unseals this → metaKey → the name.
    pub meta_key_group_enc: Option<String>,
    /// The Admin-group epoch the escrow was sealed to (matches `admin_group_key`).
    pub group_epoch: Option<i64>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Create a collection with its creator as the first owner (holding the sealed
/// key). Returns the new collection id.
pub async fn create_collection(
    db: &SqlitePool,
    name_enc: &str,
    owner_user_id: &str,
    owner_protected_meta_key: &str,
    owner_protected_items_key: &str,
) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO collections (id, name_enc, created_at) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(name_enc)
        .bind(now())
        .execute(db)
        .await?;
    add_member(
        db,
        &id,
        owner_user_id,
        CollectionRole::Owner,
        owner_protected_meta_key,
        owner_protected_items_key,
    )
    .await?;
    Ok(id)
}

/// Update a collection's encrypted name/color blob (an owner/editor action).
pub async fn set_name_enc(db: &SqlitePool, id: &str, name_enc: &str) -> Result<bool> {
    let n = sqlx::query("UPDATE collections SET name_enc = ? WHERE id = ?")
        .bind(name_enc)
        .bind(id)
        .execute(db)
        .await?
        .rows_affected();
    Ok(n > 0)
}

pub async fn delete_collection(db: &SqlitePool, id: &str) -> Result<bool> {
    let n = sqlx::query("DELETE FROM collections WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?
        .rows_affected();
    Ok(n > 0)
}

pub async fn collection_exists(db: &SqlitePool, id: &str) -> Result<bool> {
    let row: Option<(String,)> = sqlx::query_as("SELECT id FROM collections WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?;
    Ok(row.is_some())
}

/// Add or update a member: their role + the collection's two keys (metaKey +
/// itemsKey) each sealed to their public key (idempotent upsert). The caller (a
/// key-holder) does the sealing.
pub async fn add_member(
    db: &SqlitePool,
    collection_id: &str,
    user_id: &str,
    role: CollectionRole,
    protected_meta_key: &str,
    protected_items_key: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO collection_members
             (collection_id, user_id, role, protected_meta_key, protected_items_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(collection_id, user_id) DO UPDATE SET
             role = excluded.role,
             protected_meta_key = excluded.protected_meta_key,
             protected_items_key = excluded.protected_items_key",
    )
    .bind(collection_id)
    .bind(user_id)
    .bind(role.as_str())
    .bind(protected_meta_key)
    .bind(protected_items_key)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

/// Add a member with ONLY the metaKey sealed (name/roster access, no machines) — an
/// admin roster action via the group escrow. `protected_items_key` stays NULL until a
/// real member seals the itemsKey to complete their access. Idempotent, but never
/// downgrades: if the user is already a full member it leaves their itemsKey intact.
pub async fn add_member_meta_only(
    db: &SqlitePool,
    collection_id: &str,
    user_id: &str,
    role: CollectionRole,
    protected_meta_key: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO collection_members
             (collection_id, user_id, role, protected_meta_key, protected_items_key, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(collection_id, user_id) DO UPDATE SET
             role = excluded.role,
             protected_meta_key = excluded.protected_meta_key",
    )
    .bind(collection_id)
    .bind(user_id)
    .bind(role.as_str())
    .bind(protected_meta_key)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

/// Change a member's role without touching their key (owner management).
pub async fn set_role(
    db: &SqlitePool,
    collection_id: &str,
    user_id: &str,
    role: CollectionRole,
) -> Result<bool> {
    let n = sqlx::query(
        "UPDATE collection_members SET role = ? WHERE collection_id = ? AND user_id = ?",
    )
    .bind(role.as_str())
    .bind(collection_id)
    .bind(user_id)
    .execute(db)
    .await?
    .rows_affected();
    Ok(n > 0)
}

pub async fn remove_member(db: &SqlitePool, collection_id: &str, user_id: &str) -> Result<bool> {
    let n = sqlx::query("DELETE FROM collection_members WHERE collection_id = ? AND user_id = ?")
        .bind(collection_id)
        .bind(user_id)
        .execute(db)
        .await?
        .rows_affected();
    Ok(n > 0)
}

/// The user's role in a collection, or `None` if they are not a member.
pub async fn collection_role(
    db: &SqlitePool,
    collection_id: &str,
    user_id: &str,
) -> Result<Option<CollectionRole>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT role FROM collection_members WHERE collection_id = ? AND user_id = ?",
    )
    .bind(collection_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(role,)| CollectionRole::parse(&role)))
}

/// How many owners a collection has (to keep the ≥1-owner invariant).
pub async fn count_owners(db: &SqlitePool, collection_id: &str) -> Result<i64> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM collection_members WHERE collection_id = ? AND role = 'owner'",
    )
    .bind(collection_id)
    .fetch_one(db)
    .await?;
    Ok(n)
}

/// The member list joined with usernames + public keys (for the manage UI / picker).
pub async fn list_members(db: &SqlitePool, collection_id: &str) -> Result<Vec<CollectionMember>> {
    let rows: Vec<(String, String, String, Option<String>, bool)> = sqlx::query_as(
        "SELECT cm.user_id, u.username, cm.role, u.public_key,
                cm.protected_items_key IS NOT NULL AS has_items_key
         FROM collection_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.collection_id = ? ORDER BY u.username",
    )
    .bind(collection_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(user_id, username, role, public_key, has_items_key)| CollectionMember {
                user_id,
                username,
                role: CollectionRole::parse(&role),
                public_key,
                has_items_key,
            },
        )
        .collect())
}

/// Collections the given user is a member of (with their role + sealed key).
pub async fn list_collections_for_user(
    db: &SqlitePool,
    user_id: &str,
) -> Result<Vec<UserCollection>> {
    let rows: Vec<(
        String,
        String,
        String,
        String,
        Option<String>,
        i64,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT c.id, c.name_enc, cm.role, cm.protected_meta_key, cm.protected_items_key,
                c.created_at, c.team_id, c.discovery_label
         FROM collection_members cm JOIN collections c ON c.id = cm.collection_id
         WHERE cm.user_id = ? ORDER BY c.created_at",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, name_enc, role, protected_meta_key, protected_items_key, created_at, team_id, discovery_label)| {
                UserCollection {
                    id,
                    name_enc,
                    role: CollectionRole::parse(&role),
                    protected_meta_key,
                    protected_items_key,
                    created_at,
                    team_id,
                    discovery_label,
                }
            },
        )
        .collect())
}

/// A collection offered to a team the caller belongs to (opt-in discovery, ADR 0016).
/// Only the plaintext `discovery_label` is exposed (RBAC-gated to the team's members); the
/// real name and machines stay end-to-end encrypted. `member_role` is set when the caller
/// already belongs, so the UI can offer "Open" vs "Request access".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferedCollection {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    pub discovery_label: String,
    pub member_role: Option<CollectionRole>,
}

/// Record a pending access request (idempotent — one row per collection+user). Called after
/// the endpoint has checked the caller may discover the collection via a team offer.
pub async fn add_access_request(db: &SqlitePool, collection_id: &str, user_id: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO access_requests (collection_id, user_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(collection_id, user_id) DO NOTHING",
    )
    .bind(collection_id)
    .bind(user_id)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

/// Remove a pending request (on grant or dismiss). Returns false if there was none.
pub async fn remove_access_request(
    db: &SqlitePool,
    collection_id: &str,
    user_id: &str,
) -> Result<bool> {
    let n = sqlx::query("DELETE FROM access_requests WHERE collection_id = ? AND user_id = ?")
        .bind(collection_id)
        .bind(user_id)
        .execute(db)
        .await?
        .rows_affected();
    Ok(n > 0)
}

/// Access requests on collections the caller can grant (they are an owner/editor). Joins the
/// requester's name/public key + the team the collection is offered to (for context).
pub async fn list_incoming_requests(
    db: &SqlitePool,
    grantee_id: &str,
) -> Result<Vec<IncomingRequest>> {
    let rows: Vec<(String, String, String, Option<String>, Option<String>, i64)> = sqlx::query_as(
        "SELECT ar.collection_id, ar.user_id, u.username, u.public_key, t.name, ar.created_at
         FROM access_requests ar
         JOIN collection_members me
              ON me.collection_id = ar.collection_id AND me.user_id = ?
                 AND me.role IN ('owner', 'editor')
         JOIN users u ON u.id = ar.user_id
         LEFT JOIN teams t ON t.id = (SELECT team_id FROM collections WHERE id = ar.collection_id)
         ORDER BY ar.created_at",
    )
    .bind(grantee_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(collection_id, user_id, username, public_key, team_name, created_at)| IncomingRequest {
                collection_id,
                user_id,
                username,
                public_key,
                team_name,
                created_at,
            },
        )
        .collect())
}

/// Set or clear a collection's team offer (owner action, enforced at the endpoint). Passing
/// `None` for both clears the offer. team_id is an org link, discovery_label a plaintext,
/// RBAC-gated label — neither is cryptographic.
pub async fn set_collection_offer(
    db: &SqlitePool,
    id: &str,
    team_id: Option<&str>,
    discovery_label: Option<&str>,
) -> Result<bool> {
    let n = sqlx::query("UPDATE collections SET team_id = ?, discovery_label = ? WHERE id = ?")
        .bind(team_id)
        .bind(discovery_label)
        .bind(id)
        .execute(db)
        .await?
        .rows_affected();
    Ok(n > 0)
}

/// Collections offered to the teams the user belongs to (discovery). RBAC: only teams the
/// user is a member of, and only collections that carry a discovery label.
pub async fn list_offered_to_user(
    db: &SqlitePool,
    user_id: &str,
) -> Result<Vec<OfferedCollection>> {
    let rows: Vec<(String, String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT c.id, c.team_id, t.name, c.discovery_label,
                (SELECT role FROM collection_members WHERE collection_id = c.id AND user_id = ?)
         FROM collections c
         JOIN team_members tm ON tm.team_id = c.team_id AND tm.user_id = ?
         JOIN teams t ON t.id = c.team_id
         WHERE c.team_id IS NOT NULL AND c.discovery_label IS NOT NULL
         ORDER BY t.name, c.discovery_label",
    )
    .bind(user_id)
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, team_id, team_name, discovery_label, my_role)| OfferedCollection {
            id,
            team_id,
            team_name,
            discovery_label,
            member_role: my_role.map(|r| CollectionRole::parse(&r)),
        })
        .collect())
}

/// Every collection with member + item counts (admin governance). No key needed;
/// names remain encrypted.
pub async fn list_all_collections(db: &SqlitePool) -> Result<Vec<CollectionSummary>> {
    let rows: Vec<(String, i64, i64, i64, String, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT c.id, c.created_at,
            (SELECT COUNT(*) FROM collection_members m WHERE m.collection_id = c.id) AS member_count,
            (SELECT COUNT(*) FROM collection_items i WHERE i.collection_id = c.id) AS item_count,
            c.name_enc, c.meta_key_group_enc, c.group_epoch
         FROM collections c ORDER BY c.created_at DESC",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                created_at,
                member_count,
                item_count,
                name_enc,
                meta_key_group_enc,
                group_epoch,
            )| {
                CollectionSummary {
                    id,
                    created_at,
                    member_count,
                    item_count,
                    name_enc,
                    meta_key_group_enc,
                    group_epoch,
                }
            },
        )
        .collect())
}

// --- items ------------------------------------------------------------------

pub async fn list_items(db: &SqlitePool, collection_id: &str) -> Result<Vec<CollectionItem>> {
    let rows: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT id, blob, created_at, updated_at FROM collection_items
         WHERE collection_id = ? ORDER BY created_at",
    )
    .bind(collection_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, blob, created_at, updated_at)| CollectionItem {
            id,
            blob,
            created_at,
            updated_at,
        })
        .collect())
}

pub async fn create_item(
    db: &SqlitePool,
    collection_id: &str,
    blob: &str,
) -> Result<CollectionItem> {
    let id = Uuid::new_v4().to_string();
    let ts = now();
    sqlx::query(
        "INSERT INTO collection_items (id, collection_id, blob, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(collection_id)
    .bind(blob)
    .bind(ts)
    .bind(ts)
    .execute(db)
    .await?;
    Ok(CollectionItem {
        id,
        blob: blob.to_string(),
        created_at: ts,
        updated_at: ts,
    })
}

/// Update an item's blob (scoped to the collection). Returns false if not found.
pub async fn update_item(
    db: &SqlitePool,
    collection_id: &str,
    item_id: &str,
    blob: &str,
) -> Result<bool> {
    let n = sqlx::query(
        "UPDATE collection_items SET blob = ?, updated_at = ? WHERE id = ? AND collection_id = ?",
    )
    .bind(blob)
    .bind(now())
    .bind(item_id)
    .bind(collection_id)
    .execute(db)
    .await?
    .rows_affected();
    Ok(n > 0)
}

pub async fn delete_item(db: &SqlitePool, collection_id: &str, item_id: &str) -> Result<bool> {
    let n = sqlx::query("DELETE FROM collection_items WHERE id = ? AND collection_id = ?")
        .bind(item_id)
        .bind(collection_id)
        .execute(db)
        .await?
        .rows_affected();
    Ok(n > 0)
}

// ---------------------------------------------------------------------------
// Admin-group escrow (ADR 0016 split-key model).
//
// The Admin group has a versioned X25519 keypair (`admin_group_key`, one row per
// epoch). A collection's metaKey is sealed once to the current group PUBLIC key
// (`collections.meta_key_group_enc`); the group PRIVATE key is sealed to each admin
// (`admin_group_grants`). So an admin unwraps the group key with their own key, then
// unwraps a collection's metaKey → the name — never the itemsKey (machines). The
// server only ever stores sealed blobs; it holds no key. Adding an admin = one new
// grant; removing one = a fresh epoch (rotation), re-sealing every escrow client-side.
// ---------------------------------------------------------------------------

/// The current (highest-epoch) Admin-group public key, or `None` if never bootstrapped.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminGroupKey {
    pub epoch: i64,
    pub public_key: String,
}

/// An admin's sealed copy of the group private key for a given epoch.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminGroupGrant {
    pub epoch: i64,
    pub protected_private_key: String,
}

/// An admin who can hold a group grant (has a published X25519 public key).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminKey {
    pub user_id: String,
    pub username: String,
    pub public_key: String,
}

/// Set (or clear) a collection's metaKey escrow to the Admin group's current epoch.
pub async fn set_collection_group_escrow(
    db: &SqlitePool,
    collection_id: &str,
    meta_key_group_enc: &str,
    group_epoch: i64,
) -> Result<bool> {
    let n =
        sqlx::query("UPDATE collections SET meta_key_group_enc = ?, group_epoch = ? WHERE id = ?")
            .bind(meta_key_group_enc)
            .bind(group_epoch)
            .bind(collection_id)
            .execute(db)
            .await?
            .rows_affected();
    Ok(n > 0)
}

/// The current Admin-group public key (highest epoch), or `None`.
pub async fn current_admin_group(db: &SqlitePool) -> Result<Option<AdminGroupKey>> {
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT epoch, public_key FROM admin_group_key ORDER BY epoch DESC LIMIT 1")
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(epoch, public_key)| AdminGroupKey { epoch, public_key }))
}

/// An admin's sealed group private key for the current epoch, or `None` if they
/// have no grant yet (e.g. promoted after the last rotation — needs a re-grant).
pub async fn admin_group_grant(db: &SqlitePool, user_id: &str) -> Result<Option<AdminGroupGrant>> {
    let row: Option<(i64, String)> = sqlx::query_as(
        "SELECT g.epoch, g.protected_private_key
         FROM admin_group_grants g
         WHERE g.user_id = ? AND g.epoch = (SELECT MAX(epoch) FROM admin_group_key)",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(epoch, protected_private_key)| AdminGroupGrant {
        epoch,
        protected_private_key,
    }))
}

/// Bootstrap or rotate the Admin group: insert a new epoch public key and the group
/// private key sealed to each admin. One transaction so the epoch and its grants land
/// together (a half-written epoch would lock everyone out of the new key).
pub async fn set_admin_group(
    db: &SqlitePool,
    epoch: i64,
    public_key: &str,
    grants: &[(String, String)], // (user_id, protected_private_key)
) -> Result<()> {
    let mut tx = db.begin().await?;
    let ts = now();
    sqlx::query("INSERT INTO admin_group_key (epoch, public_key, created_at) VALUES (?, ?, ?)")
        .bind(epoch)
        .bind(public_key)
        .bind(ts)
        .execute(&mut *tx)
        .await?;
    for (user_id, protected_private_key) in grants {
        sqlx::query(
            "INSERT INTO admin_group_grants (epoch, user_id, protected_private_key, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(epoch, user_id) DO UPDATE SET
                 protected_private_key = excluded.protected_private_key",
        )
        .bind(epoch)
        .bind(user_id)
        .bind(protected_private_key)
        .bind(ts)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Add a single admin grant for the current epoch (promoting/adding an admin — no
/// rotation needed, just seal the existing group private key to them).
pub async fn add_admin_group_grant(
    db: &SqlitePool,
    epoch: i64,
    user_id: &str,
    protected_private_key: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO admin_group_grants (epoch, user_id, protected_private_key, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(epoch, user_id) DO UPDATE SET
             protected_private_key = excluded.protected_private_key",
    )
    .bind(epoch)
    .bind(user_id)
    .bind(protected_private_key)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

/// Active admins (role = 'admin', status = 'active') that have a published X25519
/// public key — the recipients a group grant can be sealed to. Disabled admins are
/// excluded so disabling one (then rotating) actually cuts their future name access
/// instead of re-granting them.
pub async fn list_admins_with_keys(db: &SqlitePool) -> Result<Vec<AdminKey>> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, username, public_key FROM users
         WHERE role = 'admin' AND status = 'active'
           AND public_key IS NOT NULL AND public_key <> ''
         ORDER BY username",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(user_id, username, public_key)| AdminKey {
            user_id,
            username,
            public_key,
        })
        .collect())
}

/// Every collection's id + its current metaKey escrow (for a rotation pass: an admin
/// re-seals each to a new group epoch). Names stay encrypted.
pub async fn list_collection_escrows(db: &SqlitePool) -> Result<Vec<(String, Option<String>)>> {
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT id, meta_key_group_enc FROM collections ORDER BY created_at")
            .fetch_all(db)
            .await?;
    Ok(rows)
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
            public_key: "abcd".to_string(),
            protected_private_key: "v1.p.q".to_string(),
        };
        create_user(
            db,
            name,
            b"s",
            KdfParams::recommended(),
            "h",
            Role::User,
            &vault,
        )
        .await
        .unwrap()
        .id
    }

    #[tokio::test]
    async fn collection_lifecycle_members_roles_items() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::new(&dir.path().join("c.db")).await.unwrap();
        let pool = db.pool();
        let alice = user(pool, "alice").await;
        let bob = user(pool, "bob").await;

        // Alice creates a collection → she is its sole owner, holding the sealed key.
        let cid = create_collection(
            pool,
            "v1.enc.name",
            &alice,
            "meta-to-alice",
            "items-to-alice",
        )
        .await
        .unwrap();
        assert_eq!(
            collection_role(pool, &cid, &alice).await.unwrap(),
            Some(CollectionRole::Owner)
        );
        assert_eq!(collection_role(pool, &cid, &bob).await.unwrap(), None);
        assert_eq!(count_owners(pool, &cid).await.unwrap(), 1);
        assert_eq!(
            list_collections_for_user(pool, &alice).await.unwrap().len(),
            1
        );

        // She shares it with Bob as an editor (sealing both keys to his public key).
        add_member(
            pool,
            &cid,
            &bob,
            CollectionRole::Editor,
            "meta-to-bob",
            "items-to-bob",
        )
        .await
        .unwrap();
        let bob_view = &list_collections_for_user(pool, &bob).await.unwrap()[0];
        assert_eq!(bob_view.protected_meta_key, "meta-to-bob");
        assert_eq!(
            bob_view.protected_items_key.as_deref(),
            Some("items-to-bob")
        );
        assert_eq!(bob_view.role, CollectionRole::Editor);
        assert!(bob_view.role.can_write());
        assert!(!bob_view.role.can_manage());
        assert_eq!(list_members(pool, &cid).await.unwrap().len(), 2);

        // Items round-trip (opaque blobs).
        let item = create_item(pool, &cid, "v1.iv.ct").await.unwrap();
        assert_eq!(list_items(pool, &cid).await.unwrap().len(), 1);
        assert!(
            update_item(pool, &cid, &item.id, "v1.iv.ct2")
                .await
                .unwrap()
        );
        // Wrong-collection scoping: can't touch an item via another collection id.
        assert!(!update_item(pool, "other", &item.id, "x").await.unwrap());
        assert!(delete_item(pool, &cid, &item.id).await.unwrap());
        assert_eq!(list_items(pool, &cid).await.unwrap().len(), 0);

        // Role change (promote Bob to owner) → two owners; demote Alice is then safe.
        assert!(
            set_role(pool, &cid, &bob, CollectionRole::Owner)
                .await
                .unwrap()
        );
        assert_eq!(count_owners(pool, &cid).await.unwrap(), 2);

        // Remove Bob; deleting the collection cascades members + items.
        assert!(remove_member(pool, &cid, &bob).await.unwrap());
        assert_eq!(collection_role(pool, &cid, &bob).await.unwrap(), None);
        assert!(delete_collection(pool, &cid).await.unwrap());
        assert_eq!(
            list_collections_for_user(pool, &alice).await.unwrap().len(),
            0
        );
    }

    #[tokio::test]
    async fn offer_to_team_discovery() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::new(&dir.path().join("o.db")).await.unwrap();
        let pool = db.pool();
        let alice = user(pool, "alice").await; // collection owner + team member
        let bob = user(pool, "bob").await; // team member, not a collection member
        let carol = user(pool, "carol").await; // NOT in the team

        // A team with alice + bob (carol excluded).
        let team = crate::teams::create_team(pool, "Eng").await.unwrap();
        crate::teams::set_member(pool, &team.id, &alice, crate::teams::TeamRole::Admin)
            .await
            .unwrap();
        crate::teams::set_member(pool, &team.id, &bob, crate::teams::TeamRole::Member)
            .await
            .unwrap();

        // Alice's collection, offered to the team.
        let cid = create_collection(pool, "v1.enc", &alice, "m", "i")
            .await
            .unwrap();
        assert!(
            set_collection_offer(pool, &cid, Some(&team.id), Some("Prod servers"))
                .await
                .unwrap()
        );

        // Bob (team member, not a collection member) discovers it — no membership.
        let bob_offered = list_offered_to_user(pool, &bob).await.unwrap();
        assert_eq!(bob_offered.len(), 1);
        assert_eq!(bob_offered[0].discovery_label, "Prod servers");
        assert_eq!(bob_offered[0].member_role, None);

        // Alice sees it too, already a member (owner).
        let alice_offered = list_offered_to_user(pool, &alice).await.unwrap();
        assert_eq!(alice_offered.len(), 1);
        assert_eq!(alice_offered[0].member_role, Some(CollectionRole::Owner));

        // Carol is NOT in the team → RBAC: sees nothing (no discovery leak).
        assert!(list_offered_to_user(pool, &carol).await.unwrap().is_empty());

        // Clearing the offer hides it again and blanks the collection's offer fields.
        assert!(set_collection_offer(pool, &cid, None, None).await.unwrap());
        assert!(list_offered_to_user(pool, &bob).await.unwrap().is_empty());
        let alice_coll = &list_collections_for_user(pool, &alice).await.unwrap()[0];
        assert_eq!(alice_coll.team_id, None);
        assert_eq!(alice_coll.discovery_label, None);
    }

    #[tokio::test]
    async fn access_requests_flow() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::new(&dir.path().join("r.db")).await.unwrap();
        let pool = db.pool();
        let alice = user(pool, "alice").await; // owner
        let bob = user(pool, "bob").await; // editor (a key-holder → can grant)
        let dan = user(pool, "dan").await; // requester

        let cid = create_collection(pool, "v1.enc", &alice, "m", "i")
            .await
            .unwrap();
        add_member(pool, &cid, &bob, CollectionRole::Editor, "m2", "i2")
            .await
            .unwrap();

        // Dan requests access (idempotent — a second call is a no-op).
        add_access_request(pool, &cid, &dan).await.unwrap();
        add_access_request(pool, &cid, &dan).await.unwrap();

        // Owner and editor both see it in their inbox; the requester (dan) does not.
        assert_eq!(list_incoming_requests(pool, &alice).await.unwrap().len(), 1);
        let bob_inbox = list_incoming_requests(pool, &bob).await.unwrap();
        assert_eq!(bob_inbox.len(), 1);
        assert_eq!(bob_inbox[0].username, "dan");
        assert!(list_incoming_requests(pool, &dan).await.unwrap().is_empty());

        // Resolving (grant or dismiss) removes it; a second resolve is a no-op.
        assert!(remove_access_request(pool, &cid, &dan).await.unwrap());
        assert!(!remove_access_request(pool, &cid, &dan).await.unwrap());
        assert!(list_incoming_requests(pool, &alice).await.unwrap().is_empty());
    }
}
