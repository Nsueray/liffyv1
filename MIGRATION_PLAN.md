# MIGRATION_PLAN.md — Phase 4: Legacy Table Removal

> Canonical migration from hybrid dual-write to persons+affiliations as single source of truth.
> Each step is independent, reversible, and can be deployed separately.

---

## Current State (Hybrid — Late Phase 3)

### What Exists Today

| Pattern | Description |
|---------|-------------|
| **Dual-write** | All import paths (CSV upload, import-all, leads/import) write to BOTH `prospects` (legacy) AND `persons`+`affiliations` (canonical) |
| **list_members → prospect_id** | `list_members.prospect_id` references `prospects.id`. Campaign resolve starts from `list_members JOIN prospects` |
| **COALESCE hacks** | Campaign resolve uses `COALESCE(persons.X, prospects.X)` for name, company, verification_status |
| **campaign_recipients mutable columns** | Webhooks update `delivered_at`, `opened_at`, `clicked_at`, `bounced_at`, `open_count`, `click_count` on campaign_recipients (alongside canonical `campaign_events` INSERT) |
| **verification dual-write** | Verification worker updates BOTH `persons.verification_status` AND `prospects.verification_status` |

### Legacy Tables Still Active

| Table | Reads | Writes | Files |
|-------|-------|--------|-------|
| `prospects` | 8 files (25 queries) | 8 files (21 queries) | lists.js, leads.js, miningResults.js, campaigns.js, verification.js, verificationService.js, prospects.js, urlMiner.js |
| `list_members` | 6 files (17 queries) | 5 files (15 queries) | lists.js, campaigns.js, leads.js, miningResults.js, zoho.js, verification.js |
| `email_logs` | 0 files | 1 file (testEmail.js) | testEmail.js, models/emailLogs.js (dead code) |

### Key Dependencies

```
campaign resolve: list_members → prospects → persons (LEFT JOIN) → affiliations (LATERAL)
list detail:      list_members → prospects → persons (LEFT JOIN for name COALESCE)
verification:     verification_queue.prospect_id → prospects (dual-write status)
zoho push-list:   list_members → prospects → persons (resolve person_ids)
```

---

## Target State (Canonical — Phase 4 Complete)

### What Should Exist After Migration

| Pattern | Description |
|---------|-------------|
| **Single-write** | All import paths write ONLY to `persons` + `affiliations`. No `prospects` table writes. |
| **list_members → person_id** | `list_members.person_id` references `persons.id`. Campaign resolve starts from `list_members JOIN persons` |
| **No COALESCE hacks** | Campaign resolve reads directly from `persons` + `affiliations`. No fallback to `prospects`. |
| **campaign_events only** | Engagement data lives exclusively in `campaign_events`. Mutable columns on `campaign_recipients` frozen (no more webhook updates). |
| **verification single-write** | Verification worker updates ONLY `persons.verification_status`. |
| **prospects archived** | `prospects` renamed to `prospects_archive`. Retained for historical queries only. |
| **email_logs dropped** | `email_logs` table dropped (zero active references). |

### Final Table Relationships

```
campaign resolve: list_members → persons → affiliations (LATERAL)
list detail:      list_members → persons → affiliations (LATERAL)
verification:     verification_queue.person_id → persons (single-write status)
zoho push-list:   list_members → persons → affiliations
```

---

## Step 1: list_members Migration (prospect_id → person_id)

> **Goal:** Add `person_id` column to `list_members`, backfill from prospects→persons email mapping, migrate all queries to use `person_id` instead of `prospect_id`.

### 1.1 Migration SQL

```sql
-- Migration 024: add_list_members_person_id.sql

-- 1. Add person_id column (nullable initially)
ALTER TABLE list_members
  ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES persons(id) ON DELETE CASCADE;

-- 2. Index for lookups
CREATE INDEX IF NOT EXISTS idx_list_members_person_id
  ON list_members (person_id);

-- 3. Unique constraint: one person per list
CREATE UNIQUE INDEX IF NOT EXISTS idx_list_members_list_person
  ON list_members (list_id, person_id)
  WHERE person_id IS NOT NULL;
```

### 1.2 Backfill Script

**File:** `backend/scripts/backfill_list_members_person_id.js`

```
Logic:
  1. SELECT lm.id, lm.prospect_id, p.email, p.organizer_id
     FROM list_members lm
     JOIN prospects p ON p.id = lm.prospect_id
     WHERE lm.person_id IS NULL

  2. For each row:
     - Look up persons WHERE organizer_id = p.organizer_id AND LOWER(email) = LOWER(p.email)
     - If found: UPDATE list_members SET person_id = persons.id WHERE id = lm.id
     - If NOT found: CREATE person from prospect data, then SET person_id

  3. Process in batches of 500, single transaction per batch
  4. Support --dry-run flag
  5. Report: { total, mapped, created, failed }
```

**Expected behavior:**
- Most rows will map directly (dual-write has been active since Phase 3)
- Rows from before Phase 3 (no corresponding person) get a new person created
- Idempotent: safe to run multiple times

### 1.3 Query Migration — Affected Routes/Files

After backfill, all queries switch from `prospect_id` to `person_id`:

#### `backend/routes/campaigns.js` — Campaign Resolve (Lines 360–404)

**Before:**
```sql
FROM list_members lm
INNER JOIN prospects p ON p.id = lm.prospect_id
LEFT JOIN persons pn ON LOWER(pn.email) = LOWER(p.email) AND pn.organizer_id = $2
LEFT JOIN LATERAL (
  SELECT ... FROM affiliations WHERE person_id = pn.id ...
) aff ON pn.id IS NOT NULL
```

**After:**
```sql
FROM list_members lm
INNER JOIN persons pn ON pn.id = lm.person_id
LEFT JOIN LATERAL (
  SELECT ... FROM affiliations WHERE person_id = pn.id AND organizer_id = $2
  ORDER BY created_at DESC LIMIT 1
) aff ON true
```

- Eliminates `prospects` JOIN entirely
- Eliminates email-based LEFT JOIN (direct FK now)
- Eliminates all COALESCE patterns (name, company, verification_status read from persons+affiliations directly)
- Also update exclusion stat queries (lines 421–475) to use same pattern

#### `backend/routes/campaigns.js` — Duplicate Avoidance

**Before:** `WHERE cr.prospect_id = p.id`
**After:** Need to update `campaign_recipients` to store `person_id` or match by email

> **Note:** `campaign_recipients.prospect_id` still references `prospects.id`. This column is NOT changed in Step 1 — it becomes orphaned but is only used for dedup within a single campaign. Alternative: dedup by `LOWER(email)` instead of `prospect_id`.

#### `backend/routes/lists.js` — List Detail (GET /api/lists/:id)

**Before:**
```sql
FROM list_members lm
JOIN prospects p ON p.id = lm.prospect_id
LEFT JOIN persons pn ON LOWER(pn.email) = LOWER(p.email) AND pn.organizer_id = lm.organizer_id
```

**After:**
```sql
FROM list_members lm
JOIN persons pn ON pn.id = lm.person_id
LEFT JOIN LATERAL (
  SELECT company_name, position, country_code, city, website, phone
  FROM affiliations
  WHERE person_id = pn.id AND organizer_id = lm.organizer_id
  ORDER BY created_at DESC LIMIT 1
) aff ON true
```

#### `backend/routes/lists.js` — Member Count Queries

All count queries that JOIN `list_members → prospects` switch to `list_members → persons`.

#### `backend/routes/lists.js` — CSV Upload / Add-Manual / Import-Bulk

**Before:** Insert prospect → Insert list_member with `prospect_id`
**After:** Insert person (UPSERT) → Insert list_member with `person_id`

> **Important:** During transition period (Step 1 only), BOTH `prospect_id` AND `person_id` are written. Dual-write removal happens in Step 2.

#### `backend/routes/lists.js` — List Delete / Member Remove

**Before:** `DELETE FROM list_members WHERE prospect_id = $1`
**After:** `DELETE FROM list_members WHERE person_id = $1`

#### `backend/routes/miningResults.js` — Import-All

**Before:** Creates prospect → inserts `list_members.prospect_id`
**After:** Creates person (UPSERT) → inserts `list_members.person_id`

> Same transition note: during Step 1, write both columns.

#### `backend/routes/leads.js` — Lead Import with List Creation

**Before:** Creates prospect → inserts `list_members.prospect_id`
**After:** Creates person (UPSERT) → inserts `list_members.person_id`

#### `backend/routes/verification.js` — List Verification

**Before:**
```sql
SELECT p.email FROM list_members lm JOIN prospects p ON p.id = lm.prospect_id
```

**After:**
```sql
SELECT pn.email FROM list_members lm JOIN persons pn ON pn.id = lm.person_id
```

#### `backend/routes/zoho.js` — Push List

**Before:**
```sql
FROM list_members lm JOIN prospects p ON p.id = lm.prospect_id
LEFT JOIN persons pn ON LOWER(pn.email) = LOWER(p.email)
```

**After:**
```sql
FROM list_members lm JOIN persons pn ON pn.id = lm.person_id
```

#### `backend/routes/prospects.js` — Legacy Endpoints

These endpoints (`POST /api/prospects/bulk`, `GET /api/prospects`) still use `prospects` directly. They will be deprecated but not changed in this step.

### 1.4 Rollback Plan

1. All queries can be reverted to use `prospect_id` (column is NOT dropped)
2. `person_id` column is nullable — old code works without it
3. No data is deleted — `prospect_id` values remain intact
4. Rollback SQL: `ALTER TABLE list_members DROP COLUMN IF EXISTS person_id;`

### 1.5 Test Checklist

- [ ] Backfill script maps all existing list_members to person_id (0 NULLs remaining)
- [ ] Backfill creates persons for any unmapped prospects
- [ ] Campaign resolve returns same recipients before/after (compare email sets)
- [ ] Campaign resolve verification filtering works (exclude_invalid, verified_only)
- [ ] Campaign resolve unsubscribe exclusion works
- [ ] List detail page shows correct names, companies, verification badges
- [ ] List member counts match before/after on lists index page
- [ ] CSV upload creates list_member with person_id populated
- [ ] Import-all creates list_member with person_id populated
- [ ] Lead import with create_list creates list_member with person_id populated
- [ ] List verification (verify-list) finds emails via person_id JOIN
- [ ] Zoho push-list resolves person_ids via list_members.person_id
- [ ] List member delete works with person_id
- [ ] New unique constraint prevents duplicate person in same list

---

## Step 2: Dual-Write Removal

> **Goal:** Stop writing to `prospects` table from all import paths. `persons`+`affiliations` become the sole write target.
> **Prerequisite:** Step 1 complete and verified in production.

### 2.1 No Migration SQL Required

No schema changes needed. This is a code-only change — removing legacy INSERT/UPDATE to `prospects` from all write paths.

### 2.2 Affected Routes/Files — Remove Legacy Writes

#### `backend/routes/lists.js` — CSV Upload (Inline + Background)

**Remove:**
- Inline path: `SELECT id FROM prospects WHERE ...` (check existing) → `UPDATE prospects` / `INSERT INTO prospects` → `INSERT INTO list_members (prospect_id)`
- Background path: same pattern (different function, ~line 440–480)
- Add-manual endpoint: `SELECT id FROM prospects` → `INSERT INTO prospects` → `INSERT INTO list_members (prospect_id)`
- Import-bulk endpoint: same pattern

**Keep:**
- `persons` UPSERT (existing)
- `affiliations` UPSERT (existing)
- `list_members` INSERT with `person_id` (from Step 1)

#### `backend/routes/miningResults.js` — Import-All (processImportBatch)

**Remove:**
- `SELECT id FROM prospects WHERE LOWER(email) = ...` (check existing)
- `UPDATE prospects SET ...` (update existing)
- `INSERT INTO prospects (...)` (create new)
- `INSERT INTO list_members (..., prospect_id)` (legacy FK)

**Keep:**
- `persons` UPSERT
- `affiliations` UPSERT
- `list_members` INSERT with `person_id`

#### `backend/routes/leads.js` — Lead Import

**Remove:**
- `SELECT id, meta, tags FROM prospects WHERE LOWER(email) = ...` (check existing)
- `UPDATE prospects SET ...` (merge existing)
- `INSERT INTO prospects (...)` (create new)
- `INSERT INTO list_members (..., prospect_id)` (legacy FK)

**Keep:**
- `persons` UPSERT
- `affiliations` UPSERT
- `list_members` INSERT with `person_id`

#### `backend/services/verificationService.js` — Verification Worker

**Remove:**
- `SELECT id FROM prospects WHERE ...` (lookup prospect_id for queue)
- `UPDATE prospects SET verification_status = ...` (dual-write status)
- `prospect_id` parameter in `INSERT INTO verification_queue`

**Keep:**
- `persons` verification_status UPDATE (existing)

#### `backend/routes/verification.js` — Verify Single

**Remove:**
- `UPDATE prospects SET verification_status = $1 WHERE organizer_id = $2 AND LOWER(email) = $3`

**Keep:**
- `persons` verification_status UPDATE (existing)

#### `backend/services/urlMiner.js` — URL Mining

**Remove:**
- `SELECT id FROM prospects WHERE ...` (check existing)
- `INSERT INTO prospects (...)` (create new)
- `INSERT INTO list_members (..., prospect_id)` (legacy FK)

**Add:**
- `persons` UPSERT (currently missing — urlMiner has NO dual-write)
- `affiliations` UPSERT
- `list_members` INSERT with `person_id`

> **Note:** `urlMiner.js` is the one write path that currently writes to `prospects` WITHOUT dual-writing to `persons`. This must be fixed before removal.

#### `backend/routes/prospects.js` — Legacy Prospects API

**Deprecate entire file:**
- `POST /api/prospects/bulk` — no longer needed (use leads/import or CSV upload)
- `GET /api/prospects` — replaced by `GET /api/persons`
- `POST /api/lists/:id/add` — replaced by list add-manual endpoint

**Action:** Remove routes from `server.js`, keep file for reference.

### 2.3 Leads API Migration

`GET /api/leads` and tag endpoints currently read from `prospects` table directly.

**Options:**
1. Redirect reads to `persons` + `affiliations` (preferred)
2. Keep legacy reads temporarily (simpler, but delays full removal)

**Recommended:** Rewrite `GET /api/leads` to query `persons` + `affiliations` with same filters. This is essentially the same as `GET /api/persons` — consider deprecating `/api/leads` in favor of `/api/persons`.

### 2.4 Rollback Plan

1. Re-enable dual-write code (git revert)
2. No schema changes to revert
3. `prospects` table data is frozen at point of removal (not deleted)
4. Any new imports during rollback window won't be in `prospects` — backfill from `persons` if needed

### 2.5 Test Checklist

- [ ] CSV upload creates person + affiliation + list_member (no prospect row)
- [ ] Import-all creates person + affiliation + list_member (no prospect row)
- [ ] Lead import creates person + affiliation + list_member (no prospect row)
- [ ] URL mining creates person + affiliation + list_member (no prospect row)
- [ ] Verification worker updates ONLY persons.verification_status
- [ ] Verify-single updates ONLY persons.verification_status
- [ ] Campaign resolve works (uses person_id from Step 1)
- [ ] List detail works (uses person_id from Step 1)
- [ ] No new rows appear in prospects table after any operation
- [ ] GET /api/leads returns data from persons+affiliations (or deprecated)
- [ ] Zoho push-list still works (already uses persons from Step 1)
- [ ] Bulk tag operations work (migrated to persons or deprecated)

---

## Step 3: campaign_events as Canonical Engagement

> **Goal:** Stop updating mutable columns on `campaign_recipients` from webhooks. `campaign_events` becomes the sole engagement data source. All reporting reads from `campaign_events` only.
> **Prerequisite:** Step 2 complete. All reporting endpoints already have `campaign_events` fallback (currently active as primary).

### 3.1 Migration SQL

```sql
-- Migration 025: freeze_campaign_recipients_columns.sql

-- Add comment documenting frozen columns (no schema change needed)
COMMENT ON COLUMN campaign_recipients.delivered_at IS 'FROZEN — historical only. New data in campaign_events.';
COMMENT ON COLUMN campaign_recipients.opened_at IS 'FROZEN — historical only. New data in campaign_events.';
COMMENT ON COLUMN campaign_recipients.clicked_at IS 'FROZEN — historical only. New data in campaign_events.';
COMMENT ON COLUMN campaign_recipients.bounced_at IS 'FROZEN — historical only. New data in campaign_events.';
COMMENT ON COLUMN campaign_recipients.open_count IS 'FROZEN — historical only. New data in campaign_events.';
COMMENT ON COLUMN campaign_recipients.click_count IS 'FROZEN — historical only. New data in campaign_events.';

-- Note: columns are NOT dropped. They retain historical data.
-- The webhook handler stops updating them (code change).
```

### 3.2 Affected Routes/Files

#### `backend/routes/webhooks.js` — Stop Updating Mutable Columns

**Current behavior (lines 142–200):** Each webhook event updates BOTH:
1. `campaign_recipients` mutable columns (delivered_at, opened_at, etc.)
2. `campaign_events` INSERT (canonical)

**After:**
- Remove all `UPDATE campaign_recipients SET delivered_at/opened_at/clicked_at/bounced_at/open_count/click_count` statements
- Keep `UPDATE campaign_recipients SET status = ...` (status column is still useful for send-batch flow)
- Keep all `campaign_events` INSERT statements (already canonical)

**Specific changes:**

| Event Type | Remove | Keep |
|------------|--------|------|
| `delivered` | `delivered_at = $2` | `status = 'delivered'` |
| `open` | `opened_at = COALESCE(opened_at, $2), open_count = COALESCE(open_count, 0) + 1` | `status = 'opened'` |
| `click` | `clicked_at = COALESCE(clicked_at, $2), click_count = COALESCE(click_count, 0) + 1` | `status = 'clicked'` |
| `bounce` | `bounced_at = $2` | `status = 'bounced'`, `last_error = $3` |
| `spamreport` | `bounced_at = $2` | `status = 'bounced'`, `last_error = 'Spam report'` |

#### `backend/routes/campaigns.js` — Analytics Endpoint

Currently reads from `campaign_events` (primary) with `campaign_recipients` fallback.

**After:** Remove `campaign_recipients` fallback from analytics. `campaign_events` is sole source.

#### `backend/routes/reports.js` — Reports Endpoints

Currently reads from `campaign_events` with `campaign_recipients` fallback.

**After:** Remove `campaign_recipients` timestamp fallback. All report data from `campaign_events`.

> **Note:** The `campaign_recipients` fallback was added because `campaign_events` backfill hadn't been run. By Step 3, either the backfill has been run or all new campaigns use `campaign_events` exclusively. Old campaigns without backfilled events will show empty analytics — acceptable trade-off.

#### `backend/routes/campaignSend.js` — No Changes

Already writes to `campaign_events` only. No mutable column writes.

### 3.3 Performance Index (Recommended)

```sql
-- Add composite indexes for common campaign_events queries
CREATE INDEX IF NOT EXISTS idx_campaign_events_org_campaign_type
  ON campaign_events (organizer_id, campaign_id, event_type);

CREATE INDEX IF NOT EXISTS idx_campaign_events_org_person
  ON campaign_events (organizer_id, person_id);

CREATE INDEX IF NOT EXISTS idx_campaign_events_org_occurred
  ON campaign_events (organizer_id, occurred_at);
```

These are from the Technical Debt backlog in CLAUDE.md.

### 3.4 Rollback Plan

1. Re-enable mutable column updates in webhooks.js (git revert)
2. Re-enable `campaign_recipients` fallback in analytics/reports
3. No data loss — `campaign_events` rows are immutable and always written
4. Gap: events received during freeze period won't have mutable column values (but `campaign_events` has them)

### 3.5 Test Checklist

- [ ] Webhook `delivered` event: creates `campaign_events` row, does NOT update `delivered_at` on campaign_recipients
- [ ] Webhook `open` event: creates `campaign_events` row, does NOT update `opened_at`/`open_count`
- [ ] Webhook `click` event: creates `campaign_events` row, does NOT update `clicked_at`/`click_count`
- [ ] Webhook `bounce` event: creates `campaign_events` row, does NOT update `bounced_at` (but DOES update `status` + `last_error`)
- [ ] Campaign analytics endpoint returns correct data from `campaign_events` only
- [ ] Reports overview endpoint returns correct data from `campaign_events` only
- [ ] Person detail engagement summary uses `campaign_events`
- [ ] Logs endpoint uses `campaign_events` (already does)
- [ ] Campaign detail recipients table still shows status correctly
- [ ] Old campaigns (pre-events) show empty analytics gracefully (no errors)

---

## Step 4: Cleanup — Archive & Drop

> **Goal:** Rename `prospects` to `prospects_archive`, drop `email_logs`, clean up dead code.
> **Prerequisite:** Steps 1–3 complete and stable in production for at least 2 weeks.

### 4.1 Migration SQL

```sql
-- Migration 026: archive_legacy_tables.sql

-- 1. Rename prospects to archive
ALTER TABLE prospects RENAME TO prospects_archive;

-- 2. Update foreign key on list_members (drop old, keep person_id)
ALTER TABLE list_members DROP CONSTRAINT IF EXISTS list_members_prospect_id_fkey;

-- 3. Rename prospect_id column for clarity (optional)
ALTER TABLE list_members RENAME COLUMN prospect_id TO prospect_id_legacy;

-- 4. Make person_id NOT NULL (all rows should be backfilled from Step 1)
ALTER TABLE list_members ALTER COLUMN person_id SET NOT NULL;

-- 5. Drop campaign_recipients.prospect_id FK (references defunct prospects)
ALTER TABLE campaign_recipients DROP CONSTRAINT IF EXISTS campaign_recipients_prospect_id_fkey;
ALTER TABLE campaign_recipients RENAME COLUMN prospect_id TO prospect_id_legacy;

-- 6. Drop verification_queue.prospect_id FK
ALTER TABLE verification_queue DROP CONSTRAINT IF EXISTS verification_queue_prospect_id_fkey;
ALTER TABLE verification_queue RENAME COLUMN prospect_id TO prospect_id_legacy;

-- 7. Drop email_logs table (zero active references)
DROP TABLE IF EXISTS email_logs;

-- 8. Drop dead indexes on prospects_archive (save storage)
-- (optional — archive table indexes waste space)
DROP INDEX IF EXISTS idx_prospects_organizer_id;
DROP INDEX IF EXISTS idx_prospects_email;
DROP INDEX IF EXISTS idx_prospects_verification_status;

-- 9. Remove email_logs model (dead code deletion in codebase, not SQL)
```

### 4.2 Affected Files — Dead Code Removal

| File | Action |
|------|--------|
| `backend/routes/prospects.js` | DELETE file — all endpoints deprecated |
| `backend/models/emailLogs.js` | DELETE file — dead code (zero callers) |
| `backend/routes/testEmail.js` | REMOVE `email_logs` INSERT (line 119) — use `campaign_events` or remove entirely |
| `backend/routes/leads.js` | REMOVE or rewrite to use `persons` — `GET /api/leads` reads from `prospects` |
| `backend/server.js` | REMOVE `app.use('/api/prospects', ...)` route registration |
| `backend/server.js` | REMOVE `app.use('/api/leads', ...)` if deprecated in favor of `/api/persons` |

### 4.3 Column Cleanup Summary

| Table | Column | Action |
|-------|--------|--------|
| `list_members` | `prospect_id` | RENAME to `prospect_id_legacy` |
| `list_members` | `person_id` | SET NOT NULL |
| `campaign_recipients` | `prospect_id` | RENAME to `prospect_id_legacy` |
| `campaign_recipients` | `delivered_at` | RETAIN (historical data, frozen since Step 3) |
| `campaign_recipients` | `opened_at` | RETAIN (historical data, frozen) |
| `campaign_recipients` | `clicked_at` | RETAIN (historical data, frozen) |
| `campaign_recipients` | `bounced_at` | RETAIN (historical data, frozen) |
| `campaign_recipients` | `open_count` | RETAIN (historical data, frozen) |
| `campaign_recipients` | `click_count` | RETAIN (historical data, frozen) |
| `verification_queue` | `prospect_id` | RENAME to `prospect_id_legacy` |

> Frozen columns on `campaign_recipients` are NOT dropped — they contain valid historical data from before Step 3. They will never be updated again.

### 4.4 Rollback Plan

1. `ALTER TABLE prospects_archive RENAME TO prospects;` — restores the table
2. `ALTER TABLE list_members RENAME COLUMN prospect_id_legacy TO prospect_id;` — restores column name
3. `email_logs` DROP is irreversible — but table has zero active references and can be recreated from migration 003 if needed
4. Dead code files can be restored from git history

### 4.5 Test Checklist

- [ ] All import paths work without prospects table
- [ ] Campaign resolve works with person_id only
- [ ] List detail works with person_id only
- [ ] Verification works without prospect dual-write
- [ ] Analytics works without campaign_recipients fallback
- [ ] Reports work without campaign_recipients fallback
- [ ] No 500 errors referencing `prospects` table in logs
- [ ] No 500 errors referencing `email_logs` table in logs
- [ ] `prospects_archive` table still queryable for historical analysis
- [ ] `list_members.prospect_id_legacy` column retained for audit
- [ ] Application starts without `prospects.js` route
- [ ] Application starts without `emailLogs.js` model

---

## Execution Timeline

| Step | Scope | Risk | Estimated Effort |
|------|-------|------|------------------|
| **Step 1** | list_members + person_id | LOW — additive only, no data loss | Migration + backfill + 10 files |
| **Step 2** | Remove dual-write | MEDIUM — stop writing to legacy | 7 files (remove code) |
| **Step 3** | Freeze mutable columns | LOW — campaign_events already primary | 3 files (webhooks, analytics, reports) |
| **Step 4** | Archive + cleanup | LOW — all dependencies removed | Migration + delete dead files |

### Deploy Order

```
Step 1 → Deploy → Verify 1 week → Step 2 → Deploy → Verify 1 week → Step 3 → Deploy → Verify 2 weeks → Step 4
```

### Pre-Requisites Checklist

- [ ] Backfill script for list_members.person_id written and tested
- [ ] All existing list_members rows have corresponding persons (verify query)
- [ ] urlMiner.js dual-write added (currently missing — only writes to prospects)
- [ ] campaign_events backfill run (or accepted that old campaigns show empty analytics)
- [ ] Production monitoring for 500 errors on affected endpoints
- [ ] Database backup before each step

---

## Files Changed Per Step (Summary)

### Step 1 (11 files)
- `migrations/024_add_list_members_person_id.sql` — NEW
- `scripts/backfill_list_members_person_id.js` — NEW
- `routes/campaigns.js` — resolve query rewrite
- `routes/lists.js` — detail, counts, CSV upload, add-manual, import-bulk, delete
- `routes/miningResults.js` — import-all batch processor
- `routes/leads.js` — lead import with list creation
- `routes/verification.js` — list verification email lookup
- `routes/zoho.js` — push-list person resolve
- `services/urlMiner.js` — add dual-write (person_id for list_member)

### Step 2 (7 files)
- `routes/lists.js` — remove prospects INSERT/UPDATE/SELECT
- `routes/miningResults.js` — remove prospects INSERT/UPDATE/SELECT
- `routes/leads.js` — remove prospects INSERT/UPDATE/SELECT (or rewrite reads)
- `services/verificationService.js` — remove prospects lookup + status write
- `routes/verification.js` — remove prospects status write
- `services/urlMiner.js` — remove prospects INSERT
- `routes/prospects.js` — deprecate (remove from server.js)

### Step 3 (3+ files)
- `routes/webhooks.js` — remove mutable column updates
- `routes/campaigns.js` — remove campaign_recipients analytics fallback
- `routes/reports.js` — remove campaign_recipients reports fallback
- `migrations/025_freeze_campaign_recipients_columns.sql` — NEW (comments only)

### Step 4 (5+ files)
- `migrations/026_archive_legacy_tables.sql` — NEW
- `routes/prospects.js` — DELETE
- `models/emailLogs.js` — DELETE
- `routes/testEmail.js` — remove email_logs INSERT
- `server.js` — remove route registrations
- `routes/leads.js` — rewrite or DELETE (if deprecated)
