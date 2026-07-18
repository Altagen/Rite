//! Team shared connection store (ADR 0013 phase 4).
//!
//! A team's connections are opaque blobs encrypted client-side with the team key
//! (AES-256-GCM). Rows are scoped by `team_id`; the server never parses `blob`.
//! Mirrors [`crate::vault_store`] (personal, per-user) but keyed by team. Endpoint
//! authorization (member must hold the team key) is composed in rite-server.

use anyhow::Result;
use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

/// One stored team connection blob (the plaintext lives only client-side).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamConnection {
    pub id: String,
    pub blob: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// List a team's connection blobs, newest first.
pub async fn list(db: &SqlitePool, team_id: &str) -> Result<Vec<TeamConnection>> {
    let rows: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT id, blob, created_at, updated_at FROM team_connections
         WHERE team_id = ? ORDER BY created_at DESC",
    )
    .bind(team_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, blob, created_at, updated_at)| TeamConnection {
            id,
            blob,
            created_at,
            updated_at,
        })
        .collect())
}

/// Store a new connection blob for a team.
pub async fn create(db: &SqlitePool, team_id: &str, blob: &str) -> Result<TeamConnection> {
    let id = Uuid::new_v4().to_string();
    let ts = now();
    sqlx::query(
        "INSERT INTO team_connections (id, team_id, blob, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(team_id)
    .bind(blob)
    .bind(ts)
    .bind(ts)
    .execute(db)
    .await?;
    Ok(TeamConnection {
        id,
        blob: blob.to_string(),
        created_at: ts,
        updated_at: ts,
    })
}

/// Replace a team connection's blob. Scoped by `team_id`. False if no such row.
pub async fn update(db: &SqlitePool, team_id: &str, id: &str, blob: &str) -> Result<bool> {
    let n = sqlx::query(
        "UPDATE team_connections SET blob = ?, updated_at = ? WHERE id = ? AND team_id = ?",
    )
    .bind(blob)
    .bind(now())
    .bind(id)
    .bind(team_id)
    .execute(db)
    .await?
    .rows_affected();
    Ok(n > 0)
}

/// Delete a team connection blob. Scoped by `team_id`.
pub async fn delete(db: &SqlitePool, team_id: &str, id: &str) -> Result<bool> {
    let n = sqlx::query("DELETE FROM team_connections WHERE id = ? AND team_id = ?")
        .bind(id)
        .bind(team_id)
        .execute(db)
        .await?
        .rows_affected();
    Ok(n > 0)
}
