-- Documents Rite keeps for one person, sealed under the vault's master key.
--
-- WHY A TABLE AND NOT A FILE. The marks document — the names and labels somebody put on
-- conversations — rode a JSON file beside the vault, in the clear, whenever the context
-- was not a server account. ADR 0022 §6's addendum said it should be sealed with the
-- vault's key when there is a vault, and this is the row it goes in. A local vault IS a
-- vault: the key exists, the core holds it, and a labelled conversation names a project
-- and a customer.
--
-- Named, so the next document of this kind rides the same table rather than growing a
-- second one. One row per name: two windows editing at once means the second write wins,
-- with no merge — the same bargain `user_marks` and `user_layouts` make.
--
-- The blob is AES-256-GCM under the master key, through `collection_crypto`, so there is
-- no second crypto path to keep in step with the first.
CREATE TABLE IF NOT EXISTS vault_documents (
    name TEXT PRIMARY KEY NOT NULL,
    blob TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
