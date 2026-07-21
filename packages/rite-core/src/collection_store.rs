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
    pub protected_collection_key: String,
    pub created_at: i64,
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

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Create a collection with its creator as the first owner (holding the sealed
/// key). Returns the new collection id.
pub async fn create_collection(
    db: &SqlitePool,
    name_enc: &str,
    owner_user_id: &str,
    owner_protected_key: &str,
) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO collections (id, name_enc, created_at) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(name_enc)
        .bind(now())
        .execute(db)
        .await?;
    add_member(db, &id, owner_user_id, CollectionRole::Owner, owner_protected_key).await?;
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

/// Add or update a member: their role + the collection key sealed to their key
/// (idempotent upsert). The caller (a key-holder) does the sealing.
pub async fn add_member(
    db: &SqlitePool,
    collection_id: &str,
    user_id: &str,
    role: CollectionRole,
    protected_collection_key: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO collection_members (collection_id, user_id, role, protected_collection_key, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(collection_id, user_id) DO UPDATE SET
             role = excluded.role,
             protected_collection_key = excluded.protected_collection_key",
    )
    .bind(collection_id)
    .bind(user_id)
    .bind(role.as_str())
    .bind(protected_collection_key)
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
    let n = sqlx::query("UPDATE collection_members SET role = ? WHERE collection_id = ? AND user_id = ?")
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
    let row: Option<(String,)> =
        sqlx::query_as("SELECT role FROM collection_members WHERE collection_id = ? AND user_id = ?")
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
    let rows: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT cm.user_id, u.username, cm.role, u.public_key
         FROM collection_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.collection_id = ? ORDER BY u.username",
    )
    .bind(collection_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(user_id, username, role, public_key)| CollectionMember {
            user_id,
            username,
            role: CollectionRole::parse(&role),
            public_key,
        })
        .collect())
}

/// Collections the given user is a member of (with their role + sealed key).
pub async fn list_collections_for_user(
    db: &SqlitePool,
    user_id: &str,
) -> Result<Vec<UserCollection>> {
    let rows: Vec<(String, String, String, String, i64)> = sqlx::query_as(
        "SELECT c.id, c.name_enc, cm.role, cm.protected_collection_key, c.created_at
         FROM collection_members cm JOIN collections c ON c.id = cm.collection_id
         WHERE cm.user_id = ? ORDER BY c.created_at",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name_enc, role, protected_collection_key, created_at)| UserCollection {
            id,
            name_enc,
            role: CollectionRole::parse(&role),
            protected_collection_key,
            created_at,
        })
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

pub async fn create_item(db: &SqlitePool, collection_id: &str, blob: &str) -> Result<CollectionItem> {
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
        create_user(db, name, b"s", KdfParams::recommended(), "h", Role::User, &vault)
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
        let cid = create_collection(pool, "v1.enc.name", &alice, "sealed-to-alice")
            .await
            .unwrap();
        assert_eq!(collection_role(pool, &cid, &alice).await.unwrap(), Some(CollectionRole::Owner));
        assert_eq!(collection_role(pool, &cid, &bob).await.unwrap(), None);
        assert_eq!(count_owners(pool, &cid).await.unwrap(), 1);
        assert_eq!(list_collections_for_user(pool, &alice).await.unwrap().len(), 1);

        // She shares it with Bob as an editor (sealing the key to his public key).
        add_member(pool, &cid, &bob, CollectionRole::Editor, "sealed-to-bob")
            .await
            .unwrap();
        let bob_view = &list_collections_for_user(pool, &bob).await.unwrap()[0];
        assert_eq!(bob_view.protected_collection_key, "sealed-to-bob");
        assert_eq!(bob_view.role, CollectionRole::Editor);
        assert!(bob_view.role.can_write());
        assert!(!bob_view.role.can_manage());
        assert_eq!(list_members(pool, &cid).await.unwrap().len(), 2);

        // Items round-trip (opaque blobs).
        let item = create_item(pool, &cid, "v1.iv.ct").await.unwrap();
        assert_eq!(list_items(pool, &cid).await.unwrap().len(), 1);
        assert!(update_item(pool, &cid, &item.id, "v1.iv.ct2").await.unwrap());
        // Wrong-collection scoping: can't touch an item via another collection id.
        assert!(!update_item(pool, "other", &item.id, "x").await.unwrap());
        assert!(delete_item(pool, &cid, &item.id).await.unwrap());
        assert_eq!(list_items(pool, &cid).await.unwrap().len(), 0);

        // Role change (promote Bob to owner) → two owners; demote Alice is then safe.
        assert!(set_role(pool, &cid, &bob, CollectionRole::Owner).await.unwrap());
        assert_eq!(count_owners(pool, &cid).await.unwrap(), 2);

        // Remove Bob; deleting the collection cascades members + items.
        assert!(remove_member(pool, &cid, &bob).await.unwrap());
        assert_eq!(collection_role(pool, &cid, &bob).await.unwrap(), None);
        assert!(delete_collection(pool, &cid).await.unwrap());
        assert_eq!(list_collections_for_user(pool, &alice).await.unwrap().len(), 0);
    }
}
