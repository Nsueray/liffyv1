-- Migration 045: VARCHAR(255) → TEXT for columns that overflow from PDF parsing
-- MUST run BEFORE deploying the code fix (Render auto-deploy on push to main)
-- After running, retry 21 failed_varchar_overflow rows:
--   UPDATE mining_results SET status = 'pending' WHERE status = 'failed' AND job_id IN (SELECT id FROM mining_jobs WHERE status = 'completed');

BEGIN;

ALTER TABLE affiliations ALTER COLUMN company_name TYPE TEXT;
ALTER TABLE affiliations ALTER COLUMN position TYPE TEXT;
ALTER TABLE affiliations ALTER COLUMN city TYPE TEXT;

ALTER TABLE prospects ALTER COLUMN name TYPE TEXT;
ALTER TABLE prospects ALTER COLUMN company TYPE TEXT;

ALTER TABLE persons ALTER COLUMN first_name TYPE TEXT;
ALTER TABLE persons ALTER COLUMN last_name TYPE TEXT;

COMMIT;
