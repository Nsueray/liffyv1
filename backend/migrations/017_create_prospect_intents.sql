-- 017_create_prospect_intents.sql
-- Phase 2: Constitution Migration — Intent Layer
--
-- From Constitution:
--   "A prospect is a person who has demonstrated intent
--    (reply, form submission, manual qualification)."
--   "Mining NEVER creates prospects."
--   "Intent is linked to person_email + campaign_id."
--
-- RULES:
--   - This migration is ADDITIVE. No existing tables are modified.
--   - Legacy 'prospects' table remains untouched.
--   - Intent signals are events, not status flags.
--   - A person may have multiple intents across campaigns.

CREATE TABLE prospect_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,

    -- Intent classification
    intent_type VARCHAR(30) NOT NULL
        CHECK (intent_type IN (
            'reply',               -- replied to campaign email
            'form_submission',     -- filled out a form / landing page
            'manual_qualification',-- manually qualified by user
            'meeting_booked',      -- meeting/demo scheduled
            'inbound_request',     -- inbound inquiry
            'click_through',       -- clicked CTA in email
            'referral'             -- referred by another prospect
        )),

    -- Context
    source VARCHAR(30) NOT NULL DEFAULT 'manual'
        CHECK (source IN ('webhook', 'manual', 'api', 'automation')),
    notes TEXT,
    confidence NUMERIC(3,2) CHECK (confidence >= 0 AND confidence <= 1),
    meta JSONB,

    -- Timestamps
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Lookup by person (all intents for a person)
CREATE INDEX idx_prospect_intents_person_id
ON prospect_intents (person_id);

-- Lookup by organizer (multi-tenant)
CREATE INDEX idx_prospect_intents_organizer_id
ON prospect_intents (organizer_id);

-- Lookup by campaign (which campaign generated this intent)
CREATE INDEX idx_prospect_intents_campaign_id
ON prospect_intents (campaign_id);

-- Filter by intent type (e.g. show all replies)
CREATE INDEX idx_prospect_intents_type
ON prospect_intents (organizer_id, intent_type);

-- Timeline queries (recent intents first)
CREATE INDEX idx_prospect_intents_occurred_at
ON prospect_intents (organizer_id, occurred_at DESC);

COMMENT ON TABLE prospect_intents
IS 'Intent layer — records that a person demonstrated interest. Mining never writes here.';

COMMENT ON COLUMN prospect_intents.intent_type
IS 'What the person did: reply, form_submission, manual_qualification, meeting_booked, inbound_request, click_through, referral.';

COMMENT ON COLUMN prospect_intents.source
IS 'How the intent was recorded: webhook (automated from SendGrid), manual (user action), api, automation.';

COMMENT ON COLUMN prospect_intents.occurred_at
IS 'When the intent actually happened (may differ from created_at if entered retroactively).';

COMMENT ON COLUMN prospect_intents.campaign_id
IS 'Campaign that triggered this intent. NULL for non-campaign intents (inbound, manual). SET NULL on campaign deletion.';
