-- 022_add_import_progress_columns.sql
-- Add import tracking columns for background batch processing
-- Prevents Render 30s timeout on large imports (3000+ records)

-- mining_jobs: track import-all background processing
ALTER TABLE mining_jobs ADD COLUMN IF NOT EXISTS import_status VARCHAR(20) DEFAULT NULL;
ALTER TABLE mining_jobs ADD COLUMN IF NOT EXISTS import_progress JSONB DEFAULT NULL;

-- lists: track CSV upload background processing
ALTER TABLE lists ADD COLUMN IF NOT EXISTS import_status VARCHAR(20) DEFAULT NULL;
ALTER TABLE lists ADD COLUMN IF NOT EXISTS import_progress JSONB DEFAULT NULL;
