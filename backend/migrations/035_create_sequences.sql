-- 035_create_sequences.sql
-- Multi-touch campaign sequence system.
-- campaign_sequences: step definitions per campaign
-- sequence_recipients: per-recipient state tracking
-- campaigns: campaign_type + sequence_config columns

BEGIN;

-- Sequence step definitions
CREATE TABLE IF NOT EXISTS campaign_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES organizers(id),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  sequence_order INTEGER NOT NULL,
  template_id UUID NOT NULL REFERENCES email_templates(id),
  delay_days INTEGER NOT NULL DEFAULT 0,
  condition VARCHAR(30) DEFAULT 'no_reply' CHECK (condition IN ('no_reply', 'no_open', 'always')),
  subject_override VARCHAR(255),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaign_sequences_campaign ON campaign_sequences(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_sequences_organizer ON campaign_sequences(organizer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_sequences_order ON campaign_sequences(campaign_id, sequence_order);

-- Per-recipient sequence state tracking
CREATE TABLE IF NOT EXISTS sequence_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES organizers(id),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id UUID REFERENCES persons(id) ON DELETE SET NULL,
  email VARCHAR(320) NOT NULL,
  current_step INTEGER DEFAULT 1,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'paused', 'replied', 'completed', 'unsubscribed', 'bounced')),
  next_send_at TIMESTAMPTZ,
  last_sent_step INTEGER DEFAULT 0,
  last_sent_at TIMESTAMPTZ,
  meta JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sequence_recipients_campaign ON sequence_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_sequence_recipients_organizer ON sequence_recipients(organizer_id);
CREATE INDEX IF NOT EXISTS idx_sequence_recipients_status ON sequence_recipients(status);
CREATE INDEX IF NOT EXISTS idx_sequence_recipients_next_send ON sequence_recipients(next_send_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sequence_recipients_person ON sequence_recipients(person_id);
CREATE INDEX IF NOT EXISTS idx_sequence_recipients_email ON sequence_recipients(organizer_id, LOWER(email));

-- Campaign type: single (existing) vs sequence
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS campaign_type VARCHAR(20) DEFAULT 'single' CHECK (campaign_type IN ('single', 'sequence'));
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sequence_config JSONB;

COMMIT;
