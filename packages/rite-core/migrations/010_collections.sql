-- Collections (ADR 0016) — the unit of sharing. An autonomous object with its own
-- symmetric key, sealed to each member's X25519 public key (ADR 0013 sealbox), an
-- explicit member list with per-member roles, and encrypted items. Generalises
-- vault_connections (a 1-member personal collection) and team_connections (a
-- team-scoped one) — kept as optimised special cases for now, collections added
-- alongside. The server stores only opaque blobs: the collection NAME is itself
-- encrypted with the collection key, so the server never learns it. Teams and
-- collections are orthogonal (a collection may hold members from any/no team).

CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY NOT NULL,
    name_enc TEXT NOT NULL,          -- v1.iv.ct : AES-256-GCM(collectionKey, {name,color})
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_members (
    collection_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,                     -- 'owner' | 'editor' | 'viewer' (RBAC on top of the key)
    protected_collection_key TEXT NOT NULL, -- collectionKey sealed to this member's public key
    created_at INTEGER NOT NULL,
    PRIMARY KEY (collection_id, user_id),
    FOREIGN KEY(collection_id) REFERENCES collections(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_collection_members_user ON collection_members(user_id);

CREATE TABLE IF NOT EXISTS collection_items (
    id TEXT PRIMARY KEY NOT NULL,
    collection_id TEXT NOT NULL,
    blob TEXT NOT NULL,             -- v1.iv.ct : AES-256-GCM(collectionKey, machine JSON)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(collection_id) REFERENCES collections(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_collection_items_coll ON collection_items(collection_id);
