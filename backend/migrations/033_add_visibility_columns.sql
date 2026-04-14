-- 033_add_visibility_columns.sql
-- Adds visibility column to lists, email_templates, sender_identities.
-- Values: 'private' (owner only), 'team' (same role group), 'shared' (everyone in organizer).
-- Default: 'shared' — all existing rows remain visible to everyone.
-- Also adds created_by_user_id to email_templates (lists and sender_identities already have it).
--
-- NOTE: Enforcement is initially only in lists.js. Templates and sender identities
-- will be enforced in future iterations.

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Lists: add visibility (already has created_by_user_id)
-- -----------------------------------------------------------------------------
ALTER TABLE lists
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(10) NOT NULL DEFAULT 'shared';

-- Backfill existing lists created_by_user_id to owner if NULL
UPDATE lists
   SET created_by_user_id = 'cfb66f28-54b1-4a82-85d5-616bb6bbd40b'
 WHERE created_by_user_id IS NULL;

-- -----------------------------------------------------------------------------
-- 2. Email templates: add visibility + created_by_user_id
-- -----------------------------------------------------------------------------
ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(10) NOT NULL DEFAULT 'shared';

ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_templates_created_by_user
  ON email_templates(organizer_id, created_by_user_id);

-- Backfill existing templates to owner
UPDATE email_templates
   SET created_by_user_id = 'cfb66f28-54b1-4a82-85d5-616bb6bbd40b'
 WHERE created_by_user_id IS NULL;

-- -----------------------------------------------------------------------------
-- 3. Sender identities: add visibility (already has user_id)
-- -----------------------------------------------------------------------------
ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(10) NOT NULL DEFAULT 'shared';

-- Backfill existing sender identities user_id to owner if NULL
UPDATE sender_identities
   SET user_id = 'cfb66f28-54b1-4a82-85d5-616bb6bbd40b'
 WHERE user_id IS NULL;

COMMIT;
