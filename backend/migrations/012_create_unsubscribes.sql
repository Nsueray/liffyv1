-- 012_create_unsubscribes.sql

CREATE TABLE IF NOT EXISTS unsubscribes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL,
    email VARCHAR(320) NOT NULL,
    reason VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unsubscribes_organizer_id
ON unsubscribes(organizer_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unsubscribes_organizer_email_lower
ON unsubscribes (organizer_id, LOWER(email));

COMMENT ON TABLE unsubscribes
IS 'Global email suppression list - emails here are never sent to';

COMMENT ON COLUMN unsubscribes.reason
IS 'Optional reason: user_request, hard_bounce, complaint, etc.';
