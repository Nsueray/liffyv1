# MINER_GUIDE.md — How to Write a New Miner for Liffy

> See also: [CLAUDE.md](./CLAUDE.md), [CLAUDE_DB.md](./CLAUDE_DB.md), [CLAUDE_FEATURES.md](./CLAUDE_FEATURES.md), [CLAUDE_UI.md](./CLAUDE_UI.md), [LIFFY_TODO.md](./LIFFY_TODO.md), [MINING_REFACTOR_PLAN.md](./MINING_REFACTOR_PLAN.md)

---

## 1. Architecture Overview

```
URL
 │
 ▼
PageAnalyzer ─────► Detects page type (directory, document, table, dynamic, etc.)
 │
 ▼
SmartRouter ──────► Picks primary miner + fallback chain based on page type
 │
 ▼
Miner(s) ─────────► Extract raw data (contacts, emails, phones, etc.)
 │
 ▼
normalizeResult() ► Convert raw output to UnifiedContact format (field mapping)
 │
 ▼
Aggregator V1 ────► Merge + dedup contacts from multiple miners
 │
 ▼
Aggregator V2 ────► Validate, filter hallucinations, write to mining_results DB
 │
 ▼
Canonical Pipeline:
  normalizeMinerOutput() ► emailExtractor, nameParser, countryNormalizer
  aggregationTrigger ─────► persons + affiliations UPSERT
```

### flowOrchestrator.js — Role

`backend/services/superMiner/services/flowOrchestrator.js` is the central orchestrator:

- **`loadMiners()`** — lazy-loads all miner modules, wraps each with `normalizeResult()` and browser lifecycle
- **`executeJob(job)`** — full pipeline: route → mine → aggregate → DB write → canonical aggregation
- **`executeFlow1(job)`** — runs miners, aggregates to Redis (or direct DB if no Redis)
- **`executeFlow2(job, flow1Result)`** — deep crawl enrichment (optional)
- **Pagination** — `detectPagination()`, `mineAllPages()`, `mineSinglePage()` handle multi-page sites

### Where a Miner Fits

A miner is a **plugin** in the pipeline. It:
1. Receives a Playwright `page` object (or URL) + config
2. Extracts raw data from the page
3. Returns raw results (array of cards/contacts)
4. Gets wrapped by flowOrchestrator which handles browser lifecycle, normalization, and DB writes

---

## 2. Miner Contract

### What Miners DO:
- Accept input (Playwright page + URL + config)
- Extract raw data from web pages
- Return raw output (array of objects)

### What Miners DO NOT:
- Normalize data (no name parsing, no country inference)
- Write to database
- Call other miners
- Merge/deduplicate data
- Access organizer context
- Manage browser lifecycle (wrapper does this)

### Input:
```javascript
async function runNewMiner(page, url, config) {
  // page  — Playwright Page object (browser already launched by wrapper)
  // url   — Target URL string
  // config — Job config object { max_pages, delay_ms, detail_url_pattern, ... }
}
```

### Output:
```javascript
// Return raw array of card objects
return [
  {
    company_name: "Acme Corp",
    email: "info@acme.com",
    phone: "+1-555-0100",
    website: "https://acme.com",
    country: "USA",
    address: "123 Main St",
    contact_name: "John Doe",
    job_title: "CEO"
  },
  // ...more cards
];
```

### Browser Lifecycle:
The miner itself does NOT launch or close the browser. The flowOrchestrator wrapper handles:
```
chromium.launch() → browser.newPage() → runNewMiner(page, url, config) → browser.close()
```

---

## 3. How to Add a New Miner (Step by Step)

### Step 1: Create the Miner File

**Location:** `backend/services/urlMiners/newMiner.js`

**Skeleton:**
```javascript
/**
 * LIFFY New Miner v1.0
 *
 * Extracts data from [describe target site type].
 * Returns raw card data — normalization handled by flowOrchestrator.
 *
 * Usage (module only — browser lifecycle managed by flowOrchestrator wrapper):
 *   const { runNewMiner } = require("./newMiner");
 *   const cards = await runNewMiner(page, url, config);
 */

async function runNewMiner(page, url, config = {}) {
  const maxPages = config.max_pages || 10;
  const delayMs = config.delay_ms || 1000;

  console.log(`[newMiner] Starting: ${url}`);

  // Navigate to URL
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle").catch(() => {});

  // Extract data using page.evaluate()
  const rawCards = await page.evaluate(() => {
    const results = [];
    // ... DOM extraction logic ...
    return results;
  });

  console.log(`[newMiner] Extracted ${rawCards.length} cards`);

  // Return raw cards — normalization handled by flowOrchestrator
  return rawCards;
}

module.exports = { runNewMiner };
```

### Step 2: Register in flowOrchestrator.js

**File:** `backend/services/superMiner/services/flowOrchestrator.js`

Add inside `loadMiners()`, after the main miners block, in a separate try/catch:

```javascript
// newMiner: try/catch load (separate block so failure doesn't break other miners)
try {
    const { runNewMiner } = require('../../urlMiners/newMiner');
    const { chromium } = require('playwright');

    this.miners.newMiner = {
        name: 'newMiner',
        mine: async (job) => {
            console.log(`[newMiner] Starting for: ${job.input}`);
            let browser = null;
            try {
                browser = await chromium.launch({ headless: true });
                const page = await browser.newPage();
                const rawCards = await runNewMiner(page, job.input, job.config || {});
                await browser.close();
                browser = null;

                // Convert raw cards to normalizeResult format
                const contacts = rawCards.map(card => ({
                    company_name: card.company_name,
                    email: card.email || null,
                    phone: card.phone,
                    website: card.website,
                    country: card.country,
                    address: card.address,
                    contact_name: card.contact_name || null,
                    job_title: card.job_title || null
                }));
                const emails = rawCards
                    .map(c => c.email)
                    .filter(e => e && e.includes('@'));

                console.log(`[newMiner] Result: ${contacts.length} contacts, ${emails.length} emails`);

                return this.normalizeResult({ contacts, emails }, 'newMiner');
            } catch (err) {
                if (browser) await browser.close().catch(() => {});
                throw err;
            }
        }
    };
    console.log('[FlowOrchestrator] newMiner loaded');
} catch (err) {
    console.log('[FlowOrchestrator] newMiner not available:', err.message);
}
```

**Key points from the directoryMiner example:**
- Separate `try/catch` — failure to load doesn't crash other miners
- Browser lifecycle: `chromium.launch()` → `page` → mine → `browser.close()`
- Raw cards are converted to `{ contacts, emails }` format
- `this.normalizeResult()` converts to `UnifiedContact` objects
- After loading, you'll see in logs: `"Miners loaded: ... newMiner"`

### Step 3: Add Detection Rule to pageAnalyzer.js

**File:** `backend/services/superMiner/services/pageAnalyzer.js`

#### Option A: Hostname-based Detection (like directoryMiner)

Add your domains to a new constant or extend existing:
```javascript
const NEW_MINER_DOMAINS = ['targetsite.com', 'othertarget.org'];
```

Add to the overridden `analyzeHtml` method (after directory check):
```javascript
// In the overridden analyzeHtml method, add:
try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (NEW_MINER_DOMAINS.some(d => hostname.includes(d))) {
        result.pageType = PAGE_TYPES.NEW_TYPE;
        result.isNewType = true;
        console.log(`[PageAnalyzer] New type detected via hostname: ${hostname}`);
        return result;
    }
} catch (e) {}
```

Add the new page type:
```javascript
const PAGE_TYPES = {
    // ... existing types ...
    NEW_TYPE: 'new_type',  // Add your new type
};
```

#### Option B: DOM Pattern Detection (future)

For content-based detection, add heuristics in `analyzeHtml`:
```javascript
// Check for specific DOM patterns
const hasSpecificPattern = $('selector-for-your-site-type').length > 5;
if (hasSpecificPattern) {
    result.pageType = PAGE_TYPES.NEW_TYPE;
}
```

#### Override `getRecommendation()`:
```javascript
const originalGetRecommendation = PageAnalyzer.prototype.getRecommendation;
PageAnalyzer.prototype.getRecommendation = function(analysis) {
    if (analysis.pageType === PAGE_TYPES.NEW_TYPE) {
        return {
            miner: 'newMiner',
            useCache: false,
            reason: 'New type detected, using newMiner',
            ownPagination: true  // if miner handles its own pagination
        };
    }
    return originalGetRecommendation.call(this, analysis);
};
```

### Step 4: Add Priority to smartRouter.js

**File:** `backend/services/superMiner/services/smartRouter.js`

Add to `minerPriority`:
```javascript
minerPriority: {
    httpBasicMiner: 1,
    directoryMiner: 2,
    newMiner: 3,           // Add priority (lower = tried first when cost-optimizing)
    playwrightTableMiner: 4,
    playwrightMiner: 5,
    aiMiner: 6,
    // ...
},
```

Add to `fallbackChains`:
```javascript
fallbackChains: {
    // ...existing chains...
    newMiner: ['playwrightTableMiner', 'aiMiner'],  // Fallbacks if newMiner fails
},
```

### Step 5: Add Branch to executionPlanBuilder.js

**File:** `backend/services/superMiner/services/executionPlanBuilder.js`

Add a new `inputType` branch:
```javascript
if (resolvedInputType === 'new_type') {
    addStep('newMiner', 'legacy', 'New type extraction');
    if (resolvedMiningMode === 'ai') {
        addStep('aiMiner', 'legacy', 'AI enrichment for new type');
    }
    return plan;
}
```

Also in `flowOrchestrator.js` `executeFlow1()`, map the page type:
```javascript
if (analysis.pageType === PAGE_TYPES.NEW_TYPE) {
    inputType = 'new_type';
}
```

### Step 6: Double-Pagination Guard

**If your miner handles its own pagination internally** (like `directoryMiner`), you MUST prevent the flowOrchestrator from also paginating:

In `flowOrchestrator.js`, both execution-plan path and SmartRouter path:
```javascript
// GUARD: newMiner handles its own pagination internally
const paginationInfo = (primaryStepMiner === 'newMiner' || inputType === 'new_type')
    ? { isPaginated: false, totalPages: 1, pageUrls: [job.input] }
    : await this.detectPagination(job, routeDecision);
```

Set `ownPagination: true` in `getRecommendation()` to signal this.

---

## 4. Data Flow (Miner Output → DB)

```
Raw card from miner
  │
  ▼
contacts mapping ──── flowOrchestrator wrapper converts card fields to { contacts, emails }
  │
  ▼
normalizeResult() ─── Maps both camelCase + snake_case to UnifiedContact fields:
  │                    companyName/company_name → companyName
  │                    contactName/contact_name → contactName
  │                    jobTitle/job_title → jobTitle
  ▼
Aggregator V1 ─────── Merges contacts from multiple miners, dedup by email
  │                    Saves to Redis (temp) or direct DB if no Redis
  ▼
Aggregator V2 ─────── Validates contacts, filters hallucinations
  │                    Writes to mining_results table (single transaction)
  ▼
triggerCanonicalAggregation():
  │
  ├─ normalizeMinerOutput() ── Canonical normalizer:
  │   ├─ emailExtractor (B2B valid, filters noreply/mailer-daemon)
  │   ├─ nameParser (first_name, last_name)
  │   ├─ companyResolver
  │   └─ countryNormalizer
  │
  └─ aggregationTrigger.process() ── Persists to canonical tables:
      ├─ persons UPSERT (organizer_id, LOWER(email)) unique
      └─ affiliations UPSERT (organizer_id, person_id, LOWER(company_name))
```

---

## 5. Database Tables (Mining Pipeline)

| Table | Purpose | Written By |
|-------|---------|------------|
| `mining_jobs` | Job definition, status, config, progress | miningService, worker, flowOrchestrator |
| `mining_results` | Each discovered contact (discovery event) | resultAggregator.writeToDatabase(), POST /results endpoint |
| `mining_job_logs` | Job execution logs (future) | Not yet implemented |
| `persons` | Canonical identity (organizer_id, email) | aggregationTrigger, import paths (dual-write) |
| `affiliations` | Person-company relationship (additive) | aggregationTrigger, import paths (dual-write) |

**Key rules:**
- `persons` primary key = `(organizer_id, LOWER(email))` — email is NOT globally unique
- `affiliations` are additive, never overwritten — same email + same company = enrichment
- Miners NEVER write to `persons` or `affiliations` — only aggregation layer does

---

## 6. Existing Miners Reference

| Miner | Type | Specialty | Status |
|-------|------|-----------|--------|
| `playwrightTableMiner` | Playwright | Table/list extraction from structured HTML | ACTIVE |
| `aiMiner` | Claude AI | Intelligent extraction using AI analysis | ACTIVE |
| `documentMiner` | HTTP + PDF | Flipbook/PDF/document parsing | ACTIVE |
| `directoryMiner` | Playwright | Business directories (card-based layouts, Yellow Pages, etc.) | ACTIVE |
| `messeFrankfurtMiner` | Playwright + API | Messe Frankfurt exhibition exhibitor catalogs (Techtextil, Automechanika, Heimtextil, ISH, etc.) | ACTIVE |
| `memberTableMiner` | Playwright | HTML table member/exhibitor lists (associations, chambers, federations) | ACTIVE |
| `visExhibitorMiner` | Playwright + API | Messe Düsseldorf VIS platform exhibitor catalogs (Valve World Expo, wire, Tube, interpack, MEDICA, etc.) | ACTIVE |
| `httpBasicMiner` | HTTP | Basic HTTP fetch + regex (alias for playwrightTableMiner) | ACTIVE (alias) |
| `fullMiner` | Composite | Runs playwrightTableMiner only (aiMiner removed from free mode) | ACTIVE |
| `playwrightMiner` | Playwright | General Playwright crawl (alias for fullMiner) | ACTIVE (alias) |
| `playwrightDetailMiner` | Playwright | Detail page enrichment (alias for fullMiner) | ACTIVE (alias) |

**directoryMiner details:**
- Two-phase pipeline: (1) list page crawl with pagination, (2) detail page visits for enrichment
- Handles its own pagination internally (`crawlListPages`, max 10 pages)
- Detects business cards via DOM selectors + repeated parent pattern
- Extracts: company_name, phone, address, email, website, detail_url, country
- Detail page enrichment: emails (mailto, data-email, obfuscated, RTL), phones, address (JSON-LD, microdata), website

**messeFrankfurtMiner details:**
- Two-phase pipeline: (1) API discovery + pagination via network interception, (2) detail page DOM extraction for exhibitors missing email
- Intercepts `api.messefrankfurt.com` exhibitor search API response during page load
- Extracts full data from API: company_name, email, phone, website, country, address
- Handles own pagination: navigates to successive search pages, sniffs API responses
- Handles own browser lifecycle (ownPagination: true, ownBrowser: true)
- Detects: `messefrankfurt.com` hostname + `exhibitor` in URL path
- Detail pages only visited for exhibitors missing email (most data comes from API)
- Detail page extraction: mailto: links (filtered share links), tel: links, website (strict label matching), address selectors
- Config: `max_pages` (default 50), `max_details` (default 300), `delay_ms` (default 1500ms), `page_size` (default 100)
- Covers all Messe Frankfurt events: Techtextil, Automechanika, Heimtextil, ISH, Ambiente, etc. (same SPA platform)

**memberTableMiner details:**
- Single-phase: navigates to page, finds HTML `<table>` elements, parses rows with column mapping
- Header-based extraction: analyzes header row keywords (company, email, phone, contact, city, address, country, website)
- Multi-language keywords: EN + TR support
- Scoring: longer keyword match = higher specificity (e.g., "contact details" → email, "contact person" → contact_name)
- Content-based fallback within miner: if no header row, samples data rows to infer column types (email regex, company suffixes, name prefixes)
- Does NOT handle its own pagination (ownPagination: false) — flowOrchestrator handles external pagination
- Browser lifecycle managed by flowOrchestrator wrapper
- Extracts: company_name (bold text), email, phone (prefix cleaning), contact_name, city, address (lines below company), website
- HTML entity decoding for company names (&amp; → &)
- Config: `delay_ms` (default 2000ms)
- Test case: AIACRA patron-members → 38 contacts, 100% email+company+contact+city
- **Detection (dual):**
  - *Hostname-based (early, pre-fetch):* `MEMBER_TABLE_DOMAINS` hostname + 'member' in URL — runs in `analyze()` before `fetchPage()`, catches SSL-broken sites that would otherwise fall to ERROR
  - *Content-based (generic, in analyzeHtml):* Cheerio scans all `<table>` elements for `<th>` header rows, matches header text against keyword sets for 8 field types, requires ALL four conditions:
    1. `<table>` exists
    2. `<th>` header row found (first 3 rows checked)
    3. ≥3 distinct field types matched (e.g., company + email + contact_name)
    4. ≥3 data rows contain email patterns
  - Content-based detection makes memberTableMiner generic — no need to add hostnames for new sites
- **vs playwrightTableMiner:** Both target pages with tables + emails, but memberTableMiner uses column-level semantics (header mapping → cell-to-field assignment) while playwrightTableMiner treats each row as an opaque text block. memberTableMiner extracts contact_name and city (playwrightTableMiner cannot). memberTableMiner is selected with higher priority; playwrightTableMiner remains as fallback.

**visExhibitorMiner details:**
- Three-phase pipeline: (1) A-Z directory fetch, (2) profile detail fetch, (3) merge list + profile data
- Uses VIS platform REST API via `page.evaluate(fetch())` — browser only used for session cookies
- Phase 1: Iterates letters a-z, fetches `/vis-api/vis/v1/{lang}/directory/{letter}` for each, collects exhibitor list (exh ID, name, country, city)
- Phase 2: Fetches `/vis-api/vis/v1/{lang}/exhibitors/{exh}/slices/profile` for each exhibitor, 5-concurrent chunks via `Promise.all`
- Phase 3: Merges directory list data with profile data to produce final contact cards
- All API requests require `x-vis-domain` header (value = site origin, e.g. `https://www.valveworldexpo.com`)
- `deriveApiBase(url)` extracts origin + basePath from input URL (pattern: `/vis/v1/{lang}/...` → `/vis-api/vis/v1/{lang}`)
- Handles own browser lifecycle (ownPagination: true, ownBrowser: true)
- Handles own pagination internally (A-Z letters = 26 directory requests)
- Detects: `VIS_DOMAINS` hostname match + URL contains `/vis/` or `/directory/`
- VIS_DOMAINS: `valveworldexpo.com`, `wire-tradefair.com`, `tube-tradefair.com`, `interpack.com`, `k-online.com`, `prowein.com`, `medica-tradefair.com`, `compamed-tradefair.com`
- Extracts: company_name, email, phone (`profile.phone.phone`), website (`profile.links[].link`), country (`profile.profileAddress.country`), city (`profile.profileAddress.city`), address (`profile.profileAddress.address[] + zip + city`)
- Config: `max_details` (default 500), `delay_ms` (default 500ms), `total_timeout` (default 480000ms / 8 min)
- SmartRouter: priority 2, fallback chain: `spaNetworkMiner → playwrightTableMiner`
- **vs messeFrankfurtMiner:** Similar approach (API + detail) but different platform. messeFrankfurtMiner intercepts `api.messefrankfurt.com` network responses; visExhibitorMiner calls VIS API directly via `page.evaluate(fetch())`. VIS API uses `x-vis-domain` header + A-Z directory structure; Messe Frankfurt uses search API with pagination. Different data shapes (VIS: nested `profileAddress`, `links[]`, `phone.phone`; MF: flat exhibitor objects).
- **vs spaNetworkMiner:** spaNetworkMiner uses network interception (`page.route()`); visExhibitorMiner uses direct `fetch()` inside `page.evaluate()`. VIS requires specific `x-vis-domain` header. spaNetworkMiner is in fallback chain but will not match VIS sites.

---

## 7. Local Miner (Remote Execution)

### When to Use
When Liffy detects that the target site blocks its server IP (Render), mining can be executed locally on the admin's machine.

### Flow
```
1. Liffy detects IP block (HARD_SITE or Cloudflare/CAPTCHA or 0 results + block indicator)
2. worker.js triggerManualAssist() → sets mining_jobs.manual_required=true
3. Sends email to organizer admin via SendGrid with copy-paste terminal command
4. Admin runs: node mine.js --job-id <id> --api https://api.liffy.app/api --token <token> --input "<url>"
5. Local miner crawls the site from admin's local IP
6. Results pushed to: POST /api/mining/jobs/:id/results
7. Backend validates, deduplicates, writes to mining_results (COMMIT)
8. Canonical aggregation triggers (best-effort, after COMMIT):
   normalizeMinerOutput() → aggregationTrigger.process() → persons + affiliations UPSERT
```

### Block Detection → Email Notification

Block detection triggers in these scenarios:
1. **HARD_SITE list** — known blocked domains (big5construct, thebig5, etc.) in `worker.js`
2. **Unified engine: 0 results + block indicator** — flowOrchestrator returns `blockDetected: true` when all miners return BLOCKED/FAILED/EMPTY status with 0 contacts
3. **HtmlCache poisoned content** — Cloudflare challenge pages, CAPTCHA, content too short
4. **BLOCK_DETECTED error** — miningWorker throws when Cloudflare/suspicious text detected

**Email content (3 sections):**

Section 1 — Explanation:
```
Subject: ⛏️ Manual Mining Required — Job {job_id} — {site_domain}

Liffy detected that {site_url} is blocking our cloud servers.
This typically happens with Cloudflare-protected sites, CAPTCHA challenges, or IP-based restrictions.
```

Section 2 — Terminal command (copy-paste ready, real token from env):
```
cd ~/Projects/liffy-local-miner && node mine.js --job-id {job_id} --api https://api.liffy.app/api --token {MINING_API_TOKEN} --input "{input_url}"
```

Section 3 — First-time setup:
```
1. Install Node.js: https://nodejs.org/en/download
2. Clone: git clone https://github.com/Nsueray/liffy-local-miner.git ~/Projects/liffy-local-miner
3. Install: cd ~/Projects/liffy-local-miner && npm install
4. Browsers: npx playwright install chromium
```

**Implementation:** `worker.js` → `triggerManualAssist(job)` — best-effort (try/catch), never breaks the mining job.

### Push Endpoint — Canonical Aggregation
```
POST /api/mining/jobs/:id/results
Authorization: Bearer <MINING_API_TOKEN or JWT>

Body:
{
  "results": [
    {
      "source_url": "https://example.com/exhibitor/123",
      "company_name": "Acme Corp",
      "contact_name": "John Doe",
      "job_title": "CEO",
      "country": "Ghana",
      "phone": "+233-xxx",
      "website": "https://acme.com",
      "emails": ["info@acme.com"]
    }
  ],
  "summary": { ... }  // optional metadata
}
```

**After COMMIT**, the endpoint triggers canonical aggregation (added in commit 28ea802):
- Filters contacts with email → builds minerOutput → `normalizeMinerOutput()` → `aggregationTrigger.process()`
- Writes to `persons` + `affiliations` tables
- Best-effort: aggregation failure never breaks the response

### Authentication
- JWT token (same as web UI) — `Authorization: Bearer <jwt>`
- Or `MINING_API_TOKEN` env var (also supports legacy `MANUAL_MINER_TOKEN`)

### Local Miner Repo
- **Repo:** `liffy-local-miner/` (separate repo, NOT modified by backend changes)
- **Entry:** `mine.js` — CLI tool with Playwright
- **Supports:** pagination, checkpoint/resume, test mode, multi-strategy link extraction

---

## 8. Config Options

Job config is stored in `mining_jobs.config` (JSONB). Available options:

| Key | Default | Description |
|-----|---------|-------------|
| `max_pages` | `20` | Maximum pages to mine (pagination) |
| `delay_ms` | `1000` | Delay between detail page visits (ms) |
| `list_page_delay_ms` | `2000` | Delay between list/pagination pages (ms) |
| `mining_mode` | `'full'` | Mining mode: `'full'` (free) or `'ai'` |
| `detail_url_pattern` | `null` | URL pattern for detail page links (e.g. `"/exhibitor/"`) |
| `preferred_miner` | `null` | Force a specific miner (bypasses SmartRouter) |
| `skip_details` | `false` | Skip detail page visits (directoryMiner) |
| `max_details` | `200` | Max detail pages to visit (directoryMiner) |
| `site_domain` | auto | Override site domain detection |
| `force_page_count` | `null` | Force specific page count for pagination |

---

## 9. Testing Checklist

When adding a new miner, verify:

- [ ] **Syntax check:** `node -c backend/services/urlMiners/newMiner.js`
- [ ] **Miner exports correct function:** `const { runNewMiner } = require('./newMiner')`
- [ ] **flowOrchestrator loads it:** Check logs for `"Miners loaded: ... newMiner"`
- [ ] **PageAnalyzer detection works:** Test URL triggers correct page type
- [ ] **SmartRouter routes correctly:** Log shows `"Decision: newMiner"`
- [ ] **executionPlanBuilder includes it:** Execution plan shows newMiner step
- [ ] **Double-pagination guard:** If miner does own pagination, external pagination is skipped
- [ ] **Production test:** URL → `mining_results` rows created + `persons` UPSERT + `affiliations` UPSERT
- [ ] **Fallback:** If miner fails to load, other miners still work (try/catch in loadMiners)
- [ ] **No DB writes in miner:** Miner only returns data, never calls `db.query()`
