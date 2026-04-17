-- 040_template_sender_visibility.sql
-- ADR-015 addendum: visibility for email_templates and sender_identities.
--
-- Default: 'public' (everyone in org sees).
-- Owner can set 'private' → only creator + hierarchy ABOVE (manager chain) sees.
--
-- DO NOT RUN — migration file only. User will apply manually.

-- ─── email_templates ───────────────────────────────────────────────────────

-- Add owner tracking (table never had a user column)
ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Visibility: 'public' (default, everyone) or 'private' (creator + upward chain)
ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'shared';

CREATE INDEX IF NOT EXISTS idx_email_templates_created_by
  ON email_templates(created_by_user_id);

-- ─── sender_identities ─────────────────────────────────────────────────────

-- Already has user_id column — just add visibility
ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'shared';
