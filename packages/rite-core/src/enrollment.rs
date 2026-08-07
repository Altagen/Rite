//! Enrollment tokens (ADR 0015 phase 3).
//!
//! An admin (or a manager, for user-role tokens) mints a single-use invitation encoding an org
//! role + team membership(s) + expiry. The opaque token is high-entropy; only its SHA-256 is
//! stored (plus a short display prefix), so a DB dump yields nothing usable. The token carries NO
//! keys — team-secret access still follows the usual member grant (ADR 0013/0016). Redeeming is an
//! atomic single-use claim, released again if the signup that follows fails.

use anyhow::Result;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::server_auth::Role;
use crate::teams::TeamRole;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// One team grant in a token recipe.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamGrant {
    pub team_id: String,
    pub team_role: TeamRole,
}

/// The recipe an admin encodes when minting a token.
pub struct NewToken {
    pub role: Role,
    pub teams: Vec<(String, TeamRole)>, // (team_id, team_role)
    pub expires_in_secs: Option<i64>,   // None = never
}

/// A token as listed for the admin — never the plaintext, only the display prefix + metadata.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenInfo {
    pub id: String,
    pub prefix: String,
    pub role: Role,
    pub teams: Vec<TeamGrant>,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub consumed_at: Option<i64>,
}

/// The recipe returned by a successful claim, to apply to the freshly-created user.
pub struct ClaimedRecipe {
    pub id: String,
    pub role: Role,
    pub teams: Vec<(String, TeamRole)>,
}

/// Mint a token. Returns the plaintext token (shown to the admin ONCE) and its stored info.
pub async fn create(
    db: &SqlitePool,
    spec: NewToken,
    created_by: &str,
) -> Result<(String, TokenInfo)> {
    let token = format!(
        "rite_{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let prefix: String = token.chars().take(9).collect(); // "rite_" + 4 hex
    let id = Uuid::new_v4().to_string();
    let created_at = now();
    let expires_at = spec.expires_in_secs.map(|s| created_at + s);
    sqlx::query(
        "INSERT INTO enrollment_tokens (id, token_hash, prefix, role, expires_at, created_by, created_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind(&id)
    .bind(token_hash(&token))
    .bind(&prefix)
    .bind(spec.role.as_str())
    .bind(expires_at)
    .bind(created_by)
    .bind(created_at)
    .execute(db)
    .await?;
    let mut teams = Vec::new();
    for (team_id, team_role) in &spec.teams {
        sqlx::query(
            "INSERT INTO enrollment_token_teams (token_id, team_id, team_role) VALUES (?, ?, ?)",
        )
        .bind(&id)
        .bind(team_id)
        .bind(team_role.as_str())
        .execute(db)
        .await?;
        teams.push(TeamGrant {
            team_id: team_id.clone(),
            team_role: *team_role,
        });
    }
    let info = TokenInfo {
        id,
        prefix,
        role: spec.role,
        teams,
        expires_at,
        created_at,
        consumed_at: None,
    };
    Ok((token, info))
}

/// All tokens with their team grants, newest first (for the admin list).
#[allow(clippy::type_complexity)] // the sqlx row is a one-off select tuple, mapped immediately below
pub async fn list(db: &SqlitePool) -> Result<Vec<TokenInfo>> {
    let rows: Vec<(String, String, String, Option<i64>, i64, Option<i64>)> = sqlx::query_as(
        "SELECT id, prefix, role, expires_at, created_at, consumed_at FROM enrollment_tokens ORDER BY created_at DESC",
    )
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, prefix, role, expires_at, created_at, consumed_at) in rows {
        let teams = token_teams(db, &id).await?;
        out.push(TokenInfo {
            id,
            prefix,
            role: Role::parse(&role),
            teams,
            expires_at,
            created_at,
            consumed_at,
        });
    }
    Ok(out)
}

async fn token_teams(db: &SqlitePool, token_id: &str) -> Result<Vec<TeamGrant>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT team_id, team_role FROM enrollment_token_teams WHERE token_id = ?")
            .bind(token_id)
            .fetch_all(db)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(team_id, team_role)| TeamGrant {
            team_id,
            team_role: TeamRole::parse(&team_role),
        })
        .collect())
}

/// The org role a token grants, by id (to scope the admin surface). None if the id is unknown.
pub async fn role_of(db: &SqlitePool, id: &str) -> Result<Option<Role>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT role FROM enrollment_tokens WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|(r,)| Role::parse(&r)))
}

/// Revoke (delete) a token. Cascade removes its team rows. Returns whether one was removed.
pub async fn revoke(db: &SqlitePool, id: &str) -> Result<bool> {
    let n = sqlx::query("DELETE FROM enrollment_tokens WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?
        .rows_affected();
    Ok(n > 0)
}

/// Atomically claim a token for redemption: marks it consumed iff still unconsumed and unexpired,
/// then returns its recipe. `None` when the token is unknown, already used, or expired. The caller
/// creates the user + applies the team grants, and calls [`release`] if the signup fails so the
/// single-use invite can be retried.
pub async fn claim(db: &SqlitePool, token: &str) -> Result<Option<ClaimedRecipe>> {
    let hash = token_hash(token);
    let ts = now();
    let n = sqlx::query(
        "UPDATE enrollment_tokens SET consumed_at = ?
         WHERE token_hash = ? AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
    )
    .bind(ts)
    .bind(&hash)
    .bind(ts)
    .execute(db)
    .await?
    .rows_affected();
    if n == 0 {
        return Ok(None);
    }
    let (id, role): (String, String) =
        sqlx::query_as("SELECT id, role FROM enrollment_tokens WHERE token_hash = ?")
            .bind(&hash)
            .fetch_one(db)
            .await?;
    let teams = token_teams(db, &id)
        .await?
        .into_iter()
        .map(|g| (g.team_id, g.team_role))
        .collect();
    Ok(Some(ClaimedRecipe {
        id,
        role: Role::parse(&role),
        teams,
    }))
}

/// Undo a claim (on a failed signup) so the single-use invite can be retried.
pub async fn release(db: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("UPDATE enrollment_tokens SET consumed_at = NULL WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    async fn pool() -> SqlitePool {
        let dir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        Database::new(&dir.path().join("t.db"))
            .await
            .unwrap()
            .pool()
            .clone()
    }

    #[tokio::test]
    async fn create_list_and_claim_is_single_use() {
        let db = pool().await;
        let (token, info) = create(
            &db,
            NewToken {
                role: Role::User,
                teams: vec![("team-1".into(), TeamRole::Member)],
                expires_in_secs: Some(3600),
            },
            "admin-1",
        )
        .await
        .unwrap();
        assert!(token.starts_with("rite_"));
        assert_eq!(info.prefix, &token[..9]);

        let listed = list(&db).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].role, Role::User);
        assert_eq!(listed[0].teams.len(), 1);
        assert!(listed[0].consumed_at.is_none());

        // First claim wins and returns the recipe; a second claim of the same token fails.
        let claimed = claim(&db, &token)
            .await
            .unwrap()
            .expect("first claim succeeds");
        assert_eq!(claimed.role, Role::User);
        assert_eq!(
            claimed.teams,
            vec![("team-1".to_string(), TeamRole::Member)]
        );
        assert!(
            claim(&db, &token).await.unwrap().is_none(),
            "single-use: second claim fails"
        );

        // Release re-opens it (failed-signup retry).
        release(&db, &claimed.id).await.unwrap();
        assert!(
            claim(&db, &token).await.unwrap().is_some(),
            "released token can be claimed again"
        );
    }

    #[tokio::test]
    async fn expired_and_revoked_cannot_be_claimed() {
        let db = pool().await;
        let (expired, _) = create(
            &db,
            NewToken {
                role: Role::User,
                teams: vec![],
                expires_in_secs: Some(-1),
            },
            "admin-1",
        )
        .await
        .unwrap();
        assert!(
            claim(&db, &expired).await.unwrap().is_none(),
            "expired token can't be claimed"
        );

        let (live, info) = create(
            &db,
            NewToken {
                role: Role::Manager,
                teams: vec![],
                expires_in_secs: None,
            },
            "admin-1",
        )
        .await
        .unwrap();
        assert!(revoke(&db, &info.id).await.unwrap(), "revoke removes it");
        assert!(
            claim(&db, &live).await.unwrap().is_none(),
            "revoked token can't be claimed"
        );
        assert!(
            !revoke(&db, &info.id).await.unwrap(),
            "revoking a gone token is false"
        );
    }
}
