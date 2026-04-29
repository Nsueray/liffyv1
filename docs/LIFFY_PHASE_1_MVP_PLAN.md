# LIFFY Phase 1 MVP Implementation Plan

> **Status:** APPROVED — Implementation guide
> **Date:** 2026-04-29
> **Owner:** Suer Ay
> **Duration:** 10 weeks (9 weeks code + 1 week observation, before Phase 1.5)
> **Authority:** ELL_RULES.md v4 (R1-R9, ADR-016) + LIFFY_ARCHITECTURE_BLUEPRINT.md
> **Goal:** LİFFY becomes a real Zoho replacement for sales reps (Companies + Contacts + Leads + outreach + Action)

---

## 0. Context — Why this plan exists

LİFFY's technical foundation is real (mining engine, campaign engine, reply detection, Action Engine, hierarchical isolation, ~75K records imported from Zoho). But the product is incoherent: sales reps don't use it as their daily tool because it lacks the CRM primitives Zoho provides — Company entity, Lead/Contact lifecycle, clean data model.

This Phase 1 MVP closes that gap. It is **not a rewrite**. It is **completion of Blueprint Phase 1** with three corrections informed by the April 2026 review:

1. **Company entity now Phase 1** (ADR-014 updated 2026-04-29) — was Phase 2
2. **Reference data tables** added as foundation (countries, sectors, currencies, languages)
3. **Quote deferred** to Phase 1.5 — too domain-specific (M2, agent commissions, payment terms) to bundle with foundational work

After Phase 1 MVP, sales reps can use LİFFY for everything except Quote/Contract creation (which still happens in Zoho). Phase 1.5 closes the Quote gap. Phase 2 retires Zoho fully (target: January 2027 per ADR-008).

---

## 1. Scope

### IN scope (this plan)

- Reference data tables (countries, sectors, currencies, languages) — written by ELIZA, read by LİFFY/LEENA
- `companies` table (NEW) — first-class entity, replaces affiliations.company_name string
- `persons.lifecycle_stage` enum — `lead | mql | sql | contact | customer`
- Lead → Contact conversion flow (lifecycle_stage update + company_id assignment)
- Company detail page (Zoho parity)
- Contact detail page enrichment (lifecycle stage, company link, similar contacts)
- UI sidebar reboot — collapse to: Today, Portfolio, Discover (admin), Settings
- Auto-assignment routing for new mining results (sector/country → user)
- Public data entry form URL (`/data-entry/:token`) for freelancers/data-entry staff
- Documentation updates (CLAUDE_DB.md, CLAUDE_FEATURES.md, LIFFY_TODO.md)

### OUT of scope (later phases)

- Quote module → Phase 1.5
- Sales Contract → ELIZA writes (R2, ADR-005), Phase 2 in ELIZA
- WhatsApp channel → Phase 2 (RFC_WhatsApp_Channel.md)
- Phase 6 Conversations/Inbox → after E1 legacy removal
- Floorplan sales copies → Phase 2 (ADR-010)
- AI-powered lead scoring → Phase 3
- Reply intelligence (sentiment classification) → Phase 2

### NOT this plan's job

- ELIZA changes → coordinate with ELL chat
- LEENA changes → coordinate with ELL chat
- Zoho data sync changes (current sync continues)

---

## 2. Architecture decisions enforced by this plan

| ID | Decision | Source |
|---|---|---|
| D1 | `persons` is canonical entity, no separate `contacts` or `leads` tables | ELL chat 2026-04-29 |
| D2 | `lifecycle_stage` enum on persons | ELL chat 2026-04-29 |
| D3 | `companies` is new first-class entity | ADR-014 updated |
| D4 | Reference data (countries, sectors, currencies, languages) owned by ELIZA, FK from all systems | ELL_RULES R1, R9, ADR-016 |
| D5 | Sectors hierarchical (`parent_id` self-FK), country PK is ISO `code CHAR(2)` | ELL_RULES v4 |
| D6 | Sales reps never create contracts | ELL_RULES R6, ADR-003 |
| D7 | No pipeline kanban in UI | ELL_RULES R5 |
| D8 | Hierarchical visibility via reports_to recursive CTE | ELL_RULES R4, ADR-015 |
| D9 | 510K Zoho leads stay in Zoho until Jan 2027 | Suer 2026-04-29 |
| D10 | Forbidden terms: client/customer/account → Company/Contact | ELL_RULES Glossary |
| D11 | Mining stays admin-only, results auto-routed to sales reps | Suer 2026-04-29 |
| D12 | Public data entry form, not integrated with sales rep UI | Suer + 3 AI consensus |
| D13 | 1-week observation period between Phase 1 and Phase 1.5 | ELL chat 2026-04-29 |
| D14 | Auto-assignment seed rules in migration script (DB), not hardcoded | ELL chat 2026-04-29 |

---

## 3. Phase plan — 9 weeks

| Week | Focus | Owner | Deliverable | Dependencies |
|------|-------|-------|-------------|--------------|
| 1 | Track A: Reference tables (ELIZA repo) | ELL chat writes prompt → ELIZA Claude Code | core_countries/sectors/currencies/languages tables created + seeded | None |
| 1 | Track B: companies table (LİFFY repo) | Suer → LİFFY Claude Code | companies table created (empty), affiliations.company_id added | Track A SQL types known |
| 2 | Migration: affiliations → companies | LİFFY | ~17K companies populated, affiliations linked via company_id | Week 1 (both tracks) done |
| 3 | persons.lifecycle_stage + convert flow | LİFFY | All persons have lifecycle_stage, convert API works | Week 2 done |
| 4 | Company detail page | LİFFY | `/companies/:id` page complete (Zoho parity) | Week 3 done |
| 5 | Contact detail page enrichment | LİFFY | `/contacts/:id` page complete (lifecycle, company link, similar) | Week 4 done |
| 6 | UI sidebar reboot — Today, Portfolio | LİFFY | New sidebar live, Today=homepage, Portfolio dashboard | Week 5 done |
| 7 | UI sidebar reboot — Discover (admin), Settings | LİFFY | Mining moved to admin, Settings consolidated | Week 6 done |
| 8 | Auto-assignment routing | LİFFY | Mining results auto-route to user by sector/country rules | Week 7 done |
| 9 | Public data entry form | LİFFY | `/data-entry/:token` form deployed, freelancer-ready | Week 8 done |
| 10 | **Observation week** (no code) | Suer + Elif | Real-use feedback collected, issue list for Phase 1.5 | Week 9 done |

**Buffer:** No buffer. If a week slips, Phase 1.5 (Quote) start date slips correspondingly. Do not fast-forward; foundations must be solid.

**Parallel tracks:** ELIZA reference tables (Week 1) can be done by ELL chat / Eliza Claude Code in parallel with LİFFY companies table prep.

---

## 4. Each week — detailed implementation

Each week has:
1. **Goal** — what's true at the end of the week
2. **Files touched** — exact files (use as Claude Code prompt scope)
3. **Migration scripts** — SQL filenames and contents
4. **API endpoints** — new or modified routes
5. **UI changes** — pages and components
6. **Acceptance criteria** — how to verify
7. **Claude Code prompt** — paste-ready prompt to execute the week

See `LIFFY_PHASE_1_WEEKLY_PROMPTS.md` (companion file) for executable Claude Code prompts.

---

## 5. Open questions / risks

### Risk 1: Sector dedup quality (Week 2)
Current `affiliations.industry` is messy: "Furniture", "furniture", "Mobilya", "Decor", "decoration", "Home Décor". Migration must map all variants to canonical `core_sectors.id`. If mapping is wrong, similar-companies feature gives garbage.

**Mitigation:** Manual review of top 100 sector strings before mapping. Map remaining via fuzzy match + AI assist. Unmapped (>5% threshold) → flag for human review.

### Risk 2: Company dedup quality (Week 2)
"Bosch GmbH", "BOSCH", "Bosch Türkiye" — same company or different? Migration must decide. Conservative approach: merge only on exact match (after normalization). Aggressive merge can lose data; conservative leaves duplicates that humans clean later.

**Mitigation:** Conservative merge in Week 2. Add "merge companies" tool in admin UI for human cleanup later.

### Risk 3: Lifecycle stage backfill (Week 3)
75K persons currently have no lifecycle_stage. Default value? Two options:
- (a) All persons start as `lead` (conservative)
- (b) Persons with replied=true → `contact`, persons in active campaigns → `mql`, rest → `lead` (smart)

**Mitigation:** Use (b) — smart backfill leverages existing campaign_events data. SQL provided in Week 3.

### Risk 4: UI reboot user shock (Week 6-7)
Current UI has 12-15 sidebar items. New UI has 4. Even if users don't love current UI, sudden change can disorient.

**Mitigation:** Deploy on a Friday evening. Send Elif a 5-line "what changed" email Monday morning. Monitor first 3 days for confused questions.

### Risk 5: Auto-assignment rules (Week 8)
"Sector=HVAC → Elif" works only if HVAC is a single canonical sector. Reference tables (Week 1) make this possible. But what if a person has 2 affiliations, one HVAC one Construction? Which sales rep wins?

**Mitigation:** Primary affiliation rule (most recent OR highest engagement). Default tiebreak: country rule wins over sector rule. Log every assignment decision for audit.

### Risk 6: Form URL abuse (Week 9)
Public form URL accepts data from anyone with the link. Spam risk.

**Mitigation:** Token-based URL (`/data-entry/abc123xyz`), rate limit per IP, CAPTCHA on submit, all submissions go to "review queue" (lifecycle_stage='lead', requires sales rep confirmation before becoming contact).

---

## 6. Success criteria — Phase 1 MVP done when:

1. Sales rep can search any of 17K+ companies in LİFFY → Company detail page shows all contacts, campaigns, replies, last activity
2. Sales rep can convert a Lead to Contact in LİFFY without going to Zoho — convert button assigns company_id, updates lifecycle_stage, creates audit log entry
3. New mining results auto-appear in correct sales rep's Portfolio without admin intervention
4. Data entry freelancer can enter 30 companies in 45 minutes via form URL with no LİFFY login
5. Sales rep opens LİFFY → sees Today (Action items), Portfolio (their numbers), nothing else they don't need
6. All persons have lifecycle_stage set, all affiliations have company_id set, all companies have country_id + sector_id set (or explicitly null with reason)
7. Forbidden terms (client/customer/account) return zero matches in `liffyv1` and `liffy-ui` codebases (`grep -ri "customer\|client\|account" --include="*.js" --include="*.tsx"` excluding node_modules)

---

## 7. After Phase 1 MVP

### Phase 1.5 — Quote module (estimated 4-6 weeks, starts after Week 10 observation)
- 1-week observation period between Phase 1 (Week 9) and Phase 1.5 start (Week 11). Suer + Elif use LİFFY for real work, collect issue list. This is feedback-driven, not AI-suggested.
- `quotes` table per Blueprint
- Quote creation UI (PES product codes, RF registration fees, M2, agent commissions, payment terms)
- Quote PDF generation
- Quote → ELIZA approval flow (WhatsApp via ELIZA bot)
- AF number assignment via PostgreSQL SEQUENCE on approval

### Phase 2 — Zoho retirement (October 2026 → January 2027)
- ELIZA writes Sales Contracts (per ADR-005)
- LEENA reads contracts for exhibitor activation
- Zoho goes read-only
- Final lead migration decision (the 510K — keep, archive, or delete)

### Phase 3 — Multi-channel + AI (2027)
- WhatsApp channel (per RFC_WhatsApp_Channel.md)
- Reply intelligence (sentiment classification)
- AI-powered lead scoring
- Phase 6 Conversations/Inbox

---

## 8. Document maintenance

When this plan changes, update:
- This file (`LIFFY_PHASE_1_MVP_PLAN.md`) — version bump
- `LIFFY_PHASE_1_WEEKLY_PROMPTS.md` — Claude Code prompts
- `LIFFY_TODO.md` — task tracker
- `ELL_RULES.md` (if cross-system impact) — coordinate via ELL chat

---

## 9. References

- ELL_RULES.md — cross-system rules (R1-R8)
- LIFFY_ARCHITECTURE_BLUEPRINT.md — full architecture (Phase 1A/1B/1C originally defined)
- LIFFY_ASE_v2.md — long-term vision (Autonomous Sales Engine)
- ADRs in `eliza/docs/decisions/` — particularly ADR-003 (Quote/Contract), ADR-005 (ELIZA authority), ADR-014 (Company entity, updated), ADR-015 (hierarchical visibility)
- This plan supersedes the "Yol A" UI reboot proposal from earlier 2026-04-29 conversation
