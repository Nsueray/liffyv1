# ELL Glossary & Entity Model

> The official language of the ELL Platform.
> Every system (ELIZA, LİFFY, LEENA) uses these terms exactly as defined here.
> No module may rename, redefine, or create alternative terms.

**Version:** 1.1
**Date:** 2026-04-10
**Owner:** Suer Ay

---

## Why This Exists

Three systems, one business. If ELIZA calls it "Company", LİFFY calls it "Lead", and LEENA calls it "Exhibitor" — but they're all talking about the same firm — the data breaks, the reports lie, and the team loses trust. This glossary prevents that.

---

## Core Entities

### Company

A legal or commercial entity — current client, past client, or potential client.

- Exists **once** in the system, never duplicated
- Data owner: **ELIZA** (core.companies)
- Used by: all three systems
- Examples: Coca-Cola Nigeria, LG Electronics, a local distributor in Morocco
- Note: "client", "customer", "müşteri", "firma" are informal — in code and UI, always **Company**

### Contact

A **person** at a Company. Name, email, phone, job title.

- Always linked to a Company (a Contact without a Company is invalid)
- Data owner: **ELIZA** (core.contacts)
- Used by: LİFFY (outreach), LEENA (exhibitor communication), ELIZA (reporting)
- Note: Contact ≠ Company. Contact is the person, Company is the organization.

### Lead

Raw, unqualified data — a company, person, or email address that we know little about. We haven't engaged with them yet. They might not even be relevant.

- Data owner: **LİFFY** (sales.leads)
- A Lead becomes a Company + Contact once we know enough about them
- Note: In LİFFY's current codebase, "contact" is used for mined data. Going forward, unqualified mined data = **Lead**, qualified/known = **Contact** linked to **Company**

### Prospect

A Lead that has shown interest — they responded to a campaign, replied to an email, or engaged in some way. We're in communication but haven't done business yet.

- **Not a separate entity/table** — Prospect is a pipeline stage within Opportunity, not its own data model
- A Lead graduates to Prospect status when engagement is confirmed
- Note: This is a LİFFY-specific stage label. ELIZA and LEENA don't use this term.

### Opportunity

An active sales discussion with a Company for a specific Expo. There's a real chance of a deal.

- Data owner: **LİFFY** (sales.opportunities)
- Stages: contacted → interested → negotiation → won/lost
- When "won" → a Quote is created and submitted to ELIZA for approval
- Note: Opportunity is always tied to a specific Expo Edition

### Quote

A sales proposal — proposed stand size, price, expo, and terms. Created by a Sales Rep in LİFFY.

- Data owner: **LİFFY** (sales.quotes), submitted to **ELIZA** for approval
- A Quote is NOT a Contract — it becomes a Contract only after approval by an authorized manager
- Sales Reps create Quotes. They never create Contracts. (see ADR-003)

### Contract

A signed or approved commercial agreement between Elan Expo and a Company.

- Data owner: **ELIZA** (core.contracts)
- Created only through the Quote → Approval → Contract workflow
- A Contract is NOT just "a stand sale." It can be:
  - **Stand contract** — company buys exhibition space (most common, ~70%)
  - **Sponsorship contract** — company sponsors the expo but may have no stand
  - **Equipment/service contract** — additional services for an existing exhibitor
  - **Pavilion agent contract** — an agent (e.g., China agent) buys 100m² and brings 10 companies inside
- Statuses: Draft, Valid, Transferred In, Transferred Out, Cancelled, On Hold
- Note: 1 Contract ≠ 1 Exhibitor (see Exhibitor definition)

### Payment Schedule

The planned payment timeline for a Contract — when each installment is due, how much, in what currency.

- Data owner: **ELIZA** (core.payment_schedules)

### Payment

Actual money received against a Contract.

- Data owner: **ELIZA** (core.payments)
- Currencies: EUR (primary), NGN, MAD, KES (local offices)
- Local currency payments are recorded with original amount + exchange rate + EUR equivalent

### Exhibitor

A Company that is contractually confirmed to participate in a specific Expo Edition. They have a valid contract and are expected to be present at the event (though no-shows and late cancellations can occur).

- Data owner: **LEENA** (ops.exhibitors)
- **Exhibitor is NOT a separate company** — it's a Company in the state of "participating in this expo"
- Relationship to Contract is **not always 1:1:**
  - Usually: 1 Contract = 1 Exhibitor (company bought their own stand)
  - Pavilion exception: 1 Contract (agent) = multiple Exhibitors (agent's clients)
  - Sponsor exception: 1 Contract = 0 Exhibitors (sponsor has no stand)
  - Equipment exception: 1 Exhibitor may have multiple Contracts (stand + equipment + sponsorship)

### Stand

Physical exhibition space assigned to an Exhibitor at an Expo.

- Data owner: **LEENA** (ops.stands)
- Types:
  - **Stand** — general term for any exhibition space (this is the default term)
  - **Booth** (shell scheme) — smaller, standard-built stand with basic walls/structure provided by organizer
  - **Space only** — raw floor space, exhibitor builds their own stand
- Measured in m² (square meters)
- Note: Use "Stand" as the default in code and UI. "Booth" and "Space only" are subtypes.

---

## Event Entities

### Expo

An exhibition brand owned by Elan Expo. This is the recurring event identity.

- Data owner: **ELIZA** (core.expos)
- Examples: SIEMA, Mega Clima, Madesign, Foodexpo, Buildexpo
- An Expo has multiple Editions over the years
- Other languages: Fuar (Turkish), Salon (French), Exhibition (formal English)
- In code and UI: always **Expo**

### Edition

A specific yearly occurrence of an Expo. This is the actual event that happens on a date.

- Data owner: **ELIZA** (core.expo_editions)
- Examples: SIEMA 2026, Mega Clima Nigeria 2025
- Has: start_date, end_date, venue, country, city
- Critical business rule: **Fiscal year ≠ Edition year** — sales for SIEMA 2026 may start in 2024
- Technical note: In database, use `expos` for the brand and `expo_editions` for the yearly instance. This prevents confusion when "expo" could mean either.

### Cluster

A group of Expos held in the same city and time period, sharing venue and logistics.

- Examples: Casablanca Cluster (SIEMA, Madesign, Lighting, Horeca, Ceramica)
- Not a separate entity in DB — derived from Expos sharing dates and venue

---

## People Entities

### Sales Rep (Sales Representative)

A person employed by Elan Expo who sells exhibition space. They are staff — on payroll, with an office.

- Examples: Bengü, Elif, Emircan, Joanna
- Works in: **LİFFY** (creates leads, sends campaigns, manages pipeline, creates quotes)
- Access to ELIZA: limited or none (see ADR-006)
- Note: Sales Rep ≠ Sales Agent

### Sales Agent

An external company or individual who sells Elan Expo's exhibition space on a commission basis. They are **partners, not employees.**

- Examples: Sinerji Fuarcılık, Anka Fuarcılık, individual agents in China
- May sell as pavilion (buy bulk space, fill with their own clients) or individual stands
- In Zoho: stored in Sales_Agents module
- Note: Sales Agent ≠ Sales Rep. Agent is external/partner. Rep is internal/employee.

### Country Manager

An Elan Expo manager responsible for a specific country office.

- Examples: Jude (Nigeria)
- Has country-scoped access across systems

### Project Manager

Manages expo operations — contract approval, exhibitor management, floorplan coordination.

- Example: Yaprak
- Has contract approval authority in ELIZA and full access in LEENA

---

## Floorplan Terms

### Master Floorplan

The official expo layout — aisles, islands, corridors, confirmed exhibitors. Owned by the project team (Yaprak).

- Data owner: **LEENA**
- Sales Reps **cannot** modify this
- Source of truth for stand assignment and operations

### Sales Floorplan

A customized copy of the floorplan that a Sales Rep creates for a specific prospect.

- Data owner: **LİFFY** (future, Phase 2-3)
- Cloned from a template provided by the project team
- Sales Reps can add/remove/move exhibitors freely in their copy
- Used as a sales tool — e.g., showing Pepsi that Coca-Cola is "already there"
- Each Sales Rep may have hundreds of these per expo

---

## The Entity Chain

This is the lifecycle of a company in the ELL system:

```
Lead (unknown data, LİFFY)
  ↓ qualified
Contact + Company (known entity, ELIZA)
  ↓ engaged
Prospect (interested, LİFFY)
  ↓ active discussion
Opportunity (negotiating, LİFFY)
  ↓ deal proposed
Quote (submitted to ELIZA for approval)
  ↓ approved by authorized manager
Contract (signed agreement, ELIZA)
  ↓ exhibitor activated
Exhibitor (participating in expo, LEENA)
  ↓ stand assigned
Stand (physical space, LEENA)
```

---

## Data Ownership Summary

| Entity | Owner System | Owner Schema | Other Systems |
|--------|-------------|-------------|---------------|
| Company | ELIZA | core | LİFFY reads, LEENA reads |
| Contact | ELIZA | core | LİFFY reads, LEENA reads |
| Lead | LİFFY | sales | ELIZA reads |
| Prospect | LİFFY | sales | — |
| Opportunity | LİFFY | sales | ELIZA reads |
| Quote | LİFFY | sales | ELIZA reads + approves |
| Contract | ELIZA | core | LİFFY reads status, LEENA reads |
| Payment Schedule | ELIZA | core | — |
| Payment | ELIZA | core | — |
| Exhibitor | LEENA | ops | ELIZA reads |
| Stand | LEENA | ops | ELIZA reads, LİFFY reads availability |
| Master Floorplan | LEENA | ops | LİFFY reads template |
| Sales Floorplan | LİFFY | sales | — |
| Expo | ELIZA | core | LİFFY reads, LEENA reads |
| Edition | ELIZA | core | LİFFY reads, LEENA reads |
| User | ELIZA | core | LİFFY authenticates, LEENA authenticates |
| Audit Log | ELIZA | core | All systems publish standardized audit events to ELIZA |

---

## Forbidden Terms

These terms are **banned** from code, UI, and documentation. Use the correct term instead.

| Don't Use | Use Instead | Why |
|-----------|------------|-----|
| client | Company | Ambiguous — could mean company, contact, or account |
| customer | Company | Same — use Company consistently |
| participant | Exhibitor | "Participant" could mean visitor, speaker, or exhibitor |
| account | Company | Zoho term — we're leaving Zoho terminology behind |
| deal | Opportunity or Contract | "Deal" is informal — be specific about which stage |
| event | Expo or Edition | "Event" is too generic — specify the brand or the year |
| booking | Contract | "Booking" implies hotel/restaurant — we make Contracts |
| vendor | Expo (in Zoho context) | Zoho stores Expos as "Vendors" — this is a Zoho artifact, don't propagate |
| sales order | Contract | Zoho term — in ELL, it's a Contract |

---

## Claude Code Instructions

When writing code for any ELL system:
1. Use entity names exactly as defined in this glossary (table names, variable names, API endpoints)
2. If you encounter a term not in this glossary, flag it and ask before proceeding
3. When migrating from Zoho, map Zoho terms to ELL terms (Sales_Orders → contracts, Vendors → expos, Accounts → companies)
4. Never create a new entity without adding it to this glossary first
