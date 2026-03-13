-- Migration: 025_add_replied_at_column.sql
-- Adds replied_at tracking column to campaign_recipients for reply detection

ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP;
