# LİFFY Architecture Blueprint
## Action Engine for Sales Reps

**Version:** v1.1
**Date:** 2026-04-13
**Owner:** Elan Expo / Suer Ay
**Status:** Architecture approved — aligned with ELL Architecture v2.1 and ADR decisions
**Consulted:** Claude, ChatGPT, Gemini — 3 rounds of AI consultation + ELL v2.1 alignment review
**Source:** Elif AY (Sales Manager) operational requirements + CEO vision

---

## 1. Purpose

### What LİFFY Is

LİFFY is a **sales action engine** for Elan Expo's sales team.

It answers one question every morning: **"Bugün kime ne yapacağım?"**

LİFFY scans the entire sales pipeline, evaluates every lead, prospect, opportunity, and past exhibitor against a rule set, and surfaces the items that require human decision or human touch. Everything else stays in automation.

### What LİFFY Is NOT

LİFFY is not a CRM. It does not exist to store data — data storage is a side effect, not the purpose.

LİFFY is not an email automation tool. Campaign and sequence engines are motors inside LİFFY, but they are not the product. The product is the Action screen.

LİFFY is not a pipeline viewer. The pipeline is not the primary navigation or homepage mental model. Sales reps don't open LİFFY to a Kanban board or a deal funnel — they open it to: "Here are the 12 things you need to do today, and here's why." Pipeline data (opportunity stages, quote statuses, expected revenue) exists and is accessible when needed, but it lives behind the Action screen, not in front of it.

### The Problem LİFFY Solves

Today, Elan Expo's sales team works across fragmented tools:

- **Zoho CRM** for data entry (leads, contracts)
- **Gmail** for actual email communication
- **Excel** for tracking similar companies, past exhibitors, personal notes
- **Memory** for follow-up timing

No system tells a sales rep what to do next. Zoho stores data but generates no action. Gmail has conversations but no context. Excel has intelligence but no workflow. Memory is unreliable.

LİFFY collapses all of this into one screen. The sales rep opens LİFFY, sees their action items with full context, takes action without leaving the system, and moves on.

### The Golden Rule

> A record stays in **Waiting** as long as the system can advance it.  
> A record moves to **Action** the moment it needs a human decision or human touch.

This single rule defines LİFFY's architecture.

---

## 2. Core Principles

### Principle 1: Action-First

The homepage is the Action screen. Not a dashboard. Not a pipeline. Not a search bar. The first thing a sales rep sees is: "These companies need your attention today."

### Principle 2: Zero Context Switching

When a sales rep clicks on an Action item, everything they need appears in a side panel: timeline, context cards, reply composer, notes, call log. They never leave LİFFY to check Gmail, open Excel, or search Zoho.

### Principle 3: Campaign Is a Motor, Not the Center

Campaigns and sequences are how LİFFY generates and processes leads. They are essential infrastructure. But the sales rep's daily life revolves around Action, not around managing campaigns. Campaigns run in the background. Action is the foreground.

### Principle 4: System Does the Work Until It Can't

Automation handles: sending initial emails, follow-up sequences, tracking opens/clicks, scoring engagement. The system does not ask for human help until it has exhausted its own capabilities or detected a signal that requires human judgment.

### Principle 5: "Why Am I Looking at This?"

Every Action item must show its trigger reason in plain language. The sales rep should never have to guess why a company appeared on their list. "Reply geldi", "7 gündür teklif sessiz", "Rebooking zamanı", "2 kez açtı, cevap yok" — always visible.

### Principle 6: Don't Flood the Screen

Action items are scarce by design. Most leads are in Waiting (system is handling them). Only items that genuinely need human touch make it to Action. If the Action screen regularly shows 50+ items, the rules are too loose.

---

## 3. System Position in ELL

### The Three Systems

```
ELIZA — Commercial system of record. Owns contracts, payments, approvals, intelligence.
LİFFY — Sales action engine. Creates leads, sends outreach, manages pipeline, creates quotes.
LEENA — Operations execution. Manages expos, floorplans, exhibitors, visitors.
```

### How They Connect

```
                    ┌──────────────┐
                    │   ELIZA      │
                    │  (authority) │
                    └──────┬───────┘
                           │ reads from both
                           │ writes: contracts, payments, approvals
              ┌────────────┴────────────┐
              │                         │
       ┌──────┴──────┐          ┌──────┴──────┐
       │   LİFFY     │          │   LEENA     │
       │  (sales)    │          │  (ops)      │
       └─────────────┘          └─────────────┘
              │                         │
              └────────────┬────────────┘
                           │
                    ┌──────┴───────┐
                    │  PostgreSQL  │
                    │  (shared DB) │
                    └──────────────┘
```

### Data Flow Rules

1. **LİFFY writes** leads, opportunities, quotes, email events, sequences, action items
2. **LEENA writes** expos, stands, expenses, exhibitor records, floorplans
3. **ELIZA writes** contracts (after quote approval), payments, users/permissions, audit logs — this is a permanent architectural role (ADR-005), not a transition arrangement
4. **ELIZA reads** pipeline data from LİFFY and operational data from LEENA for dashboards and AI queries
5. **LİFFY reads** expo list from LEENA/core (for "which expo is this opportunity for?")
6. **LEENA reads** contracts from ELIZA/core (for "who are the exhibitors for this expo?")

### Quote → Contract Flow (Cross-System)

```
Sales Rep (LİFFY) creates Quote
       ↓
Quote submitted for approval → ELIZA receives
       ↓
Authorized manager approves via ELIZA (WhatsApp or dashboard)
       ↓
ELIZA creates Contract (AF number assigned)
       ↓
LİFFY reads Contract status (won/lost)
LEENA activates Exhibitor record
```

This is the only cross-system write flow. Sales reps never create contracts directly (ADR-003).

---

## 4. Technical Architecture

### Repository Structure

LİFFY lives in its own repository, separate from ELIZA and LEENA. This preserves SaaS-readiness (ADR-002) and matches the current working setup.

```
liffyv1/                        (LİFFY repo — github.com/Nsueray/liffyv1)
├── backend/
│   ├── routes/
│   │   ├── actions.js           → Action items CRUD
│   │   ├── leads.js             → Lead management
│   │   ├── campaigns.js         → Campaign CRUD
│   │   ├── sequences.js         → Sequence management
│   │   ├── timeline.js          → Contact timeline assembly
│   │   ├── opportunities.js     → Pipeline management
│   │   ├── quotes.js            → Quote creation + submission
│   │   ├── context.js           → Context cards generation
│   │   └── email-events.js      → SendGrid webhook receiver
│   ├── engines/
│   │   ├── action-engine/       → Rule processor (triggers, scoring)
│   │   └── sequence-engine/     → Automation processor (scheduled emails)
│   ├── middleware/
│   │   └── auth.js              → JWT auth (same secret as ELIZA)
│   ├── migrations/
│   └── server.js
├── frontend/                    (or liffy-ui as separate repo)
│   ├── pages/
│   │   ├── index.js             → Action screen (homepage)
│   │   ├── waiting.js           → Waiting screen
│   │   ├── overview.js          → Overview screen
│   │   ├── leads/               → Lead management
│   │   ├── campaigns/           → Campaign management
│   │   └── login.js
│   └── components/
│       ├── ActionList.js        → Action item table
│       ├── ContactDrawer.js     → Right panel (timeline + actions)
│       ├── Timeline.js          → Chronological event history
│       ├── ContextCards.js      → Past exhibitor matches
│       ├── ActionPanel.js       → Reply, template, note, call
│       ├── Nav.js               → LİFFY navigation
│       └── WaitingList.js       → Waiting items
├── docs/
│   └── ELL_GLOSSARY.md          → Shared terminology (copied from ELIZA)
└── package.json

eliza/                           (ELIZA repo — github.com/Nsueray/eliza)
├── apps/
│   ├── api/                     → ELIZA API (dashboard, WhatsApp, Zoho sync)
│   ├── dashboard/               → ELIZA War Room
│   └── whatsapp-bot/            → ELIZA WhatsApp bot
├── packages/
│   ├── db/                      → Database utilities
│   ├── ai/                      → ELIZA AI (router, query engine, Sonnet)
│   ├── zoho-sync/               → Zoho sync (temporary — removed when Zoho retired)
│   └── push/                    → Push messages
└── docs/
    ├── decisions/               → ADR files (ELL Decision Journal)
    ├── ELL_GLOSSARY.md          → Shared terminology (master copy)
    └── ELL_ROADMAP.md

leena/                           (LEENA repo — future)
```

### Render Services (Production)

| Service | Domain | Type | Repo | Plan |
|---------|--------|------|------|------|
| eliza-dashboard | eliza.elanfairs.com | Web Service | eliza | Starter (paid) |
| eliza-api | eliza-api-8tkr.onrender.com | Web Service | eliza | Starter (paid) |
| eliza-bot | eliza-bot-r1vx.onrender.com | Worker | eliza | Starter (paid) |
| liffy-api | api.liffy.app | Web Service | liffyv1 | Starter (paid) |
| liffy-worker | — | Worker | liffyv1 | Standard (paid) |
| liffy-ui | liffy.elanfairs.com | Web Service | liffy-ui | Starter (paid) |
| PostgreSQL | (managed) | Database | — | Paid (shared) |

**Why LİFFY has its own API service (`api.liffy.app`), separate from ELIZA API:**

- LİFFY is designed to be SaaS-ready (ADR-002). A separate service means it can be deployed independently for other organizers
- LİFFY already has a working API with SendGrid webhooks configured at `api.liffy.app` — moving routes into ELIZA API would break existing integrations
- LİFFY's sequence engine scheduler runs inside its own worker process — independent from ELIZA's Zoho sync scheduler
- Both services connect to the same PostgreSQL database. Separation is at the service level, not the data level
- Same JWT secret across services — a token issued by LİFFY auth is valid for ELIZA reads, and vice versa

### Shared Database

Single PostgreSQL instance. All systems connect to the same database.

**Current state:** All tables in `public` schema. LİFFY tables coexist with ELIZA tables.

**Proposed table naming convention** (prefix-based, not PostgreSQL schema separation):

- `core_*` — shared entities (companies, contacts, contracts, payments, expos, users) — currently unprefixed, migration to prefixed names is future work
- `sales_*` — LİFFY-owned (leads, opportunities, quotes, sequences, campaigns, email_events, action_items)
- `ops_*` — LEENA-owned (stands, exhibitor_records, catalogs) — future
- Unprefixed — legacy/existing tables (edition_contracts, fiscal_contracts, etc.)

**Data ownership rule (ADR-004):** Each table has exactly one owner service. Only the owner writes. Other services may read, never write. Short-term enforced by convention; long-term by PostgreSQL roles.

### Authentication

Shared JWT auth system. Same `users` table. Same `JWT_SECRET` across all services.

LİFFY-specific permissions added to `users.dashboard_permissions`:
- `liffy_action` — can see Action screen
- `liffy_campaigns` — can create/manage campaigns
- `liffy_leads` — can manage leads
- `liffy_overview` — can see Overview (own data only for agents, team for managers)

---

## 5. Data Model

### Existing Tables (Unchanged, Shared)

These tables already exist in the ELIZA database. LİFFY reads from them and, in some cases, writes to them through defined workflows.

```
users               — auth, roles, permissions (shared across ELL)
contracts           — signed agreements (ELIZA owns, LİFFY reads status)
contract_payments   — received payments (ELIZA owns)
expos               — expo brands + editions (LEENA will own, currently Zoho sync)
expo_targets        — m²/revenue targets per expo (ELIZA owns)
sales_agents        — external agents (Zoho sync)
exhibitors          — participating companies (LEENA will own)
```

### New Tables

#### Core Tables (Shared — Written by LİFFY, Owned by Core/ELL)

Per the ELL Glossary, Company and Contact are **core entities** owned by the shared ELL layer (ELIZA/core schema), not by any single system. LİFFY is the primary writer during the sales flow, but LEENA and ELIZA also read and (in LEENA's case) may enrich these records. This prevents ownership confusion and ensures deduplication, reporting, and cross-system queries work correctly.

#### core.companies

Master company registry. Replaces Zoho `Accounts`.

```sql
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(500) NOT NULL,
  country VARCHAR(100),
  city VARCHAR(100),
  industry VARCHAR(200),
  website VARCHAR(500),
  employee_count VARCHAR(50),      -- "1-10", "11-50", "51-200", "201-500", "500+"
  company_type VARCHAR(50),        -- manufacturer, distributor, agent, contractor, other
  source VARCHAR(50),              -- zoho_import, manual, web_form, data_mining
  zoho_account_id VARCHAR(50),     -- for migration mapping
  tags TEXT[],                     -- flexible tagging: ["past_exhibitor", "vip", "pavilion"]
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_companies_name ON companies USING gin(name gin_trgm_ops);
CREATE INDEX idx_companies_country ON companies(country);
CREATE INDEX idx_companies_industry ON companies(industry);
```

#### core.contacts

People at companies.

```sql
CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  first_name VARCHAR(200),
  last_name VARCHAR(200),
  email VARCHAR(300),
  phone VARCHAR(50),
  job_title VARCHAR(200),
  is_primary BOOLEAN DEFAULT false,  -- primary contact for this company
  language VARCHAR(5) DEFAULT 'en',  -- preferred language: tr, en, fr
  zoho_contact_id VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_contacts_email ON contacts(email) WHERE email IS NOT NULL;
CREATE INDEX idx_contacts_company ON contacts(company_id);
```

#### Sales Tables (LİFFY-Owned)

The following tables are owned exclusively by LİFFY. Other systems read from them but never write.

#### sales.leads

Raw, unqualified data. Pre-company stage.

```sql
CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  email VARCHAR(300),
  company_name VARCHAR(500),
  contact_name VARCHAR(300),
  phone VARCHAR(50),
  country VARCHAR(100),
  city VARCHAR(100),
  industry VARCHAR(200),
  source VARCHAR(50),              -- data_mining, web_form, import, manual, referral
  source_detail TEXT,              -- e.g., "LinkedIn search HVAC Nigeria"
  status VARCHAR(30) DEFAULT 'new', -- new, in_sequence, engaged, qualified, disqualified, converted
  assigned_to INTEGER REFERENCES users(id),
  company_id INTEGER REFERENCES companies(id),  -- NULL until converted
  contact_id INTEGER REFERENCES contacts(id),   -- NULL until converted
  engagement_score INTEGER DEFAULT 0,
  last_activity_at TIMESTAMP,
  notes TEXT,
  tags TEXT[],
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_assigned ON leads(assigned_to);
CREATE INDEX idx_leads_email ON leads(email);
```

#### sales.opportunities

Active sales discussions tied to a specific expo.

```sql
CREATE TABLE IF NOT EXISTS opportunities (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  contact_id INTEGER REFERENCES contacts(id),
  expo_id INTEGER REFERENCES expos(id),          -- which expo edition
  assigned_to INTEGER REFERENCES users(id),
  stage VARCHAR(30) DEFAULT 'contacted',         -- see stage definitions below
  expected_m2 DECIMAL(8,2),
  expected_revenue DECIMAL(12,2),
  expected_close_date DATE,
  lost_reason TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_opps_company ON opportunities(company_id);
CREATE INDEX idx_opps_expo ON opportunities(expo_id);
CREATE INDEX idx_opps_assigned ON opportunities(assigned_to);
CREATE INDEX idx_opps_stage ON opportunities(stage);
```

**Opportunity stages (Elan Expo-specific):**

| Stage | Meaning | What happened | What's next |
|-------|---------|---------------|-------------|
| `contacted` | First outreach made | Email sent, call made, met at event | Waiting for response |
| `engaged` | Company responded or showed interest | Replied to email, asked questions, clicked pricing | Qualify: right expo, right size, right budget? |
| `qualified` | Confirmed fit — real potential | Company wants to exhibit, discussing details | Prepare and send quote |
| `quoting` | Quote created and sent | m², price, stand type proposed | Waiting for decision |
| `awaiting_decision` | Quote reviewed, decision pending | Company reviewing internally, negotiating terms | Follow up, adjust if needed |
| `won` | Deal closed | Quote approved, contract created | Hand off to operations |
| `lost` | Deal lost | Declined, went to competitor, budget cut, wrong timing | Log reason, consider for next edition |

*Note: These stages describe the real Elan Expo sales journey, not a generic CRM pipeline. The key difference from standard CRM stages is `engaged` (response confirmed) and `awaiting_decision` (quote is with the client, we're waiting) — these reflect the actual moments where a sales rep's workflow changes.*

#### sales.quotes

Sales proposals submitted for approval.

```sql
CREATE TABLE IF NOT EXISTS quotes (
  id SERIAL PRIMARY KEY,
  opportunity_id INTEGER REFERENCES opportunities(id),
  company_id INTEGER REFERENCES companies(id),
  expo_id INTEGER REFERENCES expos(id),
  created_by INTEGER REFERENCES users(id),       -- sales rep who created it
  approved_by INTEGER REFERENCES users(id),       -- manager/CEO who approved
  m2 DECIMAL(8,2) NOT NULL,
  unit_price DECIMAL(10,2),                       -- price per m²
  total_price DECIMAL(12,2) NOT NULL,
  currency VARCHAR(5) DEFAULT 'EUR',
  discount_percent DECIMAL(5,2) DEFAULT 0,
  stand_type VARCHAR(30),                         -- booth, space_only, pavilion
  special_conditions TEXT,
  status VARCHAR(20) DEFAULT 'draft',             -- draft, submitted, approved, rejected, expired
  submitted_at TIMESTAMP,
  approved_at TIMESTAMP,
  rejected_reason TEXT,
  valid_until DATE,                               -- quote expiry
  contract_id INTEGER REFERENCES contracts(id),   -- set when contract created after approval
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_quotes_status ON quotes(status);
CREATE INDEX idx_quotes_company ON quotes(company_id);
CREATE INDEX idx_quotes_opportunity ON quotes(opportunity_id);
```

**Quote Approval Matrix** (from ELL Roadmap v1.1 — LİFFY 1.3):

| Condition | Approver | Flow |
|-----------|----------|------|
| Standard price, no discount | System (auto-approve) | Quote → Valid immediately |
| Up to 10% discount | Sales Manager (Elif) | WhatsApp notification to manager |
| Over 10% discount | CEO | ELIZA WhatsApp approval request |
| 100m²+ or pavilion contract | CEO | ELIZA WhatsApp approval request |

- Sales reps create Quotes. They **never** create Contracts directly (see ELL Glossary, ADR-003).
- CEO approval via ELIZA WhatsApp: "Onayla" / "Reddet"
- Quote PDF cannot be sent to client until approval is complete
- AF number is assigned only after approval, via PostgreSQL SEQUENCE

#### sales.campaigns

Outreach campaigns grouping leads.

```sql
CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  name VARCHAR(300) NOT NULL,
  expo_id INTEGER REFERENCES expos(id),          -- target expo (optional)
  created_by INTEGER REFERENCES users(id),
  sequence_id INTEGER REFERENCES sequences(id),  -- which email sequence to use
  status VARCHAR(20) DEFAULT 'draft',            -- draft, active, paused, completed
  lead_count INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  open_count INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  bounce_count INTEGER DEFAULT 0,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

#### sales.sequences

Email automation sequences (templates + timing).

```sql
CREATE TABLE IF NOT EXISTS sequences (
  id SERIAL PRIMARY KEY,
  name VARCHAR(300) NOT NULL,
  created_by INTEGER REFERENCES users(id),
  is_default BOOLEAN DEFAULT false,
  status VARCHAR(20) DEFAULT 'active',           -- active, archived
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id SERIAL PRIMARY KEY,
  sequence_id INTEGER REFERENCES sequences(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,                   -- 1, 2, 3...
  delay_days INTEGER NOT NULL,                   -- days after previous step (0 for first)
  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  language VARCHAR(5) DEFAULT 'en',
  created_at TIMESTAMP DEFAULT NOW()
);
```

Default sequence (v1 — starter template, not sacred):
| Step | Day | Purpose |
|------|-----|---------|
| 1 | 0 | Initial outreach email |
| 2 | 3 | Follow-up 1 (did you see my email?) |
| 3 | 7 | Follow-up 2 (still interested?) |
| 4 | 12 | Final follow-up (last chance) → if no reply → sequence_exhausted → Action |

*Note: This is the default v1 template. Day intervals (3/7/12) are not constitutional rules — they are starting defaults. Sequences will become configurable per expo, segment, or country. The logic (initial → follow-ups → exhaustion → Action) is the principle; the specific timing is adjustable.*

#### sales.lead_sequences

Tracks each lead's position in a sequence.

```sql
CREATE TABLE IF NOT EXISTS lead_sequences (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  sequence_id INTEGER REFERENCES sequences(id),
  current_step INTEGER DEFAULT 0,                -- 0 = not started, 1+ = step number
  status VARCHAR(20) DEFAULT 'active',           -- active, completed, paused, replied, bounced
  next_send_at TIMESTAMP,                        -- when to send next step
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_lead_seq_status ON lead_sequences(status);
CREATE INDEX idx_lead_seq_next ON lead_sequences(next_send_at);
```

#### sales.email_events

SendGrid webhook events — opens, clicks, replies, bounces.

```sql
CREATE TABLE IF NOT EXISTS email_events (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER REFERENCES leads(id),
  contact_id INTEGER REFERENCES contacts(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  event_type VARCHAR(30) NOT NULL,               -- sent, delivered, opened, clicked, replied, bounced, unsubscribed
  email_to VARCHAR(300),
  email_subject TEXT,
  link_clicked TEXT,                              -- URL clicked (for click events)
  sendgrid_event_id VARCHAR(100),
  raw_payload JSONB,                              -- full SendGrid webhook payload
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_email_events_lead ON email_events(lead_id);
CREATE INDEX idx_email_events_type ON email_events(event_type);
CREATE INDEX idx_email_events_created ON email_events(created_at);
```

#### sales.action_items

Derived action items — the core of LİFFY's UI layer.

**Important: action_items is NOT a source of truth.** It is a materialized/cached working layer derived from the real source tables: leads, opportunities, quotes, contracts, email_events, and activity_log. The Action Engine periodically re-evaluates these sources and materializes the results into action_items for UI performance. If action_items were deleted entirely, they could be regenerated from the source tables. This distinction matters for data integrity — never query action_items for business analytics; always go to the source tables.

```sql
CREATE TABLE IF NOT EXISTS action_items (
  id SERIAL PRIMARY KEY,
  assigned_to INTEGER REFERENCES users(id) NOT NULL,
  
  -- What entity this is about
  lead_id INTEGER REFERENCES leads(id),
  company_id INTEGER REFERENCES companies(id),
  contact_id INTEGER REFERENCES contacts(id),
  opportunity_id INTEGER REFERENCES opportunities(id),
  quote_id INTEGER REFERENCES quotes(id),
  contract_id INTEGER REFERENCES contracts(id),  -- for rebooking
  expo_id INTEGER REFERENCES expos(id),
  
  -- Why it's here
  trigger_reason VARCHAR(30) NOT NULL,           -- reply_received, sequence_exhausted, quote_no_response, rebooking_due, engaged_hot, manual_flag
  trigger_detail TEXT,                            -- human-readable: "Replied on Apr 12", "2x opened, clicked pricing link"
  
  -- Priority
  priority INTEGER NOT NULL DEFAULT 3,           -- 1=highest (reply), 2=quote/rebooking, 3=engaged/exhausted, 4=manual
  priority_label VARCHAR(10),                    -- P1, P2, P3, P4
  
  -- Status
  status VARCHAR(20) DEFAULT 'open',             -- open, in_progress, done, dismissed, snoozed
  snoozed_until TIMESTAMP,                       -- if snoozed, when to resurface
  
  -- Metadata
  last_activity_at TIMESTAMP,                    -- most recent event that created/updated this item
  created_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP,
  resolved_by INTEGER REFERENCES users(id),
  resolution_note TEXT                           -- what was done: "Called, interested in 36m²", "Not relevant"
);

CREATE INDEX idx_actions_assigned ON action_items(assigned_to);
CREATE INDEX idx_actions_status ON action_items(status);
CREATE INDEX idx_actions_priority ON action_items(priority);
CREATE INDEX idx_actions_trigger ON action_items(trigger_reason);
```

#### sales.activity_log

Universal timeline — every interaction, every channel.

```sql
CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  
  -- Who/what
  lead_id INTEGER REFERENCES leads(id),
  company_id INTEGER REFERENCES companies(id),
  contact_id INTEGER REFERENCES contacts(id),
  opportunity_id INTEGER REFERENCES opportunities(id),
  user_id INTEGER REFERENCES users(id),          -- who did this (sales rep)
  
  -- What happened
  activity_type VARCHAR(30) NOT NULL,            -- email_sent, email_opened, email_clicked, email_replied, 
                                                  -- call_made, note_added, quote_sent, quote_approved, 
                                                  -- contract_created, meeting_scheduled, status_changed,
                                                  -- campaign_added, sequence_step, manual_action
  channel VARCHAR(20),                           -- email, phone, whatsapp, system, manual
  
  -- Details
  subject TEXT,                                   -- email subject, call topic, etc.
  body TEXT,                                      -- email body, note content, etc.
  metadata JSONB,                                 -- flexible: { link_clicked: "...", duration: "5min", template_used: "..." }
  
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_activity_lead ON activity_log(lead_id);
CREATE INDEX idx_activity_company ON activity_log(company_id);
CREATE INDEX idx_activity_contact ON activity_log(contact_id);
CREATE INDEX idx_activity_type ON activity_log(activity_type);
CREATE INDEX idx_activity_created ON activity_log(created_at DESC);
```

---

## 6. Action Engine

### The Two Engines — Sharp Distinction

LİFFY has two engines. They are fundamentally different:

- **Sequence Engine** = "Ne zaman ne gönderilecek?" — Automation. Sends scheduled emails on a timer. No human judgment involved. Operates on rules: day 0 send email, day 3 follow-up, day 7 follow-up again.

- **Action Engine** = "Artık insan müdahalesi gerekiyor mu?" — Evaluation. Scans all data sources, applies trigger rules, and decides: does this record need a human now? If yes → Action. If no → stays in Waiting.

The Sequence Engine feeds into the Action Engine: when a sequence completes without a reply, the Action Engine creates a `sequence_exhausted` action item. But they never run in reverse — the Action Engine does not trigger sequences.

### Architecture

The Action Engine is a **rule processor** that operates in two modes:

1. **Near-real-time on webhook:** When a SendGrid event arrives (reply, click, bounce), the Action Engine evaluates immediately for that specific lead. This ensures replies and high-signal events surface within seconds.

2. **Periodic reconciliation:** A scheduled job scans all active leads, opportunities, quotes, and contracts to catch time-based triggers (quote_no_response after N days, rebooking_due, sequence_exhausted) and any events that may have been missed by the webhook path. Frequency is an implementation detail — start with every 15 minutes, adjust based on load.

```
Input: All leads, opportunities, quotes, contracts, email_events
  ↓
Rule Evaluation: Check each trigger rule against current state
  ↓
Priority Scoring: Assign priority based on trigger type + context
  ↓
Deduplication: One action item per company per trigger (no flooding)
  ↓
Output: INSERT/UPDATE action_items table
  ↓
UI: Action screen reads from action_items WHERE status = 'open'
```

Location: `packages/action-engine/`

### Trigger Rules

#### T1: reply_received — Priority 1 (Highest)

```
WHEN: email_events.event_type = 'replied' 
  AND lead/contact has no open action_item with trigger = 'reply_received'
THEN: Create action_item with priority = 1
DETAIL: "Replied: {first 80 chars of reply}" or "Email reply received"
```

A reply always means a human needs to respond. No exceptions.

#### T2: sequence_exhausted — Priority 3

```
WHEN: lead_sequences.current_step >= MAX(sequence_steps.step_order)
  AND lead_sequences.status = 'active'
  AND no reply received during sequence
  AND no open action_item exists
THEN: Create action_item with priority = 3
DETAIL: "{sequence_name} completed — no response after {N} emails"
```

The automation has done everything it can. Human must decide: try another approach, call, or move on.

#### T3: quote_no_response — Priority 2

```
WHEN: quotes.status = 'submitted' OR quotes.status = 'approved'
  AND quotes.submitted_at < NOW() - INTERVAL '{N} days'  (default: 7)
  AND no reply or activity since submission
  AND no open action_item exists
THEN: Create action_item with priority = 2
DETAIL: "Quote sent {N} days ago — no response"
```

#### T4: rebooking_due — Priority 2

```
WHEN: contract.status = 'Valid'
  AND contract belongs to a previous edition of an expo
  AND next edition exists with start_date within 12 months
  AND company has no contract/opportunity for next edition
  AND no open action_item exists
THEN: Create action_item with priority = 2
DETAIL: "Rebooking — participated in {expo} {year}, new edition in {months} months"
```

#### T5: engaged_hot — Priority 3

Open or click alone does NOT create an action item. Combinations do:

```
WHEN any of these combinations is TRUE:
  a) 2+ distinct open events in 7 days (not the same open counted twice)
  b) click + company has past exhibition history (past_exhibitor tag)
  c) click + company is tagged as high_value
  d) click + clicked link contains "floorplan" OR "pricing" OR "register"
  AND no open action_item exists
  AND no reply received (reply_received takes precedence)
THEN: Create action_item with priority = 3
DETAIL: "Engaged: {description}" 
  e.g., "Opened 3x this week" or "Clicked pricing link — past exhibitor"
```

#### T6: manual_flag — Priority 4

```
WHEN: User or manager manually creates an action item
THEN: Create action_item with priority = 4
DETAIL: User-provided note
```

### What Does NOT Create an Action Item

- Single email open (noise — people open emails accidentally, email clients auto-load images)
- Single click without qualifying context (click on unsubscribe link, click on social media icon)
- Lead entering a sequence (that's Waiting, not Action)
- Lead in early sequence steps (system is still working)
- Bounced email (handled by sequence engine — marks lead, doesn't require human action)
- Low engagement score without qualifying trigger

### Priority System

| Priority | Label | Triggers | Color | Meaning |
|----------|-------|----------|-------|---------|
| 1 | P1 | reply_received | 🔴 Red | Someone responded — act now |
| 2 | P2 | quote_no_response, rebooking_due | 🟡 Yellow | Business opportunity at risk |
| 3 | P3 | engaged_hot, sequence_exhausted | 🟠 Orange | Potential — human judgment needed |
| 4 | P4 | manual_flag | 🔵 Blue | Manually flagged |

Action screen sorts by: priority ASC (P1 first), then last_activity_at DESC (most recent first within same priority).

### Action Item Lifecycle

```
Created (trigger fires)
  ↓
open → sales rep sees it on Action screen
  ↓
in_progress → sales rep clicked, reviewing (optional intermediate state)
  ↓
done → sales rep took action (replied, called, created opportunity, dismissed)
  OR
snoozed → sales rep defers to a later date (resurfaces automatically)
  OR  
dismissed → not relevant, no action needed (stays in history)
```

Resolution requires a note (even a short one): "Called, interested in 36m²", "Wrong contact", "Not relevant for this expo".

### Engagement Scoring

Every lead/contact accumulates an engagement_score:

| Event | Points |
|-------|--------|
| email_delivered | 0 |
| email_opened | +1 |
| email_clicked | +3 |
| email_replied | +10 |
| link_clicked (pricing/floorplan) | +5 |
| call_made (by sales rep) | +5 |
| quote_sent | +8 |
| 7 days no activity | -2 |

Score is used for:
- Sorting within same priority level (higher score = higher in list)
- engaged_hot trigger evaluation (future: threshold-based)
- Overview analytics (which leads are most engaged?)

---

## 7. Sequence Engine

### Purpose

The Sequence Engine sends automated email follow-ups on behalf of sales reps, through SendGrid. It runs as a periodic scheduled job inside the LİFFY API (frequency is an implementation detail — start conservatively, adjust based on volume and SendGrid rate limits).

### Flow

```
Campaign created → leads added → lead_sequences created
  ↓
Scheduler checks: lead_sequences WHERE status='active' AND next_send_at <= NOW()
  ↓
For each due lead_sequence:
  1. Get current step template from sequence_steps
  2. Render template (merge fields: company_name, contact_name, expo_name, etc.)
  3. Send via SendGrid API (from: sales rep's email address)
  4. Log email_event (type: 'sent')
  5. Log activity_log (type: 'sequence_step')
  6. Advance current_step, calculate next_send_at
  7. If last step reached → status = 'completed' → Action Engine creates sequence_exhausted
```

### SendGrid Integration

LİFFY already has SendGrid configured. Key integration points:

**Sending:**
- SendGrid Transactional API (not Marketing)
- Each email sent with custom headers for tracking: `X-LİFFY-Lead-ID`, `X-LİFFY-Campaign-ID`
- From address: sales rep's actual email (with SendGrid verified domain)

**Tracking (Webhook):**
- SendGrid Event Webhook → POST `/api/email-events/webhook`
- Events: delivered, opened, clicked, bounced, spam_report, unsubscribed
- Reply detection: SendGrid Inbound Parse → POST `/api/email-events/inbound`
- Each event creates an `email_events` row + triggers Action Engine evaluation

### Template System

Templates use simple merge fields:

```
Subject: {{expo_name}} — Exhibition Opportunity for {{company_name}}

Hi {{contact_first_name}},

I'm reaching out about {{expo_name}}, taking place on {{expo_date}} in {{expo_city}}, {{expo_country}}.

{{custom_body}}

Best regards,
{{sender_name}}
{{sender_title}}
Elan Expo
```

Available merge fields:
- `{{company_name}}`, `{{contact_first_name}}`, `{{contact_last_name}}`
- `{{expo_name}}`, `{{expo_date}}`, `{{expo_city}}`, `{{expo_country}}`
- `{{sender_name}}`, `{{sender_title}}`, `{{sender_email}}`
- `{{custom_body}}` — per-step custom content
- `{{unsubscribe_link}}` — required for compliance

### Sequence Pause Conditions

A sequence automatically pauses (does not send next step) when:
- Lead replied (status → 'replied', Action Engine creates reply_received)
- Email bounced (status → 'bounced', lead marked)
- Lead unsubscribed (status → 'unsubscribed')
- Lead manually moved to Action by sales rep
- Campaign paused by creator

---

## 8. UI Architecture

### Three Screens + Drawer

#### Screen 1: ACTION (Homepage — `/`)

The main screen. Everything the sales rep needs to do today.

```
┌─────────────────────────────────────────────────────────────────┐
│ LİFFY.                                           Bengü ▼  ⚙️  │
│ Action │ Waiting │ Overview                                     │
├─────────────────────────────────────────────────────────────────┤
│ TODAY: 12 items                    [Filter ▼] [Expo ▼] [Sort ▼]│
├─────────────────────────────────────────────────────────────────┤
│ 🔴 P1  Bosch GmbH          Reply geldi              SIEMA 2026 │
│        "We are interested in 36sqm space..."      2 hours ago   │
│─────────────────────────────────────────────────────────────────│
│ 🟡 P2  Delta Industries    7 gün teklif sessiz    Madesign 2026 │
│        Quote: 24m² / €14,400                      7 days ago    │
│─────────────────────────────────────────────────────────────────│
│ 🟡 P2  ABC Manufacturing   Rebooking zamanı      MegaClima 2026 │
│        SIEMA 2025'te katıldı — 18m²               Expo: 5 ay    │
│─────────────────────────────────────────────────────────────────│
│ 🟠 P3  XYZ Trading Ltd     2x açtı, cevap yok   Buildexpo 2026 │
│        Opened: Apr 11, Apr 12                     1 day ago     │
│─────────────────────────────────────────────────────────────────│
│ 🟠 P3  Omega Corp          Sequence bitti         SIEMA 2026    │
│        4 email gönderildi, cevap yok              12 days ago   │
│─────────────────────────────────────────────────────────────────│
│ ...                                                             │
└─────────────────────────────────────────────────────────────────┘
```

**Filters:**
- By trigger: All / Replies / Quotes / Rebooking / Engaged / Manual
- By expo: All / SIEMA 2026 / Mega Clima / etc.
- Sort: Priority (default) / Most Recent / Company Name

**Row click → Opens Contact Drawer (right panel)**

#### Screen 2: WAITING (`/waiting`)

What the system is currently processing. Sales rep monitors but doesn't act.

```
┌─────────────────────────────────────────────────────────────────┐
│ LİFFY.                                           Bengü ▼  ⚙️  │
│ Action │ Waiting │ Overview                                     │
├─────────────────────────────────────────────────────────────────┤
│ ACTIVE CAMPAIGNS                                                │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ SIEMA 2026 Outreach        380 leads │ 42% opened │ 8 reply │ │
│ │ Started: Mar 15           Step 2/4 for most leads           │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Mega Clima HVAC Mining     120 leads │ 28% opened │ 2 reply │ │
│ │ Started: Apr 1            Step 1/4 for most leads           │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ LEADS IN SEQUENCE (245 active)                                  │
│ Company           Campaign          Step   Next Send   Status   │
│ Acme Corp         SIEMA Outreach    2/4    Apr 15      active   │
│ Beta Ltd          SIEMA Outreach    3/4    Apr 18      active   │
│ Gamma SA          HVAC Mining       1/4    Apr 14      active   │
│ ...                                                             │
└─────────────────────────────────────────────────────────────────┘
```

#### Screen 3: OVERVIEW (`/overview`)

Performance and status. "Ben ne durumdayım?"

```
┌─────────────────────────────────────────────────────────────────┐
│ LİFFY.                                           Bengü ▼  ⚙️  │
│ Action │ Waiting │ Overview                                     │
├─────────────────────────────────────────────────────────────────┤
│ MY PERFORMANCE                                   [2026 ▼]      │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│ │Contracts │ │ Revenue  │ │  m² Sold │ │ Target % │           │
│ │    23    │ │ €187,500 │ │   842    │ │   64%    │           │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘           │
│                                                                 │
│ BY EXPO                                                         │
│ Expo              Contracts  m²      Revenue    Target          │
│ SIEMA 2026            12    480     €98,400      72%           │
│ Mega Clima 2026        8    245     €62,100      48%           │
│ Madesign 2026          3    117     €27,000      35%           │
│                                                                 │
│ CAMPAIGN PERFORMANCE                                            │
│ Campaign           Sent  Opened  Clicked  Replied  Converted   │
│ SIEMA Outreach     380    42%      12%      8       3          │
│ HVAC Mining        120    28%       8%      2       0          │
│                                                                 │
│ REBOOKING STATUS                                                │
│ Past exhibitors: 145 │ Contacted: 89 │ Rebooked: 34 (23%)     │
└─────────────────────────────────────────────────────────────────┘
```

#### Contact Drawer (Right Panel — 480px)

Opens when any company/lead is clicked from Action, Waiting, or anywhere.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ [Action List]                            │ ✕  Bosch GmbH                                   │
│                                          │ Germany │ HVAC │ Manufacturer                    │
│                                          │ Contact: Hans Mueller, Sales Director             │
│  (main content continues                 │ hans@bosch.com │ +49 711 XXX                     │
│   behind the drawer)                     │─────────────────────────────────────────────────── │
│                                          │ CONTEXT CARDS                                     │
│                                          │ ┌───────────────────────────────────────────────┐ │
│                                          │ │ 🏭 HVAC sector: 12 companies at SIEMA 2025   │ │
│                                          │ │ 🇩🇪 Germany: 8 companies at SIEMA 2025       │ │
│                                          │ │ 📋 Bosch at SIEMA 2024: 36m², Stand A-14     │ │
│                                          │ └───────────────────────────────────────────────┘ │
│                                          │─────────────────────────────────────────────────── │
│                                          │ TIMELINE                                          │
│                                          │                                                   │
│                                          │ Apr 12 📧 Reply received                         │
│                                          │   "We are interested in 36sqm space for SIEMA..." │
│                                          │                                                   │
│                                          │ Apr 11 👁 Opened (2nd time)                      │
│                                          │                                                   │
│                                          │ Apr 10 🔗 Clicked: SIEMA floorplan link          │
│                                          │                                                   │
│                                          │ Apr 7  📧 Follow-up 1 sent                       │
│                                          │   Subject: "SIEMA 2026 — Space Available"         │
│                                          │                                                   │
│                                          │ Apr 4  👁 Opened                                 │
│                                          │                                                   │
│                                          │ Apr 3  📧 Initial email sent                     │
│                                          │   Subject: "SIEMA 2026 — Exhibition Opportunity"  │
│                                          │                                                   │
│                                          │ 2024   📋 Contract: SIEMA 2024, 36m², €21,600    │
│                                          │─────────────────────────────────────────────────── │
│                                          │ QUICK ACTIONS                                     │
│                                          │ [Reply] [Template ▼] [Note] [Call] [Quote]        │
│                                          │                                                   │
│                                          │ ┌───────────────────────────────────────────────┐ │
│                                          │ │ To: hans@bosch.com                            │ │
│                                          │ │ Subject: Re: SIEMA 2026 — Space Available     │ │
│                                          │ │                                               │ │
│                                          │ │ Dear Hans,                                    │ │
│                                          │ │ Thank you for your interest...                │ │
│                                          │ │                                               │ │
│                                          │ │                          [Send] [Save Draft]  │ │
│                                          │ └───────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Context Cards — LİFFY's Competitive Advantage

Context Cards appear at the top of the Contact Drawer. They answer Bengü's implicit question: "What can I tell this company to convince them?"

Cards are generated automatically based on the company's profile:

| Card Type | Logic | Example |
|-----------|-------|---------|
| Same industry | COUNT companies with same industry at target expo (previous edition) | "HVAC sector: 12 companies at SIEMA 2025" |
| Same country | COUNT companies from same country at target expo (previous edition) | "Germany: 8 companies at SIEMA 2025" |
| Same city | COUNT companies from same city (if ≥3 exist) | "Stuttgart region: 3 companies attended" |
| Past participation | Company's own history at this expo | "Bosch at SIEMA 2024: 36m², Stand A-14" |
| Similar companies | Other companies with similar profile that participate | "Similar: Daikin, Carrier, Trane all exhibit at SIEMA" |

This kills Bengü's Excel. The system provides the same contextual intelligence automatically.

**Data source rules for Context Cards:**

Context Cards use **edition_contracts** logic — same as ELIZA's Expo Radar:
- Status filter: `status IN ('Valid', 'Transferred In')` — only confirmed exhibitors count
- Edition scope: previous edition of the target expo (e.g., if selling SIEMA 2026, context comes from SIEMA 2025)
- If no previous edition exists: fall back to all editions of that expo brand
- Internal agent excluded: `sales_agent != 'ELAN EXPO'` (same ELIZA rule)
- "Same industry/country/city" matches use the company's profile fields against contract.country and exhibitors.industry from the previous edition
- "Past participation" looks at all editions of the target expo where the company had a Valid/Transferred In contract

This alignment with ELIZA's edition_contracts view ensures consistency: the same numbers a CEO sees on the War Room are the same numbers a sales rep uses in their pitch.

### Design Language

LİFFY follows the same design system as ELIZA:

- CSS: Shared `styles/design-system.css` from ELIZA (DM Mono, DM Sans, gold accent #C8A97A)
- Theme: Dark/Light via `data-theme`
- But LİFFY has its own character: **more operational, less analytical**
  - ELIZA = dark, executive, dashboard-heavy
  - LİFFY = still dark, but action-oriented, list-heavy, drawer-heavy
- Mobile-first consideration: sales reps may use LİFFY on tablets during events

---

## 9. API Design

### LİFFY API Endpoints

LİFFY API runs as its own service at `api.liffy.app`. All routes are under `/api/`.

Base URL: `api.liffy.app/api`

#### Action Items

```
GET    /api/actions                    → list open action items (filtered by current user)
GET    /api/actions?trigger=reply_received&expo_id=5   → filtered
PATCH  /api/actions/:id               → update status (done, snoozed, dismissed)
POST   /api/actions                   → create manual action item (manual_flag)
```

#### Leads

```
GET    /api/leads                     → list leads (paginated, filterable)
POST   /api/leads                     → create single lead
POST   /api/leads/import              → bulk import (CSV)
PATCH  /api/leads/:id                 → update lead
DELETE /api/leads/:id                 → soft delete
POST   /api/leads/:id/convert         → convert lead to company + contact
```

#### Campaigns

```
GET    /api/campaigns                 → list campaigns
POST   /api/campaigns                 → create campaign
PATCH  /api/campaigns/:id             → update (pause, resume)
POST   /api/campaigns/:id/add-leads   → add leads to campaign
GET    /api/campaigns/:id/stats       → campaign performance stats
```

#### Sequences

```
GET    /api/sequences                 → list sequences
POST   /api/sequences                 → create sequence with steps
PATCH  /api/sequences/:id             → update
GET    /api/sequences/:id/steps       → get steps
```

#### Timeline

```
GET    /api/timeline/:company_id      → full timeline for a company (all channels, all time)
GET    /api/timeline/lead/:lead_id    → timeline for a lead (pre-conversion)
```

**Timeline assembly logic:**

The timeline is the heart of the Contact Drawer. It merges events from multiple source tables into a single chronological stream. This is not a simple table query — it's a UNION across different data sources, ordered by timestamp.

```sql
-- Conceptual query (actual implementation may use application-level merge)
SELECT created_at, activity_type, channel, subject, body, metadata
FROM activity_log
WHERE company_id = $1

UNION ALL

SELECT created_at, event_type AS activity_type, 'email' AS channel, 
       email_subject AS subject, NULL AS body, 
       jsonb_build_object('link_clicked', link_clicked) AS metadata
FROM email_events
WHERE contact_id IN (SELECT id FROM contacts WHERE company_id = $1)

UNION ALL

SELECT submitted_at AS created_at, 'quote_sent' AS activity_type, 'system' AS channel,
       'Quote: ' || m2 || 'm² / €' || total_price AS subject, special_conditions AS body, NULL
FROM quotes
WHERE company_id = $1 AND submitted_at IS NOT NULL

UNION ALL

SELECT contract_date AS created_at, 'contract_created' AS activity_type, 'system' AS channel,
       'Contract: ' || af_number || ' — ' || m2 || 'm²' AS subject, NULL, NULL
FROM contracts
WHERE company_name ILIKE (SELECT name FROM companies WHERE id = $1)

ORDER BY created_at DESC
```

**Source tables merged into timeline:**

| Source | Event Types | Example |
|--------|------------|---------|
| `activity_log` | note_added, call_made, meeting_scheduled, status_changed, manual_action | "Not: Telefonda konuştuk, 18m² düşünüyor" |
| `email_events` | email_sent, email_opened, email_clicked, email_replied, email_bounced | "📧 Follow-up 1 sent", "👁 Opened", "🔗 Clicked: pricing" |
| `quotes` | quote_sent, quote_approved, quote_rejected | "📋 Quote: 24m² / €14,400" |
| `contracts` | contract_created | "✅ Contract: AF-2026-0142 — 36m², €21,600" |
| `contracts` (historical) | past_participation | "📋 SIEMA 2024: 36m², Stand A-14" (from previous editions) |
| `lead_sequences` | sequence_started, sequence_step, sequence_completed | "Sequence: Step 2/4 sent" |

**Important:** The timeline endpoint returns a flat, chronological array. The UI renders it top-to-bottom (newest first). No grouping, no collapsing — just a clean story of everything that happened with this company.

#### Opportunities

```
GET    /api/opportunities             → list (filterable by expo, stage, user)
POST   /api/opportunities             → create
PATCH  /api/opportunities/:id         → update stage, expected values
```

#### Quotes

```
POST   /api/quotes                    → create quote (from opportunity)
PATCH  /api/quotes/:id                → update draft
POST   /api/quotes/:id/submit         → submit for approval (→ ELIZA)
GET    /api/quotes/:id/pdf            → generate quote PDF
```

#### Email Events (SendGrid Webhooks)

```
POST   /api/email-events/webhook      → SendGrid event webhook (opens, clicks, bounces)
POST   /api/email-events/inbound      → SendGrid inbound parse (reply detection)
```

#### Context Cards

```
GET    /api/context/:company_id?expo_id=5  → context cards for a company + target expo
```

---

## 10. Transition Strategy

### Current State (April 2026)

```
Sales team → Zoho CRM (leads, contracts, data entry)
           → Gmail (email communication)
           → Excel (personal tracking, similar companies)
           → Memory (follow-up timing)

ELIZA → Zoho sync (every hour) → PostgreSQL → dashboards + WhatsApp
```

### Phase 0: Foundation (Now → June 2026)

**Goal:** Technical infrastructure ready, no user-facing changes yet.

- [x] LİFFY repo exists (`liffyv1`) with working API (`api.liffy.app`) and frontend
- [x] Auth system implemented (JWT + bcrypt, user management)
- [x] Basic CRM features added (notes, activities, tasks, pipeline)
- [x] SendGrid integration working (campaigns, webhooks, reply detection)
- [ ] Add Action Engine (`backend/engines/action-engine/`) with trigger rules
- [ ] Add Sequence Engine (`backend/engines/sequence-engine/`) with scheduler
- [ ] Connect LİFFY to ELIZA's PostgreSQL (shared DB — same DATABASE_URL)
- [ ] Run database migrations for new tables (action_items, sequences, lead_sequences)
- [ ] Import Zoho Accounts → companies table (one-time migration script)
- [ ] Import Zoho Contacts → contacts table
- [ ] Existing contracts + contract_payments remain as-is (Zoho sync continues in ELIZA)

**User impact:** Zero. Everything continues as before.

### Phase 1: LİFFY MVP (July → September 2026)

**Goal:** Sales reps can use LİFFY for daily action management alongside Zoho.

**1A — Action + Timeline (Month 1):**
- Action screen showing items derived from existing data (rebooking from contracts, follow-up rules from contract dates)
- Contact Drawer with timeline (initially: contract history only, populated from existing contracts table)
- Context Cards (from existing exhibitor/contract data)

**1B — Lead + Campaign + Sequence (Month 2):**
- Lead import (CSV from Zoho Leads export)
- Campaign creation and launch
- Sequence engine with SendGrid integration
- Email event tracking (open, click, reply)
- Action Engine fully operational with all 6 triggers

**1C — Opportunity + Quote (Month 3):**
- Opportunity management
- Quote creation with PDF generation
- Quote → ELIZA approval flow (WhatsApp)
- Quote → Contract creation (on approval)

**User impact:** Sales reps start using LİFFY for daily work. Zoho still used for contract entry (until quote approval flow is proven). Dual usage period.

### Phase 2: Zoho Retirement (October → December 2026)

- CDC webhook: Zoho → LİFFY for any remaining Zoho entries
- Pilot users switch fully to LİFFY
- Zoho goes read-only for contract viewing
- LEENA built for expo/expense management (separate track)

### Phase 3: Full Independence (Q1 2027)

- Zoho sync package removed
- All data flows through ELL
- ELIZA reads directly from shared DB (no sync delay)

---

## Appendix A: What ELIZA Reads from LİFFY

ELIZA (CEO dashboard + WhatsApp) will have read access to LİFFY data for reporting:

| Data | ELIZA Use |
|------|-----------|
| action_items (counts, triggers) | "Bengü'nün bugün 12 action item'ı var, 3'ü reply" |
| campaigns (stats) | "SIEMA outreach: %42 açılma, 8 reply" |
| leads (counts, stages) | "Bu ay 380 yeni lead girildi" |
| opportunities (pipeline) | "Pipeline'da €245K var, 12 fırsat" |
| quotes (pending) | "3 teklif onay bekliyor" |
| engagement_score (trends) | "En yüksek engagement: Bosch, ABB, Schneider" |

ELIZA never writes to these tables. Read-only.

---

## Appendix B: Glossary Alignment

This blueprint uses terms exactly as defined in `docs/ELL_GLOSSARY.md`:

| Term | Definition | Owner |
|------|-----------|-------|
| Company | Legal/commercial entity | ELIZA (core) |
| Contact | Person at a Company | ELIZA (core) |
| Lead | Raw, unqualified data | LİFFY (sales) |
| Prospect | Lead with engagement (pipeline stage, not entity) | LİFFY (sales) |
| Opportunity | Active sales discussion for specific expo | LİFFY (sales) |
| Quote | Sales proposal, requires approval | LİFFY → ELIZA |
| Contract | Approved agreement | ELIZA (core) |
| Exhibitor | Company participating in expo | LEENA (ops) |

New terms introduced by this blueprint:

| Term | Definition |
|------|-----------|
| Action Item | Derived object — a company + trigger_reason surfaced on the Action screen |
| Sequence | Automated email follow-up chain with defined steps and delays |
| Campaign | A batch outreach initiative grouping leads with a sequence |
| Engagement Score | Numeric score based on email interaction (open/click/reply) |
| Context Card | Auto-generated intelligence card showing similar/related exhibitor data |
| Action Engine | Rule processor that evaluates triggers and creates action items |
| Sequence Engine | Automation processor that sends scheduled emails via SendGrid |

---

## Appendix C: Forbidden Patterns

These are anti-patterns that must be avoided in LİFFY development:

1. **No pipeline Kanban board.** Sales reps don't drag cards between columns. The system tells them what to do.

2. **No "activity required" nag screens.** LİFFY doesn't guilt-trip reps with "you haven't logged activity today." Action items are system-generated, not admin-imposed.

3. **No manual data entry screens that look like Zoho.** If a screen has 20 form fields, it's wrong. LİFFY should feel like a todo list with superpowers, not an ERP.

4. **No dashboard-first landing page.** Charts and graphs are for Overview. The homepage is Action.

5. **No email client.** LİFFY is not an email app. It composes and sends emails through SendGrid, but it doesn't show an inbox. Replies are detected and surfaced as Action items.

6. **No feature creep into email marketing tool territory.** LİFFY sends outreach emails for sales purposes. It doesn't do newsletters, HTML email builders, A/B testing, or marketing automation. Keep it focused.

---

*This document is the foundation for LİFFY development. All implementation work should reference this blueprint. Any deviation from the architecture described here requires explicit discussion and approval.*

*Named after the entity chain: Lead → İletişim → Firma → Fırsat → Yield*
