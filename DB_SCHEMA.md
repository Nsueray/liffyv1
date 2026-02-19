# Liffy DB Schema Guide

> 20 tables, 23 migrations, PostgreSQL 17 (Render hosted)
> All PKs: UUID via `gen_random_uuid()`. All tables include `organizer_id` for multi-tenant isolation.

---

## Table Index

| # | Table | Status | Category | Created In |
|---|-------|--------|----------|------------|
| 1 | [organizers](#1-organizers) | ACTIVE | Tenant | 004 |
| 2 | [users](#2-users) | ACTIVE | Auth | 004 |
| 3 | [sender_identities](#3-sender_identities) | ACTIVE | Email | 004 |
| 4 | [email_templates](#4-email_templates) | ACTIVE | Email | 001 |
| 5 | [campaigns](#5-campaigns) | ACTIVE | Email | 002 |
| 6 | [campaign_recipients](#6-campaign_recipients) | ACTIVE | Email | 005 |
| 7 | [campaign_events](#7-campaign_events) | ACTIVE | Email (Canonical) | 018 |
| 8 | [mining_jobs](#8-mining_jobs) | ACTIVE | Mining | 007 |
| 9 | [mining_results](#9-mining_results) | ACTIVE | Mining | 005b |
| 10 | [mining_job_logs](#10-mining_job_logs) | ACTIVE | Mining | 005b |
| 11 | [persons](#11-persons) | ACTIVE | Canonical Identity | 015 |
| 12 | [affiliations](#12-affiliations) | ACTIVE | Canonical Identity | 016 |
| 13 | [prospect_intents](#13-prospect_intents) | ACTIVE | Canonical Intent | 017 |
| 14 | [prospects](#14-prospects) | LEGACY | Contacts (Legacy) | 006 |
| 15 | [lists](#15-lists) | LEGACY | Lists | 006 |
| 16 | [list_members](#16-list_members) | LEGACY | Lists | 006 |
| 17 | [unsubscribes](#17-unsubscribes) | ACTIVE | Compliance | 012 |
| 18 | [verification_queue](#18-verification_queue) | ACTIVE | Verification | 019 |
| 19 | [zoho_push_log](#19-zoho_push_log) | ACTIVE | CRM Integration | 020 |
| 20 | [email_logs](#20-email_logs) | DEPRECATED | Legacy Logging | 003 |

---

## Entity Relationship Summary

```
organizers ──┬── users
             ├── sender_identities
             ├── email_templates
             ├── campaigns ──┬── campaign_recipients
             │               ├── campaign_events
             │               └── prospect_intents (via campaign_id)
             ├── mining_jobs ──┬── mining_results
             │                 ├── mining_job_logs
             │                 └── affiliations (via mining_job_id)
             ├── persons ──┬── affiliations
             │             ├── prospect_intents
             │             ├── campaign_events (via person_id)
             │             └── zoho_push_log
             ├── prospects ── list_members ── lists
             ├── unsubscribes
             └── verification_queue
```

---

## Table Details

### 1. organizers

Multi-tenant root table. Every other table references `organizer_id`.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `name` | VARCHAR(255) | NOT NULL | |
| `slug` | VARCHAR(100) | UNIQUE | |
| `logo_url` | TEXT | | |
| `phone` | VARCHAR(50) | | |
| `country` | VARCHAR(100) | | |
| `timezone` | VARCHAR(100) | | |
| `sendgrid_api_key` | TEXT | NOT NULL | SendGrid API key |
| `default_from_email` | VARCHAR(255) | | |
| `default_from_name` | VARCHAR(255) | | |
| `physical_address` | TEXT | | Required for CAN-SPAM/GDPR compliance (migration 014) |
| `zerobounce_api_key` | TEXT | | Per-organizer ZeroBounce key (migration 019) |
| `zoho_client_id` | TEXT | | Zoho OAuth2 (migration 020) |
| `zoho_client_secret` | TEXT | | |
| `zoho_refresh_token` | TEXT | | |
| `zoho_access_token` | TEXT | | Cached access token |
| `zoho_access_token_expires_at` | TIMESTAMPTZ | | |
| `zoho_datacenter` | VARCHAR(20) | DEFAULT 'com' | com, eu, in, com.au, jp, ca |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |

**Read by:** GET /api/settings, campaign send, verification, zoho push
**Written by:** PUT /api/settings/*, DELETE /api/settings/zoho, zohoService token cache
**UI pages:** Settings

---

### 2. users

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | FK → organizers, NOT NULL | |
| `email` | VARCHAR(255) | UNIQUE, NOT NULL | Login email |
| `password_hash` | TEXT | NOT NULL | bcrypt hash |
| `role` | VARCHAR(20) | NOT NULL, DEFAULT 'user' | owner, admin, user |
| `is_active` | BOOLEAN | DEFAULT TRUE | |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |

**Indexes:** `idx_users_organizer_id`
**Read by:** Auth middleware (login)
**Written by:** Registration
**UI pages:** Login (implicit)

---

### 3. sender_identities

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | FK → organizers, NOT NULL | |
| `user_id` | UUID | FK → users, ON DELETE SET NULL | |
| `label` | VARCHAR(100) | | Display label |
| `from_name` | VARCHAR(255) | NOT NULL | |
| `from_email` | VARCHAR(255) | NOT NULL | |
| `reply_to` | VARCHAR(255) | | |
| `is_default` | BOOLEAN | DEFAULT FALSE | |
| `is_active` | BOOLEAN | DEFAULT TRUE | |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |

**Indexes:** `idx_sender_identities_org`, `idx_sender_identities_user`
**Read by:** GET /api/senders, campaign resolve, campaign send
**Written by:** POST /api/senders
**UI pages:** Settings, Campaigns (sender select)

---

### 4. email_templates

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | NOT NULL | |
| `name` | VARCHAR(255) | NOT NULL | |
| `subject` | VARCHAR(255) | NOT NULL | Supports `{{placeholders}}` |
| `body_html` | TEXT | NOT NULL | HTML with `{{placeholders}}` |
| `body_text` | TEXT | | Plain text version |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |

**Indexes:** `idx_email_templates_organizer_id`
**Read by:** GET /api/email-templates, campaign send, campaign detail, reports
**Written by:** POST/PUT/DELETE /api/email-templates, POST clone
**UI pages:** Templates, Campaigns (template select)

---

### 5. campaigns

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | NOT NULL | |
| `template_id` | UUID | FK → email_templates | |
| `name` | VARCHAR(255) | NOT NULL | |
| `status` | VARCHAR(50) | DEFAULT 'draft' | draft → ready → scheduled/sending → completed/paused/failed |
| `scheduled_at` | TIMESTAMP | | Future send time |
| `list_id` | UUID | | FK → lists (migration 010) |
| `sender_id` | UUID | | FK → sender_identities (migration 010) |
| `include_risky` | BOOLEAN | DEFAULT FALSE | Include risky verification status (migration 010) |
| `recipient_count` | INTEGER | | Set at resolve time (migration 010) |
| `verification_mode` | VARCHAR(20) | DEFAULT 'exclude_invalid' | exclude_invalid or verified_only (migration 023) |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |

**Indexes:** `idx_campaigns_organizer_id`, `idx_campaigns_template_id`, `idx_campaigns_list_id`, `idx_campaigns_sender_id`
**Read by:** GET /api/campaigns, analytics, reports, send, resolve
**Written by:** POST/PATCH/DELETE /api/campaigns, resolve, start, pause, resume, schedule
**UI pages:** Campaigns, Campaign Detail, Dashboard (recent), Reports

---

### 6. campaign_recipients

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | NOT NULL | |
| `campaign_id` | UUID | FK → campaigns, NOT NULL | |
| `email` | VARCHAR(320) | NOT NULL | |
| `name` | VARCHAR(255) | | |
| `meta` | JSONB | | first_name, last_name, company, phone, city, website, person_id |
| `status` | VARCHAR(20) | DEFAULT 'pending' | pending → sent → delivered/bounced/failed |
| `last_error` | TEXT | | |
| `prospect_id` | UUID | | FK → prospects (migration 011) |
| `sent_at` | TIMESTAMP | | (migration 005 — implicit from send) |
| `delivered_at` | TIMESTAMP | | (migration 013) |
| `opened_at` | TIMESTAMP | | (migration 013) |
| `clicked_at` | TIMESTAMP | | (migration 013) |
| `bounced_at` | TIMESTAMP | | (migration 013) |
| `open_count` | INTEGER | DEFAULT 0 | (migration 013) |
| `click_count` | INTEGER | DEFAULT 0 | (migration 013) |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |

**Indexes:** `idx_campaign_recipients_campaign_id`, `idx_campaign_recipients_organizer_id`, `idx_campaign_recipients_status`, `idx_campaign_recipients_prospect_id`, `idx_campaign_recipients_email_lower`, `idx_campaign_recipients_sent_at`
**Read by:** Campaign stats, analytics (fallback), recipients list, reports, send-batch, webhooks
**Written by:** Campaign resolve (INSERT), send-batch (UPDATE status/sent_at), webhooks (UPDATE timestamps/counts)
**UI pages:** Campaign Detail (recipients table), Reports (fallback)

---

### 7. campaign_events

Immutable append-only event log. Canonical engagement data.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | FK → organizers, NOT NULL | |
| `campaign_id` | UUID | FK → campaigns, NOT NULL | |
| `recipient_id` | UUID | FK → campaign_recipients, ON DELETE SET NULL | |
| `person_id` | UUID | FK → persons, ON DELETE SET NULL | |
| `event_type` | VARCHAR(20) | NOT NULL, CHECK IN (...) | sent, delivered, open, click, reply, bounce, dropped, deferred, spam_report, unsubscribe |
| `email` | VARCHAR(320) | NOT NULL | |
| `url` | TEXT | | Clicked URL |
| `user_agent` | TEXT | | |
| `ip_address` | VARCHAR(45) | | |
| `reason` | TEXT | | Bounce reason |
| `provider_event_id` | TEXT | | SendGrid sg_message_id |
| `provider_response` | JSONB | | |
| `occurred_at` | TIMESTAMPTZ | DEFAULT NOW() | Event timestamp from provider |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |

**Indexes:** `idx_campaign_events_campaign_id`, `idx_campaign_events_organizer_id`, `idx_campaign_events_recipient_id`, `idx_campaign_events_person_id`, `idx_campaign_events_type`, `idx_campaign_events_email_lower`, `idx_campaign_events_provider_dedup` (UNIQUE)
**Read by:** Analytics, reports, logs, person detail (engagement summary)
**Written by:** Webhooks (INSERT), campaign send-batch (INSERT 'sent' event)
**UI pages:** Campaign Detail (analytics), Reports, Logs, Person Detail (engagement)

---

### 8. mining_jobs

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | FK → organizers, NOT NULL | |
| `type` | VARCHAR(20) | NOT NULL | url, file, ai |
| `input` | TEXT | NOT NULL | URL or file path |
| `name` | VARCHAR(255) | | Job display name |
| `status` | VARCHAR(20) | DEFAULT 'pending' | pending → running → completed/failed |
| `total_found` | INTEGER | DEFAULT 0 | |
| `total_prospects_created` | INTEGER | DEFAULT 0 | |
| `total_emails_raw` | INTEGER | DEFAULT 0 | |
| `stats` | JSONB | | |
| `error` | TEXT | | |
| `import_status` | VARCHAR(20) | DEFAULT NULL | NULL, processing, completed, failed (migration 022) |
| `import_progress` | JSONB | DEFAULT NULL | {imported, skipped, duplicates, total, ...} (migration 022) |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |
| `started_at` | TIMESTAMP | | |
| `completed_at` | TIMESTAMP | | |

**Indexes:** `idx_mining_jobs_organizer_id`, `idx_mining_jobs_status`, `idx_mining_jobs_type`
**Read by:** GET /api/mining/jobs, import-all, import-preview, lists/mining-jobs, dashboard
**Written by:** Mining engine (create/update), import-all (import_status/progress)
**UI pages:** Mining Jobs, Dashboard (recent jobs), Lists (mining job select)

---

### 9. mining_results

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `job_id` | UUID | FK → mining_jobs | |
| `organizer_id` | UUID | | |
| `source_url` | TEXT | | |
| `company_name` | VARCHAR(255) | | |
| `contact_name` | VARCHAR(255) | | |
| `job_title` | VARCHAR(255) | | |
| `emails` | TEXT[] | | Array of email addresses |
| `website` | TEXT | | |
| `phone` | VARCHAR(100) | | |
| `country` | VARCHAR(100) | | |
| `city` | TEXT | | |
| `address` | TEXT | | |
| `confidence_score` | NUMERIC | | 0–100 |
| `verification_status` | TEXT | | |
| `status` | TEXT | | new, imported |
| `raw` | JSONB | | Full raw miner output |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | | |

**Indexes:** `idx_mining_results_job_created_at`, `idx_mining_results_status`, `idx_mining_results_verification_status`
**Read by:** GET /api/mining/jobs/:id/results, import-all, import-preview, backfill_persons script
**Written by:** Mining engine (INSERT), import-all (UPDATE status='imported'), PATCH
**UI pages:** Mining Job Detail (results table)

---

### 10. mining_job_logs

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `job_id` | UUID | FK → mining_jobs, NOT NULL | |
| `timestamp` | TIMESTAMPTZ | DEFAULT NOW() | |
| `level` | TEXT | CHECK IN (debug, info, warn, error, success) | |
| `message` | TEXT | NOT NULL | |
| `details` | JSONB | | |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |

**Indexes:** `idx_mining_job_logs_job_id_ts`
**Read by:** Mining job detail (logs tab)
**Written by:** Mining engine during execution
**UI pages:** Mining Job Detail (logs)

---

### 11. persons

Canonical identity layer. One row per real individual per organizer.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | FK → organizers, NOT NULL | |
| `email` | VARCHAR(320) | NOT NULL | Immutable within organizer scope |
| `first_name` | VARCHAR(255) | | Parsed by normalizer |
| `last_name` | VARCHAR(255) | | Parsed by normalizer |
| `verification_status` | VARCHAR(20) | DEFAULT 'unknown' | unknown, valid, invalid, catchall, risky (migration 019) |
| `verified_at` | TIMESTAMPTZ | | (migration 019) |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |
| `updated_at` | TIMESTAMPTZ | DEFAULT NOW() | |

**Indexes:** `idx_persons_organizer_email` (UNIQUE on organizer_id + LOWER(email)), `idx_persons_organizer_id`, `idx_persons_email_lower`
**Read by:** GET /api/persons (list, stats, detail, affiliations), campaign resolve, verification, zoho push, webhooks, reports
**Written by:** Aggregation trigger, import-all, CSV upload, leads import, verification (status update)
**UI pages:** Contacts (list + detail), Dashboard (stats), Lists detail (name COALESCE), Campaign resolve

---

### 12. affiliations

Person-company relationships. Additive only, never overwritten.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | FK → organizers, NOT NULL | |
| `person_id` | UUID | FK → persons, NOT NULL | |
| `company_name` | VARCHAR(255) | | NULL if unknown. Guarded: no `@` or `|` values |
| `position` | VARCHAR(255) | | Job title |
| `country_code` | VARCHAR(2) | | ISO 3166-1 alpha-2 |
| `city` | VARCHAR(255) | | |
| `website` | VARCHAR(2048) | | |
| `phone` | VARCHAR(100) | | |
| `source_type` | VARCHAR(20) | | mining, import, manual |
| `source_ref` | TEXT | | Job ID, "CSV upload", etc. |
| `mining_job_id` | UUID | FK → mining_jobs, ON DELETE SET NULL | |
| `confidence` | NUMERIC(3,2) | CHECK 0–1 | |
| `raw` | JSONB | | Original miner output |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |

**Indexes:** `idx_affiliations_person_company` (UNIQUE on organizer_id + person_id + LOWER(company_name) WHERE NOT NULL), `idx_affiliations_person_id`, `idx_affiliations_organizer_id`, `idx_affiliations_mining_job_id`, `idx_affiliations_company_lower`
**Read by:** GET /api/persons (LATERAL JOIN for latest), person detail, zoho push
**Written by:** Aggregation trigger, import-all, CSV upload, leads import
**UI pages:** Contacts (company column), Person Detail (affiliations list)

---

### 13. prospect_intents

Intent signals — records that a person demonstrated interest.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | FK → organizers, NOT NULL | |
| `person_id` | UUID | FK → persons, NOT NULL | |
| `campaign_id` | UUID | FK → campaigns, ON DELETE SET NULL | |
| `intent_type` | VARCHAR(30) | CHECK IN (...) | reply, form_submission, manual_qualification, meeting_booked, inbound_request, click_through, referral |
| `source` | VARCHAR(30) | DEFAULT 'manual', CHECK IN (...) | webhook, manual, api, automation |
| `notes` | TEXT | | |
| `confidence` | NUMERIC(3,2) | CHECK 0–1 | |
| `meta` | JSONB | | |
| `occurred_at` | TIMESTAMPTZ | DEFAULT NOW() | |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |
| `created_by_user_id` | UUID | FK → users, ON DELETE SET NULL | |

**Indexes:** `idx_prospect_intents_person_id`, `idx_prospect_intents_organizer_id`, `idx_prospect_intents_campaign_id`, `idx_prospect_intents_type`, `idx_prospect_intents_occurred_at`, `uq_prospect_intent` (UNIQUE dedup — migration 021)
**Read by:** GET /api/intents (list, stats), person detail, persons list (has_intent EXISTS), dashboard
**Written by:** Webhooks (reply/click_through), POST /api/intents (manual)
**UI pages:** Prospects, Person Detail (intents table), Contacts (prospect badge), Dashboard (stats)

---

### 14. prospects

**LEGACY** — still written by all import paths (dual-write). Will be replaced when `list_members` migrates to reference `persons`.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | FK → organizers, NOT NULL | |
| `email` | VARCHAR(320) | NOT NULL | |
| `name` | VARCHAR(255) | | Full name |
| `company` | VARCHAR(255) | | |
| `country` | VARCHAR(100) | | |
| `sector` | VARCHAR(100) | | |
| `source_type` | VARCHAR(20) | | mining, import, manual |
| `source_ref` | TEXT | | |
| `verification_status` | VARCHAR(20) | DEFAULT 'unknown' | |
| `meta` | JSONB | | |
| `tags` | TEXT[] | | |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |

**Indexes:** `idx_prospects_organizer_id`, `idx_prospects_email`, `idx_prospects_verification_status`
**Read by:** Lists (via list_members JOIN), campaign resolve (COALESCE with persons), leads, verification (dual-write)
**Written by:** Import-all, CSV upload, leads import, verification (status dual-write), add-manual, import-bulk
**UI pages:** Lists detail (via list_members), Leads (legacy)

---

### 15. lists

**LEGACY** — used by campaign resolve and CSV upload. Will be re-evaluated in Phase 4.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | FK → organizers, NOT NULL | |
| `name` | VARCHAR(255) | NOT NULL | |
| `description` | TEXT | | |
| `type` | VARCHAR(20) | | import, manual, filter |
| `created_by_user_id` | UUID | FK → users, ON DELETE SET NULL | |
| `import_status` | VARCHAR(20) | DEFAULT NULL | processing, completed, failed (migration 022) |
| `import_progress` | JSONB | DEFAULT NULL | (migration 022) |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |

**Indexes:** `idx_lists_organizer_id`
**Read by:** GET /api/lists, list detail, campaign resolve, campaign create/edit, verification (list dropdown)
**Written by:** CSV upload, create-with-filters, create-empty, import-all (when create_list=true)
**UI pages:** Lists, List Detail, Campaigns (audience select), Verification (list dropdown)

---

### 16. list_members

**LEGACY** — references `prospect_id` (not `person_id`). Phase 4 will migrate to reference persons.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | FK → organizers, NOT NULL | |
| `list_id` | UUID | FK → lists, NOT NULL | |
| `prospect_id` | UUID | FK → prospects, NOT NULL | |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |

**Constraints:** UNIQUE (list_id, prospect_id)
**Indexes:** `idx_list_members_list_id`, `idx_list_members_organizer_id`
**Read by:** List detail, campaign resolve, list counts, verification (list emails)
**Written by:** CSV upload, import-all, create-with-filters, add-manual, import-bulk
**UI pages:** Lists (counts), List Detail (member list)

---

### 17. unsubscribes

Global email suppression list per organizer.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | NOT NULL | |
| `email` | VARCHAR(320) | NOT NULL | |
| `reason` | VARCHAR(100) | | user_request, hard_bounce, complaint |
| `source` | VARCHAR(50) | DEFAULT 'manual' | (migration 013) |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |

**Constraints:** UNIQUE (organizer_id, email) — migration 013
**Indexes:** `idx_unsubscribes_organizer_id`, `idx_unsubscribes_organizer_email_lower`
**Read by:** Campaign resolve (exclude unsubscribed), campaign send (skip check)
**Written by:** Webhooks (unsubscribe event), unsubscribe endpoint
**UI pages:** (not directly displayed — used during campaign resolve)

---

### 18. verification_queue

Email verification queue processed by background worker.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | FK → organizers, NOT NULL | |
| `email` | VARCHAR(320) | NOT NULL | |
| `person_id` | UUID | FK → persons, ON DELETE SET NULL | |
| `prospect_id` | UUID | FK → prospects, ON DELETE SET NULL | |
| `status` | VARCHAR(20) | DEFAULT 'pending' | pending → processing → completed/failed |
| `result` | JSONB | | ZeroBounce API response |
| `created_at` | TIMESTAMPTZ | DEFAULT NOW() | |
| `processed_at` | TIMESTAMPTZ | | |

**Indexes:** `idx_verification_queue_pending` (partial: WHERE status='pending'), `idx_verification_queue_dedup` (UNIQUE partial: WHERE status IN pending/processing)
**Read by:** Queue status endpoint, verification worker
**Written by:** verify-list (queue), CSV upload (auto-queue), verification worker (status update)
**UI pages:** Verification Dashboard (queue stats), List Detail (verification progress)

---

### 19. zoho_push_log

Audit trail for Zoho CRM pushes.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | FK → organizers, NOT NULL | |
| `person_id` | UUID | FK → persons, NOT NULL | |
| `zoho_module` | VARCHAR(20) | CHECK IN ('Leads', 'Contacts') | |
| `zoho_record_id` | VARCHAR(50) | | Zoho CRM record ID (for update dedup) |
| `action` | VARCHAR(10) | CHECK IN ('create', 'update') | |
| `status` | VARCHAR(20) | DEFAULT 'success' | |
| `error_message` | TEXT | | |
| `field_snapshot` | JSONB | | Data sent to Zoho |
| `pushed_at` | TIMESTAMPTZ | DEFAULT NOW() | |
| `pushed_by_user_id` | UUID | FK → users, ON DELETE SET NULL | |

**Indexes:** `idx_zoho_push_log_person_module`, `idx_zoho_push_log_latest`, `idx_zoho_push_log_organizer`
**Read by:** Zoho push (dedup check for zoho_record_id), push history, push status, person detail
**Written by:** POST /api/zoho/push, POST /api/zoho/push-list
**UI pages:** Person Detail (Zoho sync history), Zoho Push History (future)

---

### 20. email_logs

**DEPRECATED** — No longer written to or read from. Retained for historical data only.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | UUID | PK | |
| `organizer_id` | UUID | NOT NULL | |
| `campaign_id` | UUID | | |
| `template_id` | UUID | | |
| `recipient_email` | VARCHAR(320) | NOT NULL | |
| `recipient_data` | JSONB | | |
| `status` | VARCHAR(50) | DEFAULT 'queued' | |
| `provider_response` | JSONB | | |
| `sent_at` | TIMESTAMP | | |
| `created_at` | TIMESTAMP | DEFAULT NOW() | |

**Read by:** Nothing (deprecated)
**Written by:** Nothing (deprecated)
**UI pages:** None

---

## UI Page → API → Table Map

| UI Page | Route | Primary API Endpoints | Primary Tables |
|---------|-------|----------------------|----------------|
| **Dashboard** | `/dashboard` | persons/stats, reports/overview, intents/stats, campaigns, mining/jobs | persons, campaigns, campaign_events, campaign_recipients, prospect_intents, mining_jobs |
| **Contacts** | `/leads` | persons, persons/stats | persons, affiliations, prospect_intents |
| **Contact Detail** | `/leads/[id]` | persons/:id, verification/verify-single | persons, affiliations, prospect_intents, campaign_events, zoho_push_log |
| **Lists** | `/lists` | lists, lists/tags, lists/mining-jobs, lists/preview, lists/create-* | lists, list_members, prospects, persons, mining_jobs |
| **List Detail** | `/lists/[id]` | lists/:id, verification/verify-list, verification/queue-status | lists, list_members, prospects, persons, verification_queue |
| **Campaigns** | `/campaigns` | campaigns, email-templates, lists, senders | campaigns, email_templates, lists, sender_identities |
| **Campaign Detail** | `/campaigns/[id]` | campaigns/:id, campaigns/:id/analytics, campaigns/:id/recipients | campaigns, campaign_events, campaign_recipients, email_templates |
| **Templates** | `/templates` | email-templates | email_templates |
| **Mining Jobs** | `/mining/jobs` | mining/jobs | mining_jobs |
| **Mining Detail** | `/mining/[id]` | mining/jobs/:id/results | mining_results, mining_jobs |
| **Prospects** | `/prospects` | intents, intents/stats | prospect_intents, persons, campaigns |
| **Verification** | `/verification` | verification/*, lists | verification_queue, organizers, lists |
| **Reports** | `/reports` | reports/overview, campaigns, campaigns/:id/stats | campaign_events, campaign_recipients, campaigns, persons |
| **Settings** | `/settings` | settings, senders | organizers, sender_identities |

---

## Data Flow Diagrams

### Mining → Canonical Tables
```
Miner output → normalizeMinerOutput() → aggregationTrigger.aggregate()
  → persons UPSERT (organizer_id + LOWER(email))
  → affiliations UPSERT (organizer_id + person_id + LOWER(company_name))
```

### Import-All (Dual-Write)
```
mining_results → processImportBatch()
  → prospects INSERT/UPDATE (legacy)
  → list_members INSERT (legacy)
  → persons UPSERT (canonical)
  → affiliations UPSERT (canonical, skip if company has @ or |)
  → mining_results UPDATE status='imported'
```

### Campaign Send Flow
```
campaign resolve → campaign_recipients INSERT
  → send-batch → SendGrid API → campaign_recipients UPDATE
  → campaign_events INSERT (sent)
  → SendGrid webhook → campaign_events INSERT (delivered/open/click/bounce/...)
  → prospect_intents INSERT (if reply or click_through)
```

### Verification Flow
```
verify-list → verification_queue INSERT (pending)
  → worker polls every 15s → ZeroBounce API
  → persons UPDATE verification_status
  → prospects UPDATE verification_status (dual-write)
  → verification_queue UPDATE status=completed
```

---

## Migration History

| # | File | Tables/Columns |
|---|------|---------------|
| 001 | `create_email_templates.sql` | email_templates |
| 002 | `create_campaigns.sql` | campaigns |
| 003 | `create_email_logs.sql` | email_logs |
| 004 | `create_organizers_users_sender_identities.sql` | organizers, users, sender_identities |
| 005 | `create_campaign_recipients.sql` | campaign_recipients |
| 005b | `mining_logs_and_results_updates.sql` | mining_job_logs, ALTER mining_results |
| 006 | `create_prospects_and_lists.sql` | prospects, lists, list_members |
| 007 | `create_mining_jobs.sql` | mining_jobs |
| 010 | `campaigns_add_list_sender_columns.sql` | ALTER campaigns (+list_id, sender_id, include_risky, recipient_count) |
| 011 | `campaign_recipients_add_prospect_id.sql` | ALTER campaign_recipients (+prospect_id) |
| 012 | `create_unsubscribes.sql` | unsubscribes |
| 013 | `add_webhook_tracking_columns.sql` | ALTER campaign_recipients (+timestamps, counts), ALTER unsubscribes (+source) |
| 014 | `add_physical_address.sql` | ALTER organizers (+physical_address) |
| 015 | `create_persons.sql` | persons |
| 016 | `create_affiliations.sql` | affiliations |
| 017 | `create_prospect_intents.sql` | prospect_intents |
| 018 | `create_campaign_events.sql` | campaign_events |
| 019 | `add_verification_columns.sql` | ALTER organizers (+zerobounce_api_key), ALTER persons (+verification_status, verified_at), verification_queue |
| 020 | `add_zoho_crm_columns.sql` | ALTER organizers (+zoho_*), zoho_push_log |
| 021 | `prospect_intents_unique_constraint.sql` | UNIQUE INDEX on prospect_intents |
| 022 | `add_import_progress_columns.sql` | ALTER mining_jobs (+import_status, import_progress), ALTER lists (+import_status, import_progress) |
| 023 | `add_campaign_verification_mode.sql` | ALTER campaigns (+verification_mode) |

---

## Write Path Guards

All write paths to `affiliations.company_name` enforce:
- **No email addresses:** `!value.includes('@')` — prevents "user@gmail.com" as company
- **No pipe-separated junk:** `!value.includes('|')` — prevents "Name | No company | email" as company

Files with guards: `miningResults.js`, `aggregationTrigger.js`, `lists.js` (both CSV paths), `leads.js`

All read paths from `affiliations.company_name` in `persons.js` apply:
- **LATERAL JOIN filter:** `company_name NOT LIKE '%@%'`
- **CASE/SPLIT_PART:** extracts first segment if pipe-separated, NULL if email
