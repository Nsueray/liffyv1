CREATE TABLE campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL,
    template_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'draft',
    scheduled_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT fk_template FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE CASCADE
);

CREATE INDEX idx_campaigns_organizer_id ON campaigns(organizer_id);
CREATE INDEX idx_campaigns_template_id ON campaigns(template_id);
