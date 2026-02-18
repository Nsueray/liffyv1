-- 018_create_campaign_events.sql
-- Phase 2: Constitution Migration — Engagement Layer
--
-- From Constitution:
--   "Engagement is stored as events, not scores."
--   "Types: delivered, open, click, reply, bounce"
--   "Scores are derived views, never persisted."
--
-- RULES:
--   - This migration is ADDITIVE. No existing tables are modified.
--   - Legacy 'email_logs' table remains untouched.
--   - campaign_recipients columns (delivered_at, opened_at, etc.) remain untouched.
--   - Events are immutable append-only records.
--   - Counters and scores are computed from events, never stored.

CREATE TABLE campaign_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    recipient_id UUID REFERENCES campaign_recipients(id) ON DELETE SET NULL,
    person_id UUID REFERENCES persons(id) ON DELETE SET NULL,

    -- Event classification
    event_type VARCHAR(20) NOT NULL
        CHECK (event_type IN (
            'sent',        -- email handed off to provider
            'delivered',   -- provider confirmed delivery
            'open',        -- recipient opened email
            'click',       -- recipient clicked a link
            'reply',       -- recipient replied
            'bounce',      -- hard or soft bounce
            'dropped',     -- provider refused to send
            'deferred',    -- temporary delivery failure
            'spam_report', -- recipient marked as spam
            'unsubscribe'  -- recipient unsubscribed via link
        )),

    -- Event details
    email VARCHAR(320) NOT NULL,
    url TEXT,                          -- clicked URL (for click events)
    user_agent TEXT,                   -- browser/client info (for open/click)
    ip_address VARCHAR(45),            -- source IP (for open/click)
    reason TEXT,                       -- bounce reason, drop reason, etc.
    provider_event_id TEXT,            -- sg_message_id or similar
    provider_response JSONB,           -- full raw event from SendGrid

    -- Timestamps
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary query: events for a campaign (dashboard, stats)
CREATE INDEX idx_campaign_events_campaign_id
ON campaign_events (campaign_id, occurred_at DESC);

-- Multi-tenant filter
CREATE INDEX idx_campaign_events_organizer_id
ON campaign_events (organizer_id);

-- Per-recipient event history
CREATE INDEX idx_campaign_events_recipient_id
ON campaign_events (recipient_id, occurred_at DESC);

-- Per-person engagement history (across campaigns)
CREATE INDEX idx_campaign_events_person_id
ON campaign_events (person_id, occurred_at DESC);

-- Event type filtering (e.g. "show all bounces")
CREATE INDEX idx_campaign_events_type
ON campaign_events (organizer_id, event_type, occurred_at DESC);

-- Email lookup (find all events for an email address)
CREATE INDEX idx_campaign_events_email_lower
ON campaign_events (organizer_id, LOWER(email));

-- Deduplication helper: prevent duplicate provider events
CREATE UNIQUE INDEX idx_campaign_events_provider_dedup
ON campaign_events (campaign_id, event_type, LOWER(email), provider_event_id)
WHERE provider_event_id IS NOT NULL;

COMMENT ON TABLE campaign_events
IS 'Engagement layer — immutable append-only event log. Scores and counters are derived, never stored.';

COMMENT ON COLUMN campaign_events.event_type
IS 'SendGrid event type: sent, delivered, open, click, reply, bounce, dropped, deferred, spam_report, unsubscribe.';

COMMENT ON COLUMN campaign_events.recipient_id
IS 'FK to campaign_recipients. SET NULL on deletion to preserve event history.';

COMMENT ON COLUMN campaign_events.person_id
IS 'FK to persons. Links engagement to canonical identity. SET NULL on deletion.';

COMMENT ON COLUMN campaign_events.occurred_at
IS 'When the event actually occurred (from provider timestamp). May differ from created_at.';

COMMENT ON COLUMN campaign_events.provider_event_id
IS 'Provider-assigned ID (e.g. sg_message_id). Used for dedup with idx_campaign_events_provider_dedup.';
