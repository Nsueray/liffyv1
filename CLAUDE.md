# CLAUDE.md — Liffy Project Instructions (Constitution-Aligned)

> **Quick start:** [CLAUDE_QUICKSTART.md](./CLAUDE_QUICKSTART.md) (new chat reference)
> **Split docs:** [CLAUDE_DB.md](./CLAUDE_DB.md) (database & domain model), [CLAUDE_FEATURES.md](./CLAUDE_FEATURES.md) (feature documentation), [CLAUDE_UI.md](./CLAUDE_UI.md) (UI build progress)
> **Guides:** [MINER_GUIDE.md](./MINER_GUIDE.md) (miner development), [MINING_REFACTOR_PLAN.md](./MINING_REFACTOR_PLAN.md) (refactor plan)
> **Tracking:** [LIFFY_TODO.md](./LIFFY_TODO.md) (master todo list)

---

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
- **Auth:** JWT (jsonwebtoken) + bcrypt — 7-day token, hierarchical role-based access (owner/admin/manager/sales_rep) with recursive CTE team visibility (ADR-015)
- **Email:** SendGrid API only (nodemailer removed). Reply-To = salesperson's plus-addressed real email (e.g. `elif+c-xxx-r-xxx@domain.com`). Reply detection via Gmail Content Compliance header match → SendGrid Inbound Parse (reply.liffy.app).
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
| Pipeline Stage | Configurable sales pipeline step | `pipeline_stages` table |
| Contact Note | User-created note on a person | `contact_notes` table |
| Contact Activity | Auto-logged activity on a person | `contact_activities` table |
| Contact Task | Follow-up task assigned to a user | `contact_tasks` table |
| Action Item | Trigger-based follow-up item for a person | `action_items` table |
| Sequence | Multi-touch email sequence (campaign steps) | `campaign_sequences` table |
| Sequence Recipient | Person enrolled in a sequence | `sequence_recipients` table |
| Engagement Score | Weighted score: open=1, click=3, reply=10 | Computed from `campaign_events` |

### UI Concepts (Views, NOT tables)
| UI Page | Meaning |
|---------|---------|
| Contacts | Person + selected affiliation |
| Leads | Contacts without intent |
| Prospects | Contacts with intent |
| Mining Results | Discovery events |
| Lead Mining | Combined Source Discovery + Mining Jobs (tabs) |
| Companies | Aggregated company view from affiliations |
| Lists | Campaign targeting snapshots |
| Pipeline | Kanban board of contacts across stages |
| Tasks | Follow-up tasks assigned to current user |
| Admin | Owner/admin user management panel |
| Action Center | Prioritized follow-up items (homepage) |

**UI page names must NEVER mirror table names directly.**
**liffy-ui must treat API responses as canonical domain views, not database representations.**

---

## Forbidden Patterns (Anti-Patterns)

- Mining creates leads or prospects
- Mining writes to persons/prospects directly
- Email uniqueness enforced across organizers
- UI logic based on table names
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

See [MINER_GUIDE.md](./MINER_GUIDE.md) for full miner development documentation.

---

## Mining Architecture Rules (SACRED — DO NOT VIOLATE)

1. **Never modify existing miners** — no miner code is ever changed to accommodate a new site
2. **Orchestrator only adds** — new miners are added to the pipeline, never removed
3. **All miners are tried** — orchestrator runs every available miner, merges results
4. **Normalizer/merge is frozen** — orchestration, normalization, and merge logic is NOT modified when adding miners
5. **New URL doesn't work → add new miner** — never break existing miners to fix a new URL
6. **20-30 miners is fine** — quantity of miners is not a concern, coverage is
7. **Each miner is a plugin** — standalone, no dependencies on other miners, receives URL + config, returns results

See [MINER_GUIDE.md](./MINER_GUIDE.md) for miner registry and architecture details.
See [MINING_REFACTOR_PLAN.md](./MINING_REFACTOR_PLAN.md) for the 10-step refactor plan.

---

## Build Priority (Current)

1. ~~Constitution Migration~~ ✅ DONE
2. ~~Campaign Events~~ ✅ DONE
3. ~~ProspectIntent~~ ✅ DONE
4. ~~Email Campaign improvements~~ ✅ DONE
5. ~~Email verification~~ ✅ DONE
6. ~~Zoho CRM push~~ ✅ DONE
7. ~~Scraping module improvements~~ ✅ DONE
8. ~~Phase 3 migration~~ ✅ DONE
9. ~~Remove nodemailer~~ ✅ DONE
10. ~~JWT Auth System~~ ✅ DONE — login/logout, middleware, role-based access
11. ~~Contact CRM~~ ✅ DONE — notes, activities, follow-up tasks per person
12. ~~Sales Pipeline~~ ✅ DONE — 7-stage Kanban, auto-stage on reply, ownership
13. ~~User Data Isolation~~ ✅ DONE — owner sees all, user sees own rows only
14. ~~Daily Email Limit~~ ✅ DONE — per-user limit, 429 enforcement on /start
15. ~~Owner Admin Panel~~ ✅ DONE — user CRUD, password reset, usage stats
16. ~~Multi-Touch Sequences~~ ✅ DONE — campaign_sequences, sequence_recipients, worker
17. ~~Action Engine~~ ✅ DONE — 6 triggers (reply_received, sequence_exhausted, quote_no_response, rebooking_due, engaged_hot, manual_flag), priority scoring (P1-P4), 15-min reconciliation
18. ~~Action Screen~~ ✅ DONE — Blueprint Section 8 homepage, priority cards, filter/sort, snooze, history
19. ~~Phase 4 Prep~~ ✅ DONE — person_id backfill script, campaign resolve canonical path, visibility columns (migration 033-034)
20. ~~Dashboard Stat Fix~~ ✅ DONE — COUNT(DISTINCT email) for rates, events.sent for total
21. **Frontend UI build** — liffy-ui (Next.js) pages for canonical APIs ← CURRENT
22. **AI Miner Generator v2** — AXTree + Config-Driven + Self-Healing REPL. glmis ✅ 11 contact (3.5K token). expat.com multi-step ✅ 7 contact best case (tutarsız — Claude non-deterministic). Performans 24dk→2dk. Kalan: Claude tutarlılığı, anchor vs container mode seçimi. Bkz: [RFC_v4_AI_Miner_Generator.md](./RFC_v4_AI_Miner_Generator.md) ← PARKED (ASE'ye geçiş)
23. ~~Zoho Import~~ ✅ DONE — 54K records imported (persons + affiliations), industry normalization, 75K+ persons
24. ~~ADR-015 Hierarchical Permissions~~ ✅ DONE — recursive CTE team visibility, reports_to chain, 4 roles (owner/admin/manager/sales_rep), migrations 038-039-040, 11 routes updated
25. ~~Reply Email Quality~~ ✅ DONE — click tracking disabled, reply body in timeline (2000 chars), forward fallback to creator email, SendGrid tracking settings
26. ~~JWT Auth Fix~~ ✅ DONE — `id` vs `user_id` normalization across 28 auth middleware instances
27. ~~Reply Detection v2→v4~~ ✅ DONE — Plus-addressed Reply-To (`sender+c-{8hex}-r-{8hex}@domain.com`), Gmail Content Compliance header match `+c-` → forward to `parse@reply.liffy.app`, 3 detection methods (plus address → unsubscribe URL token → email match), Action Engine P1 trigger, person_id consolidated (single lookup)
28. ~~Lists created_by_user_id Fix~~ ✅ DONE — 4 list creation paths missing created_by_user_id → NULL → invisible to non-owner users
29. ~~Action Engine Reply Dedup Fix~~ ✅ DONE — every reply creates new P1 action item (no dedup for reply_received), migration 041
30. ~~Owner/Creator Info on UI~~ ✅ DONE — "By" column on campaigns, lists, templates, mining jobs tables. LEFT JOIN users, creator_name. Campaign detail shows "by {name}" in header.
31. ~~Campaign Delete Bug Fix~~ ✅ DONE — ON DELETE SET NULL on prospect_intents caused uq_prospect_intent violation. Explicit delete of prospect_intents + action_items before campaign.
32. ~~Lead Mining Page~~ ✅ DONE — Source Discovery + Mining Jobs merged into single `/mining` page with Discover/Jobs tabs. Sidebar updated (Pickaxe icon). Next.js 16 `<Suspense>` wrapper for `useSearchParams()`.
33. ~~Company Entity Page~~ ✅ DONE — `/companies` page with aggregated company view from affiliations. Backend `GET /api/companies` + `GET /api/companies/:name/contacts`. Sidebar (Building2 icon). Stats cards + search + industry/country filters.
34. ~~Reply Signature Parsing~~ ✅ DONE — `signatureParser.js` utility extracts phone/title/company from reply email signatures. 3 strategies (structured block, inline phone, vCard-style). Auto-enriches affiliations on reply webhook.
35. ~~Data Cleanup Migration 042~~ ✅ DONE — Email domain company names → NULL (~887 rows), industry typo normalization (Otomotiv→Automotive, etc.).
36. ~~Admin Bug Fixes (3x)~~ ✅ DONE — (1) Sidebar admin visibility for manager role, (2) VALID_ROLES mismatch `user`→`sales_rep` causing silent PATCH failures, (3) sequenceWorker daily limit scoped per-user via `created_by_user_id` JOIN.
37. ~~Companies 500 Fix~~ ✅ DONE — 5 column name errors fixed via production DB verification (`country`→`country_code`, `source_url`→`website`, `email_status`→`verification_status`, `p.phone`→`a.phone`).
38. ~~Sender Identity Edit/Delete~~ ✅ DONE — PUT /api/senders/:id (from_name, reply_to, visibility editable; from_email locked). Settings page Edit modal + Delete confirm dialog with campaign usage warning. GET /api/senders returns campaign_count.
39. ~~Senders 500 Fix~~ ✅ DONE — campaign_count query used `sender_identity_id` but correct column is `sender_id`. Same column-name assumption bug pattern.
40. ~~Reply Timeline Expand/Collapse~~ ✅ DONE — ContactDrawer reply events show From + Subject header, 200→full text toggle, expandedReplies Set state with reset on timeline refresh.
41. ~~Login Sidebar Fix~~ ✅ DONE — Backend `/api/auth/login` returns flat response (no `user` property) → `liffy_user` never stored → Admin/sidebar hidden. Fixed login page to construct user object from flat response.
42. ~~Duplicate Send Fix (CAS)~~ ✅ DONE — Render redeploy race: old+new instances overlap → double send. CAS claim (`UPDATE SET status='sending' WHERE status='pending' RETURNING id`) in worker.js, campaignSend.js, sequenceService.js.
43. ~~Daily Email Usage Visibility~~ ✅ DONE — `GET /api/campaigns/email-usage` endpoint + Dashboard progress bar card (green <80%, yellow 80-100%, red = limit).
44. ~~Contact Campaign History~~ ✅ DONE — `GET /api/persons/:id/campaigns` endpoint + Contact Detail page campaign history table with event type columns.
45. ~~Sequence Engine CAS Guard~~ ✅ DONE — CAS claim in sequenceService.js (active→sending→active/completed), error recovery restores to 'active'.
46. ~~inlineContactMiner~~ ✅ DONE — Cheerio-based inline contact extraction from page HTML. Multi-language labels (EN/TR/FR/DE/ES), email+phone+website+company extraction from DOM context. No link following, no Playwright — accepts raw HTML from HtmlCache.
47. ~~Execution Plan + Poison Fix~~ ✅ DONE — inlineContactMiner added as fallback step in ALL execution plans. isPoisoned() false positive fixed (block indicators only on short pages <10KB or title/h1).
48. ~~Source Discovery v2 (Sprint 1)~~ ✅ DONE — RFC written (`docs/RFC_Source_Discovery_v2.md`). 9 source types (5 main + 4 "More options"). Country dropdown (80+ countries, popular section). Industry dropdown (24 sectors). Claude API web search with source-type-aware query templates. `POST /api/mining/batch-create` batch job creation. Domain dedup (max 3/domain). Rate limit 429 handling (countdown banner). Prompt optimization (system ~80 words, user ~60 words, down from 300+).
49. ~~Source Discovery Search History~~ ✅ DONE — Migration 043: `discovery_searches` table. POST saves searches automatically. `GET /api/source-discovery/history` (last 50, mining status enrichment per URL). `GET /api/source-discovery/history/:id` single search detail. Frontend: 3-tab layout (Discover / Search History / Jobs), expand/collapse search cards, mining status badges (completed/running/failed/unmined), batch mine from history.
50. ~~Reply Detection Health Dashboard~~ ✅ DONE — Settings page monitoring section (status indicator, reply counts, recent replies). Send Test Reply button. Test reply org detection fix (To address parsing). Last test timestamp.
51. ~~ActionEngine ON CONFLICT Fix~~ ✅ DONE — upsertActionItem partial index predicate match.
52. ~~PDF Memory-Safe Processing~~ ✅ DONE — DocumentMiner stream-to-disk (was memory), HEAD size check, 5min timeout. urlAnalyzer PDF detection with size badges. File upload: multer diskStorage 1GB (was memoryStorage 50MB). Upload progress bar. Failed PDF banner.

See [LIFFY_TODO.md](./LIFFY_TODO.md) for detailed task tracking.

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

## Recurring Mistakes — MANDATORY Rules

### Column Name Assumption Bug (5+ occurrences!)

Claude Code repeatedly writes SQL queries with **assumed column names** instead of verifying against the actual DB schema. This causes 500 errors every time.

**Examples:**
- `companies.js`: `country` → `country_code`, `source_url` → `website`
- `companies.js`: `p.email_status` → `p.verification_status`, `p.phone` → `a.phone`
- `senders.js`: `sender_identity_id` → `sender_id`

**MANDATORY RULE:** Before writing ANY new query or endpoint, run:
```sql
SELECT column_name FROM information_schema.columns WHERE table_name = 'TABLE_NAME' ORDER BY ordinal_position;
```
This is NOT optional. Every new SQL query MUST be verified against the schema first.

---

## What NOT To Do

- Do NOT refactor the mining engine unless explicitly asked
- Do NOT "improve architecture" without being asked — build what's requested
- Do NOT delete legacy tables — they stay until Phase 4
- Do NOT assume tables exist that aren't listed in [CLAUDE_DB.md](./CLAUDE_DB.md)
- Do NOT create new tables without checking CLAUDE_DB.md first
- Do NOT assume column names — always verify with `information_schema.columns`

---

## Mining Engine Refactor

Active refactor in progress. See [MINING_REFACTOR_PLAN.md](./MINING_REFACTOR_PLAN.md) for full 10-step plan.
Steps 1-6 ✅ DONE. Steps 7-8 DEFERRED. Step 9 (directoryMiner) phases 1-5 ✅ DONE. Step 10 ✅ DONE.
messeFrankfurtMiner ✅ DONE — Messe Frankfurt exhibition exhibitor catalogs (API + detail page extraction).
memberTableMiner ✅ DONE — HTML table member/exhibitor lists (associations, chambers, federations).
reedExpoMiner ✅ DONE — Generic ReedExpo platform exhibitor directories (infinite scroll + GraphQL API). batimat.com, arabhealth.com, wtm.com, etc. Phase 2 "not_found" error'ları normal — API'de kayıtsız org'lar için beklenen davranış.
reedExpoMailtoMiner ✅ DONE — ReedExpo sites with mailto: emails in HTML (GraphQL'siz fallback). reedExpoMiner sonrası emailsiz org'lar için company-name match ile enrichment.
playwrightTableMiner: column-aware parse ✅ DONE — Çince/Rusça/Türkçe/çok dilli tablo header desteği. Longest-match keyword eşleştirme. Eski heuristic fallback korundu. Timeout 60s + domcontentloaded.
inlineContactMiner ✅ DONE — Cheerio-based inline contact extraction from raw HTML. No Playwright, no link following. Uses HtmlCache + HTTP fallback. Added as fallback step in ALL execution plans.
