-- 036_allow_null_template_id.sql
-- Sequence campaigns store templates per-step (campaign_sequences.template_id),
-- not on the campaign itself. Allow NULL template_id on campaigns table.

ALTER TABLE campaigns ALTER COLUMN template_id DROP NOT NULL;
