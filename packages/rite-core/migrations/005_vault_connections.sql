-- Per-user zero-knowledge connections (ADR 0011 phase 3).
--
-- A shared/team server in accounts mode stores each user's connections as an
-- opaque client-encrypted blob (AES-256-GCM under the user's vault key). The
-- server scopes rows by user_id but never parses `blob` — it cannot read a
-- connection's host, credentials, or even its name. This is separate from the
-- server-side-encrypted `connections` table (single-vault, ops-center path).

CREATE TABLE IF NOT EXISTS vault_connections (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    blob TEXT NOT NULL,            -- v1.iv.ct : AES-256-GCM(userKey, connection JSON)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vault_conn_user ON vault_connections(user_id);
