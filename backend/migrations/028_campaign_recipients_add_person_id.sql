-- Migration 028: Add person_id column to campaign_recipients
-- Part of E3 legacy removal — direct FK to persons table

ALTER TABLE campaign_recipients
  ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES persons(id);

-- Index for person-based lookups
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_person_id
  ON campaign_recipients(person_id)
  WHERE person_id IS NOT NULL;

-- Backfill: match existing recipients to persons via email + organizer_id
UPDATE campaign_recipients cr
SET person_id = pn.id
FROM persons pn
WHERE cr.person_id IS NULL
  AND LOWER(cr.email) = LOWER(pn.email)
  AND cr.organizer_id = pn.organizer_id;
