-- Drop the legacy single-key column now that collections are split-key + escrow
-- (ADR 0016 addendum). `protected_collection_key` only existed to carry the old
-- one-key format across the split migration (012); it has since mirrored the meta
-- key. As there is no released data to preserve, we make the split model the single
-- canonical form: metaKey (always present) + itemsKey (NULL for admin roster
-- meta-adds, until a member seals machine access).

ALTER TABLE collection_members DROP COLUMN protected_collection_key;
