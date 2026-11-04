-- The label words declared above the collections, on an instance.
--
-- ITS OWN TABLE AND NOT A `settings` KEY, which `e2e/mode-nudge-check.mjs` is what
-- settled. Everything in `settings` is instance POLICY that the `/api/server/mode`
-- payload carries, so every handler that writes one must nudge every client to re-read
-- it. A vocabulary is not policy: it changes nothing about how a client behaves, and
-- nudging would tell every open window the mode had changed when it had not.
--
-- IN THE CLEAR, deliberately. Every member reads this list — that is what the scope means
-- — so sealing it under a key they all hold would buy a key rotation path and no secrecy.
-- What IS secret is which machine wears a word, and that stays inside the collection's
-- encrypted item, under a key this process never has.
--
-- One row, because there is one instance. A local vault has this scope too and does NOT
-- use this table: there the only reader is the owner, so it rides `vault_documents`,
-- sealed under the master key like their marks.
CREATE TABLE IF NOT EXISTS instance_labels (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    words TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
