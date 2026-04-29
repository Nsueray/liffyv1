# ELL_RULES.md — Cross-System Rules

> This file exists in all three ELL repos (eliza, liffyv1, Leena_v401_monorepo).
> It is the SAME file everywhere. If you update it, update all three copies.
> Last updated: 2026-04-29 (v3 — fixed table naming inconsistencies)

---

## What is ELL?

ELL = ELIZA + LİFFY + LEENA. Three systems, one platform, shared PostgreSQL.

- **ELIZA** — Commercial system of record. Owns contracts, payments, approvals, intelligence, WhatsApp bot, CEO dashboard, master pricing data.
- **LİFFY** — Sales action engine + CRM. Owns leads, companies, contacts, quotes, campaigns, sequences, action items, outreach. SaaS-ready (ADR-002). Will replace Zoho CRM by Jan 2027 (ADR-008).
- **LEENA** — Operations execution. Owns expos (master), visitors, floorplans, check-ins, badges, certificates, exhibitor scanning.

Repos: `eliza` (github.com/Nsueray/eliza), `liffyv1` (github.com/Nsueray/liffyv1), `Leena_v401_monorepo` (github.com/Nsueray/Leena_v401_monorepo)

---

## MODULE OWNERSHIP MAP (Zoho → ELL Migration)

This is the authoritative mapping of every Zoho module to its ELL system. Use this when migrating data, building features, or deciding where new functionality belongs.

### LİFFY (Sales Engine + CRM — replacing Zoho's sales side)

| Zoho Module | LİFFY Equivalent | Status |
|-------------|------------------|--------|
| Leads | persons WHERE lifecycle_stage='lead' | 75K imported |
| Contacts | persons WHERE lifecycle_stage IN ('contact','customer') | Phase 1 (now) |
| Companies | companies (NEW table) | Phase 1 (now) |
| Quotes | quotes | Phase 1 (now) |
| Potentials | opportunities | Phase 1 |
| Tasks | tasks | Exists |
| Meetings | meetings | Phase 1 |
| Calls | call_logs | Phase 1 (cold call tracking) |
| Campaigns | campaigns | Exists |
| Workqueue | action_items (Action Screen) | Exists |
| SalesInbox | Contact Drawer Timeline + reply detection | Exists |
| Social | social_engagement | Future |
| Voice of the Customer | reply_intelligence (sentiment + classification) | Future |
| New Leads | mining job results → auto-routed to users | Phase 2 |
| My Jobs | mining_jobs | Exists |

**Note:** Persons is the canonical entity. Lead/Contact/Customer are LIFECYCLE STAGES, not separate tables. State machine: lead → mql → sql → contact → customer. Convert = lifecycle_stage update + company_id assignment. This is the modern CRM model (HubSpot, Pipedrive). Zoho's lead/contact separation is legacy and unnecessary in ELL.

### ELIZA (System of Record + Intelligence)

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
- All other modules pull expo data from here

---

## ZOHO MIGRATION STRATEGY

### Lead Data (selective migration)

Zoho contains 585K leads. Most are dead data accumulated over years. Strategy:

1. **75K already imported to LİFFY** — these are the active working portfolio
2. **510K stay in Zoho as archive** — sales reps don't see them in LİFFY
3. **New leads enter LİFFY directly** — via mining (auto-routed) or manual data entry form
4. **Promotion path** — Zoho leads that respond, sign, or convert get migrated to LİFFY case-by-case
5. **January 2027 cutoff** — when Zoho is decommissioned, remaining 510K archived or deleted

This means LİFFY's `persons` table represents the active CRM, not a 1:1 copy of Zoho.

### Contact Data
Zoho 17,668 contacts. These are persons with lifecycle_stage='contact' in LİFFY (already in 75K imported).

### Company Data
Zoho ~17K companies. Migration: dedupe `affiliations.company_name` values → write to new `companies` table → update `affiliations.company_id` FK. One-time script.

### Quote/Sales Contract Data
Stays in Zoho currently. Read by ELIZA via existing Zoho sync. Quote creation moves to LİFFY in Phase 1. Sales Contract creation stays in ELIZA permanently (ADR-005). Full Zoho exit January 2027.

---

## CRITICAL RULES (never violate)

### R1: Data Ownership
Each table has exactly ONE owner system. Only the owner writes. Others may read.

**ELIZA writes:** contracts, contract_payments, users, permissions, audit_logs, products, expenses, invoices

**LİFFY writes:** persons (canonical, includes leads/contacts via lifecycle_stage), affiliations, companies, opportunities, quotes, campaigns, sequences, email_events, action_items, lists, templates, sender_identities, tasks, meetings, call_logs, mining_jobs

**LEENA writes:** expos, visitors, checkins, forms, terminals, expo_halls, expo_stands, expo_stand_cells, expo_floorplan_versions, expo_exhibitors, email_queue (visitor emails), catalogues

**Shared reads:** any system can SELECT from any table. Never INSERT/UPDATE/DELETE into another system's tables.

### R2: ELIZA Writes Authority Data (ADR-005)
ELIZA is the commercial system of record. It writes contracts, payments, and master pricing data (products). This is PERMANENT, not a transition arrangement.

### R3: Company Entity Now in Phase 1 (ADR-014 UPDATED)
LİFFY uses `persons` + `affiliations` currently. Company entity migration is happening NOW (Phase 1) because Zoho replacement requires Company as first-class entity.

**Migration plan:**
- `persons` table STAYS — canonical entity for all people, no rename, no separate contacts table
- `persons.lifecycle_stage` enum added: 'lead', 'mql', 'sql', 'contact', 'customer'
- `companies` new table created
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
| 005 | ELIZA writes authority data (contracts, payments, products) — permanent | DECIDED |
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

Full ADR files: `eliza/docs/decisions/`

---

## WHEN IN DOUBT

If you're about to:
- Create a new table → check R1 (who owns it?)
- Create a `contacts` or `leads` table → STOP (R3 — use persons.lifecycle_stage)
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
