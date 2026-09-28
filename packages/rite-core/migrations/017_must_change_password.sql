-- First-login password set (ADR 0010 addendum). An admin-provisioned account starts with
-- a password the admin chose, so until the user sets their own the admin could derive the
-- vault key — not zero-knowledge from the admin. This flag forces a password change (which
-- re-keys the vault) on first login; the same flag drives the after-reset flow. Bootstrap/
-- env-provisioned admins set their own password → 0.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
