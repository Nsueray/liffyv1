-- Migration 020: Zoho CRM push integration
-- Adds Zoho OAuth2 credentials to organizers (per-organizer, mirrors SendGrid/ZeroBounce pattern)
-- Creates zoho_push_log table for dedup + audit trail

-- organizers: Zoho OAuth2 credentials
ALTER TABLE organizers ADD COLUMN IF NOT EXISTS zoho_client_id TEXT;
ALTER TABLE organizers ADD COLUMN IF NOT EXISTS zoho_client_secret TEXT;
ALTER TABLE organizers ADD COLUMN IF NOT EXISTS zoho_refresh_token TEXT;
ALTER TABLE organizers ADD COLUMN IF NOT EXISTS zoho_access_token TEXT;
ALTER TABLE organizers ADD COLUMN IF NOT EXISTS zoho_access_token_expires_at TIMESTAMPTZ;
ALTER TABLE organizers ADD COLUMN IF NOT EXISTS zoho_datacenter VARCHAR(20) DEFAULT 'com';

-- Push tracking table (dedup + audit trail)
CREATE TABLE IF NOT EXISTS zoho_push_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    zoho_module VARCHAR(20) NOT NULL CHECK (zoho_module IN ('Leads', 'Contacts')),
    zoho_record_id VARCHAR(50),
    action VARCHAR(10) NOT NULL CHECK (action IN ('create', 'update')),
    status VARCHAR(20) NOT NULL DEFAULT 'success',
    error_message TEXT,
    field_snapshot JSONB,
    pushed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pushed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Index: lookup by person + module (dedup check)
CREATE INDEX IF NOT EXISTS idx_zoho_push_log_person_module
  ON zoho_push_log (organizer_id, person_id, zoho_module);

-- Index: find latest successful push per person+module (for update vs create decision)
CREATE INDEX IF NOT EXISTS idx_zoho_push_log_latest
  ON zoho_push_log (organizer_id, person_id, zoho_module, pushed_at DESC)
  WHERE status = 'success';

-- Index: push history listing
CREATE INDEX IF NOT EXISTS idx_zoho_push_log_organizer
  ON zoho_push_log (organizer_id, pushed_at DESC);
