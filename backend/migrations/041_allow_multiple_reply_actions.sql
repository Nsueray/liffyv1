BEGIN;

-- Drop the dedup index that prevents multiple reply_received per person
DROP INDEX IF EXISTS idx_action_items_dedup;

-- Recreate dedup index but EXCLUDE reply_received from dedup
-- Other triggers (sequence_exhausted, engaged_hot, etc.) still dedup'd
CREATE UNIQUE INDEX idx_action_items_dedup
  ON action_items(organizer_id, person_id, trigger_reason)
  WHERE status IN ('open', 'in_progress')
  AND trigger_reason != 'reply_received';

COMMIT;
