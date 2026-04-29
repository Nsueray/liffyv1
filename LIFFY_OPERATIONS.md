# LIFFY Operations Quickstart

Bu belgenin amaci: yeni bir Claude chat'inde Liffy'nin operational gercekligini hizlica anlamak. Project Knowledge'a eklenmeli.

## Production Infrastructure

### Render Services (3 ayri servis)
- **liffy-api** (Node, Starter plan) — HTTP endpoints, UI requests
- **liffy-worker-docker** (Docker, Standard plan, Playwright) — Mining + import-all
- **liffy-redis** (Valkey 8) — BullMQ queues + intermediate storage

Push to `main` her iki servisi de auto-deploy eder. Worker deploy ~3-5 dk (Docker build + Playwright install). API deploy ~2 dk.

### Database
- **liffy-db** (PostgreSQL 17, Render Oregon)
- Host: `dpg-d39adoemcj7s738stkqg-a.oregon-postgres.render.com`
- User: `liffy_user`
- Database: `liffy`
- Password: Render env / 1Password

### Production Domains
- Frontend: liffy.app
- API: api.liffy.app
- Inbound parse: parse@inbound.liffy.app (Gmail Auto-Forward replies)

## How to Connect

### psql (production DB) — Multi-statement
```bash
PGPASSWORD=<password> psql \
  -h dpg-d39adoemcj7s738stkqg-a.oregon-postgres.render.com \
  -U liffy_user liffy <<'SQL'
SELECT ...;
SELECT ...;
SQL
```

### psql (single command)
```bash
PGPASSWORD=<password> psql \
  -h dpg-d39adoemcj7s738stkqg-a.oregon-postgres.render.com \
  -U liffy_user liffy \
  -c "SELECT ..."
```

### Run migration file
```bash
PGPASSWORD=<password> psql \
  -h dpg-d39adoemcj7s738stkqg-a.oregon-postgres.render.com \
  -U liffy_user liffy \
  -f backend/migrations/NNN_xxx.sql
```

### Render Dashboard
- URL: dashboard.render.com
- Workspace: My Workspace
- Manual deploy: service > "Manual Deploy" > "Deploy latest commit" or "Clear cache & deploy"

## Repos & Paths

| Repo | Local Path | Remote (origin) | Branch | Render Service(s) |
|------|-----------|-----------------|--------|-------------------|
| liffyv1 | `/Users/nsa/Projects/liffyv1` | `https://github.com/Nsueray/liffyv1.git` | main | liffy-api, liffy-worker-docker |
| liffy-ui | `/Users/nsa/Projects/liffy-ui` | `https://github.com/Nsueray/liffy-ui.git` | main | liffy-ui (Next.js) |
| liffy-local-miner | `/Users/nsa/Projects/liffy-local-miner` | `https://github.com/Nsueray/liffy-local-miner.git` | main | (none — local CLI) |

## Migration Workflow

Migrations are MANUAL (no auto-runner exists):

1. Write `backend/migrations/NNN_description.sql` (NNN = next number)
2. Commit migration file with code change
3. Operator (Suer) runs migration with psql -f
4. THEN push (Render auto-deploys)
5. Track in LIFFY_TODO.md ("(applied)" or "(not applied)")

VARCHAR-to-TEXT migrations are zero-downtime (no data rewrite in PG).

## Deploy Workflow

Push to `main` — both services auto-deploy.

### Important Caveats
- **Worker PG schema cache:** After DDL changes, worker connections may cache old schema. If new code throws "value too long for type varying(255)" after VARCHAR-to-TEXT migration, restart worker manually from Render Dashboard.
- **In-flight jobs survive deploy:** setImmediate background tasks may continue on old code if started before deploy. Database state changes visible immediately.

## Common Operational Patterns

### Stop a stuck import job
```sql
-- 1. Mark all unimported rows as failed (breaks loop)
UPDATE mining_results
SET status = 'failed'
WHERE job_id = '<JOB_ID>' AND (status IS NULL OR status NOT IN ('imported'));

-- 2. Mark job as completed
UPDATE mining_jobs SET import_status = 'completed' WHERE id = '<JOB_ID>';

-- 3. Terminate stuck DB connections
SELECT pid, pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle in transaction' AND pid != pg_backend_pid();
```

### Retry failed rows after fix
```sql
UPDATE mining_results SET status = NULL
WHERE job_id = '<JOB_ID>' AND status = 'failed';

UPDATE mining_jobs SET import_status = NULL, import_progress = NULL
WHERE id = '<JOB_ID>';
-- Then: UI re-import or wait for stale-detection
```

### Diagnose active queries
```sql
SELECT pid, state, application_name,
  EXTRACT(EPOCH FROM (NOW() - query_start))::int as seconds,
  LEFT(query, 200) as query
FROM pg_stat_activity
WHERE state != 'idle' AND pid != pg_backend_pid()
ORDER BY query_start;
```

### Diagnose locks on a table
```sql
SELECT l.locktype, l.relation::regclass, l.mode, l.granted, a.pid, a.state
FROM pg_locks l JOIN pg_stat_activity a ON l.pid = a.pid
WHERE l.relation::regclass::text = '<TABLE_NAME>';
```

## Team
- **Suer** — founder, technical lead, product owner
- **Elif AY** (elif@elan-expo.com) — Sales Manager, primary Liffy user
- **Bengu** (bengu@elan-expo.com) — sales rep, reports to Elif

## Key Constraints (LIFFY Constitution)
- **Frozen orchestrator:** flowOrchestrator.js, resultAggregator.js, aggregator.js, miner plugins — NEVER modify (additions only)
- **Additive migrations only** (no DROP COLUMN without explicit RFC)
- **No silent data loss** — sanitize/log/skip, never silently drop
- **Multi-AI consensus** before architectural decisions

## Recent Major Operations (rolling log)

### 2026-04-28 — Mining Import Pipeline Critical Fixes
- Migration 045 applied (VARCHAR-to-TEXT for affiliations.company_name/position/city, prospects.name/company, persons.first_name/last_name)
- Commit 38bfc22 deployed (loop fix in processImportBatch + sanitize helpers + MAX_BATCH_ITERATIONS guard)
- Commit 7c2650f (liffy-ui) — TypeScript optional chaining fix for importProgress.errors (Render build fail)
- Worker cache corruption recovered — Render Docker layer cache bozuldu (commit e1218d9), manual "Clear cache & deploy" ile cozuldu. Kod degisikligi degil, infra sorunu.
- Worker manual restart performed (PG schema cache after DDL)
- Final validation: job 12e8aabf-... 21 failed rows retry edildi, 21/21 imported in 5.5s, 0 errors
- Documented: MINING_IMPORT_BUG_REPORT.md, MINING_VARCHAR_INVESTIGATION.md
