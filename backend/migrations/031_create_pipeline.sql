-- 031_create_pipeline.sql
-- Sales pipeline: stages + per-person stage assignment

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES organizers(id),
  name VARCHAR(100) NOT NULL,
  sort_order INTEGER NOT NULL,
  color VARCHAR(7) DEFAULT '#6B7280',
  is_won BOOLEAN DEFAULT FALSE,
  is_lost BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pipeline_stages_organizer ON pipeline_stages(organizer_id);

-- Unique (organizer_id, name) so seed is idempotent via ON CONFLICT
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_stages_organizer_name
  ON pipeline_stages(organizer_id, name);

ALTER TABLE persons ADD COLUMN IF NOT EXISTS pipeline_stage_id UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL;
ALTER TABLE persons ADD COLUMN IF NOT EXISTS pipeline_entered_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_persons_pipeline_stage ON persons(pipeline_stage_id);

-- Seed default stages for Elan Expo (idempotent)
INSERT INTO pipeline_stages (organizer_id, name, sort_order, color, is_won, is_lost) VALUES
  ('63b52d61-ae2c-4dad-b429-48151b1b16d6', 'New',               1, '#6B7280', FALSE, FALSE),
  ('63b52d61-ae2c-4dad-b429-48151b1b16d6', 'Contacted',         2, '#3B82F6', FALSE, FALSE),
  ('63b52d61-ae2c-4dad-b429-48151b1b16d6', 'Interested',        3, '#F59E0B', FALSE, FALSE),
  ('63b52d61-ae2c-4dad-b429-48151b1b16d6', 'Meeting Scheduled', 4, '#8B5CF6', FALSE, FALSE),
  ('63b52d61-ae2c-4dad-b429-48151b1b16d6', 'Proposal Sent',     5, '#EC4899', FALSE, FALSE),
  ('63b52d61-ae2c-4dad-b429-48151b1b16d6', 'Won',               6, '#10B981', TRUE,  FALSE),
  ('63b52d61-ae2c-4dad-b429-48151b1b16d6', 'Lost',              7, '#EF4444', FALSE, TRUE)
ON CONFLICT (organizer_id, name) DO NOTHING;
