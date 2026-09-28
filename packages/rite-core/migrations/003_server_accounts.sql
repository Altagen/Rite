-- Server-mode accounts & sessions (ADR 0010).
--
-- Only used when rite-server runs in server mode (shared/team server). The local
-- desktop shell (loopback token, single implicit user) never populates these.
--
-- Zero-knowledge login: the server never sees the password. The client derives
-- an auth hash from the password + this per-user KDF salt/params (Argon2id) and
-- sends only that hash; the server stores an Argon2id verifier OF that hash.

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL,
    kdf_salt BLOB NOT NULL,             -- per-user client KDF salt (returned by prelogin)
    kdf_mem INTEGER NOT NULL,           -- Argon2id memory (KiB)
    kdf_iter INTEGER NOT NULL,          -- Argon2id iterations
    kdf_par INTEGER NOT NULL,           -- Argon2id parallelism
    auth_verifier TEXT NOT NULL,        -- Argon2id PHC verifier of the client auth hash
    role TEXT NOT NULL,                 -- 'admin' | 'user'
    status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'disabled'
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(username)
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY NOT NULL, -- SHA-256 of the opaque bearer token
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
