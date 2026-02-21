# CLAUDE_DB.md — Database & Domain Model

> See also: [CLAUDE.md](./CLAUDE.md), [CLAUDE_FEATURES.md](./CLAUDE_FEATURES.md), [CLAUDE_UI.md](./CLAUDE_UI.md), [MINER_GUIDE.md](./MINER_GUIDE.md), [LIFFY_TODO.md](./LIFFY_TODO.md), [MINING_REFACTOR_PLAN.md](./MINING_REFACTOR_PLAN.md)

---

## Canonical Domain Model

### Person (Identity Layer)
A Person represents a real individual.
- primary key = `(organizer_id, email)` — email alone is NOT globally unique
- email is immutable within an organizer scope
- a person exists independently of companies or roles
- different organizers may have the same email as separate persons

### Affiliation (Contextual Role Layer)
An Affiliation represents a relationship between a person and a company.
- a person may have multiple affiliations
- affiliations are additive, never overwritten
- same email + different company = different affiliation
- same email + same company + new info = enrichment, not replacement

### MiningResult (Discovery Event)
A MiningResult is a discovery event, NOT a lead/contact/prospect.
- exists even if the person already exists in DB
- is job-scoped
- powers segmentation and campaigns

### ProspectIntent (Intent Layer)
A prospect is a person who has demonstrated intent (reply, form submission, manual qualification).
- Mining NEVER creates prospects
- Intent is linked to person_id + campaign_id

### CampaignEvent (Engagement Layer)
Engagement is stored as events, not scores.
- Types: sent, delivered, open, click, reply, bounce, dropped, deferred, spam_report, unsubscribe
- Scores are derived views, never persisted

---

## Database — Current State (20 tables, 23 migrations)

### Core Tables (Active, Protected)
| Table | Status | Notes |
|-------|--------|-------|
| `organizers` | ACTIVE | Multi-tenant root |
| `users` | ACTIVE | Organizer users |
| `mining_jobs` | ACTIVE | Scraping job definitions |
| `mining_results` | ACTIVE | Discovery events (discovery only!) |
| `mining_job_logs` | ACTIVE | Job execution logs |
| `campaigns` | ACTIVE | Email campaigns |
| `campaign_recipients` | ACTIVE | Per-recipient tracking |
| `email_templates` | ACTIVE | Reusable templates with placeholders |
| `sender_identities` | ACTIVE | Verified sender emails |
| `unsubscribes` | ACTIVE | Opt-out records |

### Canonical Tables (Constitution Migration — Active)
| Table | Status | Migration | Notes |
|-------|--------|-----------|-------|
| `persons` | ACTIVE | 015 | Identity layer. `(organizer_id, LOWER(email))` unique. Populated by aggregationTrigger + backfill + CSV upload. |
| `affiliations` | ACTIVE | 016 | Person-company relationships. Additive only. Populated by aggregationTrigger + backfill + CSV upload. |
| `prospect_intents` | ACTIVE | 017 | Intent signals. Populated by webhook (reply, click_through). |
| `campaign_events` | ACTIVE | 018 | Immutable event log. Populated by webhook + campaignSend + backfill. |
| `verification_queue` | ACTIVE | 019 | Email verification queue. Processed by worker via ZeroBounce API. |
| `zoho_push_log` | ACTIVE | 020 | Zoho CRM push audit trail. Tracks create/update per person+module. |

### Legacy Tables (Exist but transitional)
| Table | Status | Notes |
|-------|--------|-------|
| `prospects` | LEGACY | Import-all + CSV upload (dual-write) still write here. Will be replaced when features migrate to persons + affiliations. |
| `lists` | LEGACY | Used by campaign resolve + CSV upload. Will be re-evaluated. |
| `list_members` | LEGACY | Used by campaign resolve + CSV upload. Will be re-evaluated. |
| `email_logs` | DEPRECATED | No longer written to (last write in `campaignSend.js` removed). Reports + logs migrated to `campaign_events`. Table retained for historical data only. |

**RULE:** Legacy tables must NOT be deleted. They remain until migration is complete.
New code should prefer canonical tables when available.

---

## Migration Strategy

Phase 1 — Add canonical tables (persons, affiliations). Backfill from mining_results. ✅ DONE
Phase 2 — Add intent + event tables (prospect_intents, campaign_events). Wire up webhook + send. ✅ DONE
Phase 3 — New features use canonical tables. All import paths dual-write. Campaign resolve uses canonical with legacy fallback. ✅ DONE
Phase 4 — Remove legacy tables (5 steps). Full plan in `MIGRATION_PLAN.md`.

**Current phase: Late Phase 3 (approaching Phase 4)**

All migrations (001–023) applied in production. 20 tables active.
`AGGREGATION_PERSIST=true` set on Render — mining pipeline writes to `persons` + `affiliations`.
All import paths (CSV upload, import-all, leads/import) dual-write to both legacy and canonical tables.
Campaign resolve prefers canonical data with legacy fallback.

**Phase 4 steps** (see `MIGRATION_PLAN.md` for full details):
- Step 0: Add `campaign_recipients.person_id` (migration 024)
- Step 1: Add `list_members.person_id`, migrate queries (migration 025)
- Step 2: Remove dual-write to `prospects` from all import paths
- Step 3: Backfill `campaign_events` + freeze `campaign_recipients` mutable columns (migration 026)
- Step 4: Archive `prospects` → `prospects_archive`, drop `email_logs` (migration 027)

**Remaining legacy dependencies:**
- `email_logs` — DEPRECATED. No longer written (last INSERT in `campaignSend.js` removed) or read. Zero active references. Retained for historical data only.
- `prospects` — still written to by all import paths (dual-write), read by leads.js + prospects.js + list endpoints
- `lists` + `list_members` — still used by campaign resolve (via prospect_id), CSV upload, list management
- `campaign_recipients.prospect_id` — references `prospects.id`, no `person_id` column yet
- `urlMiner.js` — writes to `prospects` only (no dual-write to persons)

---

## Aggregation Layer

The aggregation trigger (`backend/services/aggregationTrigger.js`) bridges mining → canonical tables.

**Environment variables:**
| Variable | Default | Production | Effect |
|----------|---------|------------|--------|
| `DISABLE_SHADOW_MODE` | `false` | `false` | `true` disables aggregation entirely |
| `AGGREGATION_PERSIST` | `false` | **`true`** | `true` enables DB writes to persons + affiliations |
| `SHADOW_MODE_VERBOSE` | `false` | `false` | `true` enables verbose candidate logging |

**Production status:** Aggregation is ACTIVE and PERSISTING. Mining pipeline writes to canonical tables.

**Data flow (persist mode):**
```
Miner → normalizeMinerOutput() → aggregationTrigger.aggregate() → persons + affiliations
```

**Call sites:**
- `miningService.js` — full mode + AI mode mining (passes `job.organizer_id`)
- `miningWorker.js` — Playwright strategy (passes `job.organizer_id`)
- `superMiner/services/resultAggregator.js` — aggregateV2() + aggregateSimple() after writeToDatabase()
- `routes/miningResults.js` — POST /api/mining/jobs/:id/results (local miner push)

**Normalizer email filter** (`backend/services/normalizer/emailExtractor.js`):
- B2B-valid prefixes ALLOWED: `info@`, `contact@`, `sales@`, `admin@`, `support@`, `hello@`, `office@`, `general@`, etc.
- Non-person prefixes FILTERED: `noreply@`, `no-reply@`, `mailer-daemon@`, `postmaster@`, `hostmaster@`, `abuse@`, `spam@`, `webmaster@`, `test@`

---

## Backfill Scripts

Located in `backend/scripts/`. One-time, idempotent, `--dry-run` supported.

| Script | Source | Target | Notes |
|--------|--------|--------|-------|
| `backfill_persons.js` | `mining_results` | `persons` + `affiliations` | Uses nameParser + countryNormalizer |
| `backfill_campaign_events.js` | `campaign_recipients` | `campaign_events` | Converts timestamp columns to events |

---

## Migrations (23 files)

| # | File | Tables |
|---|------|--------|
| 001 | `create_email_templates.sql` | `email_templates` |
| 002 | `create_campaigns.sql` | `campaigns` |
| 003 | `create_email_logs.sql` | `email_logs` |
| 004 | `create_organizers_users_sender_identities.sql` | `organizers`, `users`, `sender_identities` |
| 005 | `create_campaign_recipients.sql` | `campaign_recipients` |
| 005 | `mining_logs_and_results_updates.sql` | `mining_job_logs`, ALTER `mining_results` |
| 006 | `create_prospects_and_lists.sql` | `prospects`, `lists`, `list_members` |
| 007 | `create_mining_jobs.sql` | `mining_jobs` |
| 010 | `campaigns_add_list_sender_columns.sql` | ALTER `campaigns` |
| 011 | `campaign_recipients_add_prospect_id.sql` | ALTER `campaign_recipients` |
| 012 | `create_unsubscribes.sql` | `unsubscribes` |
| 013 | `add_webhook_tracking_columns.sql` | ALTER `campaign_recipients`, `unsubscribes` |
| 014 | `add_physical_address.sql` | ALTER `organizers` |
| 015 | `create_persons.sql` | `persons` |
| 016 | `create_affiliations.sql` | `affiliations` |
| 017 | `create_prospect_intents.sql` | `prospect_intents` |
| 018 | `create_campaign_events.sql` | `campaign_events` |
| 019 | `add_verification_columns.sql` | ALTER `organizers`, ALTER `persons`, `verification_queue` |
| 020 | `add_zoho_crm_columns.sql` | ALTER `organizers`, `zoho_push_log` |
| 021 | `prospect_intents_unique_constraint.sql` | UNIQUE INDEX on `prospect_intents` (dedup) |
| 022 | `add_import_progress_columns.sql` | ALTER `mining_jobs`, ALTER `lists` (import_status, import_progress) |
| 023 | `add_campaign_verification_mode.sql` | ALTER `campaigns` (verification_mode) |

---

## Phase 4 — Legacy Removal Roadmap

Legacy removal must be **incremental and reversible**.

1. Stop writing to `prospects` table (remove dual-write in import paths)
2. Migrate `list_members` to reference `persons` instead of `prospects`
3. Remove dual-write in CSV upload, import-all, leads/import
4. Drop `prospects` table (only after full migration verification)
5. Remove legacy resolve fallback in campaign resolve

See [LIFFY_TODO.md](./LIFFY_TODO.md) section E for task tracking.
