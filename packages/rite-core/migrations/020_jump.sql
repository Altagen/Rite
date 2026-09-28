-- Reference another saved connection as a jump host (ProxyJump / bastion).
-- Stores the jump connection's id; NULL = direct. Resolved recursively at
-- connect time (jump-of-jump is chainable), cycle-guarded in code.
ALTER TABLE connections ADD COLUMN jump TEXT DEFAULT NULL;
