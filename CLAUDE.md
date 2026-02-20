# CLAUDE.md — Liffy Project Instructions (Constitution-Aligned)

## What is Liffy?

Liffy is a multi-tenant SaaS platform for data discovery, qualification, and communication.
It is NOT a simple scraping or emailing tool.
Built for Elan Expo, designed to scale.

## Governing Document

This project follows the **Liffy Product & Data Constitution**.
If any implementation conflicts with the principles below, the principles win.

---

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** PostgreSQL 17 (Render hosted)
- **Frontend:** Next.js + TypeScript (liffy-ui repo) / Bootstrap 5 + CDN for static assets
- **Email:** SendGrid API only (nodemailer removed)
- **Deployment:** Render + custom domain (liffy.app, api.liffy.app, cdn.liffy.app)
- **Design:** Static assets served from `https://cdn.liffy.app/` (logo.png, style.css)
- **SQL:** Raw SQL with `pg` library. NO ORMs (no Sequelize, no Prisma, no Knex)

---

## Core Philosophy

### 1. Mining Is Discovery, Not Creation
Mining discovers that a person or company appears in a source.
Mining NEVER creates leads, contacts, or prospects.
Mining only declares: "This entity was found here, at this time, in this context."

### 2. Separation of Concerns Is Sacred
Liffy strictly separates:
- **Extraction** (miners) — get raw data
- **Interpretation** (normalization) — parse raw into candidates
- **Decision & persistence** (aggregation) — merge into DB
- **Communication** (campaigns) — send emails

Any component that crosses these boundaries is architecturally invalid.

**Canonical tables (`persons`, `affiliations`) are written by:**
- Aggregation layer (mining pipeline, when `AGGREGATION_PERSIST=true`)
- Import paths (CSV upload, import-all, leads/import) via Phase 3 dual-write
Miners and normalizers NEVER write to the database directly.

### 3. No Silent Data Loss
Never drop columns, tables, or data without explicit instruction.
Migrations must be additive. If renaming: create new → migrate data → deprecate old.

### 4. Multi-Tenant Always
Every query MUST include `organizer_id` filtering. No exceptions.
Different organizers NEVER merge, even if emails match.
Cross-organizer email uniqueness does NOT exist.

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

**Normalizer email filter** (`backend/services/normalizer/emailExtractor.js`):
- B2B-valid prefixes ALLOWED: `info@`, `contact@`, `sales@`, `admin@`, `support@`, `hello@`, `office@`, `general@`, etc.
- Non-person prefixes FILTERED: `noreply@`, `no-reply@`, `mailer-daemon@`, `postmaster@`, `hostmaster@`, `abuse@`, `spam@`, `webmaster@`, `test@`

---

## Mining Engine — Pagination (SuperMiner v3.2)

Mining engine now supports multi-page crawling for paginated sites. Previously only page 1 was mined.

**How it works:**
```
Job URL (e.g. ?page=1)
  → detectPagination() — checks URL pattern + SmartRouter hints + HTML analysis
  → detectTotalPages() — scans pagination elements, link hrefs, "Page X of Y" text
  → mineAllPages() — iterates through all pages, merges + deduplicates results
  → Aggregator V1 → Redis (all contacts from all pages)
  → Aggregator V2 → DB write + canonical aggregation
```

**Pagination detection signals:**
- URL contains `?page=N` or `/page/N/` (strong signal)
- PageAnalyzer detects pagination elements (`.pagination`, `nav[aria-label*="pagination"]`)
- SmartRouter hints include `pagination.detected: true`

**Safety guards:**
- Stops after 3 consecutive empty pages
- Stops after 2 consecutive duplicate-content pages (content hash fingerprinting)
- Polite delay between pages (`list_page_delay_ms`, default 2000ms)
- Hard max pages limit (`max_pages`, default 20)

**Job config options:**
| Config Key | Default | Description |
|------------|---------|-------------|
| `max_pages` | `20` | Maximum pages to mine |
| `list_page_delay_ms` | `2000` | Delay between page requests (ms) |

**URL construction strategies** (in priority order):
1. `/page/\d+` → replace with `/page/{N}`
2. `?page=\d+` or `&page=\d+` → replace param value
3. Append `?page=N` or `&page=N`

**Files:**
- `backend/services/superMiner/services/paginationHandler.js` — URL builder, page detection, content hashing
- `backend/services/superMiner/services/flowOrchestrator.js` — `detectPagination()`, `mineAllPages()`, `mineSinglePage()`
- `backend/services/miningService.js` — `detectJobPagination()`, pagination in `runAIMining()` + `runFullMining()`

**Both paths support pagination:**
- SuperMiner path (FlowOrchestrator) — when `SUPERMINER_ENABLED=true`
- Legacy path (miningService) — `runAIMining()` and `runFullMining()`

---

## File Mining Pipeline (Excel/CSV/PDF/Word)

File mining uses `fileOrchestrator.js` (v2.0) — a multi-phase pipeline:

```
Upload → worker picks up pending job → miningService.processMiningJob()
  → fileOrchestrator.orchestrate(job)
    → Phase 1: Extraction (excelExtractor / pdfExtractor / wordExtractor)
    → Phase 2: Mining (structuredMiner + tableMiner + unstructuredMiner)
    → Phase 3: Deduplication (merge by email, score-based field selection)
    → Phase 4: Validation
    → Phase 5: Quality check
    → Phase 6: Save to mining_results
```

**Files:**
- `backend/services/fileOrchestrator.js` — main orchestration + DB save
- `backend/services/extractors/excelExtractor.js` — Excel/CSV parse, header detection, `cellMatchesKeyword()` word-boundary matching
- `backend/services/miners/tableMiner.js` — column-based mining (with headers) + content-based guessing (without headers)
- `backend/services/miners/structuredMiner.js` — label:value text parsing
- `backend/services/miners/unstructuredMiner.js` — regex around emails
- `backend/services/validators/deduplicator.js` — merge + score
- `backend/services/fileMiner.js` — LEGACY (only used by documentMiner for PDF delegation)

**Header detection** (`excelExtractor.detectHeaders()`):
- Scans first 5 rows for header keywords (multi-language: EN, TR, FR, DE, ES, IT, NL, PT, AR, RU, ZH, JA, KO)
- Uses `cellMatchesKeyword()` with **word-boundary matching** — prevents `"ad"` matching inside `"lead"`
- Multi-word keywords (e.g. `"lead source"`) use substring match; single-word keywords require exact word match
- `source` field checked BEFORE `name` field in iteration order to prevent "Lead Source" → name mapping
- Mapped fields: `email`, `company`, `source`, `name`, `phone`, `country`, `city`, `address`, `website`, `title`

**Content-based field detection** (`tableMiner.detectFieldFromValue()`):
- Priority order: phone → URL → country → **company** → **source** → name
- Company indicators (`corp`, `ltd`, `gmbh`, etc.) checked BEFORE generic name pattern
- Source/channel values (`social media`, `web search`, `trade show`, etc.) checked BEFORE name pattern
- Unmapped columns captured in `contact._extra` → stored as `extra_fields` in raw JSON

---

## Webhook Event Flow

SendGrid webhook (`backend/routes/webhooks.js`) processes events through 3 layers:

```
SendGrid POST → campaign_recipients (UPDATE) → campaign_events (INSERT) → prospect_intents (INSERT, if intent-bearing)
```

**Intent-bearing events:**
| SendGrid Event | Intent Type | Table |
|---------------|-------------|-------|
| `reply` | `reply` | `prospect_intents` |
| `click` | `click_through` | `prospect_intents` |

**Campaign send** (`backend/routes/campaignSend.js`) also writes `sent` events to `campaign_events`.

---

## Email Campaign Features

### Template Preview & Clone (`backend/routes/emailTemplates.js`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/email-templates/:id/preview` | POST | Render template with sample data (or custom `sample_data` in body). Returns `{ preview: { subject, body_html, body_text } }` |
| `/api/email-templates/:id/clone` | POST | Duplicate template with optional custom `name` (defaults to "Copy of {name}"). Returns new template. |

Preview uses a local `processTemplate()` that mirrors the one in `campaignSend.js`.
Default sample: `{ first_name: "John", last_name: "Doe", company: "Acme Corp", ... }`. `{{unsubscribe_url}}` resolves to `"#"` in preview.

### Template Placeholder Fallback (`backend/utils/templateProcessor.js`)

Single source of truth: `backend/utils/templateProcessor.js` exports `processTemplate()` + `convertPlainTextToHtml()`.
Imported by: `campaignSend.js`, `worker.js`, `emailTemplates.js`.

Supports:

**Computed field — `{{display_name}}`:**
- `first_name` varsa → first_name
- `first_name` yoksa, `company_name` varsa → company_name
- Hiçbiri yoksa → `"Valued Partner"`

**Pipe fallback syntax — `{{field1|field2|"literal"}}`:**
- Segments are tried left-to-right, first non-empty value wins
- Field names: `first_name`, `last_name`, `name`, `company_name`, `company`, `display_name`, `email`, `country`, `position`, `website`, `tag`
- Quoted strings (`"..."` or `'...'`) are literal fallbacks
- Pipe expressions are processed BEFORE simple placeholders

**Examples:**
| Template | Data | Output |
|----------|------|--------|
| `Dear {{display_name}},` | `{first_name: "John"}` | `Dear John,` |
| `Dear {{display_name}},` | `{company_name: "Acme"}` | `Dear Acme,` |
| `Dear {{display_name}},` | `{}` | `Dear Valued Partner,` |
| `{{first_name\|company_name\|"Partner"}}` | `{company_name: "Acme"}` | `Acme` |
| `{{first_name\|company_name\|"Partner"}}` | `{}` | `Partner` |

**Frontend:** Template editor has `{{display_name}}` as first placeholder chip (green, with tooltip). Tip text below chips explains pipe fallback syntax.

### Plain Text → HTML Auto-Convert (`backend/routes/campaignSend.js`)

`convertPlainTextToHtml(text)` runs after `processTemplate()`, before `processEmailCompliance()`.

**Logic:**
- Strips `{{placeholder}}`s, then checks for any HTML tag (`<tag...>`)
- If HTML found → returns text unchanged (already HTML)
- If no HTML → splits on double newlines into `<p>` paragraphs, single `\n` → `<br>`
- Wraps in `<div>` with inline styles: `font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.6; color: #333`

**Flow in send-batch:**
```
processTemplate(body_html) → convertPlainTextToHtml() → processEmailCompliance() → sendEmail()
```

This ensures plain-text templates typed without HTML tags still render as properly styled email.

### Rich Text Template Editor (`liffy-ui/app/templates/page.tsx`)

Native `contentEditable` div with lightweight toolbar — no external rich text libraries.

**Toolbar buttons:** Bold, Italic, Underline, Font Size (Small/Normal/Large), Insert Link, Clear Formatting
**Implementation:** `document.execCommand()` for all formatting commands
**Placeholder insertion:** Clickable chips below editor insert `{{display_name}}`, `{{first_name}}`, `{{company_name}}`, etc. at cursor via `insertText`. `{{display_name}}` chip is green with tooltip. Tip text explains pipe fallback syntax.
**Save:** `innerHTML` from contentEditable div sent as `body_html` to API
**Edit:** Existing `body_html` loaded into contentEditable div when modal opens
**Empty state:** CSS `::before` placeholder via `data-placeholder` attribute

### CSV Upload to Lists (`backend/routes/lists.js`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/lists/upload-csv` | POST (multipart) | Upload CSV file to create a new list with dual-write |

- Accepts `file` (CSV, max 10MB), `name` (optional), `tags` (optional JSON string)
- Flexible header aliases: `email`/`e-mail`/`Email`, `company`/`organization`, `first_name`/`firstname`, etc.
- **Dual-write (Phase 3 pattern):**
  - Legacy: `prospects` (check-then-insert/update) + `list_members`
  - Canonical: `persons` UPSERT + `affiliations` UPSERT (if company present)
- **Background processing for large files** (>= 500 rows):
  - Returns **202 Accepted** immediately with `{ status: "processing", list_id, ... }`
  - Rows processed in background in batches of 200 with per-batch transactions
  - Progress tracked in `lists.import_status` + `lists.import_progress` (JSONB)
  - Frontend polls `GET /api/lists/:id` for `import_status` (`processing` → `completed`/`failed`)
  - Auto-queue verification runs after background completion
- Small files (< 500 rows) still process inline (single transaction, returns 201)
- Response includes `canonical_sync: { persons_upserted, affiliations_upserted }`
- Route registered BEFORE `/:id` routes to avoid Express parameter collision

### Campaign Analytics (`backend/routes/campaigns.js`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/campaigns/:id/analytics` | GET | Full analytics from `campaign_events` table |

Returns 4 sections:
1. **Summary**: event counts + derived rates (open_rate, click_rate, bounce_rate, spam_rate, unsubscribe_rate)
2. **Timeline**: `date_trunc` bucketed by `hour` or `day` (`?bucket=hour`), pivoted by event_type
3. **Top Links**: top 10 clicked URLs with click counts
4. **Bounce Breakdown**: hard/soft/unknown classification based on reason text

### Campaign Scheduling (`backend/routes/campaigns.js`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/campaigns/:id/schedule` | POST | Schedule campaign for future send. Requires `scheduled_at` (ISO 8601, must be future). Campaign must be `'ready'`. |
| `/api/campaigns/:id/start` | POST | Start campaign immediately. Now accepts `'ready'` OR `'scheduled'` status (cancels schedule). |

**Scheduling flow:**
```
resolve → status='ready' → schedule → status='scheduled' → (campaignScheduler picks up at scheduled_at) → status='sending' → (worker processes batches) → status='completed'
```
`/:id/start` can bypass scheduling by transitioning directly from `'ready'` or `'scheduled'` to `'sending'`.

### Email Verification — ZeroBounce (`backend/services/verificationService.js`, `backend/routes/verification.js`)

**Per-organizer** ZeroBounce API key stored in `organizers.zerobounce_api_key`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/verification/credits` | GET | Check ZeroBounce credit balance |
| `/api/verification/verify-single` | POST | Verify one email immediately. Dual-writes to `persons` + `prospects`. Body: `{ email }` |
| `/api/verification/verify-list` | POST | Queue list or email array for verification. Skips already-verified emails (valid/invalid/catchall). Body: `{ list_id }` or `{ emails: [...] }`. Response: `{ queued, already_verified, already_in_queue, total }` |
| `/api/verification/queue-status` | GET | Queue counts (pending/processing/completed/failed). Optional `?list_id=` filter |
| `/api/verification/process-queue` | POST | Manual trigger for queue processing. Body: `{ batch_size }` (default 100, max 200) |

**Settings endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/settings` | GET | Now includes `has_zerobounce_key`, `masked_zerobounce_key` |
| `/api/settings/zerobounce-key` | PUT | Save key after validating via `checkCredits()`. Body: `{ api_key }` |

**ZeroBounce → Liffy status mapping:**

| ZeroBounce | Liffy | Campaign Resolve |
|------------|-------|------------------|
| `valid` | `valid` | Send |
| `catch-all` | `catchall` | Send (like unknown) |
| `unknown` | `unknown` | Send |
| `invalid`, `spamtrap`, `abuse`, `do_not_mail` | `invalid` | Always exclude |

**Worker:** `startVerificationProcessor()` runs every **15s**, finds organizers with pending queue + ZeroBounce key, processes batches of **100**. API calls run in **parallel chunks of 10** via `Promise.all` (600ms pause between chunks, ~16 calls/sec — safely under ZeroBounce 20/sec limit). Throughput: ~80-100 emails/min.

**Staleness recovery:** Each poll cycle resets `processing` items with `processed_at IS NULL` back to `pending`. This recovers items stuck from a prior worker crash — safe because processing is synchronous within each cycle (no concurrent workers). The async processor is wrapped in `.catch()` to log fatal crashes instead of silently dying as unhandled rejections.

**CSV Upload auto-queue:** After `POST /api/lists/upload-csv` commit, if organizer has ZeroBounce key, emails are auto-queued. Response includes `verification_queued` count.

---

## Reports & Logs (Migrated to `campaign_events` with `campaign_recipients` fallback)

All reporting endpoints use `campaign_events` (canonical) as primary source. When `campaign_events` is empty (pre-backfill), both `/api/reports/campaign/:id` and `/api/reports/organizer/overview` fall back to `campaign_recipients` timestamps (`sent_at`, `delivered_at`, `opened_at`, `clicked_at`, `bounced_at`). Response includes `data_source` field (`campaign_events` or `campaign_recipients`).

| Endpoint | Method | Source | Description |
|----------|--------|--------|-------------|
| `/api/reports/campaign/:id` | GET | `campaign_events` → `campaign_recipients` fallback | Campaign report: event counts, timeline (per day), domain breakdown, bounce reasons |
| `/api/reports/organizer/overview` | GET | `campaign_events` → `campaign_recipients` fallback | Org-wide report: campaign stats, recipient stats, event counts, timeline, domains, bounces |
| `/api/logs` | GET | `campaign_events` | Paginated event log with `campaign_id` and `event_type` filters |
| `/api/logs/:id` | GET | `campaign_events` | Single event detail |

---

## Backfill Scripts

Located in `backend/scripts/`. One-time, idempotent, `--dry-run` supported.

| Script | Source | Target | Notes |
|--------|--------|--------|-------|
| `backfill_persons.js` | `mining_results` | `persons` + `affiliations` | Uses nameParser + countryNormalizer |
| `backfill_campaign_events.js` | `campaign_recipients` | `campaign_events` | Converts timestamp columns to events |

---

## Persons API (`backend/routes/persons.js`)

Frontend-facing canonical persons + affiliations endpoints. Replaces legacy `prospects` read path.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/persons` | GET | List persons with pagination, search, filter (`verification_status`, `country`, `company`, `has_intent`). Supports `exclude_invalid` filter value (NOT IN 'invalid','risky'). Returns latest affiliation per person. |
| `/api/persons/stats` | GET | Dashboard counts: total, verified, invalid, unverified, with_intent |
| `/api/persons/:id` | GET | Full person detail with all affiliations, intents, engagement summary, Zoho pushes |
| `/api/persons/:id/affiliations` | GET | Person's affiliation list |
| `/api/persons/:id` | DELETE | Delete person + affiliations + push logs |

---

## Import Dual-Write (Phase 3) — Background Batch Processing

All import paths now dual-write to canonical tables. Large imports use **background batch processing** to avoid Render's 30s request timeout.

| Import Path | File | Legacy Write | Canonical Write | Background? |
|-------------|------|--------------|-----------------|-------------|
| CSV Upload | `routes/lists.js` | `prospects` + `list_members` | `persons` UPSERT + `affiliations` UPSERT | >= 500 rows |
| Import All (mining) | `routes/miningResults.js` | `prospects` + `list_members` | `persons` UPSERT + `affiliations` UPSERT | Always |
| Lead Import | `routes/leads.js` | `prospects` + `list_members` | `persons` UPSERT + `affiliations` UPSERT | No |
| Aggregation Trigger | `services/aggregationTrigger.js` | — | `persons` + `affiliations` (canonical only) | No |

**Background import flow (import-all + large CSV):**
```
POST request → validate + count → return 202 Accepted → setImmediate()
  → fetch batch (200 rows) → BEGIN transaction → process rows → COMMIT
  → update progress in mining_jobs.import_progress / lists.import_progress
  → repeat until done → set import_status = 'completed'
```

**Tracking columns** (migration 022):
- `mining_jobs.import_status` — `NULL` | `processing` | `completed` | `failed`
- `mining_jobs.import_progress` — JSONB: `{ imported, skipped, duplicates, total, persons_upserted, affiliations_upserted, started_at, completed_at, errors }`
- `lists.import_status` — same values (for CSV upload)
- `lists.import_progress` — same structure

**Crash recovery:** If `import_status = 'processing'` for > 5 minutes, the next import-all call treats it as stale and allows restart. Already-imported records (status = 'imported') are skipped.

All import responses include `canonical_sync: { persons_upserted, affiliations_upserted }`.

---

## Prospect Intents API (`backend/routes/intents.js`)

Frontend-facing intent signals. Enables lead vs prospect distinction in UI.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/intents` | GET | List intents with pagination, filter by `intent_type`, `campaign_id`, `person_id`, `source`. Joins person + campaign names. |
| `/api/intents/stats` | GET | Counts by intent_type with unique_persons per type |
| `/api/intents` | POST | Manually create intent. Body: `{ person_id, intent_type, campaign_id?, notes?, confidence? }` |
| `/api/intents/:id` | DELETE | Delete an intent signal |

---

## Campaign Resolve (Phase 3 — Canonical Preference)

`POST /api/campaigns/:id/resolve` now uses canonical tables with legacy fallback:

- **Query:** `list_members JOIN prospects LEFT JOIN persons LEFT JOIN LATERAL affiliations`
- **Name:** `COALESCE(persons.first_name + last_name, prospects.name)`
- **Company:** `COALESCE(affiliations.company_name, prospects.company)`
- **Verification:** `COALESCE(persons.verification_status, prospects.verification_status)`
- **Meta enrichment:** `campaign_recipients.meta` includes `first_name`, `last_name`, `city`, `website`, `phone`, `person_id` from canonical tables

**Verification Mode** (migration 023, column `campaigns.verification_mode`):

| Mode | Filter | Use Case |
|------|--------|----------|
| `exclude_invalid` (default) | Excludes `invalid` + `risky` (unless `include_risky=true`) | Send to all, skip bad emails |
| `verified_only` | Only `valid` + `catchall` pass | Conservative — only send to verified emails |

- Resolve accepts `verification_mode` in request body, persists to campaign
- PATCH also accepts `verification_mode` for pre-configuration
- Response includes `verification_mode` + `excluded_unverified` stat (for `verified_only` mode)
- Frontend shows resolve confirmation modal with mode dropdown + exclusion stats breakdown

Legacy `list_members → prospects` path still drives resolution (lists still use prospect_id). Canonical data enriches rather than replaces.

---

## Zoho CRM Push — Integration (`backend/services/zohoService.js`, `backend/routes/zoho.js`)

**Per-organizer** Zoho OAuth2 credentials stored in `organizers` table (`zoho_client_id`, `zoho_client_secret`, `zoho_refresh_token`, `zoho_datacenter`).

**Settings endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/settings` | GET | Now includes `has_zoho`, `zoho_datacenter`, `masked_zoho_client_id` |
| `/api/settings/zoho` | PUT | Save Zoho OAuth2 credentials (validates via token refresh + org test). Body: `{ client_id, client_secret, refresh_token, datacenter }` |
| `/api/settings/zoho` | DELETE | Remove all Zoho credentials |

**Push endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/zoho/push` | POST | Push selected persons to Zoho CRM. Body: `{ person_ids: string[], module: 'Leads'\|'Contacts' }` |
| `/api/zoho/push-list` | POST | Push all persons from a list. Body: `{ list_id, module }` |
| `/api/zoho/push-history` | GET | Paginated push log. Query: `?person_id=&module=&page=1&limit=50` |
| `/api/zoho/push-status` | GET | Summary statistics (total_pushed, leads_pushed, contacts_pushed, failed, last_push_at) |

**Push flow:**
```
persons + affiliations → mapPersonToZoho() → Zoho CRM v7 API (batch 100/request) → zoho_push_log
```

**Dedup:** On re-push, existing `zoho_record_id` from `zoho_push_log` triggers UPDATE instead of CREATE.

**Datacenter support:** `com`, `eu`, `in`, `com.au`, `jp`, `ca` — determines API and OAuth endpoint URLs.

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

## Terminology

| Term | Meaning | Storage |
|------|---------|---------|
| Person | Real individual, identified by email | `persons` table |
| Affiliation | Person's relationship to a company | `affiliations` table |
| Mining Result | Discovery event from scraping | `mining_results` table |
| Prospect | Person with demonstrated intent | `prospect_intents` table |
| Campaign | Email outreach job | `campaigns` table |
| Campaign Event | Engagement signal (open/click/reply) | `campaign_events` table |
| Sender Identity | Verified sending email address | `sender_identities` table |

### UI Concepts (Views, NOT tables)
| UI Page | Meaning |
|---------|---------|
| Contacts | Person + selected affiliation |
| Leads | Contacts without intent |
| Prospects | Contacts with intent |
| Mining Results | Discovery events |
| Lists | Campaign targeting snapshots |

**UI page names must NEVER mirror table names directly.**
**liffy-ui must treat API responses as canonical domain views, not database representations.**

---

## Forbidden Patterns (Anti-Patterns)

- Mining creates leads or prospects
- Mining writes to persons/prospects directly
- Email uniqueness enforced across organizers
- UI logic based on table names
- Storing engagement scores as persisted values
- Campaign directly mutating a person record
- Cross-domain side effects (mining → prospect creation)
- Miners normalizing, parsing names, inferring countries, or writing to DB
- Using nodemailer (removed — SendGrid API only)
- Using ORMs (Sequelize, Prisma, Knex)
- Refactoring mining engine without explicit instruction
- Creating React/Vue/Angular frontend (Next.js already exists in liffy-ui)
- Skipping organizer_id in any query

---

## Miner Contract

Miners are disposable plugins. They:
- Accept input (URL or file)
- Extract raw data
- Return raw output

Miners NEVER:
- Normalize data
- Parse names
- Infer countries
- Write to database
- Merge data
- Access organizer context

---

## Build Priority (Current)

1. ~~**Constitution Migration** — persons + affiliations tables, backfill~~ ✅ DONE
2. ~~**Campaign Events** — campaign_events table, webhook + send integration~~ ✅ DONE
3. ~~**ProspectIntent** — prospect_intents table, intent detection from webhook~~ ✅ DONE
4. ~~**Email Campaign improvements** — templates, list upload, send flow~~ ✅ DONE
5. ~~**Email verification** — ZeroBounce integration, per-organizer key, queue processor~~ ✅ DONE
6. ~~**Zoho CRM push** — push persons to Zoho CRM as Leads/Contacts~~ ✅ DONE
7. ~~**Scraping module improvements** — pagination support for multi-page sites~~ ✅ DONE
8. ~~**Phase 3 migration** — import-all dual-write, campaign resolve canonical, persons API, intents API~~ ✅ DONE
9. ~~**Remove nodemailer** — dropped from package.json~~ ✅ DONE
10. **Frontend UI build** — liffy-ui (Next.js) pages for canonical APIs ← CURRENT

---

## UI Build Progress (liffy-ui — Next.js 16 + Tailwind + Radix UI)

**Frontend repo:** `Nsueray/liffy-ui` → Render: liffy.app
**Backend repo:** `Nsueray/liffyv1` → Render: api.liffy.app

### Completed UI Tasks

- ✅ **Settings: ZeroBounce + Zoho CRM** — API key input with show/hide, credit balance check, Zoho OAuth2 credentials with validation + disconnect (commit: 75c575f)
- ✅ **Contacts page (Leads → Persons migration)** — canonical `/api/persons` endpoint, stats cards (Total/Verified/Unverified/Prospects), search + 4 filters, contact detail slide-over panel with affiliations/engagement/intents/Zoho history (commit: b35562a)
- ✅ **Sidebar: Leads → Contacts** rename + breadcrumb/title fix
- ✅ **Backend fix:** `persons/:id` SQL — `event_at → occurred_at`, `recipient_email → email` (commits: 28e0f69, 068f7ba)
- ✅ **Campaign Analytics Bug Fix** — analytics endpoint fallback to `campaign_recipients` when `campaign_events` empty. Summary, timeline, bounce breakdown all have fallback. Response includes `data_source` field. (commit: 564caf5)
- ✅ **Prospects (Intents) page** — full page with stats cards, clickable intent type breakdown chips, filters (search/type/source), data table with confidence bars, pagination, loading/empty/error states (commit: 9ed12e9)
- ✅ **Campaign Analytics UI** — full analytics page with rate cards, timeline chart (Recharts), top links, bounce breakdown, recipients table with status filter. Integrated with `GET /api/campaigns/:id/analytics` endpoint.
- ✅ **Verification Dashboard** — queue status cards, credit balance, single email verify, batch process trigger, queue progress bar. Route: `/verification` (commit: 77174ed)
- ✅ **Unsubscribe compliance pipeline** — `processEmailCompliance` + RFC 8058 `List-Unsubscribe` headers wired into `campaignSend.js`. Mandatory footer injection + physical address append. (commit: f1b1636)
- ✅ **Person Detail page** — full-page `/leads/[id]` with person header, verify button, affiliations, engagement summary, intent signals table, Zoho sync history, delete. Contacts table rows navigate to detail page. (commit: 8bede92)
- ✅ **Dashboard** — real dashboard with 6 stat cards (contacts, campaigns, sent, open rate, bounce rate, prospects), quick actions, recent campaigns + mining jobs. Parallel API fetches with graceful fallback. (commit: 7835ec9)
- ✅ **Reports page** — org-wide summary (7 stat cards), campaign comparison table with per-campaign stats, domain breakdown table, bounce reasons bar chart. Sidebar link with BarChart3 icon. (commit: 42732bb)
- ✅ **List Verification UI** — "Verify All Emails" button on lists detail with ShieldCheck icon, verification progress polling (5s), 4 stat cards, color-coded badges. "Verify a List" section on verification dashboard with list dropdown. Skips already-verified emails to prevent duplicate ZeroBounce credit usage. (commits: 9c75b7d, 1fece6e)
- ✅ **Campaign Resolve Verification Mode** — resolve confirmation modal with verification_mode dropdown (exclude_invalid / verified_only), exclusion stats breakdown (invalid/risky/unverified/unsubscribed), recipients added count. Backend `verification_mode` column on campaigns table (migration 023). (commits: 83621d3, 5bbc55d)
- ✅ **Lists page member counts fix** — rewrote GET /api/lists to use LEFT JOIN + GROUP BY instead of correlated subqueries. Uses COALESCE(persons, prospects) for verification status. Includes import_status/import_progress in response. Also fixed import-all `type` column reference that doesn't exist in schema.
- ✅ **Contacts page default Exclude Invalid filter** — added `exclude_invalid` option to verification status dropdown (default). Backend `/api/persons` now supports `exclude_invalid` filter value (NOT IN 'invalid','risky').
- ✅ **Rich Text Template Editor + Plain Text Auto-Convert** — contentEditable editor with toolbar (Bold/Italic/Underline/Font Size/Link/Clear), clickable placeholder chips, no external libs. Backend `convertPlainTextToHtml()` in campaignSend.js auto-wraps plain text in styled `<p>` tags (Arial 14px, line-height 1.6, #333). Runs after processTemplate, before compliance pipeline. (commits: 652c1c8, 307dba3)
- ✅ **Verification Worker Speed Optimization** — batch size 50→100, poll interval 30s→15s, sequential API calls → parallel chunks of 10 via `Promise.all` (600ms inter-chunk pause). Throughput ~18/min → ~80-100/min. (commit: d7f471b)
- ✅ **Reports/Dashboard Backfill Fix** — both `/api/reports/campaign/:id` and `/api/reports/organizer/overview` now fall back to `campaign_recipients` timestamps when `campaign_events` is empty. Covers event stats, timeline, domain breakdown, bounce reasons. Response includes `data_source` field. (commit: 814cce2)
- ✅ **Verification Worker Fix + Staleness Recovery** — worker wasn't producing logs after restart because 349 items stuck in `processing` status blocked the `pending`-only query. Added staleness recovery (resets `processing` with `processed_at IS NULL` → `pending` each cycle), startup log, per-batch logging, stack traces in error catches, `.catch()` on async processor. (commit: 9e4141b)
- ✅ **List Verification Counts Fix** — 3-way count grouping: verified (`valid`+`catchall`), invalid (`invalid`), unverified (`unknown`+NULL). Previously `catchall` was unverified and `invalid` was lumped into unverified causing totals > 100%. Detail endpoint now JOINs `persons` for canonical status. All 4 list endpoints consistent. (commit: e603f12)
- ✅ **Lists Index Page Counts Fix** — GET /api/lists was returning 0 for all counts due to 4-table LEFT JOIN + GROUP BY issue. Split into two queries: list metadata + member counts (grouped by `lm.list_id` from `list_members`), merged in JS via map lookup. (commit: 2c76143)
- ✅ **File Mining Column Mapping Fix** — Excel/CSV column mapping was broken: `contact_name` got "Social Media Ads" (Lead Source values) instead of actual names. Root causes: (1) `cell.includes("ad")` matched "le**ad** source" → name field (word-boundary fix via `cellMatchesKeyword()`), (2) `detectFieldFromValue()` checked name pattern before company indicators ("Acme Corp" → name instead of company), (3) no `source`/`lead_source` field mapping existed. Fix: word-boundary matching, priority reorder (company → source → name), `source` keyword mapping, unmapped columns preserved in `_extra` → `extra_fields` in raw JSON. 5 files changed: excelExtractor, tableMiner, unstructuredMiner, fileOrchestrator, fileMiner.
- ✅ **List Detail + Contacts Name Display Fix** — List detail page showed wrong names (e.g. "Social Media Ads") because SQL read `prospects.name` instead of canonical `persons.first_name + last_name`. Fixed `GET /api/lists/:id` to COALESCE persons names over prospects. Also blocked email addresses from being written as `affiliations.company_name` across all 4 write paths (import-all, aggregation trigger, CSV upload, leads import) with `@` check.
- ✅ **Contacts Page Company Column Fix** — Company column showed pipe-separated junk (e.g. "Name | No company | email | Country") from corrupted `affiliations.company_name`. Fixed: (1) LATERAL JOIN excludes `@` rows, (2) CASE/SPLIT_PART extracts first segment from pipe data, (3) all write paths block `|` in company_name, (4) cleanup script `backend/scripts/cleanup_affiliations.js` for existing data. **Cleanup run:** 611 records cleaned in production.
- ✅ **Import Preview Fix** — "Cannot read properties of undefined (reading 'total_with_email')" crash when clicking Import All. Backend POST returns 202 without `stats` object; frontend now uses already-fetched `importPreview` data. (commit: db641b2 in liffy-ui)
- ✅ **Lists Index Counts Shadow Route Fix** — GET /api/lists returned raw columns without counts because `prospects.js` had 4 legacy `/api/lists/*` routes mounted before `listsRouter` in server.js. Removed shadow routes from prospects.js. (commit: 86684be)
- ✅ **Console Page Hidden** — Mining job console page (`/mining/jobs/[id]/console`) was non-functional: `mining_job_logs` table never written to, `/logs` endpoint missing, no WebSocket/SSE, no pause/resume/cancel. Removed "View Live Console" link from job detail page, redirected results back button to `/mining/jobs`. Page file kept for future implementation. (commit: 9d0581d in liffy-ui)
- ✅ **Template Placeholder Fallback** — `{{display_name}}` computed field (first_name → company_name → "Valued Partner") + pipe fallback syntax `{{field1|field2|"literal"}}`. Both `processTemplate()` functions updated. Frontend: green chip + tooltip + tip text. (commits: 3d286f5, 357b685 in liffy-ui)
- ✅ **processTemplate Unification (CRITICAL)** — worker.js had outdated processTemplate (no meta.first_name, no display_name, no pipe syntax). Production sends ALL emails through worker → placeholders not replaced. Extracted to `backend/utils/templateProcessor.js` as single source of truth, imported by campaignSend.js + worker.js + emailTemplates.js. Also added missing `convertPlainTextToHtml` to worker send flow. (commit: fa916e5)
- ✅ **Templates Page Action Buttons Fix** — Preview/Edit/Delete buttons invisible due to `overflow-hidden` on table container + `whitespace-nowrap` on Subject column. Changed to `overflow-x-auto`, Subject gets `max-w-xs truncate`. (commit: f50b8ed in liffy-ui)
- ✅ **Favicon + Browser Tab Title** — Resized 1024x1024 logo to 32x32 (favicon) + 180x180 (Apple touch icon), served from `public/`. CDN logo was 1.3MB + wrong path (404). Title "Liffy UI" → "Liffy". (commits: 7359a4c, dbafe9d in liffy-ui)

### Next UI Tasks (Priority Order)

| Priority | Task | Backend Endpoints |
|----------|------|-------------------|
| P2 #6 | Zoho CRM Push UI — push button, module select, push history | `POST /api/zoho/push`, `GET /push-history` |

### Known Issues

- ~~**Reports + Dashboard org-wide stats show 0**~~ — FIXED: both reports endpoints now fall back to `campaign_recipients` when `campaign_events` is empty (commit: 814cce2)
- ~~**Campaign Comparison table per-campaign stats all 0**~~ — FIXED: same fix, `/api/reports/campaign/:id` also has fallback now
- `/api/stats` 401 Unauthorized still repeating in console — sidebar polls every 30s, auth header was added but issue persists
- ZeroBounce account not yet configured — settings UI untested against live API
- Prospects page search is client-side only (backend `/api/intents` doesn't support text search param)
- ~~Unsubscribe footer optional (user-initiated only)~~ — FIXED: compliance pipeline now mandatory in campaignSend (f1b1636)
- ~~`campaign_events` backfill not yet run~~ — FIXED: all endpoints (analytics + reports) now have `campaign_recipients` fallback. Backfill optional.
- ~~Import-all 30s timeout on 3000+ records~~ — FIXED: background batch processing with 200-record batches (commit: 450a34c)
- **Frontend import-all polling not yet implemented** — backend returns 202 + `import_status`/`import_progress`, but liffy-ui needs to poll `GET /api/mining/jobs/:id` and show progress bar
- ~~**Verification worker silent after restart**~~ — FIXED: stuck `processing` items blocked pending-only query. Staleness recovery added (commit: 9e4141b)
- ~~**List verification counts don't add up**~~ — FIXED: 3-way grouping (verified/invalid/unverified), `catchall` counted as verified, `invalid_count` separate field (commit: e603f12)
- ~~**Lists index page all counts 0**~~ — FIXED (twice): (1) split into two queries (commit: 2c76143), (2) removed 4 legacy shadow routes from `prospects.js` that intercepted `/api/lists` before `listsRouter` (commit: 86684be)
- ~~**File mining column mapping broken**~~ — FIXED: word-boundary matching, source field mapping, priority reorder (company → source → name), unmapped columns to _extra
- ~~**List detail + Contacts page name column wrong**~~ — FIXED: list detail `GET /api/lists/:id` now COALESCEs `persons.first_name + last_name` over `prospects.name`. Contacts page already correct (reads from `persons` directly).
- ~~**Email addresses written as company_name in affiliations**~~ — FIXED: all write paths (import-all, aggregation trigger, CSV upload, leads import) now check for `@` before writing to `affiliations.company_name`.
- ~~**Contacts page company column showing pipe-separated junk**~~ — FIXED: `GET /api/persons` LATERAL JOIN now excludes `@` rows and SPLIT_PARTs pipe data. All write paths also block `|` in company_name. Cleanup script run — 611 records cleaned.
- **Name field shows company name for some records** (minor) — Excel imports where name column was empty picked up company name as first_name. Legacy data, not recurring.
- **"Web Search" appearing as name/company in a few records** (minor) — stale data from early mining runs, not recurring.
- ~~**"Exclude Invalid" default filter lost on Contacts page**~~ — FIXED: `useState('exclude_invalid')` default, `clearFilters` resets to `exclude_invalid`, `hasActiveFilters` treats it as default. (commit: a861502 in liffy-ui)
- ~~**Import preview `total_with_email` count bug**~~ — FIXED: frontend was accessing `data.stats.total_with_email` from 202 background response that doesn't include stats. Now uses already-fetched `importPreview` data. (commit: db641b2 in liffy-ui)
- **Mining console page hidden** — page exists at `/mining/jobs/[id]/console/page.tsx` but all navigation links removed. Requires: log writing in mining services, `/logs` endpoint, job control endpoints (pause/resume/cancel). Future feature.

### Immediate Next Tasks (New Session)

1. ~~**DB Schema Guide**~~ — ✅ DONE
2. ~~**Canonical Migration Plan**~~ — ✅ DONE
3. **Zoho CRM Push UI** — P2 #6, push button on Contacts page, module select, push history
4. ~~**Import preview `total_with_email` bug fix**~~ — ✅ DONE
5. ~~**Lists index counts shadow route fix**~~ — ✅ DONE: removed 4 legacy routes from prospects.js
6. ~~**Console page hide**~~ — ✅ DONE: removed navigation links, kept page for future
7. ~~**Template placeholder fallback**~~ — ✅ DONE: display_name + pipe syntax
8. **Frontend import-all polling** — show progress bar for background import-all
9. **Mining console page** (future) — implement log writing + /logs endpoint + job control

---

## Git & Versioning

- Commit after every completed feature
- Clear commit messages: `feat: add persons table migration`, `fix: campaign recipient dedup`
- Tag milestones: v1, v2, etc.
- Backend repo: `Nsueray/liffyv1` (API + assets)
- Frontend repo: `Nsueray/liffy-ui` (Next.js)

---

## File-Based Development

Each task produces complete, standalone files.
When creating or editing a file, output the FULL file content.
No partial snippets, no "rest stays the same" shortcuts.

---

## What NOT To Do

- Do NOT refactor the mining engine unless explicitly asked
- Do NOT "improve architecture" without being asked — build what's requested
- Do NOT delete legacy tables — they stay until Phase 4
- Do NOT assume tables exist that aren't listed in "Current State" above
- Do NOT create new tables without checking this document first

---

## Email Extraction Policy — B2B Context

Role-based business emails (info@, contact@, sales@, office@, etc.) **ARE** valid discovery targets.
We are a B2B exhibitor discovery platform. Generic CRM-style filtering is intentionally disabled.

**Only system-level non-human emails are filtered:** noreply, no-reply, mailer-daemon, postmaster, hostmaster, abuse, spam, webmaster, test, example domains.

This is intentional and must NOT be reverted without explicit instruction.

---

## Technical Debt & Stability Sprint Backlog

1. Pagination fallback must respect `max_pages` (no hardcoded 5-page fallback)
2. Pagination logic must be unified (single service for SuperMiner + miningService)
3. Avoid double normalization in SuperMiner canonical aggregation
4. Add performance indexes to `campaign_events` (`organizer_id+campaign_id+event_type`, `organizer_id+person_id`, `organizer_id+occurred_at`)
5. Add pagination metrics to `mining_job_logs` (`pages_detected`, `pages_mined`, `duplicates_detected`)

---

## Phase 4 — Legacy Removal Roadmap

Legacy removal must be **incremental and reversible**.

1. Stop writing to `prospects` table (remove dual-write in import paths)
2. Migrate `list_members` to reference `persons` instead of `prospects`
3. Remove dual-write in CSV upload, import-all, leads/import
4. Drop `prospects` table (only after full migration verification)
5. Remove legacy resolve fallback in campaign resolve
