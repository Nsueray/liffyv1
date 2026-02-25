# CLAUDE_UI.md — UI Build Progress & Status

> See also: [CLAUDE.md](./CLAUDE.md), [CLAUDE_DB.md](./CLAUDE_DB.md), [CLAUDE_FEATURES.md](./CLAUDE_FEATURES.md), [MINER_GUIDE.md](./MINER_GUIDE.md), [LIFFY_TODO.md](./LIFFY_TODO.md), [MINING_REFACTOR_PLAN.md](./MINING_REFACTOR_PLAN.md)

---

## UI Build Progress (liffy-ui — Next.js 16 + Tailwind + Radix UI)

**Frontend repo:** `Nsueray/liffy-ui` → Render: liffy.app
**Backend repo:** `Nsueray/liffyv1` → Render: api.liffy.app

### Completed UI Tasks

- **Settings: ZeroBounce + Zoho CRM** — API key input with show/hide, credit balance check, Zoho OAuth2 credentials with validation + disconnect (commit: 75c575f)
- **Contacts page (Leads → Persons migration)** — canonical `/api/persons` endpoint, stats cards (Total/Verified/Unverified/Prospects), search + 4 filters, contact detail slide-over panel with affiliations/engagement/intents/Zoho history (commit: b35562a)
- **Sidebar: Leads → Contacts** rename + breadcrumb/title fix
- **Backend fix:** `persons/:id` SQL — `event_at → occurred_at`, `recipient_email → email` (commits: 28e0f69, 068f7ba)
- **Campaign Analytics Bug Fix** — analytics endpoint fallback to `campaign_recipients` when `campaign_events` empty. Summary, timeline, bounce breakdown all have fallback. Response includes `data_source` field. (commit: 564caf5)
- **Prospects (Intents) page** — full page with stats cards, clickable intent type breakdown chips, filters (search/type/source), data table with confidence bars, pagination, loading/empty/error states (commit: 9ed12e9)
- **Campaign Analytics UI** — full analytics page with rate cards, timeline chart (Recharts), top links, bounce breakdown, recipients table with status filter. Integrated with `GET /api/campaigns/:id/analytics` endpoint.
- **Verification Dashboard** — queue status cards, credit balance, single email verify, batch process trigger, queue progress bar. Route: `/verification` (commit: 77174ed)
- **Unsubscribe compliance pipeline** — `processEmailCompliance` + RFC 8058 `List-Unsubscribe` headers wired into `campaignSend.js`. Mandatory footer injection + physical address append. (commit: f1b1636)
- **Person Detail page** — full-page `/leads/[id]` with person header, verify button, affiliations, engagement summary, intent signals table, Zoho sync history, delete. Contacts table rows navigate to detail page. (commit: 8bede92)
- **Dashboard** — real dashboard with 6 stat cards (contacts, campaigns, sent, open rate, bounce rate, prospects), quick actions, recent campaigns + mining jobs. Parallel API fetches with graceful fallback. (commit: 7835ec9)
- **Reports page** — org-wide summary (7 stat cards), campaign comparison table with per-campaign stats, domain breakdown table, bounce reasons bar chart. Sidebar link with BarChart3 icon. (commit: 42732bb)
- **List Verification UI** — "Verify All Emails" button on lists detail with ShieldCheck icon, verification progress polling (5s), 4 stat cards, color-coded badges. "Verify a List" section on verification dashboard with list dropdown. Skips already-verified emails to prevent duplicate ZeroBounce credit usage. (commits: 9c75b7d, 1fece6e)
- **Campaign Resolve Verification Mode** — resolve confirmation modal with verification_mode dropdown (exclude_invalid / verified_only), exclusion stats breakdown (invalid/risky/unverified/unsubscribed), recipients added count. Backend `verification_mode` column on campaigns table (migration 023). (commits: 83621d3, 5bbc55d)
- **Lists page member counts fix** — rewrote GET /api/lists to use LEFT JOIN + GROUP BY instead of correlated subqueries. Uses COALESCE(persons, prospects) for verification status. Includes import_status/import_progress in response. Also fixed import-all `type` column reference that doesn't exist in schema.
- **Contacts page default Exclude Invalid filter** — added `exclude_invalid` option to verification status dropdown (default). Backend `/api/persons` now supports `exclude_invalid` filter value (NOT IN 'invalid','risky').
- **Rich Text Template Editor + Plain Text Auto-Convert** — contentEditable editor with toolbar (Bold/Italic/Underline/Font Size/Link/Clear), clickable placeholder chips, no external libs. Backend `convertPlainTextToHtml()` in campaignSend.js auto-wraps plain text in styled `<p>` tags (Arial 14px, line-height 1.6, #333). Runs after processTemplate, before compliance pipeline. (commits: 652c1c8, 307dba3)
- **Template Editor HTML/Visual Toggle** — Added `[Visual]` / `[HTML]` mode toggle to template editor. Visual = contentEditable (default), HTML = plain textarea for raw HTML input. Fixes escaped HTML tags issue (`<table>` → `&lt;table&gt;`) when pasting raw HTML into contentEditable. (commit: 499457a in liffy-ui)
- **Campaign Analytics Sent Count Fix** — Worker was not recording `sent` events to `campaign_events`, causing analytics to show Sent=0. Added `recordSentEvent()` to worker.js. Analytics endpoint now cross-checks `campaign_recipients` for true sent count (hybrid fallback). (commits: 0ad776a, 9c29d73)
- **Campaign Detail Delivered Card** — Added Delivered metric card (cyan) to campaign analytics summary. 5-column grid: Sent, Delivered, Opened, Clicked, Bounced. (commit: 6ae713f in liffy-ui)
- **Verification Worker Speed Optimization** — batch size 50→100, poll interval 30s→15s, sequential API calls → parallel chunks of 10 via `Promise.all` (600ms inter-chunk pause). Throughput ~18/min → ~80-100/min. (commit: d7f471b)
- **Reports/Dashboard Backfill Fix** — both `/api/reports/campaign/:id` and `/api/reports/organizer/overview` now fall back to `campaign_recipients` timestamps when `campaign_events` is empty. Covers event stats, timeline, domain breakdown, bounce reasons. Response includes `data_source` field. (commit: 814cce2)
- **Verification Worker Fix + Staleness Recovery** — worker wasn't producing logs after restart because 349 items stuck in `processing` status blocked the `pending`-only query. Added staleness recovery (resets `processing` with `processed_at IS NULL` → `pending` each cycle), startup log, per-batch logging, stack traces in error catches, `.catch()` on async processor. (commit: 9e4141b)
- **List Verification Counts Fix** — 3-way count grouping: verified (`valid`+`catchall`), invalid (`invalid`), unverified (`unknown`+NULL). Previously `catchall` was unverified and `invalid` was lumped into unverified causing totals > 100%. Detail endpoint now JOINs `persons` for canonical status. All 4 list endpoints consistent. (commit: e603f12)
- **Lists Index Page Counts Fix** — GET /api/lists was returning 0 for all counts due to 4-table LEFT JOIN + GROUP BY issue. Split into two queries: list metadata + member counts (grouped by `lm.list_id` from `list_members`), merged in JS via map lookup. (commit: 2c76143)
- **File Mining Column Mapping Fix** — Excel/CSV column mapping was broken: `contact_name` got "Social Media Ads" (Lead Source values) instead of actual names. Root causes: (1) `cell.includes("ad")` matched "le**ad** source" → name field (word-boundary fix via `cellMatchesKeyword()`), (2) `detectFieldFromValue()` checked name pattern before company indicators ("Acme Corp" → name instead of company), (3) no `source`/`lead_source` field mapping existed. Fix: word-boundary matching, priority reorder (company → source → name), `source` keyword mapping, unmapped columns preserved in `_extra` → `extra_fields` in raw JSON. 5 files changed: excelExtractor, tableMiner, unstructuredMiner, fileOrchestrator, fileMiner.
- **List Detail + Contacts Name Display Fix** — List detail page showed wrong names (e.g. "Social Media Ads") because SQL read `prospects.name` instead of canonical `persons.first_name + last_name`. Fixed `GET /api/lists/:id` to COALESCE persons names over prospects. Also blocked email addresses from being written as `affiliations.company_name` across all 4 write paths (import-all, aggregation trigger, CSV upload, leads import) with `@` check.
- **Contacts Page Company Column Fix** — Company column showed pipe-separated junk (e.g. "Name | No company | email | Country") from corrupted `affiliations.company_name`. Fixed: (1) LATERAL JOIN excludes `@` rows, (2) CASE/SPLIT_PART extracts first segment from pipe data, (3) all write paths block `|` in company_name, (4) cleanup script `backend/scripts/cleanup_affiliations.js` for existing data. **Cleanup run:** 611 records cleaned in production.
- **Import Preview Fix** — "Cannot read properties of undefined (reading 'total_with_email')" crash when clicking Import All. Backend POST returns 202 without `stats` object; frontend now uses already-fetched `importPreview` data. (commit: db641b2 in liffy-ui)
- **Lists Index Counts Shadow Route Fix** — GET /api/lists returned raw columns without counts because `prospects.js` had 4 legacy `/api/lists/*` routes mounted before `listsRouter` in server.js. Removed shadow routes from prospects.js. (commit: 86684be)
- **Console Page Hidden** — Mining job console page (`/mining/jobs/[id]/console`) was non-functional: `mining_job_logs` table never written to, `/logs` endpoint missing, no WebSocket/SSE, no pause/resume/cancel. Removed "View Live Console" link from job detail page, redirected results back button to `/mining/jobs`. Page file kept for future implementation. (commit: 9d0581d in liffy-ui)
- **Template Placeholder Fallback** — `{{display_name}}` computed field (first_name → company_name → "Valued Partner") + pipe fallback syntax `{{field1|field2|"literal"}}`. Both `processTemplate()` functions updated. Frontend: green chip + tooltip + tip text. (commits: 3d286f5, 357b685 in liffy-ui)
- **processTemplate Unification (CRITICAL)** — worker.js had outdated processTemplate (no meta.first_name, no display_name, no pipe syntax). Production sends ALL emails through worker → placeholders not replaced. Extracted to `backend/utils/templateProcessor.js` as single source of truth, imported by campaignSend.js + worker.js + emailTemplates.js. Also added missing `convertPlainTextToHtml` to worker send flow. (commit: fa916e5)
- **Templates Page Action Buttons Fix** — Preview/Edit/Delete buttons invisible due to `overflow-hidden` on table container + `whitespace-nowrap` on Subject column. Changed to `overflow-x-auto`, Subject gets `max-w-xs truncate`. (commit: f50b8ed in liffy-ui)
- **Favicon + Browser Tab Title** — Resized 1024x1024 logo to 32x32 (favicon) + 180x180 (Apple touch icon), served from `public/`. CDN logo was 1.3MB + wrong path (404). Title "Liffy UI" → "Liffy". (commits: 7359a4c, dbafe9d in liffy-ui)
- **Contacts Page Search/Filter Bug** — Page showed "0 total contacts" despite 3,379 in stats. Two fixes: (1) Backend `exclude_invalid` SQL filter used `NOT IN ('invalid','risky')` which silently excludes NULL rows (NULL NOT IN (...) = NULL = false). Added `IS NULL OR` clause. Stats unverified count also now includes NULL. (2) Frontend switched from Next.js rewrite proxy to direct API URL (`api.liffy.app`) matching campaigns page pattern. Added null-safe response parsing + better error messages. (commits: c156e3f backend, 41f14d2 liffy-ui)
- **Unsubscribes Page** — Dedicated `/campaigns/unsubscribes` page showing who unsubscribed, when, from which campaign, and how. 4 summary cards (Total, Unsubscribe Link, Spam Reports, User Requests), search + source filter, table with color-coded source badges, campaign attribution links, pagination. Backend `GET /api/unsubscribes` endpoint with LATERAL join for campaign attribution. Nav link added to campaigns page header.
- **Excel/CSV Export** — Server-side export for 3 pages using `exceljs` library + shared `exportHelper.js` utility. XLSX (styled headers, auto-filter) and CSV formats. (1) Mining results: `GET /api/mining/jobs/:id/results/export` — 13 columns. (2) Contacts: `GET /api/persons/export` — 21 columns with campaign engagement stats (campaigns_sent, opens, clicks, replies, bounces, last_campaign, is_prospect, latest_intent, lists). Supports same filters as contacts page. (3) List members: `GET /api/lists/:id/export` — 17 columns with campaign engagement flags (has_opened, has_clicked, has_replied, has_bounced). Frontend: "Export All (N)" buttons on mining results, contacts, and list detail pages. Replaces old client-side CSV export. (commits: 1e6f06d backend, 72d175f liffy-ui)

---

## Next UI Tasks (Priority Order)

| Priority | Task | Backend Endpoints |
|----------|------|-------------------|
| P2 #6 | Zoho CRM Push UI — push button, module select, push history | `POST /api/zoho/push`, `GET /push-history` |

See [LIFFY_TODO.md](./LIFFY_TODO.md) for full task tracking.

---

## Known Issues

### Resolved
- ~~**Reports + Dashboard org-wide stats show 0**~~ — FIXED: both reports endpoints now fall back to `campaign_recipients` when `campaign_events` is empty (commit: 814cce2)
- ~~**Campaign Comparison table per-campaign stats all 0**~~ — FIXED: same fix, `/api/reports/campaign/:id` also has fallback now
- ~~**Unsubscribe footer optional (user-initiated only)**~~ — FIXED: compliance pipeline now mandatory in campaignSend (f1b1636)
- ~~**`campaign_events` backfill not yet run**~~ — FIXED: all endpoints (analytics + reports) now have `campaign_recipients` fallback. Backfill optional.
- ~~**Import-all 30s timeout on 3000+ records**~~ — FIXED: background batch processing with 200-record batches (commit: 450a34c)
- ~~**Verification worker silent after restart**~~ — FIXED: stuck `processing` items blocked pending-only query. Staleness recovery added (commit: 9e4141b)
- ~~**List verification counts don't add up**~~ — FIXED: 3-way grouping (verified/invalid/unverified), `catchall` counted as verified, `invalid_count` separate field (commit: e603f12)
- ~~**Lists index page all counts 0**~~ — FIXED (twice): (1) split into two queries (commit: 2c76143), (2) removed 4 legacy shadow routes from `prospects.js` that intercepted `/api/lists` before `listsRouter` (commit: 86684be)
- ~~**File mining column mapping broken**~~ — FIXED: word-boundary matching, source field mapping, priority reorder (company → source → name), unmapped columns to _extra
- ~~**List detail + Contacts page name column wrong**~~ — FIXED: list detail `GET /api/lists/:id` now COALESCEs `persons.first_name + last_name` over `prospects.name`. Contacts page already correct (reads from `persons` directly).
- ~~**Email addresses written as company_name in affiliations**~~ — FIXED: all write paths (import-all, aggregation trigger, CSV upload, leads import) now check for `@` before writing to `affiliations.company_name`.
- ~~**Contacts page company column showing pipe-separated junk**~~ — FIXED: `GET /api/persons` LATERAL JOIN now excludes `@` rows and SPLIT_PARTs pipe data. All write paths also block `|` in company_name. Cleanup script run — 611 records cleaned.
- ~~**"Exclude Invalid" default filter lost on Contacts page**~~ — FIXED: `useState('exclude_invalid')` default, `clearFilters` resets to `exclude_invalid`, `hasActiveFilters` treats it as default. (commit: a861502 in liffy-ui)
- ~~**Import preview `total_with_email` count bug**~~ — FIXED: frontend was accessing `data.stats.total_with_email` from 202 background response that doesn't include stats. Now uses already-fetched `importPreview` data. (commit: db641b2 in liffy-ui)
- ~~**Contacts page search/filter returns 0 results**~~ — FIXED: SQL NULL semantics in `exclude_invalid` filter + switched to direct API URL. (commits: c156e3f, 41f14d2)

- ~~**Template editor HTML escaping**~~ — FIXED: pasted raw HTML was escaped by contentEditable (`<table>` → `&lt;table&gt;`). Added Visual/HTML mode toggle — HTML mode uses plain textarea. (commit: 499457a in liffy-ui)
- ~~**Campaign analytics Sent=0**~~ — FIXED: worker.js was not recording `sent` events to `campaign_events`. Added `recordSentEvent()` to worker + hybrid sent count fallback in analytics endpoint. (commits: 0ad776a, 9c29d73)
- ~~**PDF mining 0 results from UI jobs**~~ — FIXED: documentMiner returned `pdfContacts` but execution plan path in flowOrchestrator overwrote them by calling `documentTextNormalizer.normalize()`. All 3 execution plan normalizer paths now check for existing contacts before applying text normalizer. (commit: 82fb4ea)

### Open
- `/api/stats` 401 Unauthorized still repeating in console — sidebar polls every 30s, auth header was added but issue persists
- ZeroBounce account not yet configured — settings UI untested against live API
- Prospects page search is client-side only (backend `/api/intents` doesn't support text search param)
- **Frontend import-all polling not yet implemented** — backend returns 202 + `import_status`/`import_progress`, but liffy-ui needs to poll `GET /api/mining/jobs/:id` and show progress bar
- **Name field shows company name for some records** (minor) — Excel imports where name column was empty picked up company name as first_name. Legacy data, not recurring.
- **"Web Search" appearing as name/company in a few records** (minor) — stale data from early mining runs, not recurring.
- **Mining console page hidden** — page exists at `/mining/jobs/[id]/console/page.tsx` but all navigation links removed. Requires: log writing in mining services, `/logs` endpoint, job control endpoints (pause/resume/cancel). Future feature.

---

## Immediate Next Tasks (New Session)

1. ~~**DB Schema Guide**~~ — ✅ DONE
2. ~~**Canonical Migration Plan**~~ — ✅ DONE
3. **Zoho CRM Push UI** — P2 #6, push button on Contacts page, module select, push history
4. ~~**Import preview `total_with_email` bug fix**~~ — ✅ DONE
5. ~~**Lists index counts shadow route fix**~~ — ✅ DONE: removed 4 legacy routes from prospects.js
6. ~~**Console page hide**~~ — ✅ DONE: removed navigation links, kept page for future
7. ~~**Template placeholder fallback**~~ — ✅ DONE: display_name + pipe syntax
8. **Frontend import-all polling** — show progress bar for background import-all
9. **Mining console page** (future) — implement log writing + /logs endpoint + job control
