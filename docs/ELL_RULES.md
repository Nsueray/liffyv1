# ELL_RULES.md — Cross-System Rules

> This file exists in all three ELL repos (eliza, liffyv1, Leena_v401_monorepo).
> It is the SAME file everywhere. If you update it, update all three copies.
> Last updated: 2026-04-17

---

## What is ELL?

ELL = ELIZA + LİFFY + LEENA. Three systems, one platform, shared PostgreSQL.

- **ELIZA** — Commercial system of record. Owns contracts, payments, approvals, intelligence, WhatsApp bot, CEO dashboard.
- **LİFFY** — Sales action engine. Owns leads, campaigns, sequences, action items, outreach. SaaS-ready (ADR-002).
- **LEENA** — Operations execution. Owns expos, visitors, floorplans, check-ins, badges, certificates.

Repos: `eliza` (github.com/Nsueray/eliza), `liffyv1` (github.com/Nsueray/liffyv1), `Leena_v401_monorepo` (github.com/Nsueray/Leena_v401_monorepo)

---

## CRITICAL RULES (never violate)

### R1: Data Ownership
Each table has exactly ONE owner system. Only the owner writes. Others may read.
- ELIZA writes: contracts, contract_payments, users, permissions, audit_logs
- LİFFY writes: persons, affiliations, campaigns, sequences, email_events, action_items, lists, templates, sender_identities
- LEENA writes: expos, visitors, checkins, forms, terminals, expo_halls, expo_stands, expo_stand_cells, expo_floorplan_versions, expo_exhibitors, email_queue (visitor emails)
- Shared reads: any system can SELECT from any table. Never INSERT/UPDATE/DELETE into another system's tables.

### R2: ELIZA Writes Authority Data (ADR-005)
ELIZA is the commercial system of record. It writes contracts and payments. This is PERMANENT, not a transition arrangement. Do not write "ELIZA read-only" or "temporary write path" anywhere.

### R3: No Company Entity Yet (ADR-014)
LİFFY uses `persons` + `affiliations` (person-centric model). There is NO `companies` table yet. Do NOT create a `companies` table in LİFFY. Company entity migration happens in Phase 2 (Quote implementation). LEENA can create `expo_exhibitors` for floorplan stand assignment — this is separate and will be linked via FK in Phase 2.

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
Sales reps NEVER create contracts directly. Flow: LİFFY creates Quote → ELIZA approves → ELIZA creates Contract. This is the ONLY cross-system write flow.

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
- Contact = person at a company (may change companies)
- Lead = unqualified data (no relationship yet)
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
| 005 | ELIZA writes authority data (contracts, payments) — permanent | DECIDED |
| 006 | Transient agents LİFFY-only access | DECIDED |
| 007 | Floorplan owned by LEENA, consumed by LİFFY | DECIDED |
| 008 | Zoho exit target January 2027 | DECIDED |
| 009 | Sales adoption — Bengü pilot first | DECIDED |
| 010 | Floorplan dual-layer (Master LEENA + Sales Copies LİFFY) | DECIDED |
| 011 | Payment authority — CEO + Yaprak full, locals form-only | DECIDED |
| 012 | Historical migration — full 2014-2027 data | DECIDED |
| 013 | SaaS long-term option, not priority | DECIDED |
| 014 | Person-centric model limitation — fix in Phase 2 with Company entity | DECIDED |
| 015 | Hierarchical data visibility — reports_to + permissions JSON | DECIDED |

Full ADR files: `eliza/docs/decisions/`

---

## WHEN IN DOUBT

If you're about to:
- Create a new table → check R1 (who owns it?)
- Write to another system's table → STOP (R1 violation)
- Create a companies table → STOP (R3, Phase 2)
- Add FK constraint to company_id/contract_id → STOP (R7, Phase 2)
- Build a pipeline/kanban → STOP (R5)
- Let sales rep create a contract → STOP (R6)
- Use "client/customer/account" → STOP (Glossary)

Mark your message with **🔶 ELL onayı gerek** and tell the user to check with the ELIZA chat before proceeding.

---

## FILE STORAGE (temporary decision)
No shared file storage yet. Current approach:
- LEENA: Base64 → DB (banner images, small files)
- LİFFY: not needed yet
- ELIZA: not needed yet
When file storage needs grow (expo logos, exhibitor logos, catalogs), a shared S3/Cloudinary solution will be implemented. ADR pending.
