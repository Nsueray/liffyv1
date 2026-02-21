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
| `directoryMiner` | Playwright | Business directories (card-based layouts, Yellow Pages, etc.) | PROTOTYPE |
| `httpBasicMiner` | HTTP | Basic HTTP fetch + regex (alias for playwrightTableMiner) | ACTIVE (alias) |
| `fullMiner` | Composite | Runs playwrightTableMiner + aiMiner, merges results | ACTIVE |
| `playwrightMiner` | Playwright | General Playwright crawl (alias for fullMiner) | ACTIVE (alias) |
| `playwrightDetailMiner` | Playwright | Detail page enrichment (alias for fullMiner) | ACTIVE (alias) |

**directoryMiner details:**
- Two-phase pipeline: (1) list page crawl with pagination, (2) detail page visits for enrichment
- Handles its own pagination internally (`crawlListPages`, max 10 pages)
- Detects business cards via DOM selectors + repeated parent pattern
- Extracts: company_name, phone, address, email, website, detail_url, country
- Detail page enrichment: emails (mailto, data-email, obfuscated, RTL), phones, address (JSON-LD, microdata), website

---

## 7. Local Miner (Remote Execution)

### When to Use
When Liffy detects that the target site blocks its server IP (Render), mining can be executed locally on the admin's machine.

### Flow
```
1. Liffy detects IP block → sends email to admin with terminal command
2. Admin runs: node mine.js --job-id <id> --api https://api.liffy.app --token <token>
3. Local miner crawls the site from admin's local IP
4. Results pushed to: POST /api/mining/jobs/:id/results
5. Backend validates, deduplicates, writes to mining_results
6. Canonical pipeline triggers: normalizeResult → aggregationTrigger → persons + affiliations
```

### Push Endpoint
```
POST /api/mining/jobs/:id/results
Authorization: Bearer <MANUAL_MINER_TOKEN or JWT>

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

### Authentication
- JWT token (same as web UI) — `Authorization: Bearer <jwt>`
- Or `MANUAL_MINER_TOKEN` env var — a static token for local miner auth

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
