-- Per-user encrypted "library tree" blob (ADR 0016 view hierarchy).
-- Stores the client-derived tree of personal folders + which collection sits in
-- which folder, encrypted with the user's key. The server only sees ciphertext
-- (zero-knowledge): it never learns folder names or the structure.
CREATE TABLE IF NOT EXISTS user_library (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    blob       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
