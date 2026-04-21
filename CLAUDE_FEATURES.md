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

## Mining Mode — Free vs AI

Mining mode determines which miners run in the execution plan:

| Mode | Backend Value | Miners Used | Cost |
|------|--------------|-------------|------|
| **Free** | `full` | Deterministic only: playwrightTableMiner, directoryMiner, documentMiner, httpBasicMiner | Free |
| **AI** | `ai` | All deterministic + aiMiner (Claude AI analysis) | Paid (API credits) |

**Key rule:** `aiMiner` is ONLY added to the execution plan when `miningMode === 'ai'`. Free mode (`full`/`free`) never includes aiMiner.

**Files:**
- `executionPlanBuilder.js` — builds plan per inputType + miningMode (aiMiner only in `'ai'` branches)
- `flowOrchestrator.js` — `fullMiner` composite runs only playwrightTableMiner (no aiMiner)
- `flowOrchestrator.js` — execution plan condition handles both `'full'` and `'free'` mode values

---

## Block Detection & Manual Mining Notification

When Liffy cannot mine a site due to IP blocking (Cloudflare, CAPTCHA, etc.), it sends an email to the organizer admin with a local miner command.

**Detection triggers:**
1. **HARD_SITE list** (`worker.js`) — known blocked domains: big5construct, big5global, thebig5, big5expo, etc.
2. **Unified engine 0 results** — flowOrchestrator returns `blockDetected: true` when all miners return BLOCKED/FAILED/EMPTY with 0 contacts. Worker confirms with `SELECT COUNT(*) FROM mining_results WHERE job_id = $1`.
3. **HtmlCache poisoned content** (`htmlCache.js`) — detects Cloudflare challenge pages, CAPTCHA, extremely short content, missing HTML structure
4. **BLOCK_DETECTED error** (`miningWorker.js`) — thrown when Cloudflare or suspicious text detected during Playwright crawl

**Email notification (3 sections):**
- Section 1: Explanation of why the site is blocked
- Section 2: Copy-paste ready terminal command with real `MINING_API_TOKEN` from env
- Section 3: First-time setup instructions (Node.js, git clone, npm install, playwright)

**Implementation:** `worker.js` → `triggerManualAssist(job)` → SendGrid email to organizer admin. Best-effort (try/catch, never breaks the job). Sets `mining_jobs.manual_required = true`.

**Files:**
- `backend/worker.js` — `isHardSite()`, `shouldUseSuperMiner()`, `triggerManualAssist()`
- `backend/services/superMiner/services/flowOrchestrator.js` — `blockDetected` flag in job result
- `backend/services/superMiner/services/htmlCache.js` — `isPoisoned()` content check
- `backend/services/miningWorker.js` — `checkBlock()` Cloudflare/CAPTCHA detection

See [MINER_GUIDE.md](./MINER_GUIDE.md) section 7 for full local miner documentation.

---

## Local Miner — Global Email Pollution Detection

Trade fair sites have organizer emails in header/footer/sidebar that appear on every exhibitor detail page. The local miner's `extractEmails()` uses page-wide regex, causing these emails to be assigned to every exhibitor.

**Solution:** Frequency-based post-processing filter (`deduplicateGlobalEmails()`).

**How it works:**
```
allResults collected (all exhibitors mined)
  → Count email frequency across all results
  → Threshold: ceil(totalResults * 0.3) — email in ≥30% of exhibitors = pollution
  → Skip if < 5 results (avoid false positives on small sets)
  → Remove polluted emails from each result
  → Log removed emails to console (No Silent Data Loss)
  → Clean results sent to postResults() + saveResultsLocally()
```

**Console output format:**
```
🧹 GLOBAL EMAIL POLLUTION DETECTED
   Threshold: appears in >= 55/181 exhibitors (30%)
   ❌ knauer@schall-messen.de — found in 181 exhibitors (removed)
   ❌ info@schall-messen.de — found in 181 exhibitors (removed)
   🧹 Removed 362 polluted email entries across 181 exhibitors
```

**Files:**
- `liffy-local-miner/mine.js:293-339` — `deduplicateGlobalEmails()` function
- `liffy-local-miner/mine.js:1508-1509` — call site (after allResults, before statistics)

**Design decisions:**
- Generic: works for any fair site, no domain blacklists needed
- Post-processing only: does not modify extraction logic, existing sites unaffected
- Threshold 30%: low enough to catch organizer emails (appear in ~100%), high enough to avoid false positives on shared exhibitor emails

---

## Local Miner — ExpoPlatform Miner

Specialized miner for ExpoPlatform-based trade fair sites (digital.agritechnica.com, etc.).

**Two-phase architecture:**
```
Phase 1: HTTP POST /api/v1/search/exhibitors (no Playwright needed)
  → limit=60 per page (server cap), paginate all pages
  → Collect: slug, name, country, city, hall/stand from API response
  → Response format: { code, data: { total, list: [...] } }

Phase 2: Playwright detail pages /newfront/exhibitor/{slug}
  → waitForSelector('a[href^="mailto:"]', 10s) → fallback 'COMPANY EMAIL' (5s)
  → DOM extraction: mailto links, website (www.* text links), phone
  → Hall/stand via [data-styleid="exhibitorHallBlock"] attribute
  → 1.5s polite delay between pages
```

**Site detection:** URL contains `/newfront/marketplace/exhibitors` or `expoplatform`

**Config:** `max_pages` (API page limit), `max_details` (detail page limit), `delay_ms` (default 1500)

**Files:**
- `liffy-local-miner/miners/expoPlatformMiner.js` — standalone module + CLI runner
- `liffy-local-miner/mine.js:3` — require + `isExpoPlatformUrl()` routing in `runMiningTest()`

**Test results:** digital.agritechnica.com — 2918 exhibitors, 49 API pages, 100% email coverage on 5-item sample.

---

## Local Miner — Batch Result Posting

Large mining results (2000+ exhibitors) caused "Payload Too Large" errors when posting to API.

**Solution:** `postResults()` now chunks results into 200-item batches with 1s delay between each.

**Behavior:**
- Results ≤ 200: single POST, no batch metadata (unchanged behavior)
- Results > 200: split into 200-item chunks, each batch posted separately
- Progress log: `📤 Batch 1/15: 200 results pushed`
- Batch metadata added to `meta.batch` field (e.g. `"3/15"`)

**File:** `liffy-local-miner/mine.js:194-240` — `postResults()` function

---

## Manual Mining Email — Organizer Pollution Detection

Cloud miner sometimes finds 1-2 results on SPA sites (e.g. ExpoPlatform) — typically the organizer's footer email. System treated this as "successful" mining and didn't trigger manual mining notification.

**Solution:** `looksLikeOrganizerPollution()` check added to worker.js.

**Logic:**
```
resultCount <= 2
  → Query all emails from mining_results for this job
  → Extract email domains
  → Compare with source URL domain
  → If ALL email domains differ from source domain → organizer pollution
  → Trigger manual mining email (same as 0-result case)
```

**Example:** source=digital.agritechnica.com, email=digital-plattform@dlg.org → dlg.org ≠ agritechnica.com → pollution → manual mining triggered

**Files:**
- `backend/worker.js:477-520` — `looksLikeOrganizerPollution()` helper
- `backend/worker.js:432-437` — unified engine trigger (0 results + pollution check)
- `backend/worker.js:449-454` — hard site trigger (0 results + pollution check)

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
- `backend/services/fileMiner.js` — Used by documentMiner for PDF delegation (pdfplumber tables + columnar text parser + email-centric extraction)

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

**Campaign send** (`backend/routes/campaignSend.js`) and **worker** (`backend/worker.js`) both write `sent` events to `campaign_events` via `recordSentEvent()`.

> **Note:** Worker `recordSentEvent` was added in commit 0ad776a. Campaigns sent before this commit may have incomplete `sent` events in `campaign_events`. The analytics endpoint has a hybrid fallback that cross-checks `campaign_recipients` for the true sent count.

---

## Reply Detection — Full Journey (v1→v4)

**Status:** LIVE (v4 — plus addressing). Production-stable since 2026-04-20. DNS fix: `parse@reply.liffy.app` (not `parse@inbound.liffy.app` — inbound.liffy.app has no MX record).

### The Journey — 4 iterations, each solving a real failure

#### v1: VERP-based system (DEPRECATED)
- Reply-To: `c-{8hex}-r-{8hex}@reply.liffy.app` (VERP address)
- Customer replied to garip `@reply.liffy.app` address → unnatural
- LİFFY forwarded reply to salesperson: wrapper HTML, campaign metadata, tracking pixel, broken signature
- AI consultation (ChatGPT + Gemini): "VERP Reply-To breaks natural human conversation; mature platforms use mailbox integration"
- **Verdict:** Customer experience terrible, forward formatting broken

#### v2: Hidden HTML comment + Gmail auto-forward (FAILED)
- Reply-To changed to salesperson's real email (e.g. `elif@elan-expo.com`)
- Hidden HTML comment in body: `<!--LIFFY:c-{8hex}-r-{8hex}-->`
- Gmail Content Compliance rule to match body text and forward
- **Problem:** Gmail strips HTML comments from email body. Tag disappears before Content Compliance can scan it.
- Alternative tried: `<span style="display:none">` — spam risk, abandoned
- **Verdict:** Gmail comment stripping killed this approach

#### v3: Unsubscribe URL token enrichment (PARTIAL)
- Moved tracking data into unsubscribe URL token (HMAC-signed, base64url)
- Token format: `email:orgId:campaignId:recipientId:timestamp:signature` (6-part, backward compatible with old 4-part)
- Gmail Content Compliance rule to match `api.liffy.app/api/unsubscribe` in body
- **Problem:** Gmail Content Compliance doesn't scan quoted/blockquote text. When customer replies, the unsubscribe link is inside the quoted original message, which Content Compliance ignores.
- **Verdict:** Body-based matching fundamentally unreliable in Gmail replies

#### v4: Plus addressing (FINAL — LIVE)
- Reply-To: `sender+c-{8hex}-r-{8hex}@domain.com` (plus-addressed real email)
- Gmail's `+tag` standard: `elif+c-abc12345-r-def67890@elan-expo.com` delivers to `elif@elan-expo.com`
- Customer sees normal email thread, Gmail ignores the `+tag` part
- Content Compliance: Advanced content match, **Full headers**, contains `+c-`
- Headers are always available (not in quoted body) → reliable matching
- **Verdict:** Works! Production-stable. ✅

### Final Architecture (v4)

```
Outbound (3 send paths):
  Reply-To = sender+c-{campaignId8}-r-{recipientId8}@domain.com
  Unsubscribe URL token includes campaignId + recipientId (backward compatible)
  Click tracking OFF, open tracking ON

Customer replies:
  → Goes to salesperson's Gmail inbox (natural thread, +tag ignored)
  → Gmail Content Compliance: headers match "+c-" → also deliver to parse@reply.liffy.app
  → SendGrid Inbound Parse → POST /api/webhooks/inbound/:secret

Inbound handler (3 detection methods, priority order):
  Method 0: parsePlusAddress(toAddress) — most reliable, parses +tag from To header
  Method 1: detectReplySource(body) — unsubscribe URL token from quoted body (fallback)
  Method 2: from-email DB match — campaign_recipients WHERE email = fromEmail (last resort)

  → campaign_events INSERT (event_type='reply', person_id resolved ONCE)
  → campaign_recipients UPDATE (status='replied')
  → prospect_intents INSERT
  → contact_activities INSERT
  → pipeline auto-stage (→ Interested)
  → Action Engine: evaluateForPerson(personId, orgId, 'reply_received') → P1 action item
  → NO forward — salesperson already has reply in Gmail
```

### 3 Send Paths (all in sync)

| File | Reply-To | Unsubscribe |
|------|----------|-------------|
| `campaignSend.js` | `buildPlusReplyTo(replyToBase, campaign_id, r.id)` | `getUnsubscribeUrl(email, orgId, campaignId, recipientId)` |
| `worker.js` | `buildPlusReplyTo(replyToBase, campaign.id, r.id)` | Same |
| `sequenceService.js` | `buildPlusReplyTo(replyToBase, campaign_id, id)` | Same |

### Plus Address Parser (`parsePlusAddress`)

```javascript
// Parses: "Elif AY <elif+c-abc12345-r-def67890@elan-expo.com>"
// Returns: { campaignShort: 'abc12345', recipientShort: 'def67890' }
// Regex: /\+c-([a-f0-9]{8})-r-([a-f0-9]{8})@/i
```

### Unsubscribe URL Token (v3 enrichment, still active)

Token format: `base64url(email:orgId:campaignId:recipientId:timestamp:hmacSig)`
- 6-part format, backward compatible with old 4-part tokens
- `verifyUnsubscribeToken()` handles both formats
- Used as Method 1 fallback in reply detection

### person_id Consolidation (Action Engine fix)

Inbound handler resolves `person_id` ONCE after recipient match, attaches to `recipient.person_id`.
Used by: `recordCampaignEvent()`, `contact_activities`, pipeline auto-stage, Action Engine.
Previously had 4 independent lookups — if any returned NULL, downstream silently failed.
`recordCampaignEvent()` prefers pre-resolved `recipient.person_id`, falls back to its own lookup for non-inbound callers (SendGrid webhooks).

### Gmail Admin Setup (per organization, one-time)

1. admin.google.com → Apps → Google Workspace → Gmail → Compliance → Content Compliance
2. Add rule: "Liffy Reply Detection"
3. **Inbound** checked, **Internal - Receiving** checked (same-domain replies)
4. Expression: **Advanced content match**, **Full headers**, **Contains text**, `+c-`
5. Also deliver to: `parse@reply.liffy.app`
6. Save

**Alternative (Google Workspace Content Compliance regex):**
Pattern: `\+c-[a-f0-9]{8}-r-[a-f0-9]{8}@` on Full headers

### DNS & SendGrid Config

| Domain | Record | Value | Purpose |
|--------|--------|-------|---------|
| `reply.liffy.app` | MX | `mx.sendgrid.net` | Inbound Parse receives forwarded replies |
| `inbound.liffy.app` | — | NO MX record | Not used (legacy reference, ignore) |

SendGrid Inbound Parse URL: `https://api.liffy.app/api/webhooks/inbound/{INBOUND_WEBHOOK_SECRET}`

### Important Details

- Click tracking **disabled** (`clickTracking: { enable: false }` in mailer.js) — reply threads stay clean
- Open tracking **enabled** (analytics)
- Reply forward **removed** — `forwardReplyToOrganizer()` deleted. Salesperson has reply in Gmail natively.
- Reply body stored in `campaign_events.provider_response` (JSONB, 2000 chars)
- ContactDrawer shows reply body preview (200 chars) with red left border
- Auto-reply filter: RFC 3834 headers, OOO subjects, mailer-daemon from patterns

### Env Vars

| Variable | Required | Description |
|----------|----------|-------------|
| `INBOUND_WEBHOOK_SECRET` | Yes | Secret in URL path for inbound webhook auth |

### Phase 2 Plan (Future)
- Gmail API OAuth integration (replaces Content Compliance auto-forward)
- Native inbox sync, no admin filter setup needed
- Merges with Blueprint Phase 6 (Conversations/Inbox)

### Key Commits
- e1e05f8 (v1 VERP), 03e7a0d (VERP forwarding), 5d317fe (v2 hidden tag), 36fb0ed (v3 unsubscribe URL token), 5e59855 (v4 plus addressing), f2cc7b4 (person_id consolidation)

### Files
- `backend/utils/unsubscribeHelper.js` — `buildPlusReplyTo()`, `generateUnsubscribeToken()`, `verifyUnsubscribeToken()`, `processEmailCompliance()`
- `backend/routes/webhooks.js` — `parsePlusAddress()`, `detectReplySource()`, inbound handler, gmail-filter-info endpoint
- `backend/routes/campaignSend.js` — plus-addressed Reply-To
- `backend/worker.js` — plus-addressed Reply-To
- `backend/services/sequenceService.js` — plus-addressed Reply-To
- `backend/mailer.js` — click tracking disabled

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

**Frontend:** Template editor has two chip rows below the editor:
- **Smart Placeholders (green):** 6 preset pipe-fallback chips that insert full `{{first_name|last_name|company_name|"fallback"}}` expressions. Each chip shows the fallback label and a tooltip explaining the cascade. Presets: Export Manager, Dear Exhibitor, Business Partner, Industry Professional, Valued Partner, Trade Representative.
- **Insert (orange):** Simple field chips: `{{first_name}}`, `{{last_name}}`, `{{company_name}}`, `{{email}}`, `{{country}}`, `{{position}}`, `{{website}}`, `{{tag}}`
- Tip text below explains pipe fallback syntax.
- Placeholder insertion works in both Visual (contentEditable `insertText`) and HTML (textarea cursor splice) modes.
- `{{display_name}}` chip removed from frontend (commit: 9bdebb2 liffy-ui). Backend `display_name` computed field still works for backward compatibility.

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
**Placeholder insertion:** Two chip rows below editor — Smart Placeholders (green, pipe-fallback presets) and Insert (orange, simple fields). Works in both Visual (`insertText`) and HTML (textarea cursor splice) modes.
**Save:** `innerHTML` from contentEditable div sent as `body_html` to API
**Edit:** Existing `body_html` loaded into contentEditable div when modal opens
**Empty state:** CSS `::before` placeholder via `data-placeholder` attribute

**HTML / Visual Mode Toggle** (commit: 499457a in liffy-ui):
- Two-mode editor with `[Visual]` / `[HTML]` toggle buttons above the body field
- **Visual mode:** Existing contentEditable editor with rich text toolbar (default)
- **HTML mode:** Plain `<textarea>` with monospace font — raw HTML input, no escaping
- Switching Visual → HTML: `textarea.value = editor.innerHTML`
- Switching HTML → Visual: `editor.innerHTML = textarea.value`
- Save uses whichever mode is active (Visual: `innerHTML`, HTML: `textarea.value`)
- Solves: contentEditable was escaping pasted HTML tags (`<table>` → `&lt;table&gt;`), causing raw HTML to appear as text in sent emails

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
1. **Summary**: event counts + derived rates (open_rate, click_rate, bounce_rate, spam_rate, unsubscribe_rate). **Hybrid sent count:** if `campaign_events.sent` < `campaign_recipients` actual sent, uses the higher number (covers pre-fix worker campaigns).
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
| `/api/persons/export` | GET | Export all contacts as XLSX or CSV. 21 columns including engagement stats. Supports same filters as listing. Query: `?format=xlsx\|csv&search=&verification_status=&country=&company=&has_intent=` |
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
  → fetch batch (500 rows) → BEGIN transaction
    → dedup emails within batch (skip duplicates, mark imported)
    → sort by email (consistent lock ordering)
    → for each row: SAVEPOINT → process → RELEASE / ROLLBACK TO SAVEPOINT
  → COMMIT → update progress in mining_jobs.import_progress
  → repeat until done → set import_status = 'completed'
```

**Batch size:** 500 rows per transaction (increased from 200, commit: 944594b).

**Deadlock prevention (3-layer fix, commit: 95f43e8):**
1. **Batch-internal email dedup:** Same email appearing multiple times in a batch only processes once; duplicates are marked as `imported` immediately
2. **Consistent lock ordering:** Rows sorted by email before processing — prevents cross-row lock ordering deadlocks on `persons`/`affiliations` UPSERT
3. **Per-row SAVEPOINT:** Each row wrapped in `SAVEPOINT sp_{id}` / `RELEASE SAVEPOINT`. On error: `ROLLBACK TO SAVEPOINT` — single row failure does NOT abort the entire transaction. This prevents the PostgreSQL "current transaction is aborted, commands ignored until end of transaction block" cascade failure.

**Root cause of original deadlock bug:** The `catch` block in `processImportBatch()` swallowed per-row errors but PostgreSQL had already moved the transaction to aborted state — all subsequent queries in the 200-row batch failed with "commands ignored until end of transaction block", causing hundreds of cascade errors.

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

## Messe Frankfurt Miner

Specialized miner for Messe Frankfurt exhibition exhibitor catalogs. All Messe Frankfurt events (Techtextil, Automechanika, Heimtextil, ISH, Ambiente, etc.) share the same SPA platform and API.

**Triggering condition:**
- URL hostname includes `messefrankfurt.com`
- URL path includes `exhibitor`
- Page type: `PAGE_TYPES.MESSE_FRANKFURT` → `messeFrankfurtMiner`

**API endpoint pattern:**
```
GET https://api.messefrankfurt.com/service/esb_api/exhibitor-service/api/2.1/public/exhibitor/search
  ?language=en-GB&q=&orderBy=name&pageNumber={N}&pageSize=100
  &showJumpLabels=false&findEventVariable={EVENT}
```
Event variable derived from subdomain (e.g. `techtextil.messefrankfurt.com` → `TECHTEXTIL`).

**API response structure:**
```json
{
  "success": true,
  "result": {
    "hits": [
      {
        "exhibitor": {
          "name": "Company Name",
          "rewriteId": "company-name-slug",
          "homepage": "http://www.company.com",
          "address": {
            "email": "info@company.com",
            "tel": "+49 123 456789",
            "street": "Main St 1",
            "zip": "12345",
            "city": "Berlin",
            "country": { "label": "Germany", "iso3": "DEU" }
          }
        }
      }
    ]
  }
}
```

**Detail page DOM selectors (Phase 2 — only for exhibitors missing email):**
- Emails: `a[href^="mailto:"]` (filters `mailto:?subject=` share links)
- Phones: `a[href^="tel:"]`
- Website: `a[href^="http"]` near "website"/"homepage" labels (strict matching)
- Address: `.exhibitor-address`, `[class*="address"]`, `.address`
- Detail URL: `{baseUrl}/exhibitor-search.detail.html/{rewriteId}.html`

**Config options:**
| Key | Default | Description |
|-----|---------|-------------|
| `max_pages` | `50` | Maximum API pagination pages |
| `max_details` | `300` | Maximum detail page visits (only for missing-email exhibitors) |
| `delay_ms` | `1500` | Delay between detail page visits (ms) |
| `page_size` | `100` | API page size |
| `total_timeout` | `480000` | Total timeout (8 minutes) |

**Performance:** ~60 exhibitors in 25 seconds (2 pages), ~88% with email from API alone.

---

## PDF Table Extraction Pipeline (documentMiner + fileMiner)

PDF mining uses a multi-method extraction cascade for tabular PDFs (exhibitor lists, waste management providers, etc.):

```
documentMiner.mine(url)
  → detect .pdf URL → download as binary
  → fileMiner.processFile(buffer, 'download.pdf')
    → Method 0: pdfplumber (Python) — table detection + structured extraction
    → Method 0b: pdftotext -layout → columnar text parser (parseColumnarPdfText)
    → Method 1: pdftotext / mutool / pdf-parse — raw text extraction
    → Method 2: email-centric extraction (regex around emails)
    → mergeContacts() — dedup by email, pick best fields
  → result.pdfContacts → flowOrchestrator (bypasses documentTextNormalizer)
  → aggregator → mining_results → persons + affiliations
```

**Key components:**

| Component | File | Role |
|-----------|------|------|
| `pdfTableExtractor.py` | `backend/services/extractors/pdfTableExtractor.py` | Python pdfplumber script — detects tables, extracts headers + rows |
| `tryPdfPlumber()` | `backend/services/fileMiner.js` | Calls Python script, parses JSON output |
| `extractContactsFromTables()` | `backend/services/fileMiner.js` | Maps table headers to contact fields (email, company, phone, etc.) |
| `parseColumnarPdfText()` | `backend/services/fileMiner.js` | Parses pdftotext `-layout` output with numbered entries (S/No), column detection |
| `extractFromPdf()` | `backend/services/urlMiners/documentMiner.js` | Downloads PDF, delegates to fileMiner.processFile() |

**pdfContacts pipeline bypass:**
When documentMiner returns `pdfContacts` (pre-extracted contacts from fileMiner), the flowOrchestrator skips `documentTextNormalizer.normalize()` and uses the contacts directly. This bypass is applied in all 4 code paths:
1. Inline adapter (loadMiners documentMiner wrapper)
2. Paginated execution plan path
3. Enrichment miners path
4. Non-paginated step execution path

**TLD validation:** Emails from pdfplumber are validated against a TLD allowlist (`com`, `org`, `net`, `gov`, `edu`, `ng`, `uk`, etc.) to filter garbled/reversed emails from rotated PDF pages.

**Dockerfile dependencies:**
```dockerfile
python3, python3-pip  # System packages
pdfplumber            # pip install
poppler-utils         # pdftotext
mupdf-tools           # mutool
```

**Test case:** NUPRC Waste Management PDF → 50 contacts, 41 with company names (82%), completed in 1.9s.

---

## Unsubscribe Tracking

Backend endpoint + frontend page for viewing unsubscribe history.

**Backend:** `GET /api/unsubscribes` (`backend/routes/unsubscribes.js`)
- Auth-protected with pagination (`page`, `limit`), search (email ILIKE), source filter
- LATERAL join to `campaign_events` + `campaign_recipients` for campaign attribution
- Uses `COALESCE(u.source, u.reason, 'unknown')` for source field
- Returns `{ unsubscribes, pagination, stats: { total, by_source } }`
- Registered in `server.js` as `app.use('/api/unsubscribes', unsubscribesRouter)`

**Frontend:** `/campaigns/unsubscribes` (`liffy-ui/app/campaigns/unsubscribes/page.tsx`)
- 4 summary cards: Total, Unsubscribe Link, Spam Reports, User Requests
- Search input + source filter dropdown
- Table: Email, Source (color-coded badge), Campaign (linked), Date
- Source badges: sendgrid_unsubscribe=gray, spam_report=red, user_request=blue
- Nav link added to campaigns page header (next to "Create Campaign")

---

## Excel/CSV Export (`backend/utils/exportHelper.js`)

Server-side data export using `exceljs` library. Shared utility generates both XLSX and CSV formats.

**Utility:** `generateExport(rows, columns, sheetName, format)` — XLSX features: bold white headers on blue fill, auto-filter. CSV: proper escaping (quotes, commas, newlines). Arrays auto-converted to comma-separated strings.

| Endpoint | Method | Columns | Description |
|----------|--------|---------|-------------|
| `/api/mining/jobs/:id/results/export` | GET | 13 | Email, Company, Contact Name, Job Title, Phone, Website, Country, City, Address, Confidence, Verification, Status, Found At |
| `/api/persons/export` | GET | 21 | Email, First/Last Name, Company, Job Title, Phone, Website, Country, City, Verification, Verified At, Added, Campaigns Sent, Opens, Clicks, Replies, Bounces, Last Campaign, Is Prospect, Latest Intent, Lists |
| `/api/lists/:id/export` | GET | 17 | Email, First/Last Name, Display Name, Company, Job Title, Phone, Website, Country, Verification, Source, Tags, Opened, Clicked, Replied, Bounced, Added |

All endpoints:
- Query param: `?format=xlsx` (default) or `?format=csv`
- Auth-protected with `organizer_id` filtering
- Stream binary buffer with `Content-Disposition: attachment` header
- No pagination/LIMIT — exports full dataset
- Persons export supports same filters as listing endpoint (search, verification_status, country, company, has_intent)

**Frontend:** "Export All (N)" buttons on mining results page, contacts page, and list detail page. Download via `fetch → blob → URL.createObjectURL → anchor click`. Loading state shown during export.

**Files:**
- `backend/utils/exportHelper.js` — shared `generateExport()` + `generateCSV()` utility
- `backend/routes/miningResults.js` — mining results export endpoint
- `backend/routes/persons.js` — contacts export endpoint (registered BEFORE `/:id` to avoid param collision)
- `backend/routes/lists.js` — list members export endpoint
- `liffy-ui/app/mining/jobs/[id]/results/page.tsx` — export button (replaces old client-side CSV)
- `liffy-ui/app/leads/page.tsx` — export button
- `liffy-ui/app/lists/[id]/page.tsx` — export button

---

## AI Miner Generator — v1 (Park) → v2 (Aktif Geliştirme)

Self-evolving mining engine: when existing miners fail on a new site, Claude generates site-specific extraction config that runs via generic templates.

**Status:** v1 (Phase 0, JS generation) PARKED — %29 başarı oranı. v2 geçiş aktif.

**v1 Neden Park Edildi:**
- %29 başarı — sadece email'leri DOM'da doğrudan gösteren basit sayfalarda çalıştı
- Claude **uydurma CSS selector** üretiyordu (`.company-card`, `.directory-item` — gerçekte yok)
- 100KB raw HTML gönderiliyordu — çok gürültülü, Claude asıl veriyi bulamıyordu
- Tek deneme, başarısız olursa bitir. Self-healing yok.

**v2 Yaklaşım (3 Temel Değişiklik):**

| # | Değişiklik | Etki |
|---|-----------|------|
| 1 | **AXTree (Accessibility Tree)** — Ham HTML yerine Playwright `ariaSnapshot()` YAML | %95 token tasarrufu, halüsinasyon riski sıfır |
| 2 | **Config-Driven Extraction** — AI kod yazmaz, JSON selector config üretir | Kırılganlık azalır, güvenlik riski düşer |
| 3 | **Self-Healing REPL Loop** — tek deneme yerine iteratif düzeltme (max 3-5) | Başarı oranı %29 → hedef %60+ |

**v2 Pipeline:**
```
URL → Playwright render → ariaSnapshot() YAML (2-5KB)
  → Claude API: "Bu AXTree'de tekrar eden entity blokları bul"
  → Claude JSON config döner (kod değil!):
    {
      entity_selector: "role=listitem",
      name: "heading level=3",
      detail_link: "link 'View Profile'",
      email: "link name=/mailto:/",
      phone: "text /\\+?\\d/"
    }
  → Sabit GenericExtractor template config ile çalışır
  → Başarısız → hata + güncel AXTree → Claude'a geri → düzelt (max 3-5)
  → Başarılı → config DB'ye kaydet, reuse
```

**v2 Bileşenler (implemente edildi):**
- ✅ AXTree integration — Playwright ariaSnapshot() YAML (6KB vs 100KB HTML = %94 azalma)
- ✅ GenericExtractor — config-driven template (anchor-based + container-based dual mode)
- ✅ Self-healing REPL loop — generateMinerV2WithHealing() (max 3 iterasyon)
- ✅ Config DB storage — generated_miners.miner_code → JSON config
- ✅ Multi-step config — listing AXTree + sample detail AXTree → iki Claude API çağrısı

**v2 Test Sonuçları (6 Mart 2025 — Final):**

| URL | AXTree | Tokens | Type | Result | Süre |
|-----|--------|--------|------|--------|------|
| glmis.gov.gh/Domestic | 6KB | 3,555 | single_page anchor | ✅ 11 contact, 100% email | 14s |
| expat.com/business/ghana | 31KB | 15,323 | multi_step | ✅ 7 contact, 100% email (best run) | 88s |
| expat.com (tutarsız run) | 31KB | 17,584 | single→multi override | ⚠️ 3 contact, 33% email | 137s |
| valveworldexpo.com | 20KB | 8,081 | multi_step | ⏳ Timeout (115 entity, VIS SPA) | — |
| ghanabusinessweb.com | 15KB | 6,224 | multi_step | ❌ Homepage, directory değil | — |

**Performans iyileştirmesi:**

| Metrik | İlk test | Optimized |
|--------|----------|-----------|
| expat.com süre | 24 dakika | 88 saniye (%94↓) |
| Listing extraction | 5-10 dk (locator loop) | 100ms (page.evaluate bulk) |
| Detail page crawl | 10-15 dk | 30-60s (tab reuse + quick extract) |

**Kalan sorunlar:**
- Claude non-deterministic: aynı AXTree'ye bazen TYPE 1, bazen TYPE 2 dönüyor
- Anchor mode navigasyon linkleri karıştırabiliyor (entity_selector null olunca)
- Çözüm bekleniyor: prompt güçlendirme veya response post-validation

**v2 Commits:** d3db511 (AXTree + GenericExtractor), f139403 (anchor fix), 3f84983 (name fallback + URL filter), be00916 (link entity filter), 636cd55 (self-href detail_url), 7cea825 (performance bulk extract), bb97a49 (networkidle restore + Claude override)

**GenericExtractor İyileştirmeleri:**
- Container name fallback: heading → first text line (name_role null durumu)
- Detail URL fallback: first valid `<a>` link, isValidDetailUrl filtering
- Link entity guard: entity_role="link" → isNavigationLink + isBusinessProfileLink filtering
- Link entity self-href: entity IS the link → its href = detail_url
- quickText timeout: 5s Promise.race guard, max 50 entities cap
- bulkExtractFromPage: page.evaluate() for link entities (100ms vs 5-10 min)
- quickExtractDetail: page.evaluate() for detail pages (10ms vs 5-10s)

**Mevcut altyapı (aynen kalıyor):**
- `generated_miners` DB tablosu — `miner_code` artık JSON config
- Admin API (7 endpoint) — değişmez
- Pipeline hook (flowOrchestrator) — değişmez
- Security scan — config-driven'da daha az risk ama kalır
- Output validation — değişmez

**Detaylı dokümanlar:**
- [RFC_v4_AI_Miner_Generator.md](./RFC_v4_AI_Miner_Generator.md) — teknik RFC
- [AI_Miner_Generator_Report_v2.md](./AI_Miner_Generator_Report_v2.md) — proje raporu

**Files:**
- `backend/services/aiMinerGenerator.js` — main service (~2180 lines, v2 methods added)
- `backend/services/genericExtractor.js` — config-driven extraction template (anchor + container dual mode)
- `backend/scripts/testAIMinerGenerator.js` — CLI test script (--v2 default, --v1, --axtree)
- `backend/migrations/024_create_generated_miners.sql` — DB table

**Test CLI:**
```bash
# v2 (default) — AXTree + Config-Driven
ANTHROPIC_API_KEY=sk-... node backend/scripts/testAIMinerGenerator.js "https://example.com/directory"

# AXTree only (debug, no Claude call)
node backend/scripts/testAIMinerGenerator.js "https://example.com/directory" --axtree

# v1 (legacy)
ANTHROPIC_API_KEY=sk-... node backend/scripts/testAIMinerGenerator.js "https://example.com/directory" --v1
```

---

## Email Extraction Policy — B2B Context

Role-based business emails (info@, contact@, sales@, office@, etc.) **ARE** valid discovery targets.
We are a B2B exhibitor discovery platform. Generic CRM-style filtering is intentionally disabled.

**Only system-level non-human emails are filtered:** noreply, no-reply, mailer-daemon, postmaster, hostmaster, abuse, spam, webmaster, test, example domains.

This is intentional and must NOT be reverted without explicit instruction.

---

## reedExpoMiner — ReedExpo Platform Exhibitor Extraction

Generic miner for all ReedExpo/Informa platform exhibitor directories.

**Sites:** batimat.com, arabhealth.com, mcexpocomfort.it, wtm.com, ishhvac.com, bigshowafrica.com, etc.

**Pipeline:**
1. Phase 1: Playwright infinite scroll — collect exhibitor links + org GUIDs + auto-detect `eventEditionId` + `x-clientid`
2. Phase 2: GraphQL API (`api.reedexpo.com/graphql/`) — batch query for contactEmail/website/phone (concurrency 20)

**Email rate:** ~28% (batimat.com: 430/1519). Phase 2 "not_found" error'ları normal — tüm org'lar GraphQL API'de kayıtlı değil, beklenen davranış.

**Enrichment:** `reedExpoMailtoMiner` step 2 olarak çalışır — emailsiz org'ları company-name match ile mailto: linklerinden zenginleştirir.

## reedExpoMailtoMiner — ReedExpo Mailto Fallback

ReedExpo sites where emails are visible as `mailto:` links directly in HTML (no GraphQL needed).

**Pipeline:** Single-phase Playwright infinite scroll — collects mailto: emails + nearest company name + external website links from DOM.

**Usage:** (1) Standalone miner for `reed_expo_mailto` page type, (2) Enrichment step after `reedExpoMiner` for emailless orgs.

## playwrightTableMiner — Column-Aware Table Parse

**Added:** Multilingual column-aware structured table parser.

**How it works:**
1. Detects header row (`<th>` or first `<tr>`)
2. Maps column headers to fields via keyword matching (EN/TR/ZH/RU/FR/DE/ES)
3. Extracts data from each row using column index mapping

**Keyword fields:** company, email, country, website, phone
**Languages:** English, Turkish, Chinese, Russian, French, German, Spanish

**Matching strategy:** Two-pass — exact match first, then longest substring match. Prevents ambiguous matches (e.g., `公司网站` → website, not company).

**Fallback:** If column-aware produces 0 results, falls back to existing heuristic (bold text, first line, card selectors).

## SuperMiner Status Update Bug Fix (2026-04-07)

**Bug:** Worker.js SuperMiner path never set `status='completed'` after `runMiningJob()` returned. Jobs stayed `running` forever until stale detection cleaned them.

**Root cause:** Two code paths existed for running SuperMiner:
1. **Direct path** (worker.js:407) — `shouldUseSuperMiner(job) = true` → `superMiner.runMiningJob()` → stats written → **no status update** ❌
2. **Legacy path** (worker.js:455) — `processMiningJob()` → internally calls `superMinerEntry.runMiningJob()` → `updateJobStatus()` → `completed` ✅

The legacy path worked because `miningService.js:updateJobStatus()` (line 692) handled status updates. The direct path was missing this entirely.

**Fix:** Added `status='completed'` update after block detection check, with `manualTriggered` flag to avoid overwriting `needs_manual` set by `triggerManualAssist()`. SQL uses `WHERE status = 'running'` guard.

**Files:** `backend/worker.js` lines 446-453

## Stale Job Detection — Periodic Cleanup (2026-04-07)

Worker heartbeat now includes periodic stale job detection (every 10 minutes), in addition to existing startup cleanup.

**How it works:**
1. Every 10 minutes, checks for jobs in `running` status older than 3 hours
2. Skips jobs with `manual_required = true` (awaiting local miner push)
3. Marks stale jobs as `failed` with timeout error
4. Sends notification email to organizer admin with job details and site URL

**Two cleanup layers:**
| Layer | Trigger | Timeout | Scope |
|-------|---------|---------|-------|
| Startup cleanup | Worker restart | 1 hour | All running jobs |
| Periodic cleanup | Every 10 min | 3 hours | Running jobs where `manual_required` is false |

**Files:** `backend/worker.js` — `checkStaleJobs()` function, called in main worker loop

## 120K Email Campaign — Feasibility Analysis (2026-04-07)

Analysis of Liffy's email sending capacity for large campaigns (120K recipients). No code changes — analysis only.

**Current architecture:**
- Two send paths: `campaignSend.js` (API batch) and `worker.js` (background)
- Batch size: 5 per cycle (hardcoded `EMAIL_BATCH_SIZE`)
- Synchronous sends: 1 SendGrid API call per recipient, no parallelism
- Worker cycle: 3s interval between batches
- No queue system (BullMQ), no rate limiting, no 429 retry

**Estimated performance for 120K:**
- ~5 emails/second → **18-24 hours** to complete
- Memory spike during resolve (~50-150MB for INSERT)
- No 429 retry → emails lost on rate limit

**SendGrid limits:** Free: 100/day, Essentials: 100K/day, Pro: 1.5M/month

**Missing capabilities:**
- BullMQ/Redis job queue
- 429 exponential backoff retry
- Parallel sends (Promise.all with concurrency)
- Configurable batch size from UI
- Domain-based throttle (Gmail 500/hr, Outlook 500/hr)
- IP warm-up schedule
- Bounce rate monitoring with auto-pause
- Campaign pause/resume

**Recommended minimum changes for 120K:**
1. Batch size 5 → 50-100
2. 429 retry with exponential backoff
3. Parallel sends (5-10 concurrent)
4. Progress endpoint for UI tracking

Target: 120K in 2-4 hours (vs current 18-24 hours).

## labelValueMiner — Flat HTML Directory Parser (2026-04-07)

New miner for sites with bold company names and `<b>Label:</b> value` patterns separated by `<br>` tags. Generic, multi-language.

**Target pattern:**
```html
<b>CompanyName</b><br>
Optional subtitle<br>
<b>Address:</b> 2, Olokobi Lane, Lagos.<br>
<b>Phone:</b> +234 08022350641<br>
<b>Email:</b> <a href="mailto:info@company.com">info@company.com</a><br>
<b>Website:</b> <a href="http://company.com">company.com</a><br>
<br><br>
```

**How it works:**
1. Finds smallest DOM container with ≥2 "Address:" labels
2. Iterates all `<b>`/`<strong>` elements
3. Classifies each bold: label (Address/Phone/Email/Website) vs company name
4. Between two company name bolds → one entry with extracted label:value pairs
5. Email: searches immediate siblings for `mailto:` link or email regex in text
6. Website: searches siblings for `<a href="http...">` or URL in text

**Detection:** pageAnalyzer checks for `<b>Label:</b>` pattern ≥3 times with ≥2 unique label types.

**Label languages:** English, French, Spanish, Turkish, Italian, Portuguese, German, Malay

**Test result (nigeriagalleria.com):** 30/30 entries extracted, 3/3 emails correct, 0 false positives.

**Files:**
- `backend/services/urlMiners/labelValueMiner.js` — miner code
- `backend/services/superMiner/services/flowOrchestrator.js` — loadMiners + inputType mapping
- `backend/services/superMiner/services/pageAnalyzer.js` — LABEL_VALUE page type + detection
- `backend/services/superMiner/services/smartRouter.js` — priority 2, fallback chain
- `backend/services/superMiner/services/executionPlanBuilder.js` — label_value plan

## SuperMiner Finalization Hang Fix (2026-04-07)

**Bug:** After Flow 2 completed, job stayed `running` forever. Third occurrence of the same pattern.

**Root cause:** `resultAggregator.aggregateV1()` published `AGGREGATION_DONE` event with `deepCrawlAttempted: false` (hardcoded). The `orchestratorListener` received this event asynchronously and triggered Flow 2 **again** — after `executeJob()` had already run Flow 2 synchronously and cleared Redis. The second Flow 2 failed silently (`FLOW1_NOT_FOUND` from empty Redis), leaving the job permanently running.

**Race condition chain:**
1. `executeJob()` → Flow 1 → `aggregateV1()` publishes event (`deepCrawlAttempted: false`)
2. `executeJob()` → Flow 2 synchronously → writes DB → clears Redis
3. `orchestratorListener` receives event → `deepCrawlAttempted: false` → triggers Flow 2 again
4. Second Flow 2 → Redis empty → `FLOW1_NOT_FOUND` → silent return → no status update

**Fix:** Three-layer protection:
1. **Root cause:** `deepCrawlAttempted: true` in aggregateV1 event — listener skips Flow 2
2. **Safety net:** 2-hour `Promise.race` timeout in worker.js — if SuperMiner hangs, outer catch sets `status='failed'`
3. **Last resort:** `checkStaleJobs()` periodic 3-hour cleanup

**Files:**
- `backend/services/superMiner/services/resultAggregator.js` line 153 — `deepCrawlAttempted: true`
- `backend/worker.js` lines 407-412 — Promise.race timeout

## Organizer Email Pollution Detection (2026-04-07)

`looksLikeOrganizerPollution()` function in worker.js detects when mining results contain only organizer/footer emails instead of real exhibitor data.

**How it works:**
1. Only runs when result count is 1-2 (triggered by `contactCount <= 2` condition)
2. Queries distinct emails from `mining_results` for the job
3. Compares email domains with source URL domain
4. If ALL emails are from foreign domains → pollution detected → `triggerManualAssist()`

**Example:** Mining `expo-site.com` returns 1 result with `info@expo-organizer.com` → foreign domain → pollution → needs_manual status + email notification.

**Files:** `backend/worker.js` — `looksLikeOrganizerPollution()` function

## Campaign Reply UX Improvements (2026-04-07)

1. **VERP display name:** Reply-to changed from plain string to object with sender display name
   - Before: `"c-xxx-r-xxx@reply.liffy.app"`
   - After: `{ email: "c-xxx-r-xxx@reply.liffy.app", name: "Elif AY" }`
   - Both `campaignSend.js` and `worker.js` updated

2. **Forward FROM format:** Changed from "Name via Liffy" to "Reply: Name"
   - `webhooks.js` inbound forward: `displayName = "Reply: ${senderName}"`

## /api/stats 401 Fix (2026-04-07)

**Bug:** Sidebar stats polling returned 401 even for logged-in users.

**Root cause:** Next.js `rewrite` in `next.config.ts` doesn't forward `Authorization` headers. Other endpoints worked because they all had explicit `app/api/.../route.ts` proxy files.

**Fix:** Created `liffy-ui/app/api/stats/route.ts` — local API route proxy that forwards auth headers to backend. Also added `stopped` flag in sidebar.tsx to stop polling on 401.

## contactPageMiner DNS Fail Early Exit (2026-04-08)

**Problem:** When a domain was dead (DNS failure), contactPageMiner still tried all 15+ contact paths (/contact, /about, /iletisim, etc.), each timing out individually. Wasted ~150s per dead domain.

**Fix:** Added `domainDead` flag. On first DNS-level error (ERR_NAME_NOT_RESOLVED, ERR_CONNECTION_REFUSED, ERR_ADDRESS_UNREACHABLE), flag is set and all remaining paths are skipped immediately.

**Detection errors that trigger early exit:**
- `ERR_NAME_NOT_RESOLVED` — domain doesn't exist
- `ERR_CONNECTION_REFUSED` — server refuses connection
- `ERR_ADDRESS_UNREACHABLE` — IP unreachable

**Files:** `backend/services/urlMiners/contactPageMiner.js`

## Email Send Optimization — 120K Campaign Scalability (2026-04-08)

**Problem:** Email sending was sequential (for loop), batch size 5, no rate limit retry. 120K emails would take ~20 hours and any 429 response would lose that email.

**3 fixes in worker.js:**

1. **Batch size:** `EMAIL_BATCH_SIZE` 5 → 50 (env configurable via `process.env.EMAIL_BATCH_SIZE`)
2. **429 retry:** `sendWithRetry()` wrapper with exponential backoff (2s → 4s → 8s, max 3 retries). Only retries on HTTP 429, all other errors fail immediately.
3. **Parallel sends:** Sequential `for` loop → `Promise.all` with concurrency 10. Batch of 50 = 5 chunks × 10 concurrent. 500ms pause between chunks.

**Constants (all env-configurable):**
| Constant | Default | Env Var |
|----------|---------|---------|
| `EMAIL_BATCH_SIZE` | 50 | `EMAIL_BATCH_SIZE` |
| `EMAIL_CONCURRENCY` | 10 | `EMAIL_CONCURRENCY` |
| `EMAIL_CHUNK_PAUSE_MS` | 500 | — |
| `EMAIL_RETRY_MAX` | 3 | — |
| `EMAIL_RETRY_BASE_MS` | 2000 | — |

**Expected throughput:** ~1.7 email/s → ~50 email/s. 120K campaign: ~20 hours → ~40 minutes.

**Files:** `backend/worker.js` — `sendWithRetry()`, `processSendingCampaigns()`

---

## JWT Authentication System

**Status:** LIVE.

**Flow:**
```
POST /api/auth/login (email, password) → bcrypt verify → JWT sign (7 day expiry)
  → { token, user: { id, email, role, organizer_id }, organizer: { id, name } }
```

**Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/auth/login` | POST | Email + password login, returns JWT + user info |
| `/api/auth/me` | GET | Returns current user from JWT |

**Middleware:**
- `backend/middleware/auth.js` — shared `authRequired` middleware. Sets both `req.user` and `req.auth` (dual shape for compatibility with legacy routes).
- JWT payload: `{ user_id, email, role, organizer_id }`
- Token stored in `localStorage.liffy_token` (frontend)

**Files:**
- `backend/middleware/auth.js` — shared auth middleware
- `backend/routes/auth.js` — login/me endpoints
- `backend/scripts/seed_admin.js` — idempotent admin user seeder

---

## Contact CRM (Notes, Activities, Tasks)

**Status:** LIVE.

Per-person CRM features: notes, auto-logged activity timeline, and follow-up tasks.

**Endpoints** (all under `/api/persons/:id/`):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/persons/:id/notes` | GET | List notes (newest first) |
| `/api/persons/:id/notes` | POST | Create note (auto-logs activity) |
| `/api/persons/:id/notes/:noteId` | DELETE | Delete own note |
| `/api/persons/:id/activities` | GET | Activity timeline (newest first) |
| `/api/persons/:id/tasks` | GET | List tasks |
| `/api/persons/:id/tasks` | POST | Create task (auto-logs activity) |
| `/api/persons/:id/tasks/:taskId` | PATCH | Update task (status, title, etc.) |
| `/api/persons/:id/tasks/:taskId` | DELETE | Delete own task |
| `/api/tasks/mine` | GET | All tasks assigned to current user (filterable) |
| `/api/tasks/summary` | GET | Pending/overdue/completed counts for sidebar badge |

**Activity auto-logging triggers:**
- Note created → activity_type='note'
- Task created → activity_type='task'
- Task completed → activity_type='task' (description: "Completed: ...")
- Pipeline stage changed → activity_type='status_change' (meta: from/to stage)
- Reply received (webhook) → activity_type='email' (auto via webhooks.js)
- Zoho push → activity_type='zoho_push' (auto via zohoService.js)

**User isolation:**
- Notes: non-privileged users see only their own notes
- Activities: non-privileged users see own + system-generated (user_id IS NULL)
- Tasks: non-privileged users see tasks assigned to them or created by them

**Files:**
- `backend/routes/contactCrm.js` — all CRM endpoints
- `backend/migrations/030_contact_crm.sql` — tables

---

## Sales Pipeline

**Status:** LIVE. 7 default stages seeded by `seed_admin.js`.

Configurable Kanban pipeline with per-person stage tracking and auto-assignment.

**Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/pipeline/stages` | GET | List organizer's stages (sorted) |
| `/api/pipeline/stages` | POST | Create stage (owner/admin only) |
| `/api/pipeline/stages/:id` | PATCH | Update stage |
| `/api/pipeline/stages/:id` | DELETE | Delete stage (persons auto-cleared via ON DELETE SET NULL) |
| `/api/pipeline/board` | GET | Full Kanban board — stages with people (latest affiliation, last activity) |
| `/api/persons/:id/stage` | PATCH | Move person to a stage (auto-assign, ownership check) |

**Default stages** (seeded): New Lead → Contacted → Interested → Meeting Scheduled → Proposal Sent → Won → Lost

**Auto-stage on reply:** When a reply webhook is received, if the person has no pipeline stage or is in an early stage (sort_order < "Interested"), they are auto-moved to "Interested" stage.

**Pipeline ownership:**
- `pipeline_assigned_user_id` on persons — set on first stage change
- Non-privileged users cannot move contacts assigned to another user (403)
- Owner/admin can move anyone; only fills NULL assignees (doesn't override existing)

**Files:**
- `backend/routes/pipeline.js` — stages CRUD + board + stage assignment
- `backend/migrations/031_pipeline_stages.sql` — pipeline_stages table + persons columns
- `liffy-ui/app/pipeline/page.tsx` — Kanban board UI

---

## User Management (Owner/Admin Panel)

**Status:** LIVE.

Owner/admin-only endpoints for managing team members.

**Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/users` | GET | List users in organizer (sorted by role) |
| `/api/users` | POST | Create user (email, password, role, names, daily limit) |
| `/api/users/:id` | PATCH | Update user (role, names, limit, is_active) |
| `/api/users/:id/reset-password` | POST | Set new password for user |
| `/api/users/:id/stats` | GET | Per-user activity stats (campaigns, mining, tasks, email usage) |

**Access control:**
- All endpoints require owner or admin role (403 otherwise)
- Only owner can create/modify another owner
- Cannot demote the last active owner (400)
- Only owner can reset an owner's password

**Files:**
- `backend/routes/userManagement.js` — all user management endpoints
- `liffy-ui/app/admin/page.tsx` — admin panel UI

---

## User Data Isolation

**Status:** LIVE (migration 032).

Role-based data visibility: owner/admin see everything within their organizer; regular users only see rows they created or are assigned to.

**Middleware:** `backend/middleware/userScope.js`

| Function | Description |
|----------|-------------|
| `getUserContext(req)` | Returns `{ userId, organizerId, role }` from `req.user` or `req.auth` |
| `isPrivileged(req)` | Returns true if owner or admin |
| `userScopeFilter(req, paramIdx, column)` | Returns SQL clause + params for user filtering |
| `canAccessRow(req, ownerUserId)` | Check if user can access a specific row |

**Isolation rules by resource:**

| Resource | Isolation | Column |
|----------|-----------|--------|
| Campaigns | User-scoped | `created_by_user_id` |
| Mining Jobs | User-scoped | `created_by_user_id` |
| Contact Notes | User-scoped | `user_id` |
| Contact Tasks | User-scoped | `assigned_to` OR `created_by` |
| Contact Activities | User-scoped + system visible | `user_id` (NULL = visible to all) |
| Pipeline | SHARED view, ownership on stage change | `pipeline_assigned_user_id` |
| Contacts/Lists/Templates | SHARED | — |
| Prospects/Intents | Campaign ownership JOIN | `campaigns.created_by_user_id` |
| Reports | Campaign ownership scoped | Pre-loaded `campaignIds` array |

---

## Daily Email Limit

**Status:** LIVE.

Per-user daily email send cap enforced on campaign start.

**How it works:**
- `users.daily_email_limit` column (default 500, owner: 100000)
- Checked at `POST /api/campaigns/:id/start`
- Counts today's sent emails via `campaign_events` (event_type='sent', occurred_at >= CURRENT_DATE)
- Returns 429 if limit reached or campaign would exceed limit

**429 response format:**
```json
{
  "error": "Daily email limit reached",
  "limit": 500,
  "sent_today": 500,
  "remaining": 0
}
```

Or if campaign would exceed:
```json
{
  "error": "Campaign would exceed your daily email limit",
  "limit": 500,
  "sent_today": 300,
  "remaining": 200,
  "attempted": 350
}
```

---

## Multi-Touch Campaign Sequences

**Status:** LIVE.

Campaign sequences allow sending a series of emails over time with configurable delays and conditions.

**Architecture:**
```
Campaign (campaign_type='sequence')
  → campaign_sequences (step definitions: template, delay, condition)
  → initializeSequence() populates sequence_recipients from resolved campaign_recipients
  → sequenceWorker polls every 60s for due recipients
  → processSequenceStep() sends email, advances step or completes
```

**Sequence step conditions:**
- `no_reply` — send only if recipient hasn't replied (default)
- `no_open` — send only if recipient hasn't opened
- `always` — send regardless

**Lifecycle:** active → paused (manual) → resumed → completed/replied/bounced/unsubscribed

**Daily limit enforcement:** Sequence worker checks per-user daily_email_limit before each send.

**API endpoints:**
- `GET /api/campaigns/:id/sequences` — list steps
- `POST /api/campaigns/:id/sequences` — add step
- `PATCH /api/campaigns/:id/sequences/:stepId` — update step
- `DELETE /api/campaigns/:id/sequences/:stepId` — remove step
- `POST /api/campaigns/:id/sequences/reorder` — reorder steps
- `POST /api/campaigns/:id/start` — start sequence (initializes recipients)
- `POST /api/campaigns/:id/pause` — pause sequence
- `POST /api/campaigns/:id/resume` — resume sequence
- `GET /api/campaigns/:id/sequence-analytics` — per-step analytics

**Files:**
- `backend/services/sequenceService.js` — core logic (init, step processing, reply/bounce/unsub handling)
- `backend/services/sequenceWorker.js` — 60s polling, batch 50, daily limit, auto-completion
- `backend/routes/sequences.js` — CRUD + control endpoints
- `backend/migrations/035_create_sequences.sql` — campaign_sequences + sequence_recipients tables
- `backend/migrations/036_allow_null_template_id.sql` — template_id nullable for sequence campaigns

---

## Action Engine (Blueprint Section 6)

**Status:** LIVE.

The Action Engine evaluates trigger rules and creates prioritized follow-up items for users.

**Two modes:**
1. **Near-real-time:** `evaluateForPerson()` called from webhooks and sequence completion hooks
2. **Periodic:** `reconcile()` called every 15 minutes by actionWorker

**6 Trigger Rules:**

| # | Trigger | Priority | Condition | Status |
|---|---------|----------|-----------|--------|
| T1 | `reply_received` | P1 | Person replied to any campaign email | LIVE |
| T2 | `sequence_exhausted` | P3 | Sequence completed, no reply received | LIVE |
| T3 | `quote_no_response` | P2 | Quote sent, no response (requires quotes table) | STUB |
| T4 | `rebooking_due` | P2 | Rebooking date approaching (requires ELIZA DB) | STUB |
| T5 | `engaged_hot` | P3 | Click in 7 days, or 2+ opens on different days in 7 days | LIVE |
| T6 | `manual_flag` | P4 | User manually flagged a person | LIVE (via POST /api/actions) |

**Engagement scoring:** Computed from campaign_events in last 30 days.
- Open = +1 point
- Click = +3 points
- Reply = +10 points
- 7-day inactive = -2 penalty

**Deduplication:**
- **reply_received:** NO dedup. Every reply creates a new P1 action item. Uses `insertActionItem()` (plain INSERT). Salesperson marks done/dismiss; new reply → new item appears. Migration 041 excludes `reply_received` from the dedup index.
- **All other triggers:** Partial unique index `(organizer_id, person_id, trigger_reason) WHERE status IN ('open', 'in_progress') AND trigger_reason != 'reply_received'` prevents duplicates. Uses `upsertActionItem()` with ON CONFLICT.

**Reconciliation (every 15 min):**
1. Resurface snoozed items past snoozed_until
2. Evaluate all persons with campaign activity in last 7 days (**reply_received skipped** — real-time only)
3. Check completed sequences without action items
4. Bulk-update engagement scores on open items

**Webhook hooks (best-effort, never breaks webhook flow):**
- SendGrid events: reply → reply_received, open/click → engaged_hot
- Inbound reply: → reply_received (P1, no dedup)
- Sequence completion: → sequence_exhausted

**Files:**
- `backend/engines/action-engine/actionEngine.js` — trigger evaluation + reconciliation
- `backend/engines/action-engine/actionWorker.js` — 15-min polling worker
- `backend/migrations/037_create_action_items.sql` — action_items table

---

## Action Items API (Blueprint Section 8)

**Status:** LIVE.

CRUD endpoints for action items with user-scoped access.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/actions` | List open/in_progress items (user-scoped, person+affiliation JOIN) |
| GET | `/api/actions/summary` | Badge counts by priority + snoozed |
| PATCH | `/api/actions/:id` | Update status (done/dismissed/snoozed/in_progress) |
| POST | `/api/actions` | Create manual_flag item |
| GET | `/api/actions/history` | Resolved items (done/dismissed) |

**User isolation:** Regular users see only items assigned to them. Owner/admin see all items in org.

**GET /api/actions query params:**
- `status` — comma-separated (default: open,in_progress)
- `trigger_reason` — filter by trigger type
- `sort` — priority (default), recent, company, engagement
- `limit` — max 200
- `offset` — pagination offset

**PATCH status transitions:**
- `done` / `dismissed` → sets resolved_at, resolved_by, optional resolution_note
- `snoozed` → requires snoozed_until datetime
- `in_progress` → clears snoozed_until
- `open` → reset

**Files:**
- `backend/routes/actions.js` — all endpoints
- `backend/server.js` — mounted at `/api/actions`

---

## Visibility System (Migration 033)

**Status:** LIVE (migration pending application).

Sharing control on lists, email_templates, and sender_identities.

**Column:** `visibility VARCHAR(20) DEFAULT 'shared'`
**Values:** `private` (creator only), `team` (same role group), `shared` (all org users)

**Enforcement (lists.js):**
- Owner/admin: see all lists regardless of visibility
- Regular user: see shared lists + their own private/team lists
- `visibilityFilter()` helper builds parameterized WHERE clause

**Default:** All existing rows backfilled to 'shared' (no access changes).

**Files:**
- `backend/migrations/033_add_visibility_columns.sql`
- `backend/routes/lists.js` — visibilityFilter() applied to GET /, GET /:id, DELETE /:id

---

## Phase 4 — Legacy Removal Progress

**Status:** Preparation complete, execution pending.

**Completed:**
- Migration 034: Re-backfill person_id on campaign_recipients + list_members, NULL tracking partial indexes
- Backfill script: `backend/scripts/backfill_person_ids.js` (idempotent, --dry-run/--apply)
- Campaign resolve: CTE UNION with Path A (person_id canonical) + Path B (prospect email fallback)
- TODO [Phase 4] comments added to dual-write locations

**Remaining:**
- Remove dual-write to prospects table
- Archive/drop prospects table

---

## ADR-015 — Hierarchical Permissions (Migrations 038-040)

**Status:** LIVE. All migrations applied in production.

Team-based data isolation using recursive CTE on `users.reports_to` chain.

**4 roles:** owner → admin → manager → sales_rep
- **owner/admin:** see all data in org (`isPrivileged = true`)
- **manager:** sees own data + all reports (recursive downward)
- **sales_rep:** sees only own data

**Current team:** Suer (owner) → Elif (manager, reports_to: Suer) → Bengü (sales_rep, reports_to: Elif)

**Key functions** (`backend/middleware/userScope.js`):
| Function | Purpose |
|----------|---------|
| `getUserContext(req)` | Returns userId, organizerId, role, isPrivileged |
| `isPrivileged(req)` | Returns true for owner/admin |
| `getHierarchicalScope(req)` | Recursive CTE — returns downward team user IDs |
| `getVisibilityScope(req, table)` | Parameterized WHERE for campaigns, mining_jobs, persons |
| `getUpwardVisibilityScope(req)` | Upward chain for templates/senders (sees manager's shared items) |
| `canAccessRowHierarchical(req, userId)` | Boolean — can current user see this user's row? |

**11 routes updated:** campaigns, emailTemplates, senders, miningJobs, miningResults, campaignRecipients, campaignSend, persons, lists, reports, stats

**Visibility defaults:**
- Lists: `private` (creator sees, must share explicitly)
- Templates/Senders: `shared` (upward visibility — sees own + manager's chain)

**Data transfer:** Suer→Elif ownership transfer done for templates/senders/campaigns (pre-isolation resources)

**JWT Auth Fix:** `payload.user_id = payload.user_id || payload.id` normalization across 28 auth middleware instances. Fixed critical bug where Elif saw 0 data due to JWT `id` vs `user_id` mismatch.

**Migrations:**
- 038: `users.reports_to` (UUID FK→users)
- 039: `users.permissions` (JSONB)
- 040: `email_templates.visibility`, `email_templates.created_by_user_id`, `sender_identities.visibility`

---

## Zoho Import (54K Records)

**Status:** DONE. One-time bulk import completed 2026-04-15.

Imported ~54,000 records from Zoho CRM into canonical tables (persons + affiliations).
Industry normalization: 20 canonical sectors mapped from raw Zoho industry values.
Production DB: 75,399 persons, 85,603 affiliations.

---

## Company & Industry Filter

**Status:** LIVE.

Added company_name and industry filters to GET /api/persons endpoint.
- `company` query param: ILIKE search on affiliations.company_name
- `industry` query param: ILIKE search on affiliations.industry
- Filters applied via LATERAL JOIN on affiliations

---

## Reply Detection Architecture — v4 Plus Addressing (2026-04-20)

See "Reply Detection — Full Journey (v1→v4)" section above for the complete architecture, all 4 iterations, setup instructions, and file references. This section kept as a pointer to avoid duplication.

---

## JWT Auth Fix — id vs user_id Normalization (2026-04-16)

**Status:** LIVE. Critical production bug fix.

**Root cause:** JWT payload contained `id` field but all auth middleware read `user_id`.
This caused `getUserContext()` to return `userId: null`, breaking all data isolation queries.

**Fix:** Added `payload.user_id = payload.user_id || payload.id;` normalization to all 28 auth middleware instances across the codebase.

**3 patterns fixed:**
1. Pattern 1 (19 files): `const payload = jwt.verify(...)` → added normalization
2. Pattern 2 (6 files): `req.auth = jwt.verify(...)` → added `req.auth.user_id = req.auth.user_id || req.auth.id`
3. Pattern 3 (1 file): `const decoded = jwt.verify(...)` → added normalization

**Files:** All 28 route files + `backend/middleware/auth.js`

---

## Lists created_by_user_id Bug Fix (2026-04-17)

**Status:** LIVE.

**Root cause:** Elif created a list ("Prod Expo 2026") but `created_by_user_id` was NULL. ADR-015 visibility filter requires `created_by_user_id` to determine who can see a list — NULL makes it invisible to non-owner users.

**Fix:** All 4 list creation paths now set `created_by_user_id` and `visibility='shared'`:

| Path | File | Source of user_id |
|------|------|-------------------|
| CSV import | `backend/routes/lists.js` | `req.auth.user_id` |
| Import-all | `backend/routes/miningResults.js` | `req.auth.user_id` |
| Leads import | `backend/routes/leads.js` | `req.auth.user_id` |
| URL miner auto-create | `backend/services/urlMiner.js` | `job.created_by_user_id` (no req.auth in service layer) |

---

## Data Ownership Transfer (2026-04-16)

**Status:** DONE. One-time production operation.

Transferred ownership of templates, sender identities, and campaigns from Suer to Elif using direct SQL UPDATE statements. Required because Suer (owner) created all resources before user isolation was implemented — Elif couldn't see them under ADR-015 visibility rules.

---

## Blueprint Implementation Progress (2026-04-20)

**Blueprint Section 6 (Action Engine):** ✅ DONE — 6 triggers, priority scoring, 15-min reconciliation worker. Reply_received has no dedup (every reply = new P1 action item, migration 041).
**Blueprint Section 8 (Action Screen):** ✅ DONE — homepage with priority cards, filter/sort, snooze, history.
**Blueprint Principle 2 (Zero Context Switching):** Reply Detection v4 delivers natural email threads — customer replies go to salesperson's real inbox via plus-addressed Reply-To.
**Owner/Creator Info:** ✅ DONE — "By" column on all listing pages (campaigns, lists, templates, mining jobs). LEFT JOIN users on 4 GET endpoints.
**Campaign Delete Fix:** ✅ DONE — explicit delete of prospect_intents + action_items before campaign (ON DELETE SET NULL + uq_prospect_intent trap).
**engaged_hot rule tightened:** 93→2 action items after strict combination rules (2+ opens on different days, click + qualifying context).
**Pipeline sidebar removed:** Pipeline accessible via top nav only.

---

## Contacts Page Filters (2026-04-16)

**Status:** LIVE.

Enhanced contacts page with company and industry filtering:
- **Company autocomplete:** ILIKE search on `affiliations.company_name` via LATERAL JOIN
- **Industry dropdown:** ILIKE search on `affiliations.industry` (populated from Zoho import normalization)
- Both filters work alongside existing search, verification status, and exclude_invalid filters

---

## Owner/Creator Info on Listing Pages (2026-04-21)

**Status:** LIVE.

Added "By" column to all 4 listing pages and "by {name}" to campaign detail header.

**Backend changes (4 endpoints):**

| Endpoint | File | Change |
|----------|------|--------|
| `GET /api/campaigns` | `campaigns.js` | LEFT JOIN users, `creator_name` in response |
| `GET /api/campaigns/:id` | `campaigns.js` | LEFT JOIN users, `creator_name` in response |
| `GET /api/lists` | `lists.js` | LEFT JOIN users (alias `l`), `creator_name` + `creator_email` |
| `GET /api/email-templates` | `emailTemplates.js` | LEFT JOIN users (alias `e`), `creator_name` in response |
| `GET /api/mining/jobs` | `miningJobs.js` | LEFT JOIN users (alias `j`), all WHERE clauses prefixed, `creator_name` |

**Frontend changes (5 pages):**

| Page | Change |
|------|--------|
| `/campaigns` | "By" column between Scheduled and Created |
| `/campaigns/[id]` | "by {name}" next to status in header |
| `/lists` | "By" column between Unverified and Created |
| `/templates` | "By" column between Visibility and Created |
| `/mining/jobs` | "By" column between Emails and Created |

**Design:** `text-xs text-gray-500`, NULL shows "—".

**creator_name computation:** `[first_name, last_name].filter(Boolean).join(' ') || null`

---

## Campaign Delete Bug Fix (2026-04-21)

**Status:** LIVE.

**Error:** `"duplicate key value violates unique constraint uq_prospect_intent"` when deleting a campaign.

**Root cause chain:**
1. `prospect_intents.campaign_id` has `ON DELETE SET NULL` (migration 017)
2. When campaign is deleted, PostgreSQL sets `campaign_id` to NULL
3. Unique index `uq_prospect_intent` uses `COALESCE(campaign_id::text, '')` (migration 021)
4. If same person already has another intent with NULL campaign_id and same intent_type → unique violation

**Fix:** Explicitly delete child rows BEFORE the campaign:
```
1. DELETE FROM prospect_intents WHERE campaign_id = $1
2. DELETE FROM action_items WHERE campaign_id = $1
3. DELETE FROM campaign_recipients WHERE campaign_id = $1
4. DELETE FROM campaigns WHERE id = $1
```

`campaign_events` and `campaign_sequences`/`sequence_recipients` have `ON DELETE CASCADE`, so PostgreSQL handles them automatically.

**FK reference summary for campaigns:**

| Table | FK | ON DELETE |
|-------|-----|-----------|
| `campaign_events` | `campaign_id NOT NULL` | CASCADE |
| `campaign_sequences` | `campaign_id NOT NULL` | CASCADE |
| `sequence_recipients` | `campaign_id NOT NULL` | CASCADE |
| `campaign_recipients` | `campaign_id NOT NULL` | CASCADE |
| `prospect_intents` | `campaign_id` (nullable) | SET NULL |
| `action_items` | `campaign_id` (nullable) | SET NULL |

**Lesson:** Nullable FKs with `ON DELETE SET NULL` + unique constraints using `COALESCE(nullable, '')` create a trap. Always check unique indexes when using SET NULL.

---

## Lead Mining Page — Source Discovery + Mining Jobs Merge (2026-04-20)

**Status:** LIVE.

Combined two separate pages (Source Discovery and Mining Jobs) into a single `/mining` page with two tabs.

**Frontend changes:**
- Created `/mining/page.tsx` — unified page with `tab` query param (`discover` / `jobs`)
- Tab 1 "Discover": URL input + mining mode selector + launch job (previously `/mining/discover`)
- Tab 2 "Jobs": mining jobs table with status, results, strategy, etc. (previously `/mining/jobs`)
- `useSearchParams()` required `<Suspense>` wrapper for Next.js 16 static prerendering
- Sidebar: removed separate Mining Jobs + Source Discovery items, added single "Lead Mining" (Pickaxe icon)

---

## Company Entity Page (2026-04-20)

**Status:** LIVE.

Aggregated company view from `affiliations` table — lets users see all unique companies and drill into their contacts.

**Backend:** `backend/routes/companies.js` (new file, mounted at `/api/companies` in server.js)

| Endpoint | Description |
|----------|-------------|
| `GET /api/companies` | Aggregated companies with contact_count, verified_count, industry, country, last_added. Filters: search, industry, country, min_contacts. Sort + pagination. |
| `GET /api/companies/:companyName/contacts` | All persons affiliated with a company. Returns person details + affiliation data. |

**Key SQL pattern:**
```sql
SELECT LOWER(TRIM(a.company_name)) as company_key,
  MAX(a.company_name) as company_name,
  COUNT(DISTINCT a.person_id) as contact_count,
  COUNT(DISTINCT CASE WHEN p.verification_status = 'valid' THEN a.person_id END) as verified_count
FROM affiliations a
JOIN persons p ON p.id = a.person_id AND p.organizer_id = a.organizer_id
WHERE a.organizer_id = $1
GROUP BY LOWER(TRIM(a.company_name))
```

**Column name lessons learned (5 errors fixed):**
- `affiliations.country` → `affiliations.country_code`
- `affiliations.source_url` → `affiliations.website`
- `persons.email_status` → `persons.verification_status`
- `persons.phone` → `affiliations.phone` (phone is on affiliations, not persons)

**Frontend:** `/companies/page.tsx` with stats cards, search, industry dropdown, country filter, company table, contact drawer.

---

## Reply Email Signature Parsing (2026-04-20)

**Status:** LIVE.

Automatically extracts phone number, job title, and company from email reply signatures and enriches the sender's affiliation record.

**File:** `backend/utils/signatureParser.js`

**3 extraction strategies (tried in order):**

1. **Structured signature block** — finds `--` or `___` separator, parses lines below for name/title/company/phone
2. **Inline phone regex** — scans entire body for phone patterns (`+XX XXX...`, `(XXX) XXX-XXXX`, etc.)
3. **vCard-style fields** — looks for `TEL:`, `TITLE:`, `ORG:` patterns

**Functions:**
- `parseEmailSignature(bodyText)` → `{ phone, title, company, raw_signature }`
- `enrichPersonFromSignature(organizerId, email, signatureData)` → updates `affiliations` (phone, position)

**Integration:** Called in `webhooks.js` after reply is recorded and Action Engine fires (step 6c). Best-effort — errors logged but never block reply processing.

**Title regex fix:** Changed character class from `[\\w\\s/&-]` to `[\\w /&-]` (space instead of `\\s`) + `m` flag. Original `\\s` matched newlines, causing title to span across lines.

---

## Admin Bug Fixes — VALID_ROLES & Daily Limit Scoping (2026-04-20)

**Status:** LIVE.

### Bug 1: Admin sidebar not showing for manager role

**Root cause:** Sidebar `adminOnly` filter checked `role === 'owner' || role === 'admin'` — managers excluded.
**Fix:** Added `|| role === 'manager'` to sidebar filter + admin page auth guard.

### Bug 2: Permissions UI save not working (VALID_ROLES mismatch)

**Root cause:** `userManagement.js` had `VALID_ROLES = ['owner', 'admin', 'manager', 'user']` but the actual system role is `sales_rep`, not `user`. When an admin edited ANY field of a sales_rep user (e.g., daily_email_limit), the PATCH request included the user's current role (`sales_rep`), which failed validation against the incorrect VALID_ROLES array. The entire PATCH was rejected — the daily_email_limit change was silently lost.

**Fix:** Changed to `VALID_ROLES = ['owner', 'admin', 'manager', 'sales_rep']`. Also cleaned up frontend role dropdowns (removed `staff`/`user` options).

### Bug 3: Sequence Worker daily limit counting ALL organizer events

**Root cause:** `sequenceWorker.js` `getRemainingDailyLimit()` counted all sent events for the entire organizer, not per-user. If Elif sent 100 emails, Bengü's limit was also reduced by 100.

**Fix:** Added `JOIN campaigns c ON c.id = ce.campaign_id ... AND c.created_by_user_id = $1` to scope the count per campaign owner.

---

## Data Cleanup Migration 042 (2026-04-20)

**Status:** Applied in production.

**File:** `backend/migrations/042_cleanup_company_industry.sql`

**Two operations:**

1. **Email domain company names → NULL** (~887 rows)
   - Pattern: `company_name LIKE '%@%'` — matches email addresses stored as company names
   - These came from early mining runs where email addresses were incorrectly parsed as company names

2. **Industry typo normalization**
   - Turkish → English standardization: Otomotiv→Automotive, Lojistik→Logistics, Gıda→Food & Beverage, İnşaat→Construction, Tekstil→Textile, Mobilya→Furniture, Enerji→Energy, Kimya→Chemicals, Makine→Machinery, Madencilik→Mining

---

## Sender Identity Edit/Delete (2026-04-20)

**Status:** LIVE.

### Backend (`routes/senders.js`)

**PUT /api/senders/:id** — Update sender identity:
- Editable fields: `from_name`, `reply_to`, `visibility`, `label`
- `from_email` is NOT editable (requires SendGrid re-verification)
- Ownership check via `canAccessRowHierarchical()`

**GET /api/senders** — now includes `campaign_count` per sender:
```sql
SELECT sender_id, COUNT(*)::int AS campaign_count
FROM campaigns WHERE organizer_id = $1 AND sender_id IS NOT NULL
GROUP BY sender_id
```

**DELETE /api/senders/:id** — unchanged (soft delete: `is_active = false`).

### Frontend (`settings/page.tsx`)

- Sender table: added "Campaigns" count column + "Actions" column with Edit/Delete buttons
- **Edit modal:** from_name input, reply_to input (optional), visibility radio (Public/Private). from_email shown as disabled input with explanation text.
- **Delete modal:** confirm dialog showing sender name + email. Orange warning banner if `campaign_count > 0`: "This sender has been used in X campaigns."

### Senders 500 Bug

**Error:** GET /api/senders returning 500 after campaign_count feature was added.
**Root cause:** Query used `sender_identity_id` but the actual column on `campaigns` table is `sender_id`.
**Fix:** Changed to `sender_id` in 3 places (SELECT, WHERE, GROUP BY).
**Pattern:** Same column-name assumption bug as Companies 500 (5th occurrence). Added mandatory schema verification rule to CLAUDE.md.

---

## Reply Timeline Expand/Collapse (2026-04-20)

**Status:** LIVE.

Enhanced reply event rendering in ContactDrawer timeline.

**Changes (`components/ContactDrawer.tsx`):**

1. **Reply header** — Shows `From: email@example.com` and subject line above body text (10px muted gray, truncated)
2. **Expand/collapse** — Default 200-char preview, "Show full reply" toggle for longer texts (up to 2000 chars from DB)
3. **Independent state** — `expandedReplies: Set<number>` tracks expanded replies by timeline index
4. **Reset on refresh** — `setExpandedReplies(new Set())` called in both `fetchAll` and `addNote` to prevent stale index references
5. **Fallback preserved** — "Reply detected — check email for details" when `meta.text` is missing

---

## Login Sidebar Fix (2026-04-20)

**Status:** LIVE.

**Problem:** After login, sidebar didn't show Admin menu item. Users had to refresh page.

**Root cause chain:**
1. Backend `/api/auth/login` returns flat response: `{ success, organizer_id, user_id, role, token }` — no `user` property
2. Login page stored only `liffy_token`, never constructed `liffy_user`
3. Sidebar reads `liffy_user` from localStorage on mount (React effects fire children-first)
4. Without `liffy_user`, sidebar role check fails → Admin hidden

**Fix (`liffy-ui/app/login/page.tsx`):**
```javascript
const userInfo = {
  email: data.user?.email || data.email || email,
  role: data.user?.role || data.role || '',
  user_id: data.user?.user_id || data.user_id || '',
  organizer_id: data.user?.organizer_id || data.organizer_id || '',
};
localStorage.setItem("liffy_user", JSON.stringify(userInfo));
```

---

## Duplicate Send Fix — CAS Pattern (2026-04-20)

**Status:** LIVE.

**Problem:** Siema Mail campaign: 1747 recipients but 2053 sent emails. Two distinct bursts 18 minutes apart (09:11-09:18: 1001, 09:36-09:43: 1052).

**Root cause:** Render redeploy: old and new instances briefly overlap. `FOR UPDATE SKIP LOCKED` in autocommit mode releases locks immediately after SELECT returns. Both instances claim the same recipients.

**Fix: CAS (Compare-And-Swap) claim pattern** in 3 files:

1. **`worker.js`** — background campaign send:
```javascript
const claim = await client.query(
  `UPDATE campaign_recipients SET status = 'sending'
   WHERE id = $1 AND status = 'pending' RETURNING id`, [r.id]
);
if (claim.rows.length === 0) return; // already claimed
```

2. **`campaignSend.js`** — API send-batch path: same pattern

3. **`sequenceService.js`** — sequence engine (different state machine):
```javascript
// active → sending (claim)
const claim = await db.query(
  `UPDATE sequence_recipients SET status = 'sending', updated_at = NOW()
   WHERE id = $1 AND status = 'active' RETURNING id`, [id]
);
// After send: sending → active (next step) or completed
// On failure: sending → active (retry)
```

**Key insight:** Sequence engine runs inside `server.js` (API process), NOT in `worker.js` — separate processes with separate redeploy overlap risks.

---

## Daily Email Usage Visibility (2026-04-20)

**Status:** LIVE.

**Backend:** `GET /api/campaigns/email-usage` (authRequired)
- Returns `{ daily_limit, sent_today, remaining }`
- Counts today's `sent` events from `campaign_events` for current user's campaigns

**Frontend (Dashboard):**
- Progress bar card showing daily email usage
- Colors: green <80%, yellow 80-100%, red = limit reached
- Fetched in parallel with actions summary and dashboard stats

---

## Contact Campaign History (2026-04-20)

**Status:** LIVE.

**Backend:** `GET /api/persons/:id/campaigns` (authRequired)
- Returns campaigns a person was involved in with per-campaign event stats
- Groups `campaign_events` by campaign, counts each event type (sent/delivered/opens/clicks/replies/bounces)

**Frontend (`liffy-ui/app/leads/[id]/page.tsx`):**
- Campaign History table in Overview tab below Engagement section
- Columns: Campaign name (clickable → /campaigns/[id]), status badge, ✅/— for each event type (sent, delivered, opened, clicked, replied, bounced)

---

## inlineContactMiner (2026-04-20)

**Status:** ACTIVE.

Cheerio-based inline contact extraction for pages where all contact info (emails, phones, company names) appears inline on a single page — no exhibitor links to follow. WordPress tables, association directories, simple HTML pages.

**Architecture:**
- Input: raw HTML string (NOT Playwright page object)
- Output: Array of raw contact cards
- Dependencies: cheerio only (no Playwright, no browser)

**HTML source strategy:**
1. HtmlCache (Redis) — reuse already-fetched HTML from prior miners
2. HTTP fetch fallback — simple `fetch()` with User-Agent header
3. No Playwright navigation — avoids duplicate requests that trigger blocking

**Extraction pipeline:**
1. Find all emails (mailto: links + text regex)
2. For each email, walk up DOM to find container (tr, li, dl, article, section, div>30chars)
3. Extract context from container:
   - `parseLabeledFields()` — "Label: Value" patterns with multi-language keywords
   - `parseTableRowContext()` — table header → column mapping
   - `findBoldText()` — bold/strong/heading text as company name
   - `findTitlePrefixName()` — Mr./Mrs./Dr./Bay/Bayan prefixes as contact name
   - `findPhone()` — international phone regex (7-15 digits)
   - `findWebsite()` — URL regex + href extraction
   - `domainToCompany()` — email domain fallback (skip generic domains)
4. Merge duplicate emails (keep richest data, prefer longer values)

**Multi-language labels (LABELS constant):**
- EN, TR, FR, DE, ES keywords for: company, contact_name, phone, website, address, country, city

**Execution plan integration:**
- Added as fallback step in ALL execution plans: directory, member_table, label_value, website, table, unknown
- Runs AFTER primary miner, catches emails missed by link-following strategies

**HtmlCache isPoisoned() fix:**
- Block indicators (cloudflare, rate limit, forbidden, etc.) only flag short pages (<10KB) or structural signals (title/h1)
- Large content pages (>10KB) that mention "rate limit" in body text are NOT poisoned

**Files:**
- `backend/services/urlMiners/inlineContactMiner.js` — miner (~476 lines)
- `backend/services/superMiner/services/flowOrchestrator.js` — wrapper (HtmlCache + HTTP fallback)
- `backend/services/superMiner/services/executionPlanBuilder.js` — fallback step in all plans
- `backend/services/superMiner/services/htmlCache.js` — isPoisoned() fix

---

## Source Discovery v2 — Sprint 1 + Search History (2026-04-21)

**Status:** LIVE.

**RFC:** `docs/RFC_Source_Discovery_v2.md` — 4-sprint plan (Discovery Search → Source Analysis → Collections → ASE).

### Sprint 1: Source-Type-Aware Discovery

Source type is a first-class concept. User selects WHAT they're looking for before searching.

**9 source types (5 main + 4 expandable):**

| Main | Expandable |
|------|-----------|
| Trade Fair | Chamber of Commerce |
| Association | Trade Portal |
| Directory | Gov Database |
| Catalog / Listing | Custom Search |
| Paste URL | |

**Filters:** Country dropdown (80+ countries, 10 popular at top with separator), Industry dropdown (24 sectors), Keywords (optional).

**Backend — `backend/services/sourceDiscovery.js` (v2.1):**
- Claude API `web_search_20250305` tool with Haiku model
- Source-type → compact search focus mapping (`SOURCE_TYPE_FOCUS`)
- Optimized prompts: system ~80 words, user ~60 words (was 300+ combined)
- `max_tokens`: 8K (was 16K), requested results: 10-15 (was 15-20)
- Response parsing: uses LAST text block (contains JSON), fallback to all concatenated
- Web search error detection (`web_search_tool_result_error` blocks)
- Domain dedup: max 3 results per domain (`deduplicateByDomain()`)
- Rate limit 429 handling: returns `{ error: 'rate_limit', retry_after: N }`

**Backend — `backend/routes/sourceDiscovery.js`:**
- `POST /api/source-discovery` — extended with `source_type`, `keyword` (optional), saves to `discovery_searches`
- Validation: at least one filter required (keyword, industry, or country)
- Returns `search_id` in response

**Backend — `backend/routes/miningJobs.js`:**
- `POST /api/mining/batch-create` — batch create mining jobs (max 50 URLs)

**Frontend — `/mining/page.tsx` DiscoverTab:**
- 5 main source type cards + "More options" expandable (4 extra)
- Cards collapse to inline badge after selection ("Change" link to reset)
- Inline filter row (keyword, industry, country)
- Country chips with remove
- Rate limit countdown banner + disabled button ("Wait Xs")
- Result rows: checkbox + type badge + URL + notes + estimated contacts + Mine button
- Batch mine: "Mine Selected (N)" sticky bottom bar
- "This search has been saved. View in Search History →" link

### Sprint 1.5: Search History

**Migration 043:** `discovery_searches` table:
```sql
CREATE TABLE discovery_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES organizers(id),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source_type VARCHAR(30) NOT NULL,
  keyword TEXT,
  industry VARCHAR(100),
  countries TEXT[],
  results JSONB NOT NULL DEFAULT '[]',
  result_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Backend endpoints:**
- `GET /api/source-discovery/history` — last 50 searches, each result URL enriched with mining status from `mining_jobs` (batch `DISTINCT ON (input)` query)
- `GET /api/source-discovery/history/:id` — single search detail with mining status

**Mining status enrichment per URL:**
- `mining_status`: completed / running / failed / null (never mined)
- `mining_found`: total contacts found
- `mining_job_id`: link to the job

**Frontend — SearchHistoryTab:**
- 3-tab layout: [Discover] [Search History] [Jobs]
- Compact search cards with: source type badge, filter description (`keyword | industry | countries`), result count, unmined count, timestamp
- Expand/collapse to see all results
- Mining status badges:
  - Green: "Mined — N found" (completed)
  - Yellow: "Mining..." (running)
  - Red: "Failed" (failed)
  - Orange "Mine" button (unmined)
- Checkbox multi-select + batch mine for unmined results
- Empty state: "No searches yet. Start discovering sources in the Discover tab."

### Parked: Google Custom Search API

Google Cloud project "Liffy" created (elan-expo.com org), Custom Search API enabled, Programmable Search Engine created (cx: `0603113d7eb6642a6`). Got 403 "PERMISSION_DENIED" — Google Custom Search JSON API deprecated/migrated to Vertex AI. Parked — continuing with Claude API web search. SerpAPI/Serper.dev as future alternatives.

---
