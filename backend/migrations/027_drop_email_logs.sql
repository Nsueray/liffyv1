-- Migration: 027_drop_email_logs.sql
-- email_logs fully replaced by campaign_events. No active writes or reads remain.

DROP TABLE IF EXISTS email_logs;
