-- Migration: 013_add_webhook_tracking_columns.sql
-- Adds columns needed for SendGrid webhook tracking

-- Add tracking columns to campaign_recipients
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMP;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMP;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS open_count INTEGER DEFAULT 0;
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS click_count INTEGER DEFAULT 0;

-- Add unique constraint to unsubscribes if not exists
-- This prevents duplicate entries
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'unsubscribes_organizer_email_unique'
    ) THEN
        ALTER TABLE unsubscribes ADD CONSTRAINT unsubscribes_organizer_email_unique 
        UNIQUE (organizer_id, email);
    END IF;
EXCEPTION
    WHEN duplicate_table THEN NULL;
    WHEN duplicate_object THEN NULL;
END $$;

-- Add source column to unsubscribes if not exists
ALTER TABLE unsubscribes ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'manual';

-- Create index for faster webhook lookups
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_email_lower ON campaign_recipients (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_sent_at ON campaign_recipients (sent_at DESC NULLS LAST);
