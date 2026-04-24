-- Migration 044: Drop status CHECK constraints
-- These constraints block valid status transitions (e.g. 'sending' for CAS claim).
-- Status values are enforced in application code (sequenceService.js).
-- Valid statuses: active, sending, completed, replied, bounced, unsubscribed, paused

ALTER TABLE sequence_recipients DROP CONSTRAINT IF EXISTS sequence_recipients_status_check;
ALTER TABLE campaign_recipients DROP CONSTRAINT IF EXISTS campaign_recipients_status_check;
