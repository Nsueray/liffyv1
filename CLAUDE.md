# CLAUDE.md — Liffy Project Instructions (Constitution-Aligned)

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
- **Email:** SendGrid API only (NO nodemailer — remove nodemailer dependency when possible)
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

**Only the Aggregation layer may write to `persons` and `affiliations` tables.**
Miners and normalizers NEVER write to the database directly.

### 3. No Silent Data Loss
Never drop columns, tables, or data without explicit instruction.
Migrations must be additive. If renaming: create new → migrate data → deprecate old.

### 4. Multi-Tenant Always
Every query MUST include `organizer_id` filtering. No exceptions.
Different organizers NEVER merge, even if emails match.
Cross-organizer email uniqueness does NOT exist.

---

## Canonical Domain Model

### Person (Identity Layer)
A Person represents a real individual.
- primary key = `(organizer_id, email)` — email alone is NOT globally unique
- email is immutable within an organizer scope
- a person exists independently of companies or roles
- different organizers may have the same email as separate persons

### Affiliation (Contextual Role Layer)
An Affiliation represents a relationship between a person and a company.
- a person may have multiple affiliations
- affiliations are additive, never overwritten
- same email + different company = different affiliation
- same email + same company + new info = enrichment, not replacement

### MiningResult (Discovery Event)
A MiningResult is a discovery event, NOT a lead/contact/prospect.
- exists even if the person already exists in DB
- is job-scoped
- powers segmentation and campaigns

### ProspectIntent (Intent Layer)
A prospect is a person who has demonstrated intent (reply, form submission, manual qualification).
- Mining NEVER creates prospects
- Intent is linked to person_email + campaign_id

### CampaignEvent (Engagement Layer)
Engagement is stored as events, not scores.
- Types: sent, delivered, open, click, reply, bounce, dropped, deferred, spam_report, unsubscribe
- Scores are derived views, never persisted

---

## Database — Current State (20 tables)

### Core Tables (Active, Protected)
| Table | Status | Notes |
|-------|--------|-------|
| `organizers` | ACTIVE | Multi-tenant root |
| `users` | ACTIVE | Organizer users |
| `mining_jobs` | ACTIVE | Scraping job definitions |
| `mining_results` | ACTIVE | Discovery events (discovery only!) |
| `mining_job_logs` | ACTIVE | Job execution logs |
| `campaigns` | ACTIVE | Email campaigns |
| `campaign_recipients` | ACTIVE | Per-recipient tracking |
| `email_templates` | ACTIVE | Reusable templates with placeholders |
| `sender_identities` | ACTIVE | Verified sender emails |
| `unsubscribes` | ACTIVE | Opt-out records |

### Canonical Tables (Constitution Migration — Active)
| Table | Status | Migration | Notes |
|-------|--------|-----------|-------|
| `persons` | ACTIVE | 015 | Identity layer. `(organizer_id, LOWER(email))` unique. Populated by aggregationTrigger + backfill + CSV upload. |
| `affiliations` | ACTIVE | 016 | Person-company relationships. Additive only. Populated by aggregationTrigger + backfill + CSV upload. |
| `prospect_intents` | ACTIVE | 017 | Intent signals. Populated by webhook (reply, click_through). |
| `campaign_events` | ACTIVE | 018 | Immutable event log. Populated by webhook + campaignSend + backfill. |
| `verification_queue` | ACTIVE | 019 | Email verification queue. Processed by worker via ZeroBounce API. |
| `zoho_push_log` | ACTIVE | 020 | Zoho CRM push audit trail. Tracks create/update per person+module. |

### Legacy Tables (Exist but transitional)
| Table | Status | Notes |
|-------|--------|-------|
| `prospects` | LEGACY | Import-all + CSV upload (dual-write) still write here. Will be replaced when features migrate to persons + affiliations. |
| `lists` | LEGACY | Used by campaign resolve + CSV upload. Will be re-evaluated. |
| `list_members` | LEGACY | Used by campaign resolve + CSV upload. Will be re-evaluated. |
| `email_logs` | LEGACY | Webhook still writes here. Will be removed when campaign_events is fully adopted. |

**RULE:** Legacy tables must NOT be deleted. They remain until migration is complete.
New code should prefer canonical tables when available.

---

## Migration Strategy

Phase 1 — Add canonical tables (persons, affiliations). Backfill from mining_results. ✅ DONE
Phase 2 — Add intent + event tables (prospect_intents, campaign_events). Wire up webhook + send. ✅ DONE
Phase 3 — New features use canonical tables. Legacy tables become read-only.
Phase 4 — Remove legacy tables (only when fully migrated and tested).

**Current phase: Phase 3**

**IMPORTANT:** Legacy tables still serve existing features (import-all → prospects, campaign resolve → lists). Do not remove them until each feature is explicitly migrated to use canonical tables.

---

## Aggregation Layer

The aggregation trigger (`backend/services/aggregationTrigger.js`) bridges mining → canonical tables.

**Environment variables:**
| Variable | Default | Effect |
|----------|---------|--------|
| `DISABLE_SHADOW_MODE` | `false` | `true` disables aggregation entirely |
| `AGGREGATION_PERSIST` | `false` | `true` enables DB writes to persons + affiliations |
| `SHADOW_MODE_VERBOSE` | `false` | `true` enables verbose candidate logging |

**Data flow (persist mode):**
```
Miner → normalizeMinerOutput() → aggregationTrigger.aggregate() → persons + affiliations
```

**Call sites:**
- `miningService.js` — full mode mining (passes `job.organizer_id`)
- `miningWorker.js` — Playwright strategy (passes `job.organizer_id`)

---

## Webhook Event Flow

SendGrid webhook (`backend/routes/webhooks.js`) processes events through 3 layers:

```
SendGrid POST → campaign_recipients (UPDATE) → campaign_events (INSERT) → prospect_intents (INSERT, if intent-bearing) → email_logs (INSERT, legacy)
```

**Intent-bearing events:**
| SendGrid Event | Intent Type | Table |
|---------------|-------------|-------|
| `reply` | `reply` | `prospect_intents` |
| `click` | `click_through` | `prospect_intents` |

**Campaign send** (`backend/routes/campaignSend.js`) also writes `sent` events to `campaign_events`.

---

## Email Campaign Features

### Template Preview & Clone (`backend/routes/emailTemplates.js`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/email-templates/:id/preview` | POST | Render template with sample data (or custom `sample_data` in body). Returns `{ preview: { subject, body_html, body_text } }` |
| `/api/email-templates/:id/clone` | POST | Duplicate template with optional custom `name` (defaults to "Copy of {name}"). Returns new template. |

Preview uses a local `processTemplate()` that mirrors the one in `campaignSend.js`.
Default sample: `{ first_name: "John", last_name: "Doe", company: "Acme Corp", ... }`. `{{unsubscribe_url}}` resolves to `"#"` in preview.

### CSV Upload to Lists (`backend/routes/lists.js`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/lists/upload-csv` | POST (multipart) | Upload CSV file to create a new list with dual-write |

- Accepts `file` (CSV, max 10MB), `name` (optional), `tags` (optional JSON string)
- Flexible header aliases: `email`/`e-mail`/`Email`, `company`/`organization`, `first_name`/`firstname`, etc.
- **Dual-write (Phase 3 pattern):**
  - Legacy: `prospects` (check-then-insert/update) + `list_members`
  - Canonical: `persons` UPSERT + `affiliations` UPSERT (if company present)
- Response includes `canonical_sync: { persons_upserted, affiliations_upserted }`
- Route registered BEFORE `/:id` routes to avoid Express parameter collision

### Campaign Analytics (`backend/routes/campaigns.js`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/campaigns/:id/analytics` | GET | Full analytics from `campaign_events` table |

Returns 4 sections:
1. **Summary**: event counts + derived rates (open_rate, click_rate, bounce_rate, spam_rate, unsubscribe_rate)
2. **Timeline**: `date_trunc` bucketed by `hour` or `day` (`?bucket=hour`), pivoted by event_type
3. **Top Links**: top 10 clicked URLs with click counts
4. **Bounce Breakdown**: hard/soft/unknown classification based on reason text

### Campaign Scheduling (`backend/routes/campaigns.js`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/campaigns/:id/schedule` | POST | Schedule campaign for future send. Requires `scheduled_at` (ISO 8601, must be future). Campaign must be `'ready'`. |
| `/api/campaigns/:id/start` | POST | Start campaign immediately. Now accepts `'ready'` OR `'scheduled'` status (cancels schedule). |

**Scheduling flow:**
```
resolve → status='ready' → schedule → status='scheduled' → (campaignScheduler picks up at scheduled_at) → status='sending' → (worker processes batches) → status='completed'
```
`/:id/start` can bypass scheduling by transitioning directly from `'ready'` or `'scheduled'` to `'sending'`.

### Email Verification — ZeroBounce (`backend/services/verificationService.js`, `backend/routes/verification.js`)

**Per-organizer** ZeroBounce API key stored in `organizers.zerobounce_api_key`.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/verification/credits` | GET | Check ZeroBounce credit balance |
| `/api/verification/verify-single` | POST | Verify one email immediately. Dual-writes to `persons` + `prospects`. Body: `{ email }` |
| `/api/verification/verify-list` | POST | Queue list or email array for verification. Body: `{ list_id }` or `{ emails: [...] }` |
| `/api/verification/queue-status` | GET | Queue counts (pending/processing/completed/failed). Optional `?list_id=` filter |
| `/api/verification/process-queue` | POST | Manual trigger for queue processing. Body: `{ batch_size }` (default 50, max 200) |

**Settings endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/settings` | GET | Now includes `has_zerobounce_key`, `masked_zerobounce_key` |
| `/api/settings/zerobounce-key` | PUT | Save key after validating via `checkCredits()`. Body: `{ api_key }` |

**ZeroBounce → Liffy status mapping:**

| ZeroBounce | Liffy | Campaign Resolve |
|------------|-------|------------------|
| `valid` | `valid` | Send |
| `catch-all` | `catchall` | Send (like unknown) |
| `unknown` | `unknown` | Send |
| `invalid`, `spamtrap`, `abuse`, `do_not_mail` | `invalid` | Always exclude |

**Worker:** `startVerificationProcessor()` runs every 30s, finds organizers with pending queue + ZeroBounce key, processes batches of 50. Rate-limited at ~20 calls/sec.

**CSV Upload auto-queue:** After `POST /api/lists/upload-csv` commit, if organizer has ZeroBounce key, emails are auto-queued. Response includes `verification_queued` count.

---

## Backfill Scripts

Located in `backend/scripts/`. One-time, idempotent, `--dry-run` supported.

| Script | Source | Target | Notes |
|--------|--------|--------|-------|
| `backfill_persons.js` | `mining_results` | `persons` + `affiliations` | Uses nameParser + countryNormalizer |
| `backfill_campaign_events.js` | `campaign_recipients` | `campaign_events` | Converts timestamp columns to events |

---

## Zoho CRM Push — Integration (`backend/services/zohoService.js`, `backend/routes/zoho.js`)

**Per-organizer** Zoho OAuth2 credentials stored in `organizers` table (`zoho_client_id`, `zoho_client_secret`, `zoho_refresh_token`, `zoho_datacenter`).

**Settings endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/settings` | GET | Now includes `has_zoho`, `zoho_datacenter`, `masked_zoho_client_id` |
| `/api/settings/zoho` | PUT | Save Zoho OAuth2 credentials (validates via token refresh + org test). Body: `{ client_id, client_secret, refresh_token, datacenter }` |
| `/api/settings/zoho` | DELETE | Remove all Zoho credentials |

**Push endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/zoho/push` | POST | Push selected persons to Zoho CRM. Body: `{ person_ids: string[], module: 'Leads'\|'Contacts' }` |
| `/api/zoho/push-list` | POST | Push all persons from a list. Body: `{ list_id, module }` |
| `/api/zoho/push-history` | GET | Paginated push log. Query: `?person_id=&module=&page=1&limit=50` |
| `/api/zoho/push-status` | GET | Summary statistics (total_pushed, leads_pushed, contacts_pushed, failed, last_push_at) |

**Push flow:**
```
persons + affiliations → mapPersonToZoho() → Zoho CRM v7 API (batch 100/request) → zoho_push_log
```

**Dedup:** On re-push, existing `zoho_record_id` from `zoho_push_log` triggers UPDATE instead of CREATE.

**Datacenter support:** `com`, `eu`, `in`, `com.au`, `jp`, `ca` — determines API and OAuth endpoint URLs.

---

## Migrations (20 files)

| # | File | Tables |
|---|------|--------|
| 001 | `create_email_templates.sql` | `email_templates` |
| 002 | `create_campaigns.sql` | `campaigns` |
| 003 | `create_email_logs.sql` | `email_logs` |
| 004 | `create_organizers_users_sender_identities.sql` | `organizers`, `users`, `sender_identities` |
| 005 | `create_campaign_recipients.sql` | `campaign_recipients` |
| 005 | `mining_logs_and_results_updates.sql` | `mining_job_logs`, ALTER `mining_results` |
| 006 | `create_prospects_and_lists.sql` | `prospects`, `lists`, `list_members` |
| 007 | `create_mining_jobs.sql` | `mining_jobs` |
| 010 | `campaigns_add_list_sender_columns.sql` | ALTER `campaigns` |
| 011 | `campaign_recipients_add_prospect_id.sql` | ALTER `campaign_recipients` |
| 012 | `create_unsubscribes.sql` | `unsubscribes` |
| 013 | `add_webhook_tracking_columns.sql` | ALTER `campaign_recipients`, `unsubscribes` |
| 014 | `add_physical_address.sql` | ALTER `organizers` |
| 015 | `create_persons.sql` | `persons` |
| 016 | `create_affiliations.sql` | `affiliations` |
| 017 | `create_prospect_intents.sql` | `prospect_intents` |
| 018 | `create_campaign_events.sql` | `campaign_events` |
| 019 | `add_verification_columns.sql` | ALTER `organizers`, ALTER `persons`, `verification_queue` |
| 020 | `add_zoho_crm_columns.sql` | ALTER `organizers`, `zoho_push_log` |

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

### UI Concepts (Views, NOT tables)
| UI Page | Meaning |
|---------|---------|
| Contacts | Person + selected affiliation |
| Leads | Contacts without intent |
| Prospects | Contacts with intent |
| Mining Results | Discovery events |
| Lists | Campaign targeting snapshots |

**UI page names must NEVER mirror table names directly.**
**liffy-ui must treat API responses as canonical domain views, not database representations.**

---

## Forbidden Patterns (Anti-Patterns)

- Mining creates leads or prospects
- Mining writes to persons/prospects directly
- Email uniqueness enforced across organizers
- UI logic based on table names
- Storing engagement scores as persisted values
- Campaign directly mutating a person record
- Cross-domain side effects (mining → prospect creation)
- Miners normalizing, parsing names, inferring countries, or writing to DB
- Using nodemailer (SendGrid API only)
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

---

## Build Priority (Current)

1. ~~**Constitution Migration** — persons + affiliations tables, backfill~~ ✅ DONE
2. ~~**Campaign Events** — campaign_events table, webhook + send integration~~ ✅ DONE
3. ~~**ProspectIntent** — prospect_intents table, intent detection from webhook~~ ✅ DONE
4. ~~**Email Campaign improvements** — templates, list upload, send flow~~ ✅ DONE
5. ~~**Email verification** — ZeroBounce integration, per-organizer key, queue processor~~ ✅ DONE
6. ~~**Zoho CRM push** — push persons to Zoho CRM as Leads/Contacts~~ ✅ DONE
7. **Scraping module improvements** — if needed
8. **Phase 3 migration** — migrate import-all and campaign resolve to use canonical tables
9. **Remove nodemailer** — drop dependency from package.json

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

## What NOT To Do

- Do NOT refactor the mining engine unless explicitly asked
- Do NOT "improve architecture" without being asked — build what's requested
- Do NOT delete legacy tables — they stay until Phase 4
- Do NOT assume tables exist that aren't listed in "Current State" above
- Do NOT create new tables without checking this document first
