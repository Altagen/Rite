-- Pending host keys awaiting user confirmation (strict host-key mode).
--
-- On an unknown host in strict mode, rite-core stores the offered key here and
-- rejects the connection; the user then accepts it (moving it to known_hosts)
-- or rejects it (dropping the row). One pending entry per (host, port).
CREATE TABLE IF NOT EXISTS pending_host_keys (
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    key_type TEXT NOT NULL,           -- e.g. 'ssh-ed25519'
    fingerprint TEXT NOT NULL,        -- SHA256 fingerprint for display
    public_key_data BLOB NOT NULL,    -- full public key data
    created_at INTEGER NOT NULL,      -- Unix timestamp in seconds
    UNIQUE(host, port)
);
