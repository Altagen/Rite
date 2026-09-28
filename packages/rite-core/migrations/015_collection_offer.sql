-- Offer-to-team (ADR 0016): a collection can be attached to a team for opt-in discovery.
-- team_id is an ORGANISATIONAL link (not cryptographic); discovery_label is a plaintext,
-- owner-crafted, RBAC-gated (team-members-only) label so people can find & request access.
-- The real (metaKey-encrypted) name and the machines stay end-to-end encrypted. Both NULL
-- when the collection is not offered.
ALTER TABLE collections ADD COLUMN team_id TEXT;
ALTER TABLE collections ADD COLUMN discovery_label TEXT;
