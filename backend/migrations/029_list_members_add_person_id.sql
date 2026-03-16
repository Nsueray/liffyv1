-- Migration 029: Add person_id column to list_members (dual-column, prospect_id preserved)
-- Part of E2 legacy removal — direct FK to persons table

ALTER TABLE list_members
  ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES persons(id);

-- Index for person-based lookups
CREATE INDEX IF NOT EXISTS idx_list_members_person_id
  ON list_members(person_id)
  WHERE person_id IS NOT NULL;

-- Backfill: match existing list_members → prospects (email) → persons (email match)
UPDATE list_members lm
SET person_id = (
  SELECT p.id FROM persons p
  JOIN prospects pr ON LOWER(p.email) = LOWER(pr.email)
  WHERE pr.id = lm.prospect_id
    AND p.organizer_id = lm.organizer_id
  LIMIT 1
)
WHERE lm.person_id IS NULL;
