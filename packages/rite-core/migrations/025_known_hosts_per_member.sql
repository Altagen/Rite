-- Host-key trust belongs to a member, not to an instance (ADR 0021, addendum).
--
-- Both tables were keyed UNIQUE(host, port) with no owner, which is correct for one person
-- on one machine and wrong for a shared server: `POST /api/ssh/host-key/accept` is not an
-- admin route, so any member could promote a pending key and every other member then
-- connected to that host without ever being asked. A member who accepted a
-- man-in-the-middle key silenced the changed-key refusal for the whole instance.
--
-- SQLite cannot drop a table-level UNIQUE, so both tables are rebuilt.
--
-- The owner is NOT NULL with a default rather than nullable: SQLite treats NULLs as
-- distinct inside a UNIQUE index, so an absent owner would have let the same host be
-- recorded twice over. 'local' is the literal a local vault passes, and member ids are
-- uuids, so no member can collide with it.
--
-- That default is also what decides who inherits the rows that already exist, and it lands
-- differently on each side on purpose:
--   * a local vault is one person, so every existing row is theirs and stays trusted — a
--     host already accepted there speaks up again only if its key changes;
--   * a shared instance cannot attribute them, because nothing records which member
--     accepted a given key. They match no member, so each member is asked once per host
--     they had already used. Attributing them by guess would be the silent inheritance
--     this change exists to end.

CREATE TABLE known_hosts_new (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL DEFAULT 'local',  -- 'local' = the one person a local vault has
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    key_type TEXT NOT NULL,           -- e.g., 'ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'
    fingerprint TEXT NOT NULL,        -- SHA256 fingerprint for display
    public_key_data BLOB NOT NULL,    -- Full public key data
    added_at INTEGER NOT NULL,        -- Unix timestamp in seconds
    last_seen_at INTEGER NOT NULL,    -- Unix timestamp in seconds
    UNIQUE(user_id, host, port)
);

INSERT INTO known_hosts_new (
    id, user_id, host, port, key_type, fingerprint, public_key_data, added_at, last_seen_at
)
SELECT id, 'local', host, port, key_type, fingerprint, public_key_data, added_at, last_seen_at
FROM known_hosts;

DROP TABLE known_hosts;
ALTER TABLE known_hosts_new RENAME TO known_hosts;

CREATE INDEX IF NOT EXISTS idx_known_hosts_owner_host_port
ON known_hosts(user_id, host, port);

-- Pending keys are rebuilt WITHOUT carrying their rows over. A pending key is the product
-- of one refused connection attempt, and attributing it to 'local' on a shared instance
-- would leave a row nobody can accept. The next attempt records a fresh one, owned by
-- whoever made it.
CREATE TABLE pending_host_keys_new (
    user_id TEXT NOT NULL DEFAULT 'local',
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    key_type TEXT NOT NULL,           -- e.g. 'ssh-ed25519'
    fingerprint TEXT NOT NULL,        -- SHA256 fingerprint for display
    public_key_data BLOB NOT NULL,    -- full public key data
    created_at INTEGER NOT NULL,      -- Unix timestamp in seconds
    UNIQUE(user_id, host, port)
);

DROP TABLE pending_host_keys;
ALTER TABLE pending_host_keys_new RENAME TO pending_host_keys;
