-- Migration 019: Email verification (ZeroBounce integration)
-- Adds zerobounce_api_key to organizers, verification columns to persons, and verification_queue table

-- organizers: ZeroBounce API key (per-organizer, mirrors SendGrid pattern)
ALTER TABLE organizers ADD COLUMN IF NOT EXISTS zerobounce_api_key TEXT;

-- persons: verification status (canonical)
ALTER TABLE persons ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) DEFAULT 'unknown';
ALTER TABLE persons ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- verification_queue: batch processing queue for worker
CREATE TABLE IF NOT EXISTS verification_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    email VARCHAR(320) NOT NULL,
    person_id UUID REFERENCES persons(id) ON DELETE SET NULL,
    prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, processing, completed, failed
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- Index for worker: pick pending items efficiently
CREATE INDEX IF NOT EXISTS idx_verification_queue_pending
ON verification_queue (organizer_id, status, created_at ASC)
WHERE status = 'pending';

-- Dedup: prevent duplicate pending/processing entries for same organizer+email
CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_queue_dedup
ON verification_queue (organizer_id, LOWER(email))
WHERE status IN ('pending', 'processing');
