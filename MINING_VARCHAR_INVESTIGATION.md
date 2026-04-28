# Mining VARCHAR(255) Overflow Investigation

**Date:** 2026-04-28
**Status:** Analysis complete — ROOT CAUSE IDENTIFIED
**Context:** After migration 045 (VARCHAR→TEXT) and commit 38bfc22 (infinite loop fix), "value too long for type character varying(255)" error persists.

---

## 1. processImportBatch — ALL Write Paths

`backend/routes/miningResults.js` lines 487–674.

### Tables Written To (COMPLETE LIST)

| # | Table | Operation | Target Column | Column Type (after 045) | Source Value |
|---|-------|-----------|---------------|------------------------|--------------|
| 1 | mining_results | UPDATE | status | TEXT | `'imported'` or `'failed'` (hardcoded) |
| 2 | prospects | SELECT | — | — | Dedup check by email |
| 3 | prospects | UPDATE | tags | TEXT[] (array) | `mergedTags` (existing + new) |
| 4 | prospects | INSERT | organizer_id | UUID | `organizerId` |
| 5 | prospects | INSERT | email | VARCHAR(320) | `trimmedEmail` (validated email) |
| 6 | prospects | INSERT | **name** | **TEXT** (was VARCHAR(255)) | `mr.contact_name \|\| null` |
| 7 | prospects | INSERT | **company** | **TEXT** (was VARCHAR(255)) | `mr.company_name \|\| null` |
| 8 | prospects | INSERT | country | VARCHAR(100) | `mr.country \|\| null` |
| 9 | prospects | INSERT | source_type | VARCHAR(20) | `'mining'` (hardcoded, 6 chars) |
| 10 | prospects | INSERT | source_ref | TEXT | `jobId` (UUID, 36 chars) |
| 11 | prospects | INSERT | verification_status | VARCHAR(20) | `mr.verification_status \|\| 'unknown'` |
| 12 | prospects | INSERT | tags | TEXT[] | `tagsArray` (user-provided) |
| 13 | prospects | INSERT | meta | JSONB | Object with mr.* fields |
| 14 | list_members | INSERT | list_id, prospect_id, organizer_id | UUID×3 | IDs only |
| 15 | list_members | UPDATE | person_id | UUID | `personId` |
| 16 | persons | UPSERT | organizer_id | UUID | `organizerId` |
| 17 | persons | UPSERT | email | VARCHAR(320) | `trimmedEmail` |
| 18 | persons | UPSERT | **first_name** | **TEXT** (was VARCHAR(255)) | `firstName` (split from mr.contact_name) |
| 19 | persons | UPSERT | **last_name** | **TEXT** (was VARCHAR(255)) | `lastName` (split from mr.contact_name) |
| 20 | affiliations | UPSERT | organizer_id | UUID | `organizerId` |
| 21 | affiliations | UPSERT | person_id | UUID | `personId` |
| 22 | affiliations | UPSERT | **company_name** | **TEXT** (was VARCHAR(255)) | `mr.company_name` |
| 23 | affiliations | UPSERT | **position** | **TEXT** (was VARCHAR(255)) | `sanitizeShortText(mr.job_title, 200)` |
| 24 | affiliations | UPSERT | country_code | VARCHAR(2) | `mr.country.substring(0,2)` |
| 25 | affiliations | UPSERT | **city** | **TEXT** (was VARCHAR(255)) | `sanitizeCityField(mr.city)` |
| 26 | affiliations | UPSERT | website | VARCHAR(2048) | `mr.website \|\| null` |
| 27 | affiliations | UPSERT | phone | VARCHAR(100) | `mr.phone \|\| null` |
| 28 | affiliations | UPSERT | source_type | VARCHAR(20) | `'mining'` (hardcoded, 6 chars) |
| 29 | affiliations | UPSERT | source_ref | TEXT | `jobId` (UUID, 36 chars) |

### processImportInBackground additionally writes:

| # | Table | Operation | Target Column | Column Type | Source Value |
|---|-------|-----------|---------------|-------------|--------------|
| 30 | mining_jobs | UPDATE | import_status | VARCHAR(20) | `'processing'`/`'completed'`/`'failed'` |
| 31 | mining_jobs | UPDATE | import_progress | JSONB | Progress JSON object |

### import-all route additionally writes:

| # | Table | Operation | Target Column | Column Type | Source Value |
|---|-------|-----------|---------------|-------------|--------------|
| 32 | lists | INSERT | name | **VARCHAR(255)** | `list_name.trim()` (user input) |
| 33 | mining_jobs | UPDATE | import_status | VARCHAR(20) | `'processing'` |

### Verdict

After migration 045, processImportBatch writes to **ZERO VARCHAR(255) columns**.

The ONLY VARCHAR(255) column in the entire import-all flow is `lists.name` (row 32), which is user-provided text from the `list_name` request parameter — NOT from mining data. This cannot be the source of the overflow.

**processImportBatch does NOT write to:** campaign_recipients, contact_tasks, contact_notes, contact_activities, campaigns, email_templates, sender_identities, users, organizers, generated_miners, campaign_sequences.

---

## 2. Helper Functions Called by processImportBatch

### Direct analysis: processImportBatch calls NO external functions.

All SQL is inline within the function. Specifically:

- **aggregationTrigger** — imported at line 9, but ONLY called from `POST /api/mining/jobs/:id/results` route (line 315). **NOT called from processImportBatch or processImportInBackground.** The import path does its own inline SQL for persons + affiliations.
- **listService** — does not exist. List INSERT is inline in the import-all route (line 930).
- **contactService** — does not exist. No contact notes/activities/tasks are created during import.
- **normalizeMinerOutput** — only called in POST /results route (line 313), not in import path.

### aggregationTrigger.persistCandidates (for reference, NOT in import path)

Writes to:
- `persons` (first_name, last_name — now TEXT) ← `candidate.first_name`, `candidate.last_name`
- `affiliations` (company_name, position, city — now TEXT) ← `aff.company_name`, `aff.position`, `aff.city`

Same tables, same TEXT columns. No VARCHAR(255) risk here either.

---

## 3. mr.raw JSONB Usage

`mr.raw` is a JSONB column on mining_results. In processImportBatch:

- **mr.raw is NEVER read or used.** It's not in the SELECT column list for the batch query (line 717-719).
- The batch SELECT only fetches: `id, company_name, contact_name, job_title, emails, website, phone, country, city, address, source_url, confidence_score, verification_status`
- The `meta` JSONB written to prospects (line 551-562) is constructed from individual `mr.*` fields, NOT from `mr.raw`.

**Verdict: mr.raw plays no role in the import path.**

---

## 4. New Code Deployment Verification

### Code check (local repo):

| Feature | Present? | Location |
|---------|----------|----------|
| `sanitizeShortText` function | ✅ YES | Lines 20-26 |
| `sanitizeCityField` function | ✅ YES | Lines 28-30 |
| catch block `SET status = 'failed'` | ✅ YES | Lines 664-666 |
| `MAX_BATCH_ITERATIONS = 1000` | ✅ YES | Line 703 |
| `NOT IN ('imported', 'failed')` | ✅ YES | Lines 696, 723, 902, 1045 |

### CRITICAL EVIDENCE: New code was NOT running in production

**The worker reached batch 2003+.** But `MAX_BATCH_ITERATIONS = 1000` would have aborted at batch 1001 with:
```
[import-all] Max batch iterations (1000) exceeded for job {jobId}. Aborting.
```

**2003 > 1000 is proof that the OLD code (pre-38bfc22) was executing.**

Possible explanations:
1. **Render deploy didn't complete before the import was triggered.** The import started on the old instance, and Render's deploy killed the old process and started a new one — but the import was already mid-flight on old code.
2. **The import was already running when the push happened.** Render auto-deploy restarts the process, but `setImmediate(() => processImportInBackground(...))` runs in-memory. If the old process was mid-import, the deploy would kill it. But if someone re-triggered the import immediately after deploy, it would run new code → should have stopped at 1000.
3. **Zero-downtime deploy overlap.** Render may briefly run both old and new instances. The old instance could continue processing.

---

## 5. Special Test: Other VARCHAR(255) Write Paths for mr.* Data

### Complete VARCHAR(255) column inventory (from user's production query):

| Table | Column | Written by processImportBatch? |
|-------|--------|-------------------------------|
| campaign_recipients | name | ❌ NO |
| campaign_sequences | subject_override | ❌ NO |
| campaigns | name | ❌ NO |
| contact_tasks | title | ❌ NO |
| email_templates | name | ❌ NO |
| email_templates | subject | ❌ NO |
| generated_miners | domain_pattern | ❌ NO |
| lists | name | ✅ YES — but from user input, not mr.* |
| mining_jobs | name | ❌ NO (only import_status + import_progress) |
| organizers | name, default_from_email, default_from_name | ❌ NO |
| sender_identities | from_name, from_email, reply_to | ❌ NO |
| users | email | ❌ NO |

**Verdict: processImportBatch writes to ZERO of the 16 remaining VARCHAR(255) columns.**

No `mr.*` value flows to any VARCHAR(255) column. Specifically:
- `mr.city` → `affiliations.city` (now TEXT) via sanitizeCityField
- `mr.job_title` → `affiliations.position` (now TEXT) via sanitizeShortText
- `mr.contact_name` → `prospects.name` (now TEXT), `persons.first_name`/`last_name` (now TEXT)
- `mr.company_name` → `prospects.company` (now TEXT), `affiliations.company_name` (now TEXT)
- No mr.* value goes to contact_tasks.title, campaign_recipients.name, or any other VARCHAR(255) column.

---

## ROOT CAUSE ANALYSIS

### The error "value too long for type character varying(255)" CANNOT come from processImportBatch after migration 045.

Every column that previously was VARCHAR(255) and received mining data has been migrated to TEXT. The remaining VARCHAR(255) columns in the database are in tables that processImportBatch never touches.

### The batch count (2003+) proves OLD CODE was running.

The new code's MAX_BATCH_ITERATIONS=1000 would have stopped execution at batch 1001. Reaching 2003+ is definitive proof that commit 38bfc22 was not the code running the import.

### Three scenarios explain the persistent error:

| # | Scenario | Likelihood | Verification |
|---|----------|------------|--------------|
| A | **Old code ran on old Render instance** while new code deployed. The VARCHAR(255) error came from the old code writing to TEXT columns — but wait, migration 045 was applied BEFORE deploy. So even old code + TEXT columns = no VARCHAR(255) error. Unless migration 045 didn't actually succeed. | **HIGH — if migration 045 failed** | Run: `SELECT column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_name = 'persons' AND column_name IN ('first_name','last_name');` |
| B | **Migration 045 was applied but didn't commit.** The migration uses BEGIN/COMMIT — if the psql session was interrupted or the connection dropped, the transaction would rollback. All 7 ALTER TABLE statements would revert. | **MEDIUM** | Same query as A — check actual production types |
| C | **The error is from a DIFFERENT process** (not import). A concurrent mining job, campaign send, or other background task hit a VARCHAR(255) column. The error was attributed to import but actually came from another worker path. | **LOW** | Check Render logs: does the error stack trace point to processImportBatch or elsewhere? |

---

## VERIFICATION COMMANDS (run in production psql)

### 1. Confirm migration 045 actually took effect:
```sql
SELECT table_name, column_name, data_type, character_maximum_length
FROM information_schema.columns
WHERE (table_name, column_name) IN (
  ('affiliations', 'company_name'),
  ('affiliations', 'position'),
  ('affiliations', 'city'),
  ('prospects', 'name'),
  ('prospects', 'company'),
  ('persons', 'first_name'),
  ('persons', 'last_name')
)
ORDER BY table_name, column_name;
```

**Expected (if migration succeeded):** All 7 rows show `data_type = 'text'`, `character_maximum_length = NULL`
**If migration failed:** Some/all show `data_type = 'character varying'`, `character_maximum_length = 255`

### 2. Check if any other VARCHAR(255) columns exist that we missed:
```sql
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND data_type = 'character varying'
  AND character_maximum_length = 255
ORDER BY table_name, column_name;
```

### 3. Check failed rows' current status:
```sql
SELECT status, COUNT(*) FROM mining_results
WHERE job_id = (SELECT id FROM mining_jobs ORDER BY created_at DESC LIMIT 1)
GROUP BY status;
```

---

## TL;DR

**VARCHAR(255) hatası processImportBatch'ten GELEMİYOR** — migration 045 sonrası bu fonksiyonun yazdığı hiçbir kolonda VARCHAR(255) kalmadı.

**2003+ batch = eski kod kanıtı** — MAX_BATCH_ITERATIONS=1000 olan yeni kod çalışsaydı 1001'de dururdu.

**En olası senaryo: Migration 045 commit etmedi veya uygulanmadı.**

### Fix checklist:

- [ ] **ÖNCE:** Production'da verification query çalıştır (Bölüm "Verification Commands" #1)
- [ ] Eğer kolonlar hala VARCHAR(255) ise → migration 045'i tekrar çalıştır
- [ ] Eğer kolonlar TEXT ise → Render logs'tan error stack trace'i al (hangi fonksiyon, hangi satır?)
- [ ] Yeni kodun canlıda olduğunu doğrula: `MAX_BATCH_ITERATIONS` log'u aranmalı
- [ ] Migration doğrulandıktan sonra failed satırları retry et: `UPDATE mining_results SET status = 'pending' WHERE status = 'failed';`

**Hipotez production'da SQL ile doğrulanabilir mi?** EVET — verification query #1 kesin cevap verir.
