-- Unify sharing on collections (ADR 0016): teams are keyless rosters. The team key
-- (ADR 0013, superseded) and team-shared connections are removed — sharing now lives
-- entirely in collections. Drops the team_connections table and the per-member sealed
-- team key. Breaking (pre-release): any team-shared connections are gone; move them to
-- a collection.
DROP TABLE IF EXISTS team_connections;
ALTER TABLE team_members DROP COLUMN protected_team_key;
