-- A collection's Board (ADR 0016): a members-only space of cards (links, notes,
-- one-click actions, live views), stored as one opaque blob encrypted with the
-- collection's itemsKey. NULL/absent = no board yet. The server never learns its
-- contents; only members holding the itemsKey can decrypt it.
ALTER TABLE collections ADD COLUMN board_enc TEXT DEFAULT NULL;
