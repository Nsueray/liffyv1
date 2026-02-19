-- Migration 021: Add UNIQUE constraint to prospect_intents for deduplication
-- Prevents duplicate intent signals for the same person+campaign+type combination.
-- Existing duplicates (if any) are removed first, keeping the earliest record.

-- Step 1: Remove duplicates (keep earliest by occurred_at)
DELETE FROM prospect_intents a
USING prospect_intents b
WHERE a.id > b.id
  AND a.organizer_id = b.organizer_id
  AND a.person_id = b.person_id
  AND COALESCE(a.campaign_id::text, '') = COALESCE(b.campaign_id::text, '')
  AND a.intent_type = b.intent_type;

-- Step 2: Add unique constraint
-- campaign_id is nullable (manual intents may have no campaign), so we use a unique index
-- with COALESCE to treat NULLs as equal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_prospect_intent
ON prospect_intents (organizer_id, person_id, COALESCE(campaign_id::text, ''), intent_type);
