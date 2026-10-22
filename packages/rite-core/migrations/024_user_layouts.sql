-- Per-user layouts blob (ADR 0027).
--
-- The second support for presets and layouts: a file on the machine, and this. Sealed
-- client-side under the user's vault key, so the server stores machine names it cannot
-- read. One row per user — concurrent edits from two machines are last-write-wins, which
-- ADR 0027 accepts and documents.

CREATE TABLE IF NOT EXISTS user_layouts (
    user_id TEXT PRIMARY KEY NOT NULL,
    blob TEXT NOT NULL,            -- v1.iv.ct : AES-256-GCM(userKey, layouts TOML)
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
