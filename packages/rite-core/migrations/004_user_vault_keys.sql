-- Per-user zero-knowledge vault keys (ADR 0011 phase 2).
--
-- The client generates a random user key, wraps it with a master key derived
-- from the password (Argon2id, distinct salt), and sends the wrapped blob at
-- signup. The server stores it but cannot unwrap it (it never has the master
-- key). On login it returns the blob + salt so the client can unwrap the user
-- key and decrypt its vault. Nullable: users provisioned before this migration,
-- or by a flow that hasn't set up a vault yet, have neither.

ALTER TABLE users ADD COLUMN kdf_master_salt BLOB;      -- client KDF salt for the master key
ALTER TABLE users ADD COLUMN protected_user_key TEXT;   -- v1.iv.ct — AES-256-GCM(masterKey, userKey)
