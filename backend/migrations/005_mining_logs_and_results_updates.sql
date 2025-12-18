-- Ensure UUID helpers exist
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Mining job logs table for console view
CREATE TABLE IF NOT EXISTS public.mining_job_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES public.mining_jobs(id) ON DELETE CASCADE,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error', 'success')),
  message TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mining_job_logs_job_id_ts ON public.mining_job_logs(job_id, timestamp);

-- Mining results enhancements for staging area + inline edits
ALTER TABLE public.mining_results
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS confidence_score NUMERIC,
  ADD COLUMN IF NOT EXISTS verification_status TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS raw JSONB,
  ADD COLUMN IF NOT EXISTS organizer_id UUID;

CREATE INDEX IF NOT EXISTS idx_mining_results_job_created_at ON public.mining_results(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mining_results_status ON public.mining_results(status);
CREATE INDEX IF NOT EXISTS idx_mining_results_verification_status ON public.mining_results(verification_status);
