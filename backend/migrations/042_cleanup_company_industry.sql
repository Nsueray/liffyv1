-- Migration 042: Cleanup email-domain company names + industry typo normalization
-- Run manually: psql $DATABASE_URL -f backend/migrations/042_cleanup_company_industry.sql

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- Part A: Email domain company names → NULL
-- These are email provider domains incorrectly stored as company_name
-- ═══════════════════════════════════════════════════════════════════════

UPDATE affiliations SET company_name = NULL
WHERE LOWER(company_name) IN (
  'yahoo', 'yahoo co in', 'yahoo com',
  'gmail', 'hotmail', 'outlook', 'live', 'msn', 'aol',
  'mail', 'ymail', 'rocketmail', 'icloud',
  'rediffmail',
  'africaonline', 'africaonline com gh',
  '4u com gh'
);
-- Expected: ~887 rows

-- ═══════════════════════════════════════════════════════════════════════
-- Part B: Industry typo normalization
-- Merge misspelled/duplicate industry values into canonical forms
-- ═══════════════════════════════════════════════════════════════════════

-- Construction variants (48 rows)
UPDATE affiliations SET industry = 'Construction'
WHERE industry IN ('Constraction', 'CONSTRUTION');

-- Electricity variants (19 rows)
UPDATE affiliations SET industry = 'Electricity'
WHERE industry IN ('ELECTIRICITY');

-- Led / Sign / Lighting variants (1 row)
UPDATE affiliations SET industry = 'Led & Sign / Lighting'
WHERE industry = 'Led / Sign / Lighting';

COMMIT;
