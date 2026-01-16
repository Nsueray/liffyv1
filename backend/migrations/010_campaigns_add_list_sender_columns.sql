-- 010_campaigns_add_list_sender_columns.sql

ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS list_id UUID;

ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS sender_id UUID;

ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS include_risky BOOLEAN DEFAULT false;

ALTER TABLE campaigns
ADD COLUMN IF NOT EXISTS recipient_count INTEGER;

CREATE INDEX IF NOT EXISTS idx_campaigns_list_id ON campaigns(list_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_sender_id ON campaigns(sender_id);

COMMENT ON COLUMN campaigns.list_id IS 'References lists.id - the ONE list snapshot used for recipient resolution';
COMMENT ON COLUMN campaigns.sender_id IS 'References sender_identities.id - locked at READY state';
COMMENT ON COLUMN campaigns.include_risky IS 'If true, include prospects with verification_status=risky';
COMMENT ON COLUMN campaigns.recipient_count IS 'Final resolved recipient count, set at DRAFT→READY transition';
