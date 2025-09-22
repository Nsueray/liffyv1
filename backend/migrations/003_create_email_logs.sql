CREATE TABLE email_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL,
    campaign_id UUID,
    template_id UUID,
    recipient_email VARCHAR(320) NOT NULL,
    recipient_data JSONB,
    status VARCHAR(50) NOT NULL DEFAULT 'queued',
    provider_response JSONB,
    sent_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_email_logs_organizer_id ON email_logs(organizer_id);
CREATE INDEX idx_email_logs_campaign_id ON email_logs(campaign_id);
CREATE INDEX idx_email_logs_recipient_email ON email_logs(recipient_email);
