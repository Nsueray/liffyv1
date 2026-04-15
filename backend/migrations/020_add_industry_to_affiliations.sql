-- Migration 020: Add industry column to affiliations table
-- Run manually: psql -f backend/migrations/020_add_industry_to_affiliations.sql

ALTER TABLE affiliations ADD COLUMN IF NOT EXISTS industry VARCHAR(100);

-- Index for industry filtering
CREATE INDEX IF NOT EXISTS idx_affiliations_industry
  ON affiliations (organizer_id, industry)
  WHERE industry IS NOT NULL;

-- Verify
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'affiliations' AND column_name = 'industry';
