-- 039: ADR-015 — Hierarchical Data Visibility + Granular Permissions
--
-- Layer 1: reports_to (N-level hierarchy, replaces flat manager_id from 038)
-- Layer 2: permissions JSONB (per-user granular permissions)
-- Layer 3: role CHECK constraint (owner, manager, sales_rep, staff + legacy admin/user)
--
-- DO NOT RUN AUTOMATICALLY — apply manually.

BEGIN;

-- ---------------------------------------------------------------------------
-- Layer 1: reports_to hierarchy
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS reports_to UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_users_reports_to ON users(reports_to) WHERE reports_to IS NOT NULL;

-- Migrate manager_id → reports_to (if migration 038 was applied)
UPDATE users SET reports_to = manager_id
 WHERE manager_id IS NOT NULL AND reports_to IS NULL;

-- ---------------------------------------------------------------------------
-- Layer 2: permissions JSONB
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN users.reports_to IS 'Direct manager — recursive CTE walks this tree for data visibility.';
COMMENT ON COLUMN users.permissions IS 'ADR-015 granular permissions JSON: daily_email_limit, can_view_revenue, country_scope, etc.';

-- ---------------------------------------------------------------------------
-- Layer 3: role CHECK constraint (expand to 4 new + 2 legacy roles)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- Drop old constraint if it exists (may not — Liffy had no CHECK on role)
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users DROP CONSTRAINT users_role_check;
  END IF;

  -- Add new constraint: 4 ADR-015 roles + 2 legacy for backward compat
  ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('owner', 'manager', 'sales_rep', 'staff', 'user', 'admin'));
END $$;

-- ---------------------------------------------------------------------------
-- Backfill: set reports_to for existing users
-- Suer (owner) → NULL (top of tree)
-- Elif → reports_to Suer
-- Bengü → reports_to Elif
-- ---------------------------------------------------------------------------
UPDATE users SET reports_to = NULL
 WHERE id = 'cfb66f28-54b1-4a82-85d5-616bb6bbd40b'; -- Suer (owner)

UPDATE users SET reports_to = 'cfb66f28-54b1-4a82-85d5-616bb6bbd40b'
 WHERE id = '1798e4e3-e705-4ee6-9c22-6a816ad6c95b'
   AND reports_to IS NULL; -- Elif → Suer

UPDATE users SET reports_to = '1798e4e3-e705-4ee6-9c22-6a816ad6c95b'
 WHERE id = 'c845b557-0de6-48f7-975e-5e41bc124d43'
   AND reports_to IS NULL; -- Bengü → Elif

-- ---------------------------------------------------------------------------
-- Fix lists visibility: change default from 'shared' to 'private'
-- Existing lists stay 'shared' unless explicitly changed by owner
-- New lists will default to 'private'
-- ---------------------------------------------------------------------------
ALTER TABLE lists ALTER COLUMN visibility SET DEFAULT 'private';

COMMIT;
