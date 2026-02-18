-- 016_create_affiliations.sql
-- Phase 1: Constitution Migration — Contextual Role Layer
--
-- From Constitution:
--   "An Affiliation represents a relationship between a person and a company."
--   "a person may have multiple affiliations"
--   "affiliations are additive, never overwritten"
--   "same email + different company = different affiliation"
--   "same email + same company + new info = enrichment, not replacement"
--
-- RULES:
--   - This migration is ADDITIVE. No existing tables are modified.
--   - Legacy 'prospects' table remains untouched.
--   - Only the Aggregation layer may write to this table.

CREATE TABLE affiliations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    company_name VARCHAR(255),
    position VARCHAR(255),
    country_code VARCHAR(2),
    city VARCHAR(255),
    website VARCHAR(2048),
    phone VARCHAR(100),
    source_type VARCHAR(20),
    source_ref TEXT,
    mining_job_id UUID REFERENCES mining_jobs(id) ON DELETE SET NULL,
    confidence NUMERIC(3,2) CHECK (confidence >= 0 AND confidence <= 1),
    raw JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prevent exact duplicate affiliations (same person + same company within organizer)
-- NULL company_name pairs are allowed (NULLS NOT DISTINCT requires PG15+)
CREATE UNIQUE INDEX idx_affiliations_person_company
ON affiliations (organizer_id, person_id, LOWER(company_name))
WHERE company_name IS NOT NULL;

-- Lookup by person (get all affiliations for a person)
CREATE INDEX idx_affiliations_person_id
ON affiliations (person_id);

-- Lookup by organizer (multi-tenant queries)
CREATE INDEX idx_affiliations_organizer_id
ON affiliations (organizer_id);

-- Lookup by mining job (trace which job discovered this affiliation)
CREATE INDEX idx_affiliations_mining_job_id
ON affiliations (mining_job_id);

-- Lookup by company name (find all people at a company)
CREATE INDEX idx_affiliations_company_lower
ON affiliations (organizer_id, LOWER(company_name))
WHERE company_name IS NOT NULL;

COMMENT ON TABLE affiliations
IS 'Contextual role layer — person-company relationships. Additive only, never overwritten.';

COMMENT ON COLUMN affiliations.person_id
IS 'FK to persons. A person may have many affiliations.';

COMMENT ON COLUMN affiliations.company_name
IS 'Company/organization name as discovered. NULL if unknown.';

COMMENT ON COLUMN affiliations.position
IS 'Job title/position at this company. NULL if unknown.';

COMMENT ON COLUMN affiliations.country_code
IS 'ISO 3166-1 alpha-2 country code (e.g. TR, US, DE). NULL if unknown.';

COMMENT ON COLUMN affiliations.confidence
IS 'Extraction confidence score 0.00–1.00. From normalizer.';

COMMENT ON COLUMN affiliations.mining_job_id
IS 'Which mining job discovered this affiliation. SET NULL on job deletion to preserve affiliation.';

COMMENT ON COLUMN affiliations.raw
IS 'Original raw data from miner output, preserved for audit/debugging.';
