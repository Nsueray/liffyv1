-- mining_results: production-only tablo, koda eklendi (Faz 0a şema kurtarma).
-- NOT: LIFFY migration ordering'i (005→007) ve kolon drift'i Faz 1'e ertelendi.
--
-- EN SONA eklendi (047): boylece mining_jobs (007) zaten mevcut olur ve
-- job_id FK'si ordering cikmazina girmeden kurulur. Idempotent: IF NOT EXISTS
-- + FK/PK icin pg_constraint guard'li DO blogu.

CREATE TABLE IF NOT EXISTS public.mining_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    organizer_id uuid NOT NULL,
    source_url text NOT NULL,
    company_name text,
    contact_name text,
    job_title text,
    phone text,
    country text,
    website text,
    emails text[] DEFAULT '{}'::text[],
    raw jsonb,
    created_at timestamp without time zone DEFAULT now(),
    city text,
    address text,
    confidence_score numeric,
    verification_status text,
    status text,
    updated_at timestamp with time zone
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mining_results_pkey') THEN
    ALTER TABLE ONLY public.mining_results ADD CONSTRAINT mining_results_pkey PRIMARY KEY (id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mining_results_job_created_at ON public.mining_results USING btree (job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mining_results_job_id ON public.mining_results USING btree (job_id);
CREATE INDEX IF NOT EXISTS idx_mining_results_organizer_id ON public.mining_results USING btree (organizer_id);
CREATE INDEX IF NOT EXISTS idx_mining_results_status ON public.mining_results USING btree (status);
CREATE INDEX IF NOT EXISTS idx_mining_results_verification_status ON public.mining_results USING btree (verification_status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mining_results_job_id_fkey') THEN
    ALTER TABLE ONLY public.mining_results
      ADD CONSTRAINT mining_results_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.mining_jobs(id) ON DELETE CASCADE;
  END IF;
END $$;
