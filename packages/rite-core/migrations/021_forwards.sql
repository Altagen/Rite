-- Saved port-forward configs on a connection, stored as a JSON array
-- (non-secret metadata). NULL/absent = no forwards. Started/stopped at runtime.
ALTER TABLE connections ADD COLUMN forwards TEXT DEFAULT NULL;
