-- 011_campaign_recipients_add_prospect_id.sql

ALTER TABLE campaign_recipients
ADD COLUMN IF NOT EXISTS prospect_id UUID;

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_prospect_id
ON campaign_recipients(prospect_id);

COMMENT ON COLUMN campaign_recipients.prospect_id
IS 'References prospects.id - used for deduplication and tracking at application level';
