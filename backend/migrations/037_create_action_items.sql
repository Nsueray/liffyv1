-- 037_create_action_items.sql
-- Action Engine: action items for the Action Screen (Blueprint Section 6 & 8).
-- 6 trigger reasons, priority scoring, per-user assignment.

BEGIN;

CREATE TABLE IF NOT EXISTS action_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES organizers(id),
  assigned_to UUID NOT NULL REFERENCES users(id),

  -- What entity this is about
  person_id UUID REFERENCES persons(id) ON DELETE CASCADE,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,

  -- Why it's here (6 triggers)
  trigger_reason VARCHAR(30) NOT NULL CHECK (trigger_reason IN (
    'reply_received',
    'sequence_exhausted',
    'quote_no_response',
    'rebooking_due',
    'engaged_hot',
    'manual_flag'
  )),
  trigger_detail TEXT,

  -- Priority system
  priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  priority_label VARCHAR(4) CHECK (priority_label IN ('P1', 'P2', 'P3', 'P4')),

  -- Status + lifecycle
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'dismissed', 'snoozed')),
  snoozed_until TIMESTAMPTZ,

  -- Metadata
  last_activity_at TIMESTAMPTZ,
  engagement_score INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES users(id),
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_action_items_assigned ON action_items(assigned_to);
CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(status);
CREATE INDEX IF NOT EXISTS idx_action_items_priority ON action_items(priority);
CREATE INDEX IF NOT EXISTS idx_action_items_trigger ON action_items(trigger_reason);
CREATE INDEX IF NOT EXISTS idx_action_items_organizer ON action_items(organizer_id);
CREATE INDEX IF NOT EXISTS idx_action_items_person ON action_items(person_id);
CREATE INDEX IF NOT EXISTS idx_action_items_open ON action_items(assigned_to, status, priority) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_action_items_snoozed ON action_items(snoozed_until) WHERE status = 'snoozed';

-- Prevent duplicate open action items per person per trigger
CREATE UNIQUE INDEX IF NOT EXISTS idx_action_items_dedup
  ON action_items(organizer_id, person_id, trigger_reason)
  WHERE status IN ('open', 'in_progress');

COMMIT;
