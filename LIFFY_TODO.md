# LIFFY — MASTER TODO LIST

> See also: [CLAUDE.md](./CLAUDE.md), [CLAUDE_DB.md](./CLAUDE_DB.md), [CLAUDE_FEATURES.md](./CLAUDE_FEATURES.md), [CLAUDE_UI.md](./CLAUDE_UI.md), [MINER_GUIDE.md](./MINER_GUIDE.md), [MINING_REFACTOR_PLAN.md](./MINING_REFACTOR_PLAN.md)

*Updated: 2026-02-22*

## A. MINING ENGINE (Refactor Remaining)

| # | Task | Priority | Status |
|---|------|----------|--------|
| A1 | Step 7 — urlMiner DB write removal | P2 | DEFER |
| A2 | Step 8 — Legacy deletion (miningService 916→200 lines) | P2 | DEFER |
| A3 | CLAUDE.md update — Mining Refactor note to current status | P3 | DONE |
| A4 | directoryMiner registry "PROTOTYPE" → "ACTIVE" | P3 | TODO |
| A5 | Heuristic directory detection (DOM pattern) | P3 | FUTURE |
| A6 | directoryMiner max_pages UI config | P3 | FUTURE |
| A7 | Local miner fix + orchestrator integration (commits: 28ea802, fb9e7d5) | P1 | DONE |
| A8 | Job status "needs_manual" for blocked sites — completed yerine farklı status | P2 | TODO |
| A9 | Email'de gerçek MINING_API_TOKEN kullan, "some-long-random-secret" değil | P2 | TODO |
| A10 | Free mode'da aiMiner çalışmaması fix'i (commit: 2a7ecd2) | P1 | DONE |
| A11 | Block detection email notification (commits: 2a7ecd2, fb9e7d5) | P1 | DONE |

## B. UI TASKS

| # | Task | Priority | Status |
|---|------|----------|--------|
| B1 | Zoho CRM Push UI — push button, module select, push history | P3 | TODO |
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

## G. EMAIL TRACKING & PROSPECTS

| # | Task | Priority | Status |
|---|------|----------|--------|
| G1 | Reply detection — campaign reply'ları tespit et, prospect'e dönüştür | P1 | TODO |
| G2 | Reply webhook/polling — SendGrid inbound parse veya IMAP polling ile reply algılama | P1 | TODO |
| G3 | Unsubscribe tracking — unsubscribe olanları UI'da göster | P1 | TODO |
| G4 | Unsubscribe listesi sayfası — kim, ne zaman, hangi campaign'den unsubscribe oldu | P2 | TODO |
| G5 | Prospect conversion — reply detected → lead becomes prospect | P2 | TODO |

### Context

**Current state:**
- ✅ Click tracking works (campaign_events, event_type='click')
- ✅ Open tracking works (campaign_events, event_type='open')
- ❌ Reply detection NOT working — replies not detected, prospects not created
- ❌ Unsubscribe list NOT visible — unsubscribes happen but no UI to see them

**Reply detection options:**
1. SendGrid Inbound Parse webhook — forwards replies to our endpoint
2. IMAP polling — check sender inbox periodically
3. SendGrid Event Webhook — reply events (limited)

**Unsubscribe:**
- SendGrid handles unsubscribe links in emails
- campaign_events may have unsubscribe events from webhook
- Need: UI page showing unsubscribed contacts with date + campaign
- Need: Suppress unsubscribed contacts from future campaigns

**Prospect flow:** Lead (persons) → receives campaign → replies → becomes Prospect

Note: Zoho CRM push is optional (P3), not part of core prospect flow.
