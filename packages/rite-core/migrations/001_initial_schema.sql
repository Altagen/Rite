-- RITE Database Schema v1 (Consolidated)
-- This file contains the complete initial database schema for RITE
-- All tables and settings required for MVP functionality
--
-- NOTE: This is the CONSOLIDATED schema. Do NOT add new migrations for alpha/beta.
-- Only add migrations (002+) after first stable release.

-- =============================================================================
-- Schema Version Tracking
-- =============================================================================

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, strftime('%s', 'now'));

-- =============================================================================
-- Authentication & Security
-- =============================================================================

-- Master password storage
-- Only one row should ever exist in this table
CREATE TABLE IF NOT EXISTS master_password (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    hash TEXT NOT NULL,
    salt BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Unlock attempt tracking for rate limiting
CREATE TABLE IF NOT EXISTS unlock_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    success INTEGER NOT NULL CHECK (success IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_unlock_attempts_timestamp
ON unlock_attempts(timestamp DESC);

-- =============================================================================
-- Application Settings
-- =============================================================================

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Insert default settings
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
    ('auto_lock_enabled', 'false', strftime('%s', 'now')),
    ('auto_lock_timeout', '0', strftime('%s', 'now')),
    ('clipboard_clear_enabled', 'false', strftime('%s', 'now')),
    ('clipboard_clear_timeout', '30', strftime('%s', 'now')),
    ('ssh_keep_alive_enabled', 'false', strftime('%s', 'now')),
    ('ssh_keep_alive_interval', '30', strftime('%s', 'now')),
    ('host_key_verification_mode', 'strict', strftime('%s', 'now'));

-- =============================================================================
-- Connections
-- =============================================================================

-- Saved connections (credentials encrypted with master key)
CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY,  -- UUID v4
    name TEXT NOT NULL,
    protocol TEXT NOT NULL CHECK (protocol IN ('ssh', 'sftp', 'local')),
    hostname TEXT NOT NULL,
    port INTEGER NOT NULL CHECK (port > 0 AND port <= 65535),
    username TEXT NOT NULL,

    -- Encrypted credentials (JSON containing auth_method details)
    -- Format: { "type": "password", "password": "..." } or
    --         { "type": "publickey", "key_path": "...", "passphrase": "..." }
    encrypted_credentials BLOB NOT NULL,
    nonce BLOB NOT NULL,  -- Nonce for ChaCha20-Poly1305

    -- Per-connection SSH keep-alive settings
    ssh_keep_alive_override TEXT DEFAULT NULL,  -- NULL (use global), 'disabled', 'enabled'
    ssh_keep_alive_interval INTEGER DEFAULT NULL,  -- Value in seconds, NULL = use global

    -- Optional metadata for UI
    color TEXT,      -- Hex color code (e.g., "#3B82F6")
    icon TEXT,       -- Icon name or emoji
    folder TEXT,     -- Folder/group for organization
    notes TEXT,      -- User notes (not encrypted for MVP)

    -- Timestamps
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_connections_folder
ON connections(folder);

CREATE INDEX IF NOT EXISTS idx_connections_last_used
ON connections(last_used_at DESC);

CREATE INDEX IF NOT EXISTS idx_connections_name
ON connections(name COLLATE NOCASE);

-- =============================================================================
-- SSH Host Key Verification (MITM Protection)
-- =============================================================================

CREATE TABLE IF NOT EXISTS known_hosts (
    id TEXT PRIMARY KEY NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    key_type TEXT NOT NULL,           -- e.g., 'ssh-rsa', 'ssh-ed25519', 'ecdsa-sha2-nistp256'
    fingerprint TEXT NOT NULL,        -- SHA256 fingerprint for display
    public_key_data BLOB NOT NULL,    -- Full public key data
    added_at INTEGER NOT NULL,        -- Unix timestamp in seconds
    last_seen_at INTEGER NOT NULL,    -- Unix timestamp in seconds
    UNIQUE(host, port)
);

CREATE INDEX IF NOT EXISTS idx_known_hosts_host_port
ON known_hosts(host, port);
