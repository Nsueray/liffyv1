# CLAUDE_FEATURES.md — Feature Documentation

> See also: [CLAUDE.md](./CLAUDE.md), [CLAUDE_DB.md](./CLAUDE_DB.md), [CLAUDE_UI.md](./CLAUDE_UI.md), [MINER_GUIDE.md](./MINER_GUIDE.md), [LIFFY_TODO.md](./LIFFY_TODO.md), [MINING_REFACTOR_PLAN.md](./MINING_REFACTOR_PLAN.md)

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

---

## CSV Upload to Lists (`backend/routes/lists.js`)

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

---

## Campaign Analytics (`backend/routes/campaigns.js`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/campaigns/:id/analytics` | GET | Full analytics from `campaign_events` table |

Returns 4 sections:
1. **Summary**: event counts + derived rates (open_rate, click_rate, bounce_rate, spam_rate, unsubscribe_rate)
2. **Timeline**: `date_trunc` bucketed by `hour` or `day` (`?bucket=hour`), pivoted by event_type
3. **Top Links**: top 10 clicked URLs with click counts
4. **Bounce Breakdown**: hard/soft/unknown classification based on reason text

---

## Campaign Scheduling (`backend/routes/campaigns.js`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/campaigns/:id/schedule` | POST | Schedule campaign for future send. Requires `scheduled_at` (ISO 8601, must be future). Campaign must be `'ready'`. |
| `/api/campaigns/:id/start` | POST | Start campaign immediately. Now accepts `'ready'` OR `'scheduled'` status (cancels schedule). |

**Scheduling flow:**
```
resolve → status='ready' → schedule → status='scheduled' → (campaignScheduler picks up at scheduled_at) → status='sending' → (worker processes batches) → status='completed'
```
`/:id/start` can bypass scheduling by transitioning directly from `'ready'` or `'scheduled'` to `'sending'`.

---

## Email Verification — ZeroBounce (`backend/services/verificationService.js`, `backend/routes/verification.js`)

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

## Email Extraction Policy — B2B Context

Role-based business emails (info@, contact@, sales@, office@, etc.) **ARE** valid discovery targets.
We are a B2B exhibitor discovery platform. Generic CRM-style filtering is intentionally disabled.

**Only system-level non-human emails are filtered:** noreply, no-reply, mailer-daemon, postmaster, hostmaster, abuse, spam, webmaster, test, example domains.

This is intentional and must NOT be reverted without explicit instruction.
