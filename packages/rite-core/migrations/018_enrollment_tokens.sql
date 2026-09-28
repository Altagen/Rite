-- Enrollment tokens (ADR 0015 phase 3). An admin (or a manager, for user-role tokens) mints a
-- single-use invitation encoding an org role + team membership(s) + expiry. Only the SHA-256 of the
-- opaque token is stored (like sessions) — a DB dump yields no usable token. A short non-sensitive
-- prefix is kept for display so the admin can recognise a token in the list (the full value has
-- ample entropy; a few visible chars are harmless). The token carries no keys: team-secret access
-- still follows the usual member grant (ADR 0013/0016).
CREATE TABLE enrollment_tokens (
    id           TEXT PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    prefix       TEXT NOT NULL,           -- display-only fragment, e.g. "rite_ab12"
    role         TEXT NOT NULL,           -- org role granted on redeem: 'user' | 'manager'
    expires_at   INTEGER,                 -- NULL = never
    created_by   TEXT NOT NULL,           -- minting user id
    created_at   INTEGER NOT NULL,
    consumed_at  INTEGER                  -- NULL = unconsumed (single-use)
);

-- The recipe's team grants: which team(s) the redeemer joins, and with which team role.
CREATE TABLE enrollment_token_teams (
    token_id   TEXT NOT NULL,
    team_id    TEXT NOT NULL,
    team_role  TEXT NOT NULL,             -- 'admin' | 'member'
    PRIMARY KEY (token_id, team_id),
    FOREIGN KEY (token_id) REFERENCES enrollment_tokens(id) ON DELETE CASCADE
);
