-- Per-user X25519 keypair for team-secret sharing (ADR 0013 phase 2).
--
-- Generated client-side at signup: the public key is stored in the clear (it is
-- public — a key-holder seals a team key TO it), the private key is wrapped with
-- the user's `userKey` (ADR 0011) so the server can't read it. Returned at login/
-- me so the client can unwrap the private key. Nullable for accounts created
-- before this migration (they get a keypair on next key-setup).

ALTER TABLE users ADD COLUMN public_key TEXT;            -- X25519 public key, base64
ALTER TABLE users ADD COLUMN protected_private_key TEXT; -- v1.iv.ct, private key wrapped by userKey
