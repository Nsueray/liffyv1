-- ============================================================
-- Migration: Add physical_address to organizers table
-- Version: 014
-- Date: 2025-01-23
-- Purpose: Legal compliance - CAN-SPAM/GDPR requires physical address
-- ============================================================

-- Add physical_address column to organizers
ALTER TABLE organizers 
ADD COLUMN IF NOT EXISTS physical_address TEXT;

-- Add comment explaining the requirement
COMMENT ON COLUMN organizers.physical_address IS 
'Physical mailing address required for email compliance (CAN-SPAM/GDPR). Campaign sending is blocked if empty.';

-- Optional: Add a constraint to prevent empty strings (but allow NULL for migration)
-- This allows existing organizers to still function until they add their address
-- The application layer will enforce the requirement when sending campaigns

-- Create index for potential future queries
CREATE INDEX IF NOT EXISTS idx_organizers_physical_address_null 
ON organizers (id) 
WHERE physical_address IS NULL OR physical_address = '';

-- Log migration
DO $$
BEGIN
  RAISE NOTICE 'Migration 014: physical_address column added to organizers table';
  RAISE NOTICE 'IMPORTANT: Organizers must add their physical address before sending campaigns';
END $$;
