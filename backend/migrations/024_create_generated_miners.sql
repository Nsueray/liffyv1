-- Migration 024: AI Miner Generator — generated_miners table
-- Phase 0: Foundation for self-evolving mining engine
-- Stores AI-generated extraction code per domain, with approval workflow and quality tracking.

CREATE TABLE IF NOT EXISTS generated_miners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID REFERENCES organizers(id) ON DELETE SET NULL,  -- NULL = global
  domain_pattern VARCHAR(255) NOT NULL,
  url_pattern TEXT,
  miner_code TEXT NOT NULL,
  miner_version INTEGER DEFAULT 1,

  -- Metadata
  source_url TEXT NOT NULL,
  source_html_hash VARCHAR(64),
  ai_model VARCHAR(50) DEFAULT 'claude-sonnet-4-20250514',
  ai_prompt_version VARCHAR(20) DEFAULT 'v1',
  generation_tokens_used INTEGER,

  -- Quality tracking
  test_result JSONB,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  total_contacts_mined INTEGER DEFAULT 0,
  quality_score NUMERIC(3,2),

  -- Lifecycle
  status VARCHAR(20) DEFAULT 'pending_approval',
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  disabled_reason TEXT,
  last_used_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_generated_miners_domain ON generated_miners(domain_pattern, status);
CREATE INDEX idx_generated_miners_quality ON generated_miners(quality_score DESC) WHERE status = 'active';
CREATE INDEX idx_generated_miners_organizer ON generated_miners(organizer_id) WHERE organizer_id IS NOT NULL;
