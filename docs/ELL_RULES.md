# ELL_RULES.md — Cross-System Rules

> This file exists in all three ELL repos (eliza, liffyv1, Leena_v401_monorepo).
> It is the SAME file everywhere. If you update it, update all three copies.
> Last updated: 2026-05-01 (v5.1 — sync worker timing corrected to Phase 1 end)

---

## What is ELL?

ELL = ELIZA + LİFFY + LEENA. Three systems forming one platform.

- **ELIZA** — Commercial system of record. Owns contracts, payments, approvals, intelligence, WhatsApp bot, CEO dashboard, master pricing data, **reference data (countries, sectors, currencies, languages)**.
- **LİFFY** — Sales action engine + CRM. Owns leads, companies, contacts, quotes, campaigns, sequences, action items, outreach. SaaS-ready (ADR-002). Will replace Zoho CRM by Jan 2027 (ADR-008).
- **LEENA** — Operations execution. Owns expos (master), visitors, floorplans, check-ins, badges, certificates, exhibitor scanning.

Repos: `eliza` (github.com/Nsueray/eliza), `liffyv1` (github.com/Nsueray/liffyv1), `Leena_v401_monorepo` (github.com/Nsueray/Leena_v401_monorepo)

---

## DATABASE ARCHITECTURE (CORRECTED — read this carefully)

**ELL has THREE separate PostgreSQL databases on Render.** Earlier versions of this document said "shared PostgreSQL" — that was incorrect.

| Database | Plan | Cost/mo | RAM | CPU | Storage | PG Version |
|----------|------|---------|-----|-----|---------|------------|
| eliza-db | Basic-256mb | $10.50 | 256 MB | 0.1 | 15 GB | 18 |
| liffy-db | Basic-1gb | $23.50 | 1 GB | 0.5 | 15 GB | 17 |
| leena_v401_db | Basic-1gb | $23.50 | 1 GB | 0.5 | 15 GB | 17 |

**Total: $57.50/month**. All in Oregon (US West).

**Implications:**
- No cross-database JOIN possible
- No cross-database FK constraints possible
- Reference data must be REPLICATED across all three databases
- LİFFY's `companies.country_code` is a "soft FK" — application-level validation only, references local liffy-db.core_countries (synced from eliza-db)

**Future plan (Phase 3, after fair season):** Consolidate to single PostgreSQL instance with schema-level separation (`eliza.*`, `liffy.*`, `leena.*`). See ADR-018. Estimated savings: $34/month. Cannot do during fair season due to risk to LEENA fair operations.

---

## REFERENCE DATA SYNC STRATEGY

Reference data tables (`core_countries`, `core_sectors`, `core_currencies`, `core_languages`) exist in ALL THREE databases with identical schema and identical content.

**Master:** ELIZA writes (eliza-db is source of truth).
**Replicas:** LİFFY and LEENA databases hold synced copies.

**Sync mechanism — phased approach:**
- **During Phase 1 (weeks 1-9):** MANUAL SYNC. When ELIZA admin adds/edits reference data, manually run the SQL on liffy-db and leena_v401_db. Reference data changes 1-2 times during Phase 1, dakikalık iş.
- **End of Phase 1 (Week 9 or Observation Week):** Build automated sync worker. Cron job every 5-10 minutes, ELIZA worker writes to a `reference_sync_log`, LİFFY/LEENA workers pull and UPSERT.
- **Phase 1.5 onwards:** Automated sync worker handles all updates.

**Rationale for delaying automated sync:** Sync worker is non-trivial work (state tracking, error recovery, conflict resolution, monitoring, schema drift detection). Building it during Phase 1 would delay companies migration. Manual sync is acceptable for low change rate (5-10 changes per year).

**Why replication, not API calls:**
- LİFFY/LEENA tables FK (soft FK) to local copies — needs to be in same DB
- Aggregation queries need JOIN with reference tables
- Network latency unacceptable for hot paths
- Reference data is small (~100 rows total) and rarely changes

**Validation pattern (in application code):**
```javascript
// Before INSERT/UPDATE, validate FK against local DB
const valid = await db.query(
  `SELECT 1 FROM core_countries WHERE code = $1 AND is_active = true`,
  [companyData.country_code]
);
if (!valid.rows.length) throw new Error(`Invalid country_code: ${companyData.country_code}`);
```

**Sync lag tolerance (after automated sync goes live):** Up to 10 minutes. If a sales rep adds a brand-new country in ELIZA admin UI, LİFFY won't accept it until next sync cycle. Acceptable trade-off.

---

## MODULE OWNERSHIP MAP (Zoho → ELL Migration)

### LİFFY (Sales Engine + CRM — replacing Zoho's sales side)

| Zoho Module | LİFFY Equivalent | Status |
|-------------|------------------|--------|
| Leads | persons WHERE lifecycle_stage='lead' | 75K imported |
| Contacts | persons WHERE lifecycle_stage IN ('contact','customer') | Phase 1 (now) |
| Companies | companies (NEW table) | Phase 1 (now) |
| Quotes | quotes | Phase 1.5 |
| Potentials | opportunities | Phase 1 |
| Tasks | tasks | Exists |
| Meetings | meetings | Phase 1 |
| Calls | call_logs | Phase 1 (cold call tracking) |
| Campaigns | campaigns | Exists |
| Workqueue | action_items (Action Screen) | Exists |
| SalesInbox | Contact Drawer Timeline + reply detection | Exists |
| Social | social_engagement | Future |
| Voice of the Customer | reply_intelligence (sentiment + classification) | Future |
| New Leads | mining job results → auto-routed to users | Phase 1 |
| My Jobs | mining_jobs | Exists |

**Note:** Persons is the canonical entity. Lead/Contact/Customer are LIFECYCLE STAGES, not separate tables. State machine: lead → mql → sql → contact → customer. Convert = lifecycle_stage update + company_id assignment. Modern CRM model (HubSpot, Pipedrive). Zoho's lead/contact separation is legacy and unnecessary in ELL.

### ELIZA (System of Record + Intelligence + Reference Data Master)

| Zoho Module | ELIZA Equivalent | Notes |
|-------------|------------------|-------|
| Sales Contracts | contracts | ELIZA authority writes (ADR-005) |
| Expenses | expenses | Synced from Zoho currently |
| Invoices | invoices | Financial documents |
| Revenues | revenue_summary | Reports/analytics |
| Reports | dashboard | War Room |
| Analytics | dashboard analytics | War Room |
| Sales Agents | users + permissions | ADR-015 hierarchy |
| Products | products | Master pricing data — read by all systems, written only by ELIZA |
| Product Groups | product_categories | Categories of products |
| (NEW) Reference Data | core_countries, core_sectors, core_currencies, core_languages | Master ref data — synced to LİFFY and LEENA databases |

### LEENA (Operations + Events)

| Zoho Module | LEENA Equivalent | Notes |
|-------------|------------------|-------|
| Expos | expos | **Master expo data — created here, read by ALL systems via API or Zoho sync** |
| Visitors | visitors | Visitor management |
| Visits | visits | Visit tracking |
| Catalogues | catalogues | Phase 2 |
| Check in Logs | checkins | Existing |
| Stand Leads | exhibitor_leads | Existing |
| Member Companies | (linked to expos) | Future |

### Cross-Database Read Strategy

Since databases are separate, "read" patterns differ:
- **Reference data:** Replicated locally (sync worker). Direct SQL access in own DB.
- **Master data (Products, Expos):** Owner exposes API endpoints. Consumers cache or call API.
- **Cross-system queries:** Currently done via Zoho sync into ELIZA dashboard. Phase 3 (after consolidation) will enable direct cross-schema JOINs.

### Not Migrated / Deprecated

| Zoho Module | Reason |
|-------------|--------|
| Purchase Orders | Not used by Elan Expo |
| Bodies/Expos | Legacy module, replaced by Expos in LEENA |
| Kurumlar | Same as Bodies/Expos (Turkish), legacy |
| My Requests | Zoho-specific feature, no equivalent needed |
| Documents | Future — needs shared file storage (S3/Cloudinary) |
| Google Ads | Out of ELL scope |
| Data | Zoho-specific, not needed |
| Services | Unclear scope, evaluate if/when needed |

---

## ZOHO MIGRATION STRATEGY

### Lead Data (selective migration)

Zoho contains 585K leads. Most are dead data accumulated over years.

1. **75K already imported to LİFFY** — active working portfolio
2. **510K stay in Zoho as archive** — sales reps don't see them in LİFFY
3. **New leads enter LİFFY directly** — via mining (auto-routed) or manual data entry form
4. **Promotion path** — Zoho leads that respond, sign, or convert get migrated to LİFFY case-by-case
5. **January 2027 cutoff** — when Zoho is decommissioned, remaining 510K archived or deleted

### Contact Data
Zoho 17,668 contacts. Already in LİFFY's 75K imported persons (lifecycle_stage='contact').

### Company Data
Zoho ~17K companies. Migration: dedupe `affiliations.company_name` values → write to new `companies` table → update `affiliations.company_id` FK. One-time script with manual review checkpoints.

### Sector Data
Zoho sector strings (free text, inconsistent). Migration: build `core_sectors` first (ELIZA, manual curation from Zoho data), then map `affiliations.industry` strings to `core_sectors.id` via fuzzy match + manual review.

### Country Data
Zoho country strings ("Turkey" / "Türkiye" / "TR"). Migration: standardize via ISO 3166 mapping in `core_countries`, update all references.

### Quote/Sales Contract Data
Stays in Zoho currently. Read by ELIZA via existing Zoho sync. Quote creation moves to LİFFY in Phase 1.5. Sales Contract creation stays in ELIZA permanently (ADR-005). Full Zoho exit January 2027.

---

## CRITICAL RULES (never violate)

### R1: Data Ownership
Each table has exactly ONE owner system. Only the owner writes. Others may read (within their own DB).

**ELIZA writes (eliza-db):** contracts, contract_payments, users, permissions, audit_logs, products, expenses, invoices, **core_countries, core_sectors, core_currencies, core_languages (master)**

**LİFFY writes (liffy-db):** persons (canonical, includes leads/contacts via lifecycle_stage), affiliations, companies, opportunities, quotes, campaigns, sequences, email_events, action_items, lists, templates, sender_identities, tasks, meetings, call_logs, mining_jobs

**LEENA writes (leena_v401_db):** expos, visitors, checkins, forms, terminals, expo_halls, expo_stands, expo_stand_cells, expo_floorplan_versions, expo_exhibitors, email_queue (visitor emails), catalogues

**Reference data special case:** core_* tables exist in ALL THREE databases. Only ELIZA writes to its master copy. Sync worker (built end of Phase 1) pushes to LİFFY and LEENA replicas. During Phase 1, manual sync. LİFFY/LEENA never write to their core_* tables directly.

### R2: ELIZA Writes Authority Data (ADR-005)
ELIZA is the commercial system of record. It writes contracts, payments, master pricing data (products), and reference data (countries, sectors, currencies, languages). This is PERMANENT.

### R3: Company Entity Now in Phase 1 (ADR-014 UPDATED)
LİFFY uses `persons` + `affiliations` currently. Company entity migration is happening NOW (Phase 1) because Zoho replacement requires Company as first-class entity.

**Migration plan:**
- `persons` table STAYS — canonical entity for all people, no rename, no separate contacts table
- `persons.lifecycle_stage` enum added: 'lead', 'mql', 'sql', 'contact', 'customer'
- `companies` new table created with soft FK to local liffy-db.core_countries, core_sectors
- `affiliations.company_name` deduped and migrated to `companies` table
- `affiliations.company_id` FK added pointing to companies
- Quotes, opportunities, tasks reference both person_id and company_id

**No separate `contacts` or `leads` tables.** Lifecycle stages are filters/views on the persons table.

LEENA can have `expo_exhibitors` for floorplan stand assignment — will FK to LİFFY companies in Phase 2 via API integration (not direct DB FK, since separate DBs).

### R4: Hierarchical Data Visibility (ADR-015)
All user-scoped data uses `reports_to` recursive CTE for visibility:
- Owner (suer) sees everything
- Manager sees self + recursive team below
- Sales Rep sees self + recursive team below
- 4 roles: owner, manager, sales_rep, staff
- Granular permissions via `permissions` JSONB on users table
- Each system has its own users table; sync mechanism keeps them aligned

### R5: No Pipeline Kanban (Blueprint Forbidden Pattern)
LİFFY does NOT have a pipeline/kanban board. Action Screen is the homepage. If pipeline_stages table exists, it stays in DB but is NOT visible in UI.

### R6: Quote → Contract Flow (ADR-003)
Sales reps NEVER create contracts directly.
- LİFFY creates Quote (sales rep)
- ELIZA approves Quote (authorized manager via WhatsApp or dashboard)
- ELIZA creates Contract (AF number assigned)
- LEENA reads Contract for exhibitor activation (via API, not direct DB read)
This is the ONLY cross-system write flow.

### R7: Floorplan Ownership (ADR-007, ADR-010)
Floorplan tables owned by LEENA. Master floorplan managed by project team (Yaprak). Sales copies (Phase 2) will be in LİFFY — per-prospect copies for sales presentations. `company_id` and `contract_id` on expo_stands are nullable soft FK — application-level validation only (cross-DB, no constraint possible).

### R8: Separate Repos AND Separate Databases (ADR-002, ADR-017)
Three separate repos AND three separate PostgreSQL databases. Each system has its own API service:
- ELIZA: eliza-api, eliza-dashboard (eliza.elanfairs.com), eliza-bot — uses eliza-db
- LİFFY: liffy-api (api.liffy.app), liffy-ui (liffy.app), liffy-worker — uses liffy-db
- LEENA: leena web service (leena.app), leena-email-worker — uses leena_v401_db
Same JWT_SECRET across services.

### R9: Reference Data is the Foundation
All country, sector, currency, language fields MUST FK to core_* tables. No free-text fields for these. UI dropdowns populated from local DB's core_* tables only. Reference data is replicated across all three databases (manual during Phase 1, automated sync worker end of Phase 1). ELIZA is authoritative source.

---

## FORBIDDEN TERMS (ELL Glossary)
Never use these in code, UI, or documentation:
- ❌ "client" → use "Company" or "Exhibitor"
- ❌ "customer" → use "Company" or "Contact"
- ❌ "participant" → use "Visitor" or "Exhibitor"
- ❌ "account" → use "Company"
- ❌ "vendor" → use "Expo" or "Organizer"
- ❌ "shared database" → use "shared platform with three databases" or "ELL platform"

Correct terms:
- Company = legal entity (contract is with company)
- Contact = person at a company with lifecycle_stage='contact' or 'customer'
- Lead = person at a company with lifecycle_stage='lead'
- Sales Rep = employed salesperson (Bengü)
- Sales Agent = external partner (Sinerji, Anka)
- Expo = brand (SIEMA). Edition = yearly instance (SIEMA 2026)

---

## DECISION LOG (ADR Summary)

| ADR | Decision | Status |
|-----|----------|--------|
| 001 | ELIZA is commercial system of record | DECIDED |
| 002 | LİFFY/LEENA SaaS-ready, separate repos | DECIDED |
| 003 | Sales reps never create contracts (Quote→Contract) | DECIDED |
| 004 | ~~Shared database, schema-level ownership~~ — SUPERSEDED by ADR-017 | SUPERSEDED |
| 005 | ELIZA writes authority data (contracts, payments, products, reference data) — permanent | DECIDED |
| 006 | Transient agents LİFFY-only access | DECIDED |
| 007 | Floorplan owned by LEENA, consumed by LİFFY | DECIDED |
| 008 | Zoho exit target January 2027 | DECIDED |
| 009 | Sales adoption — Bengü pilot first | DECIDED |
| 010 | Floorplan dual-layer (Master LEENA + Sales Copies LİFFY) | DECIDED |
| 011 | Payment authority — CEO + Yaprak full, locals form-only | DECIDED |
| 012 | Historical migration — full 2014-2027 data (Sales Contracts only; Leads filtered) | DECIDED |
| 013 | SaaS long-term option, not priority | DECIDED |
| 014 | Company entity — UPDATED: now Phase 1 (was Phase 2) | UPDATED 2026-04-29 |
| 015 | Hierarchical data visibility — reports_to + permissions JSON | DECIDED |
| 016 | Reference data tables (countries, sectors, currencies, languages) owned by ELIZA | DECIDED 2026-04-29 |
| 017 | Per-system separate databases with reference data sync (manual during Phase 1, automated end of Phase 1) | DECIDED 2026-05-01 |
| 018 | Future database consolidation to single instance — Phase 3 (after fair season) | PLANNED 2026-05-01 |

Full ADR files: `eliza/docs/decisions/`

---

## WHEN IN DOUBT

If you're about to:
- Create a new table → check R1 (who owns it? which DB?)
- Create a `contacts` or `leads` table → STOP (R3 — use persons.lifecycle_stage)
- Add a country/sector/currency/language as text field → STOP (R9 — use FK to local core_*)
- Add cross-database FK constraint → STOP (R8 — impossible across separate DBs)
- Write to another system's table → STOP (R1 violation)
- Write to core_* tables in LİFFY/LEENA → STOP (only ELIZA writes, sync worker pushes)
- Add FK constraint to company_id/contract_id → STOP if Phase 2 work, else proceed (R7)
- Build a pipeline/kanban → STOP (R5)
- Let sales rep create a contract → STOP (R6)
- Use "client/customer/account" → STOP (Glossary)
- Add a feature that exists in Zoho → check Module Ownership Map first
- Need data from another system → API call, NOT direct DB query (R8)

Mark your message with **🔶 ELL onayı gerek** and tell the user to check with the ELIZA chat before proceeding.

---

## FILE STORAGE (temporary decision)
No shared file storage yet. Current approach:
- LEENA: Base64 → DB (banner images, small files) — currently 9.31% of leena_v401_db
- LİFFY: not needed yet
- ELIZA: not needed yet
When file storage needs grow (expo logos, exhibitor logos, catalogs, documents), a shared S3/Cloudinary solution will be implemented. ADR pending.
