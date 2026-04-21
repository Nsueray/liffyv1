# RFC: Source Discovery v2 — Liffy's Discovery Gateway

## Status: APPROVED
## Date: 2026-04-21
## Author: Suer (product), Claude (architecture)
## Reviewed by: ChatGPT (product feedback)

---

## Problem

Current Discover tab is limited to "enter a fair name → search → mine".
Liffy is NOT just a trade fair scraper — it's a data discovery platform.
Source Discovery should be the intelligent front door to all mining activity.

## Design Principles

1. Source type is a first-class concept, not a filter
2. Mining and discovery are separate concerns (Constitution)
3. Show history/context as badges, don't hide with exclude filters
4. Every source gets a mineability assessment before mining
5. Batch operations with review step before job creation

## Module Architecture (4 parts)

### Part 1: Discovery Search (Sprint 1)

The main entry point. User first selects WHAT they're looking for:

**Source Types (first-class selection, not filter):**

| Icon | Source Type | Description |
|------|-----------|-------------|
| 🏭 | Trade Fair / Exhibition | Exhibitor directories |
| 🏢 | Association / Federation / Union | Member lists |
| 🏛️ | Chamber of Commerce | Member directories |
| 📋 | Business Directory / Portal | Kompass, Europages, etc. |
| 📄 | Company Listing / Catalog Page | WordPress, blogs, portals |
| 🌐 | Trade Portal | Alibaba, TradeFord, ExportHub |
| 📑 | Government Trade Database | TOBB, trade attaché lists |
| 🔗 | Custom URL | Paste any URL directly |
| 🔎 | Custom Search | Free-text keyword search |

**Then filters:**
- Country / Region (dropdown, multi-select)
- Industry / Sector (dropdown with common sectors)
- Keywords (free text, optional refinement)

Search generates web search query based on source type + filters.
Example: "Association" + "HVAC" + "Nigeria" →
`"HVAC association Nigeria member directory list"`

### Part 2: Source Analysis (Sprint 2)

For each discovered URL, quick analysis:
- Fetch page (timeout 10s)
- Count emails (mailto + regex)
- Detect tables, links, page structure
- Mineability score: 🟢 High / 🟡 Medium / 🔴 Low
- Reason badges: "120 mailto links found", "Table structure detected",
  "JS-heavy — may need Playwright", "Likely blocked"
- Suggested miner family
- Estimated contacts count
- Prior mining history: "Mined 14 days ago — 147 contacts found",
  "3 jobs exist for this domain", "Never mined"

### Part 3: Source Selection & Collections (Sprint 3)

- Checkbox multi-select
- Save as Discovery Set ("HVAC Nigeria Associations")
- Discovery Sets page — saved searches for later
- History badges on each result (not exclude filters)

### Part 4: Mining Job Creation with Review (Sprint 1 basic, Sprint 3 full)

**Sprint 1 (basic):** Select URLs → "Mine Selected" → create jobs
**Sprint 3 (full):** Select → Review screen showing:
  - URL, suggested miner, strategy, expected yield
  - Already mined warnings
  - Same domain history
  - "Create X Mining Jobs" button

## Sprint Plan

### Sprint 1 (NOW)
- [x] New Discover tab UI with source type cards as main entry
- [x] Country + Sector + Keyword filters
- [x] Custom URL direct input
- [x] Web search integration (existing /api/source-discovery endpoint, extended)
- [x] Results list with checkbox selection
- [x] "Mine Selected" → batch job creation (basic, no review)
- [x] Source type influences search query template

### Sprint 2 (NEXT)
- [ ] Mineability analysis endpoint (POST /api/mining/analyze-url)
- [ ] Quick fetch + structure detection
- [ ] Reason badges on each result
- [ ] Estimated contacts
- [ ] Miner suggestion

### Sprint 3 (AFTER)
- [ ] Discovery Collections (save/load source sets)
- [ ] Prior mining history badges
- [ ] Review screen before batch job creation
- [ ] Domain dedup warnings

### Sprint 4 (ASE — FUTURE)
- [ ] AI-powered search (Product Brain + Market Discovery)
- [ ] Country-aware query templates
- [ ] Language-aware search expansion
- [ ] Sector synonym expansion

## API Endpoints

### Existing (modified in Sprint 1)
- `POST /api/source-discovery` — extended with `source_type` parameter. Query template changes based on source type. Backward compatible (falls back to existing behavior without source_type).

### New (Sprint 1)
- `POST /api/mining/batch-create` — create multiple mining jobs at once
  - Body: `{ urls: [{ url, name? }] }`
  - Response: `{ jobs: [{ id, url, name, status }], created: number, failed: number }`

### New (Sprint 2)
- `POST /api/mining/analyze-url` — quick mineability analysis
  - Body: `{ url }`
  - Response: `{ mineability_score, email_count, table_detected, link_count, page_size_kb, suggested_miner, estimated_contacts, reason_badges[] }`

### New (Sprint 3)
- `POST /api/mining/discovery-sets` — save a discovery set
- `GET /api/mining/discovery-sets` — list saved sets
- `GET /api/mining/discovery-sets/:id` — get set with URLs
- `GET /api/mining/url-history?url=` — prior mining history for URL/domain

## UI Design Notes

- Source type cards: 3x3 grid with icon + label + short description
- Selected source type highlighted (orange border + bg-orange-50), others dimmed
- Filters appear below source type selection
- Results: card layout with source type badge, URL, notes, selection checkbox
- Bottom bar with selected count + "Mine Selected" button
- Custom URL: direct URL input + "Analyze & Mine" button
- Mobile-friendly (Elif uses desktop but future-proofing)
- Consistent with existing Liffy design (Tailwind, orange accents)
- Discover/Jobs tab switcher preserved

## Technical Notes

### Web Search Engine
Uses Anthropic Claude API `web_search_20250305` tool (not Google/Bing/SerpAPI).
Model: `claude-haiku-4-5-20251001`. Timeout: 60s.
Claude prompt generates source-type-aware search queries.

### Source Type → Query Template Mapping
```
trade_fair:        "{keyword} {sector} {country} exhibitor list directory"
association:       "{keyword} {sector} {country} association federation union member list directory"
chamber:           "{keyword} {country} chamber of commerce member directory list"
business_directory:"{keyword} {sector} {country} business directory supplier manufacturer list"
company_listing:   "{keyword} {sector} {country} company catalog listing page"
trade_portal:      "{keyword} {sector} {country} supplier manufacturer trade portal"
government_trade:  "{keyword} {country} trade ministry export import database directory"
custom_search:     "{keyword}" (pass through as-is)
```

### Batch Job Creation
Each selected URL creates an independent mining job (POST /api/mining/jobs internally).
No review step in Sprint 1 — direct creation.
