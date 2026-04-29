-- 046_create_companies.sql
-- ADR-014 Phase 1: Company entity table + affiliations.company_id column
-- ELL_RULES v4: country_code and sector_id are soft FKs (cross-system, no FK constraint)
--
-- Run BEFORE deploying code that references companies table.
-- No data backfill — that's Week 2 migration script.

BEGIN;

-- pg_trgm for fuzzy name search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- COMPANIES TABLE
-- ============================================================
CREATE TABLE companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,

    -- Identity
    name VARCHAR(500) NOT NULL,
    name_normalized VARCHAR(500) NOT NULL,  -- lowercased, trimmed, dedup key

    -- Location (country_code = soft FK to core_countries.code, NO FK constraint — R1)
    country_code CHAR(2),
    city VARCHAR(200),

    -- Classification (sector_id = soft FK to core_sectors.id, NO FK constraint — R1)
    sector_id INTEGER,

    -- Contact
    website VARCHAR(500),
    phone VARCHAR(50),
    email VARCHAR(320),

    -- Metadata
    employee_count VARCHAR(50),   -- '1-10', '11-50', '51-200', '201-500', '500+', NULL
    company_type VARCHAR(50),     -- 'manufacturer', 'distributor', 'agent', 'contractor', 'other'
    source VARCHAR(50),           -- 'zoho_import', 'manual', 'mining', 'data_entry_form', 'lead_convert'
    zoho_account_id VARCHAR(50),
    tags TEXT[],
    notes TEXT,

    -- Ownership
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    assigned_to_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Dedup constraint: one canonical name per organizer
    CONSTRAINT uq_companies_organizer_name UNIQUE (organizer_id, name_normalized)
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_companies_organizer ON companies(organizer_id);
CREATE INDEX idx_companies_country ON companies(country_code);
CREATE INDEX idx_companies_sector ON companies(sector_id);
CREATE INDEX idx_companies_assigned_user ON companies(assigned_to_user_id);
CREATE INDEX idx_companies_name_trgm ON companies USING gin(name gin_trgm_ops);
CREATE INDEX idx_companies_zoho_id ON companies(zoho_account_id) WHERE zoho_account_id IS NOT NULL;

-- ============================================================
-- TRIGGER: auto-update updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_companies_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_companies_updated_at
    BEFORE UPDATE ON companies
    FOR EACH ROW
    EXECUTE FUNCTION update_companies_updated_at();

-- ============================================================
-- AFFILIATIONS: add company_id (nullable, backfill in Week 2)
-- ============================================================
ALTER TABLE affiliations ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_affiliations_company ON affiliations(company_id) WHERE company_id IS NOT NULL;

COMMENT ON TABLE companies IS 'Canonical company entity. One row per normalized company name per organizer. ADR-014 Phase 1.';
COMMENT ON COLUMN companies.country_code IS 'ISO 3166-1 alpha-2. Soft FK to core_countries.code (cross-system, ELIZA writes, Liffy reads).';
COMMENT ON COLUMN companies.sector_id IS 'Soft FK to core_sectors.id (cross-system, ELIZA writes, Liffy reads).';
COMMENT ON COLUMN companies.name_normalized IS 'Lowercased, trimmed canonical name for dedup. UNIQUE per organizer.';
COMMENT ON COLUMN affiliations.company_id IS 'FK to companies. NULL until Week 2 backfill migration. ADR-014 Phase 1.';

COMMIT;
