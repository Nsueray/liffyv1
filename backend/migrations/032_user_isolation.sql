-- 032_user_isolation.sql
-- Multi-user data isolation + per-user daily email limits.
--
-- Owner / admin see everything within their organizer; regular users only see
-- the rows they created (campaigns, mining_jobs) or are assigned to (pipeline).
--
-- All changes are additive. Existing rows are backfilled to the founding owner
-- user so nothing becomes invisible after the migration.

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Campaigns: track which user created the campaign
-- -----------------------------------------------------------------------------
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_campaigns_created_by_user
  ON campaigns(organizer_id, created_by_user_id);

-- -----------------------------------------------------------------------------
-- 2. Mining jobs: track which user created the job
-- -----------------------------------------------------------------------------
ALTER TABLE mining_jobs
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mining_jobs_created_by_user
  ON mining_jobs(organizer_id, created_by_user_id);

-- -----------------------------------------------------------------------------
-- 3. Persons: pipeline assignment (which user owns the contact in pipeline)
--    Distinct from who imported the person — reflects current pipeline owner.
-- -----------------------------------------------------------------------------
ALTER TABLE persons
  ADD COLUMN IF NOT EXISTS pipeline_assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_persons_pipeline_assigned_user
  ON persons(organizer_id, pipeline_assigned_user_id)
  WHERE pipeline_stage_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. Users: per-user daily email limit + optional name fields
-- -----------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS daily_email_limit INTEGER NOT NULL DEFAULT 500;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS first_name TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_name TEXT;

-- -----------------------------------------------------------------------------
-- 5. Backfill existing data to the founding owner user (Elan Expo)
--    user_id: cfb66f28-54b1-4a82-85d5-616bb6bbd40b ("suer" — role=owner)
-- -----------------------------------------------------------------------------
UPDATE campaigns
   SET created_by_user_id = 'cfb66f28-54b1-4a82-85d5-616bb6bbd40b'
 WHERE created_by_user_id IS NULL;

UPDATE mining_jobs
   SET created_by_user_id = 'cfb66f28-54b1-4a82-85d5-616bb6bbd40b'
 WHERE created_by_user_id IS NULL;

-- Persons already in a pipeline stage default to the owner user
UPDATE persons
   SET pipeline_assigned_user_id = 'cfb66f28-54b1-4a82-85d5-616bb6bbd40b'
 WHERE pipeline_stage_id IS NOT NULL
   AND pipeline_assigned_user_id IS NULL;

-- Owner gets a generous daily limit so existing workflows don't break
UPDATE users
   SET daily_email_limit = 100000
 WHERE id = 'cfb66f28-54b1-4a82-85d5-616bb6bbd40b';

COMMIT;
