-- Team shared connections (ADR 0013 phase 4). A team's connections are stored as
-- opaque blobs encrypted client-side with the team key (AES-256-GCM). Every row
-- is scoped by team_id; the server never parses `blob`. Only members who hold the
-- team key can read/write them. Mirrors `vault_connections` (personal), keyed by
-- team instead of user.

CREATE TABLE IF NOT EXISTS team_connections (
    id TEXT PRIMARY KEY NOT NULL,
    team_id TEXT NOT NULL,
    blob TEXT NOT NULL,            -- v1.iv.ct : AES-256-GCM(teamKey, connection JSON)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_team_conn_team ON team_connections(team_id);
