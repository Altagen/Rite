//! Teams / RBAC (product-model.md palier 1).
//!
//! One instance = one organization; teams are the departments within it. The
//! org-level role is on `users.role` (admin = org-admin); the team-level role is
//! per membership here (admin = team-admin | member). This module is the data +
//! authz-primitive layer; endpoint-level authorization is composed in rite-server.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

/// Role of a user within a team.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeamRole {
    Admin,
    Member,
}

impl TeamRole {
    pub fn as_str(self) -> &'static str {
        match self {
            TeamRole::Admin => "admin",
            TeamRole::Member => "member",
        }
    }
    pub fn parse(s: &str) -> TeamRole {
        match s {
            "admin" => TeamRole::Admin,
            _ => TeamRole::Member,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
    pub created_at: i64,
}

/// A team membership joined with the user's name, plus their team role. Carries the
/// member's X25519 public key so a collection key-holder can seal collection keys to it
/// (teams are keyless rosters — ADR 0016).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub user_id: String,
    pub username: String,
    pub role: TeamRole,
    pub public_key: Option<String>,
}

/// A team the current user belongs to, with their role (keyless roster — ADR 0016).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTeam {
    pub id: String,
    pub name: String,
    pub role: TeamRole,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub async fn create_team(db: &SqlitePool, name: &str) -> Result<Team> {
    let id = Uuid::new_v4().to_string();
    let ts = now();
    sqlx::query("INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(name)
        .bind(ts)
        .execute(db)
        .await?;
    Ok(Team {
        id,
        name: name.to_string(),
        created_at: ts,
    })
}

/// All teams in the org (org-admin view).
pub async fn list_teams(db: &SqlitePool) -> Result<Vec<Team>> {
    let rows: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT id, name, created_at FROM teams ORDER BY name")
            .fetch_all(db)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, created_at)| Team {
            id,
            name,
            created_at,
        })
        .collect())
}

pub async fn delete_team(db: &SqlitePool, id: &str) -> Result<bool> {
    let n = sqlx::query("DELETE FROM teams WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?
        .rows_affected();
    Ok(n > 0)
}

pub async fn team_exists(db: &SqlitePool, id: &str) -> Result<bool> {
    let row: Option<(String,)> = sqlx::query_as("SELECT id FROM teams WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await?;
    Ok(row.is_some())
}

/// Add or update a member's role (idempotent upsert).
pub async fn set_member(
    db: &SqlitePool,
    team_id: &str,
    user_id: &str,
    role: TeamRole,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role",
    )
    .bind(team_id)
    .bind(user_id)
    .bind(role.as_str())
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

/// Number of team-admins (Managers) on a team — gates the "last manager can't leave"
/// invariant (a team should never be left with no manager).
pub async fn count_admins(db: &SqlitePool, team_id: &str) -> Result<i64> {
    let (n,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM team_members WHERE team_id = ? AND role = 'admin'")
            .bind(team_id)
            .fetch_one(db)
            .await?;
    Ok(n)
}

pub async fn remove_member(db: &SqlitePool, team_id: &str, user_id: &str) -> Result<bool> {
    let n = sqlx::query("DELETE FROM team_members WHERE team_id = ? AND user_id = ?")
        .bind(team_id)
        .bind(user_id)
        .execute(db)
        .await?
        .rows_affected();
    Ok(n > 0)
}

/// Members of a team (joined with usernames + public keys + key-grant status).
pub async fn list_members(db: &SqlitePool, team_id: &str) -> Result<Vec<TeamMember>> {
    let rows: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT tm.user_id, u.username, tm.role, u.public_key
         FROM team_members tm JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = ? ORDER BY u.username",
    )
    .bind(team_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(user_id, username, role, public_key)| TeamMember {
            user_id,
            username,
            role: TeamRole::parse(&role),
            public_key,
        })
        .collect())
}

/// Teams the given user is a member of, with their role + their sealed team key.
pub async fn list_teams_for_user(db: &SqlitePool, user_id: &str) -> Result<Vec<UserTeam>> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT t.id, t.name, tm.role
         FROM team_members tm JOIN teams t ON t.id = tm.team_id
         WHERE tm.user_id = ? ORDER BY t.name",
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, role)| UserTeam {
            id,
            name,
            role: TeamRole::parse(&role),
        })
        .collect())
}

/// Whether two users share at least one team. Used to enforce the "no sharing outside teams"
/// collection policy: a member may only add someone they already share a team with.
pub async fn users_share_team(db: &SqlitePool, a: &str, b: &str) -> Result<bool> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM team_members ta JOIN team_members tb ON ta.team_id = tb.team_id \
         WHERE ta.user_id = ? AND tb.user_id = ? LIMIT 1",
    )
    .bind(a)
    .bind(b)
    .fetch_optional(db)
    .await?;
    Ok(row.is_some())
}

/// The user's role in a team, or `None` if they are not a member. The core authz
/// primitive: team-admin = `Some(Admin)`, member = `Some(Member)`.
pub async fn team_role(db: &SqlitePool, team_id: &str, user_id: &str) -> Result<Option<TeamRole>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?")
            .bind(team_id)
            .bind(user_id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(role,)| TeamRole::parse(&role)))
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
            false,
        )
        .await
        .unwrap()
        .id
    }

    #[tokio::test]
    async fn team_membership_and_roles() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::new(&dir.path().join("t.db")).await.unwrap();
        let pool = db.pool();
        let alice = user(pool, "alice").await;
        let bob = user(pool, "bob").await;

        let team = create_team(pool, "platform").await.unwrap();
        set_member(pool, &team.id, &alice, TeamRole::Admin)
            .await
            .unwrap();
        set_member(pool, &team.id, &bob, TeamRole::Member)
            .await
            .unwrap();

        assert_eq!(
            team_role(pool, &team.id, &alice).await.unwrap(),
            Some(TeamRole::Admin)
        );
        assert_eq!(
            team_role(pool, &team.id, &bob).await.unwrap(),
            Some(TeamRole::Member)
        );
        assert_eq!(team_role(pool, &team.id, "ghost").await.unwrap(), None);

        assert_eq!(list_members(pool, &team.id).await.unwrap().len(), 2);
        assert_eq!(list_teams_for_user(pool, &alice).await.unwrap().len(), 1);

        // One manager (alice) so far — gates the "last manager can't leave" invariant.
        assert_eq!(count_admins(pool, &team.id).await.unwrap(), 1);

        // Upsert changes the role, doesn't duplicate → now two managers.
        set_member(pool, &team.id, &bob, TeamRole::Admin)
            .await
            .unwrap();
        assert_eq!(
            team_role(pool, &team.id, &bob).await.unwrap(),
            Some(TeamRole::Admin)
        );
        assert_eq!(list_members(pool, &team.id).await.unwrap().len(), 2);
        assert_eq!(count_admins(pool, &team.id).await.unwrap(), 2);

        assert!(remove_member(pool, &team.id, &bob).await.unwrap());
        assert_eq!(count_admins(pool, &team.id).await.unwrap(), 1);
        assert_eq!(team_role(pool, &team.id, &bob).await.unwrap(), None);

        // Deleting the team cascades memberships.
        assert!(delete_team(pool, &team.id).await.unwrap());
        assert_eq!(list_teams_for_user(pool, &alice).await.unwrap().len(), 0);
    }
}
