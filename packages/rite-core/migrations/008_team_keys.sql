-- Team key grants (ADR 0013 phase 3). A team has a symmetric team key; it is
-- sealed to each member's X25519 public key (libsodium crypto_box_seal) and
-- stored per membership. NULL = the member has no crypto access yet (RBAC
-- membership without a key grant — the "invited, not yet confirmed" state).
-- The server stores only the sealed blob and can never open it.

ALTER TABLE team_members ADD COLUMN protected_team_key TEXT; -- teamKey sealed to this member's public key
