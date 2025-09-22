CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE email_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    subject VARCHAR(255) NOT NULL,
    body_html TEXT NOT NULL,
    body_text TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_email_templates_organizer_id ON email_templates(organizer_id);
