-- Access requests (ADR 0016): a member of a team discovers a collection offered to it and
-- requests access; a key-holder (owner/editor) then grants by sealing the itemsKey to them
-- (the existing member-add flow). The server stores only who-asked-for-which-collection —
-- never a key. One pending row per (collection, user); granting/dismissing removes it.
CREATE TABLE IF NOT EXISTS access_requests (
    collection_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (collection_id, user_id),
    FOREIGN KEY(collection_id) REFERENCES collections(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_access_requests_coll ON access_requests(collection_id);
