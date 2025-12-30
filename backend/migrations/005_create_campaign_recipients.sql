-- 005_create_campaign_recipients.sql

CREATE TABLE campaign_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    email VARCHAR(320) NOT NULL,
    name VARCHAR(255),
    meta JSONB,
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, sent, failed
    last_error TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_campaign_recipients_campaign_id ON campaign_recipients(campaign_id);
CREATE INDEX idx_campaign_recipients_organizer_id ON campaign_recipients(organizer_id);
CREATE INDEX idx_campaign_recipients_status ON campaign_recipients(status);
