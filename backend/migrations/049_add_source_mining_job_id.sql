-- 049_add_source_mining_job_id.sql
-- Mining job → persons traceability: which mining job first discovered this person.
-- Enables "show all persons from this job" queries and bulk owner assignment from mining results.
--
-- Nullable: existing ~80K persons stay NULL (no retroactive backfill possible).
-- ON DELETE SET NULL: if mining_jobs row is deleted, persons keep their data but lose the trace.
-- COALESCE on conflict: first job wins — subsequent UPSERTs don't overwrite.
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.

ALTER TABLE persons ADD COLUMN IF NOT EXISTS source_mining_job_id UUID REFERENCES mining_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_persons_source_mining_job ON persons(source_mining_job_id) WHERE source_mining_job_id IS NOT NULL;
