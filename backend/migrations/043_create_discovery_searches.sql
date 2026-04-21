-- Migration 043: Discovery search history
-- Stores source discovery searches and their results for replay/history

CREATE TABLE discovery_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES organizers(id),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source_type VARCHAR(30) NOT NULL,
  keyword TEXT,
  industry VARCHAR(100),
  countries TEXT[],
  results JSONB NOT NULL DEFAULT '[]',
  result_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_discovery_searches_org ON discovery_searches(organizer_id, created_at DESC);
