# LIFFY — MASTER TODO LIST

> See also: [CLAUDE.md](./CLAUDE.md), [CLAUDE_DB.md](./CLAUDE_DB.md), [CLAUDE_FEATURES.md](./CLAUDE_FEATURES.md), [CLAUDE_UI.md](./CLAUDE_UI.md), [MINER_GUIDE.md](./MINER_GUIDE.md), [MINING_REFACTOR_PLAN.md](./MINING_REFACTOR_PLAN.md)

*Updated: 2026-02-21*

## A. MINING ENGINE (Refactor Remaining)

| # | Task | Priority | Status |
|---|------|----------|--------|
| A1 | Step 7 — urlMiner DB write removal | P2 | DEFER |
| A2 | Step 8 — Legacy deletion (miningService 916→200 lines) | P2 | DEFER |
| A3 | CLAUDE.md update — Mining Refactor note to current status | P3 | DONE |
| A4 | directoryMiner registry "PROTOTYPE" → "ACTIVE" | P3 | TODO |
| A5 | Heuristic directory detection (DOM pattern) | P3 | FUTURE |
| A6 | directoryMiner max_pages UI config | P3 | FUTURE |
| A7 | Local miner fix + orchestrator integration | P1 | DONE |

## B. UI TASKS

| # | Task | Priority | Status |
|---|------|----------|--------|
| B1 | Zoho CRM Push UI — push button, module select, push history | P2 | TODO |
| B2 | Frontend import-all polling — progress bar | P2 | TODO |
| B3 | Mining console page — log writing + /logs endpoint | P3 | FUTURE |

## C. KNOWN ISSUES

| # | Task | Priority | Status |
|---|------|----------|--------|
| C1 | /api/stats 401 Unauthorized — sidebar polling | P2 | OPEN |
| C2 | Prospects page search backend missing | P3 | OPEN |

## D. TECHNICAL DEBT

| # | Task | Priority | Status |
|---|------|----------|--------|
| D1 | Performance indexes on campaign_events | P2 | TODO |
| D2 | Pagination metrics in mining_job_logs | P3 | TODO |

## E. PHASE 4 — LEGACY REMOVAL

| # | Task | Priority | Status |
|---|------|----------|--------|
| E1 | prospects table dual-write removal | P2 | TODO |
| E2 | list_members → persons reference migration | P2 | TODO |
| E3 | campaign_recipients.person_id (migration 024) | P2 | TODO |
| E4 | email_logs table archive/drop | P3 | TODO |

## F. NEW MINERS

| # | Task | Priority | Status |
|---|------|----------|--------|
| F1 | URL test results → identify new miner needs | P1 | TESTING |
