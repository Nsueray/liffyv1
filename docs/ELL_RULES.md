# ELL_RULES.md — Cross-System Rules

> This file exists in all three ELL repos (eliza, liffyv1, Leena_v401_monorepo).
> It is the SAME file everywhere. If you update it, update all three copies.
> Last updated: 2026-04-29 (v4 — added reference data tables)

---

## What is ELL?

ELL = ELIZA + LİFFY + LEENA. Three systems, one platform, shared PostgreSQL.

- **ELIZA** — Commercial system of record. Owns contracts, payments, approvals, intelligence, WhatsApp bot, CEO dashboard, master pricing data, **reference data (countries, sectors, currencies, languages)**.
- **LİFFY** — Sales action engine + CRM. Owns leads, companies, contacts, quotes, campaigns, sequences, action items, outreach. SaaS-ready (ADR-002). Will replace Zoho CRM by Jan 2027 (ADR-008).
- **LEENA** — Operations execution. Owns expos (master), visitors, floorplans, check-ins, badges, certificates, exhibitor scanning.

Repos: `eliza` (github.com/Nsueray/eliza), `liffyv1` (github.com/Nsueray/liffyv1), `Leena_v401_monorepo` (github.com/Nsueray/Leena_v401_monorepo)

---

## REFERENCE DATA TABLES (CRITICAL — read this first)

Reference data is the foundation of cross-system data quality. "Türkiye" vs "Turkey" vs "TR" inconsistencies poison the entire platform. All three systems read from the same canonical reference tables.

**Owner:** ELIZA writes, LİFFY and LEENA read only.

### `core_countries`
ISO 3166 standard. Canonical country list used everywhere.

```sql
CREATE TABLE core_countries (
  code CHAR(2) PRIMARY KEY,           -- ISO 3166-1 alpha-2 (TR, NG, MA, KE)
  code3 CHAR(3) NOT NULL UNIQUE,      -- ISO 3166-1 alpha-3 (TUR, NGA, MAR, KEN)
  name_en VARCHAR(100) NOT NULL,      -- "Turkey", "Nigeria"
  name_tr VARCHAR(100),               -- "Türkiye", "Nijerya"
  name_fr VARCHAR(100),               -- "Turquie", "Nigéria"
  region VARCHAR(50),                 -- "Africa", "MENA", "Europe", "Asia"
  is_active BOOLEAN DEFAULT true
);
```

Seed: full ISO 3166 list (~250 countries).

### `core_sectors`
Hierarchical industry classification. Parent-child relationships.

```sql
CREATE TABLE core_sectors (
  id SERIAL PRIMARY KEY,
  parent_id INTEGER REFERENCES core_sectors(id),
  slug VARCHAR(100) UNIQUE NOT NULL,  -- "hvac", "interior-design", "home-decoration"
  name_en VARCHAR(100) NOT NULL,
  name_tr VARCHAR(100),
  name_fr VARCHAR(100),
  level INTEGER NOT NULL,             -- 1=top, 2=mid, 3=detail
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true
);
```

Example hierarchy:
```
HVAC & Refrigeration (level 1)
├── Air Conditioning (level 2)
├── Refrigeration (level 2)
└── Ventilation (level 2)

Furniture & Decoration (level 1)
├── Interior Design (level 2)
├── Home Decoration (level 2)
├── Office Furniture (level 2)
├── Kitchen & Bath (level 2)
└── Lighting (level 2)

Construction & Building (level 1)
├── Building Materials (level 2)
├── Construction Equipment (level 2)
└── Architecture & Engineering (level 2)
```

Seed: Elan Expo's actual sectors (HVAC, Construction, Food Processing, Furniture, Ceramics, Water/Wastewater, Plastics, Electricity, etc.) — derived from current Zoho sector list, manually curated.

### `core_currencies`
Active currencies used in contracts, quotes, payments.

```sql
CREATE TABLE core_currencies (
  code CHAR(3) PRIMARY KEY,           -- ISO 4217 (EUR, USD, TRY, NGN, MAD, KES, DZD, GHS)
  name_en VARCHAR(50) NOT NULL,
  symbol VARCHAR(5),                  -- €, $, ₺, ₦
  is_active BOOLEAN DEFAULT true
);
```

Seed: EUR, USD, TRY, NGN, MAD, KES, DZD, GHS (Elan Expo's operating currencies).

### `core_languages`
Languages used for communication, email templates, UI.

```sql
CREATE TABLE core_languages (
  code CHAR(2) PRIMARY KEY,           -- ISO 639-1 (en, tr, fr, ar, es, de)
  name_en VARCHAR(50) NOT NULL,
  name_native VARCHAR(50)             -- "Türkçe", "Français", "العربية"
);
```

Seed: en, tr, fr, ar (Elan Expo's primary communication languages).

### Usage rules

**Every text-typed country/sector/currency/language field is being deprecated.** New tables and migrations MUST use FK to `core_*` tables:

- `companies.country_code` (CHAR(2) FK to core_countries.code)
- `companies.sector_id` (INTEGER FK to core_sectors.id)
- `persons.preferred_language_code` (CHAR(2) FK to core_languages.code)
- `quotes.currency_code` (CHAR(3) FK to core_currencies.code)
- `contracts.currency_code` (CHAR(3) FK to core_currencies.code)
- `expos.country_code` (CHAR(2) FK to core_countries.code)

Migration plan:
- Old text fields kept temporarily during transition (e.g., `affiliations.industry` → `affiliations.sector_id` via mapping script)
- After Phase 1 migration, text fields dropped
- All UI dropdowns populated from `core_*` tables only

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

### ELIZA (System of Record + Intelligence + Reference Data)

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
| (NEW) Reference Data | core_countries, core_sectors, core_currencies, core_languages | Master ref data — read by all systems |

### LEENA (Operations + Events)

| Zoho Module | LEENA Equivalent | Notes |
|-------------|------------------|-------|
| Expos | expos | **Master expo data — created here, read by ALL systems** |
| Visitors | visitors | Visitor management |
| Visits | visits | Visit tracking |
| Catalogues | catalogues | Phase 2 |
| Check in Logs | checkins | Existing |
| Stand Leads | exhibitor_leads | Existing |
| Member Companies | (linked to expos) | Future |

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

### Special Cases (Master Data — Cross-System Reads)

**Reference Data (countries, sectors, currencies, languages):**
- Owned by ELIZA (writes via migration scripts and admin UI)
- Read by LİFFY and LEENA via SELECT only
- Single source of truth for all dropdowns and FK references
- See "REFERENCE DATA TABLES" section above

**Products (master pricing data):**
- Owned by ELIZA (writes)
- Read by LİFFY (when creating Quotes — stand types, registration fees, agent commissions)
- Read by LEENA (when displaying stand prices to exhibitors)
- Single source of truth for pricing across all three systems

**Expos (master expo data):**
- Owned by LEENA (writes — Yaprak/operations creates the expo)
- Read by LİFFY (Quote creation needs expo info)
- Read by ELIZA (Contracts, dashboard, intelligence queries reference expo)
- Single source of truth for expo definitions

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
Each table has exactly ONE owner system. Only the owner writes. Others may read.

**ELIZA writes:** contracts, contract_payments, users, permissions, audit_logs, products, expenses, invoices, **core_countries, core_sectors, core_currencies, core_languages**

**LİFFY writes:** persons (canonical, includes leads/contacts via lifecycle_stage), affiliations, companies, opportunities, quotes, campaigns, sequences, email_events, action_items, lists, templates, sender_identities, tasks, meetings, call_logs, mining_jobs

**LEENA writes:** expos, visitors, checkins, forms, terminals, expo_halls, expo_stands, expo_stand_cells, expo_floorplan_versions, expo_exhibitors, email_queue (visitor emails), catalogues

**Shared reads:** any system can SELECT from any table. Never INSERT/UPDATE/DELETE into another system's tables.

### R2: ELIZA Writes Authority Data (ADR-005)
ELIZA is the commercial system of record. It writes contracts, payments, master pricing data (products), and reference data (countries, sectors, currencies, languages). This is PERMANENT.

### R3: Company Entity Now in Phase 1 (ADR-014 UPDATED)
LİFFY uses `persons` + `affiliations` currently. Company entity migration is happening NOW (Phase 1) because Zoho replacement requires Company as first-class entity.

**Migration plan:**
- `persons` table STAYS — canonical entity for all people, no rename, no separate contacts table
- `persons.lifecycle_stage` enum added: 'lead', 'mql', 'sql', 'contact', 'customer'
- `companies` new table created with FK to core_countries, core_sectors
- `affiliations.company_name` deduped and migrated to `companies` table
- `affiliations.company_id` FK added pointing to companies
- Quotes, opportunities, tasks reference both person_id and company_id

**No separate `contacts` or `leads` tables.** Lifecycle stages are filters/views on the persons table.

LEENA can have `expo_exhibitors` for floorplan stand assignment — will FK to LİFFY companies in Phase 2.

### R4: Hierarchical Data Visibility (ADR-015)
All user-scoped data uses `reports_to` recursive CTE for visibility:
- Owner (suer) sees everything
- Manager sees self + recursive team below
- Sales Rep sees self + recursive team below
- 4 roles: owner, manager, sales_rep, staff
- Granular permissions via `permissions` JSONB on users table
- This applies to ALL three systems (same users table)

### R5: No Pipeline Kanban (Blueprint Forbidden Pattern)
LİFFY does NOT have a pipeline/kanban board. Action Screen is the homepage. If pipeline_stages table exists, it stays in DB but is NOT visible in UI.

### R6: Quote → Contract Flow (ADR-003)
Sales reps NEVER create contracts directly.
- LİFFY creates Quote (sales rep)
- ELIZA approves Quote (authorized manager via WhatsApp or dashboard)
- ELIZA creates Contract (AF number assigned)
- LEENA reads Contract for exhibitor activation
This is the ONLY cross-system write flow.

### R7: Floorplan Ownership (ADR-007, ADR-010)
Floorplan tables owned by LEENA. Master floorplan managed by project team (Yaprak). Sales copies (Phase 2) will be in LİFFY — per-prospect copies for sales presentations. `company_id` and `contract_id` on expo_stands are nullable FK — do NOT add FK constraints until Phase 2.

### R8: Separate Repos (ADR-002)
Three separate repos. Do NOT merge into monorepo. Each system has its own API service:
- ELIZA: eliza-api, eliza-dashboard (eliza.elanfairs.com), eliza-bot
- LİFFY: liffy-api (api.liffy.app), liffy-ui (liffy.app), liffy-worker
- LEENA: leena web service (leena.app), leena-email-worker
Shared PostgreSQL database. Same JWT_SECRET across services.

### R9: Reference Data is the Foundation
NEW. All country, sector, currency, language fields MUST FK to core_* tables. No free-text fields for these. UI dropdowns populated from core_* tables only. This rule applies retroactively — old text fields will be migrated in Phase 1.

---

## FORBIDDEN TERMS (ELL Glossary)
Never use these in code, UI, or documentation:
- ❌ "client" → use "Company" or "Exhibitor"
- ❌ "customer" → use "Company" or "Contact"
- ❌ "participant" → use "Visitor" or "Exhibitor"
- ❌ "account" → use "Company"
- ❌ "vendor" → use "Expo" or "Organizer"

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
| 004 | Shared database, schema-level ownership | DECIDED |
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

Full ADR files: `eliza/docs/decisions/`

---

## WHEN IN DOUBT

If you're about to:
- Create a new table → check R1 (who owns it?)
- Create a `contacts` or `leads` table → STOP (R3 — use persons.lifecycle_stage)
- Add a country/sector/currency/language as text field → STOP (R9 — use FK to core_*)
- Write to another system's table → STOP (R1 violation)
- Add FK constraint to company_id/contract_id → STOP if Phase 2 work, else proceed (R7)
- Build a pipeline/kanban → STOP (R5)
- Let sales rep create a contract → STOP (R6)
- Use "client/customer/account" → STOP (Glossary)
- Add a feature that exists in Zoho → check Module Ownership Map first

Mark your message with **🔶 ELL onayı gerek** and tell the user to check with the ELIZA chat before proceeding.

---

## FILE STORAGE (temporary decision)
No shared file storage yet. Current approach:
- LEENA: Base64 → DB (banner images, small files)
- LİFFY: not needed yet
- ELIZA: not needed yet
When file storage needs grow (expo logos, exhibitor logos, catalogs, documents), a shared S3/Cloudinary solution will be implemented. ADR pending.
