-- Migration 023: Add verification_mode to campaigns
-- Controls how verification status is filtered during resolve:
--   'exclude_invalid' (default) — exclude invalid/risky, send to rest
--   'verified_only' — only send to valid/catchall verified emails

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS verification_mode VARCHAR(20) DEFAULT 'exclude_invalid';
