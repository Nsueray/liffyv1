-- 038: Add manager_id to users for hierarchical data isolation.
-- Owner sees all, Manager sees own + team, User sees own only.
-- DO NOT RUN AUTOMATICALLY — apply manually.

ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES users(id);

-- Index for quick team lookups (find all users managed by X)
CREATE INDEX IF NOT EXISTS idx_users_manager_id ON users (manager_id) WHERE manager_id IS NOT NULL;

COMMENT ON COLUMN users.manager_id IS 'Direct manager — used for hierarchical data isolation. Manager sees own + team rows.';
