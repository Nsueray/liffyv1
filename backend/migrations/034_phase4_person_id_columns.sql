-- 034_phase4_person_id_columns.sql
-- Phase 4 preparation: re-backfill person_id columns, add coverage tracking.
-- Migrations 028/029 added the columns and did initial backfill.
-- This migration re-runs backfill for any new rows since then.
--
-- NOTE: person_id is NOT made NOT NULL yet — dual-write removal comes later.
-- See TODO comments in lists.js, miningResults.js, leads.js.

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Re-backfill campaign_recipients.person_id (idempotent)
-- -----------------------------------------------------------------------------
UPDATE campaign_recipients cr
SET person_id = pn.id
FROM persons pn
WHERE cr.person_id IS NULL
  AND LOWER(cr.email) = LOWER(pn.email)
  AND cr.organizer_id = pn.organizer_id;

-- -----------------------------------------------------------------------------
-- 2. Re-backfill list_members.person_id (idempotent)
-- -----------------------------------------------------------------------------
UPDATE list_members lm
SET person_id = (
  SELECT p.id FROM persons p
  JOIN prospects pr ON LOWER(p.email) = LOWER(pr.email)
  WHERE pr.id = lm.prospect_id
    AND p.organizer_id = lm.organizer_id
  LIMIT 1
)
WHERE lm.person_id IS NULL;

-- -----------------------------------------------------------------------------
-- 3. Add partial indexes for NULL person_id tracking (monitor backfill gaps)
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_missing_person
  ON campaign_recipients(organizer_id)
  WHERE person_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_list_members_missing_person
  ON list_members(organizer_id)
  WHERE person_id IS NULL;

COMMIT;
