# LIFFY — MASTER TODO LIST

> See also: [CLAUDE.md](./CLAUDE.md), [CLAUDE_DB.md](./CLAUDE_DB.md), [CLAUDE_FEATURES.md](./CLAUDE_FEATURES.md), [CLAUDE_UI.md](./CLAUDE_UI.md), [MINER_GUIDE.md](./MINER_GUIDE.md), [MINING_REFACTOR_PLAN.md](./MINING_REFACTOR_PLAN.md)

*Updated: 2026-02-24*

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
| A12 | spaNetworkMiner v1 complete — token capture, fast path, 257/259 coverage | P1 | ✅ DONE |
| A13 | Generic SPA detection in pageAnalyzer — hostname bağımlılığını kaldır | P1 | ✅ DONE |
| A14 | PDF URL routing — .pdf URL'leri documentMiner'a yönlendir | P1 | ✅ DONE |
| A15 | PDF mining — documentMiner'da PDF text extraction (pdfjs/pdf-parse) | P2 | TODO |
| A16 | Cloudflare partial block — site yükleniyor ama data eksik (AFMT India pattern) | P2 | TODO |
| A17 | Stuck job cleanup on startup | P1 | ✅ DONE |
| A18 | Flow 2 OOM protection — contact count + enrichment rate rules (skip/limit Flow 2) | P1 | ✅ DONE |
| A19 | Enrich Remaining button — POST /api/mining/jobs/:id/enrich + UI button | P1 | ✅ DONE |
| A20 | NaN enrichment guard — shouldTriggerFlow2 undefined/NaN default to 100% (safe skip) | P1 | ✅ DONE |
| A21 | Redis truncate limit kaldır (Starter plan upgrade) | P1 | ✅ DONE |
| A22 | PDF name/company extraction — documentTextNormalizer structured text parsing | P2 | TODO |
| A23 | Node.js heap limit (NODE_OPTIONS env var) | P1 | TODO (manual Render config) |
| A24 | Excel mining quality — column mapping improvement | P2 | TODO |

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
| C3 | Template editor HTML escaping — pasted raw HTML tags shown as text in emails | P1 | ✅ DONE |
| C4 | Campaign analytics Sent=0 — worker not recording sent events to campaign_events | P1 | ✅ DONE |

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
| G1 | Reply detection Stage 1 — inbound webhook endpoint, VERP parser, auto-reply filter (commit: e1e05f8) | P1 | ✅ DONE |
| G2 | Reply detection Stage 2 — VERP reply-to generation in campaignSend.js + worker.js (short format, RFC 5321 safe) | P1 | ✅ DONE |
| G3 | Reply detection Stage 3 — wrapper forward to organizer inbox + collision guard + URL path secret + multer multipart (commits: 03e7a0d, 878a28a, bf88167) | P1 | ✅ DONE |
| G4 | Reply detection DNS + SendGrid config — reply.liffy.app MX record + Inbound Parse URL + INBOUND_WEBHOOK_SECRET env var | P1 | ✅ DONE |
| G5 | Reply count in campaign analytics UI | P2 | TODO |
| G6 | Unsubscribe tracking — unsubscribe olanları UI'da göster | P1 | TODO |
| G7 | Unsubscribe listesi sayfası — kim, ne zaman, hangi campaign'den unsubscribe oldu | P2 | TODO |
| G8 | Prospect conversion — reply detected → lead becomes prospect | P2 | TODO |

### Context

**Current state:**
- ✅ Click tracking works (campaign_events, event_type='click')
- ✅ Open tracking works (campaign_events, event_type='open')
- ✅ Reply detection backend COMPLETE — all stages implemented (Stages 1-3)
- ✅ VERP reply-to active in both campaignSend.js and worker.js (short format: 8 hex chars)
- ✅ Inbound webhook with URL path secret + envelope domain validation + multer multipart
- ✅ Wrapper forward to organizer inbox (FROM notify@liffy.app, reply-to = original sender)
- ✅ Collision guard on VERP prefix lookup (LIMIT 2 + >1 match = skip)
- ✅ DNS + SendGrid config DONE — reply.liffy.app MX + Inbound Parse URL + env var configured
- ❌ Unsubscribe list NOT visible — unsubscribes happen but no UI to see them

**Reply detection approach:** Hybrid VERP + SendGrid Inbound Parse
- VERP format: `c-{8 hex}-r-{8 hex}@reply.liffy.app` (RFC 5321 safe, 22 char local-part)
- Endpoint: `POST /api/webhooks/inbound/:secret` (multer multipart middleware)
- Auto-reply filter: RFC 3834 headers, OOO subjects, mailer-daemon from patterns
- Forward: wrapper email FROM notify@liffy.app TO organizer (reply-to = original sender)

**Live:** Reply detection is fully operational. DNS, SendGrid Inbound Parse, and env vars all configured.

**Unsubscribe:**
- SendGrid handles unsubscribe links in emails
- campaign_events may have unsubscribe events from webhook
- Need: UI page showing unsubscribed contacts with date + campaign
- Need: Suppress unsubscribed contacts from future campaigns

**Prospect flow:** Lead (persons) → receives campaign → replies → becomes Prospect

Note: Zoho CRM push is optional (P3), not part of core prospect flow.

## H. UI IMPROVEMENTS

| # | Task | Priority | Status |
|---|------|----------|--------|
| H1 | Re-mine butonu — mevcut job'u tekrar başlat (aynı URL + config ile yeni job) | P2 | ✅ DONE |
| H2 | New Mining Job formunda Free mode default olsun (şu an AI mode default) | P1 | ✅ DONE |
| H3 | Campaign scheduling — gün ve saat seçerek otomatik gönderim | P2 | TODO |
| H4 | Mining Jobs Strategy kolonu — miner_used, mining_mode, flow2_status detaylı gösterim | P1 | ✅ DONE |
