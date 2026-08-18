-- Pre-connect hook: a local command that must succeed before connecting
-- (wg-quick / tailscale up / aws sso login / kinit / mount…). NULL = none.
ALTER TABLE connections ADD COLUMN preconnect TEXT DEFAULT NULL;
