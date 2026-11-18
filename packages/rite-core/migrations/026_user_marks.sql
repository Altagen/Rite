-- Per-user marks blob (ADR 0022 §6).
--
-- The names a person gave to conversations, on the second of their two supports: a file
-- on the machine, and this. Sealed client-side under the vault key, so the server holds
-- names it cannot read — the same arrangement as `user_layouts`, and for the same reason.
--
-- ITS OWN ROW AND NOT A FIELD OF THAT ONE. A mark is keyed to a conversation id on a
-- machine, and a conversation is something a vendor's tool can rotate away; a layout is
-- durable configuration. Rite can prune what it owns and must not prune a person's
-- config file, so the two cannot share a document.
--
-- One row per user — concurrent edits from two machines are last-write-wins, which is
-- what ADR 0027 already accepts for the document beside it.

CREATE TABLE IF NOT EXISTS user_marks (
    user_id TEXT PRIMARY KEY NOT NULL,
    blob TEXT NOT NULL,            -- v1.iv.ct : AES-256-GCM(userKey, marks JSON)
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
