-- Last-used timestamps for collection machines (ADR 0018).
--
-- The legacy `connections` table carries `last_used_at` as a column. A machine in
-- a collection is one opaque AES-GCM blob, and stamping a timestamp is not worth
-- rewriting ciphertext for: it would change the blob on every connect, defeat any
-- future sync diffing, and briefly put the record back through encryption for a
-- field nobody needs encrypted.
--
-- So it lives beside the item instead. This is deliberately NOT the model on a
-- server: there, "last seen" is the user's own local record and never goes
-- server-side (ADR 0017), because it would leak access patterns to an operator who
-- otherwise learns nothing. In a local vault the database *is* the user's own
-- machine, so there is nobody to leak to, and keeping it here means it survives a
-- browser profile reset the way a localStorage entry would not.

CREATE TABLE IF NOT EXISTS machine_last_used (
    item_id TEXT PRIMARY KEY NOT NULL,
    last_used_at INTEGER NOT NULL,
    FOREIGN KEY(item_id) REFERENCES collection_items(id) ON DELETE CASCADE
);
