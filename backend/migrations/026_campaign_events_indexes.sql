-- Migration: 026_campaign_events_indexes.sql
-- Performance indexes for campaign_events analytics queries

-- created_at for time-range queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaign_events_created_at
  ON campaign_events (created_at DESC);

-- Composite: campaign + event_type for analytics aggregation (sent/open/click/reply counts)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaign_events_campaign_type
  ON campaign_events (campaign_id, event_type);
