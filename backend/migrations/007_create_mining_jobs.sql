-- 007_create_mining_jobs.sql

-- MINING JOBS
-- Generic jobs for data mining from URL / PDF / Excel / Word etc.
CREATE TABLE mining_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL,              -- url, pdf, excel, word, other
    input TEXT NOT NULL,                    -- URL or file path / name
    status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed
    total_found INTEGER DEFAULT 0,          -- raw items found (emails, rows, etc.)
    total_prospects_created INTEGER DEFAULT 0,
    total_emails_raw INTEGER DEFAULT 0,
    stats JSONB,                            -- generic stats JSON (per type)
    error TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    started_at TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE INDEX idx_mining_jobs_organizer_id ON mining_jobs(organizer_id);
CREATE INDEX idx_mining_jobs_status ON mining_jobs(status);
CREATE INDEX idx_mining_jobs_type ON mining_jobs(type);
