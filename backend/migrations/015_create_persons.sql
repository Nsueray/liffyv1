-- 015_create_persons.sql
-- Phase 1: Constitution Migration — Identity Layer
--
-- From Constitution:
--   "A Person represents a real individual."
--   "primary key = (organizer_id, email) — email alone is NOT globally unique"
--   "email is immutable within an organizer scope"
--   "a person exists independently of companies or roles"
--   "different organizers may have the same email as separate persons"
--
-- RULES:
--   - This migration is ADDITIVE. No existing tables are modified.
--   - Legacy 'prospects' table remains untouched.
--   - Only the Aggregation layer may write to this table.

CREATE TABLE persons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    email VARCHAR(320) NOT NULL,
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Canonical identity constraint: (organizer_id, email) is unique
-- Case-insensitive email matching to prevent duplicates like John@Acme.com vs john@acme.com
CREATE UNIQUE INDEX idx_persons_organizer_email
ON persons (organizer_id, LOWER(email));

-- Lookup by organizer (multi-tenant queries)
CREATE INDEX idx_persons_organizer_id
ON persons (organizer_id);

-- Lookup by email within organizer (fast exact match)
CREATE INDEX idx_persons_email_lower
ON persons (LOWER(email));

COMMENT ON TABLE persons
IS 'Identity layer — one row per real individual per organizer. Email is immutable within organizer scope.';

COMMENT ON COLUMN persons.email
IS 'Email address — sole identity key. Immutable within (organizer_id) scope.';

COMMENT ON COLUMN persons.first_name
IS 'Parsed first name (from normalizer). NULL if unknown.';

COMMENT ON COLUMN persons.last_name
IS 'Parsed last name (from normalizer). NULL if unknown.';
