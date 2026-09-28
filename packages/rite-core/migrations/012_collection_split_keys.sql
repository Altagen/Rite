-- Split collection keys + Admin-group escrow (ADR 0016, split-key model).
--
-- A collection used to have ONE symmetric key encrypting both its name/colour and
-- its items, sealed to each member. That made it impossible to grant an admin the
-- collection NAME (for governance) without also handing them the machine
-- credentials. We split it into two data-encryption keys:
--   * metaKey  — encrypts collections.name_enc (name/colour + folder header)
--   * itemsKey — encrypts collection_items.blob (machines/credentials)
-- Each is sealed per-member (X25519 sealbox, ADR 0013). metaKey is additionally
-- sealed once to an "Admins group" public key so admins can read names + manage the
-- roster, while itemsKey stays sealed to members only — so admins never see machine
-- credentials. The server still holds no keys (full zero-knowledge to the server).
--
-- Non-destructive: for existing collections the old single key becomes BOTH keys
-- (no re-encryption). Such migrated collections keep meta_key_group_enc = NULL
-- (metaKey == itemsKey there, so escrowing metaKey would leak items); admin
-- name-access lights up for new collections and, opt-in, after a client re-key.

-- Per-member sealed keys. Keep protected_collection_key for back-compat (drop later).
ALTER TABLE collection_members ADD COLUMN protected_meta_key TEXT;
ALTER TABLE collection_members ADD COLUMN protected_items_key TEXT;
UPDATE collection_members
   SET protected_meta_key  = protected_collection_key,
       protected_items_key = protected_collection_key;

-- metaKey sealed to the current Admin-group public key (NULL until escrowed), and
-- which group generation it was sealed to.
ALTER TABLE collections ADD COLUMN meta_key_group_enc TEXT;
ALTER TABLE collections ADD COLUMN group_epoch INTEGER;

-- The Admin group's X25519 keypair, versioned by epoch. The public key is stored in
-- the clear (it is public — members seal metaKey TO it). Rotated (new epoch) when an
-- admin is removed. Current epoch = MAX(epoch).
CREATE TABLE IF NOT EXISTS admin_group_key (
    epoch INTEGER PRIMARY KEY NOT NULL,
    public_key TEXT NOT NULL,          -- X25519 group public key, hex
    created_at INTEGER NOT NULL
);

-- The group PRIVATE key sealed to each admin's own public key (one grant per admin
-- per epoch). Adding an admin = one new grant; removing = a fresh epoch (rotation).
CREATE TABLE IF NOT EXISTS admin_group_grants (
    epoch INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    protected_private_key TEXT NOT NULL,  -- group private key sealed to this admin
    created_at INTEGER NOT NULL,
    PRIMARY KEY (epoch, user_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
