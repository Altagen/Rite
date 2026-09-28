-- Teams / RBAC (product-model.md palier 1). One instance = one organization
-- (instance-per-tenant); teams are the departments within it. Org-level role
-- lives on users.role ('admin' = org-admin | 'user' = member); team-level role
-- lives here per membership ('admin' = team-admin | 'member').

CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS team_members (
    team_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,              -- 'admin' (team-admin) | 'member'
    created_at INTEGER NOT NULL,
    PRIMARY KEY (team_id, user_id),
    FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
