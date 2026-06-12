-- Migration 052: Replace quotes.company_id FK with company_name TEXT
-- Reason: companies table is empty (0 rows), all company data lives in affiliations.
--         Quote needs a company label, not a FK reference.
-- Safe: 0 quotes exist, column swap is clean.

BEGIN;

-- Drop the FK column and index
ALTER TABLE quotes DROP COLUMN IF EXISTS company_id;
DROP INDEX IF EXISTS idx_quotes_company;

-- Add company_name TEXT NOT NULL
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS company_name TEXT NOT NULL DEFAULT '';
ALTER TABLE quotes ALTER COLUMN company_name DROP DEFAULT;

COMMIT;
