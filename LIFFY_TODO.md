# LIFFY — MASTER TODO LIST

> See also: [CLAUDE.md](./CLAUDE.md), [CLAUDE_DB.md](./CLAUDE_DB.md), [CLAUDE_FEATURES.md](./CLAUDE_FEATURES.md), [CLAUDE_UI.md](./CLAUDE_UI.md), [MINER_GUIDE.md](./MINER_GUIDE.md), [MINING_REFACTOR_PLAN.md](./MINING_REFACTOR_PLAN.md)

*Updated: 2026-04-21*

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
| A8 | Job status "needs_manual" for blocked sites — completed yerine farklı status | P2 | ✅ DONE |
| A9 | Email'de gerçek MINING_API_TOKEN kullan, "some-long-random-secret" değil | P2 | ✅ DONE (zaten process.env.MINING_API_TOKEN kullanıyordu) |
| A10 | Free mode'da aiMiner çalışmaması fix'i (commit: 2a7ecd2) | P1 | DONE |
| A11 | Block detection email notification (commits: 2a7ecd2, fb9e7d5) | P1 | DONE |
| A12 | spaNetworkMiner v1 complete — token capture, fast path, 257/259 coverage | P1 | ✅ DONE |
| A13 | Generic SPA detection in pageAnalyzer — hostname bağımlılığını kaldır | P1 | ✅ DONE |
| A14 | PDF URL routing — .pdf URL'leri documentMiner'a yönlendir | P1 | ✅ DONE |
| A15 | PDF mining — pdfplumber table extraction + columnar text parser + fileMiner.processFile integration | P1 | ✅ DONE |
| A16 | Cloudflare partial block — stealth args, UA rotation, JS challenge wait & retry, enhanced checkBlock | P2 | ✅ DONE |
| A17 | Stuck job cleanup on startup + periodic stale detection (3h timeout, manual_required skip, email notification) | P1 | ✅ DONE |
| A18 | Flow 2 OOM protection — contact count + enrichment rate rules (skip/limit Flow 2) | P1 | ✅ DONE |
| A19 | Enrich Remaining button — POST /api/mining/jobs/:id/enrich + UI button | P1 | ✅ DONE |
| A20 | NaN enrichment guard — shouldTriggerFlow2 undefined/NaN default to 100% (safe skip) | P1 | ✅ DONE |
| A21 | Redis truncate limit kaldır (Starter plan upgrade) | P1 | ✅ DONE |
| A22 | PDF name/company extraction — pdfContacts bypass in execution plan path (all 3 normalizer calls fixed) | P1 | ✅ DONE |
| A23 | Node.js heap limit (NODE_OPTIONS env var) | P1 | ✅ DONE (startup log + Render manual config) |
| A24 | Excel mining quality — column mapping improvement (two-pass matching, first/last name merge, multilingual keywords) | P2 | ✅ DONE |
| A25 | flipbookMiner v2 — dual-path extraction (column-position + isolateSegment for pre/code layouts) | P1 | ✅ DONE |
| A26 | AI Miner Generator v2 — AXTree integration (Playwright ariaSnapshot) | P1 | ✅ DONE |
| A27 | AI Miner Generator v2 — GenericExtractor templates (config-driven, anchor+container+bulk modes) | P1 | ✅ DONE |
| A28 | AI Miner Generator v2 — Self-healing REPL loop (3-5 iterations) | P1 | ✅ DONE (code ready, needs more testing) |
| A29 | AI Miner Generator v2 — Multi-step config (listing + detail AXTree) — expat.com 7 contact best case | P1 | ✅ DONE |
| A30 | AI Miner Generator v2 — Test sonuçları: glmis ✅ 11, expat.com ✅ 7 (best), performans 24dk→2dk. Kalan sorun: Claude non-deterministic (anchor vs container). | P1 | PARKED |
| A31 | AI Miner Generator v2 — Claude tutarlılık sorunu: aynı AXTree'ye TYPE 1/TYPE 2, anchor/container farklı dönüyor. Prompt veya post-processing iyileştirmesi gerekli. | P2 | TODO |
| A32 | Local miner — global email pollution detection (frequency-based dedup, 30% threshold) | P1 | ✅ DONE |
| A33 | SuperMiner status='completed' bug fix — direct path missing final status update, jobs stuck in 'running' forever | P1 | ✅ DONE |
| A34 | SuperMiner finalization hang fix — deepCrawlAttempted=true, duplicate Flow 2 prevention, 2h Promise.race timeout | P1 | ✅ DONE |
| A35 | contactPageMiner DNS fail optimization — ERR_NAME_NOT_RESOLVED'da domainDead flag ile hemen skip | P2 | ✅ DONE |
| A36 | labelValueMiner profile-only contact investigation — 30 contact bulundu ama sadece 2 kaydedildi, emailsiz card'lar DB'ye yazılmıyor mu? | P2 | TODO |
| A37 | inlineContactMiner — Cheerio-based inline contact extraction from raw HTML (no Playwright). HtmlCache + HTTP fallback. | P1 | ✅ DONE |
| A38 | inlineContactMiner execution plan integration — added as fallback step in ALL plans (directory, member_table, label_value, website, table, unknown) | P1 | ✅ DONE |
| A39 | isPoisoned() false positive fix — block indicators only on short pages (<10KB) or title/h1. WordPress directory blocked. | P1 | ✅ DONE |

## B. UI TASKS

| # | Task | Priority | Status |
|---|------|----------|--------|
| B1 | Zoho CRM Push UI — push button, module select, push history | P3 | TODO |
| B2 | Frontend import-all polling — progress bar | P2 | ✅ DONE |
| B3 | Mining console page — log writing + /logs endpoint | P3 | FUTURE |
| B4 | Excel/CSV Export — mining results, contacts, list members (exceljs + exportHelper.js) (commits: 1e6f06d, 72d175f) | P1 | ✅ DONE |
| B5 | JWT Auth System — login/logout, middleware, auth guard, role persist | P1 | ✅ DONE |
| B6 | Contact CRM — notes/activities/tasks tabs on person detail | P1 | ✅ DONE |
| B7 | Sales Pipeline — Kanban board, 7 stages, auto-stage on reply | P1 | ✅ DONE |
| B8 | Tasks page — my assigned tasks with filters | P1 | ✅ DONE |
| B9 | User Data Isolation — owner/admin see all, user sees own | P1 | ✅ DONE |
| B10 | Daily Email Limit — per-user, 429 enforcement | P1 | ✅ DONE |
| B11 | Owner Admin Panel — user CRUD, password reset, usage stats | P1 | ✅ DONE |
| B12 | Action Engine — multi-touch campaign sequences (migration 035, service, worker, routes, UI) | P1 | ✅ DONE |
| B13 | Multi-Touch Sequences UI — campaign type selector, sequence builder, step CRUD, analytics | P1 | ✅ DONE |
| B14 | Action Engine — trigger rules, priority scoring, webhook hooks, action worker | P1 | ✅ DONE |
| B15 | Action Screen — homepage, priority cards, filter/sort, snooze, history | P1 | ✅ DONE |
| B16 | ADR-015 Hierarchical Permissions — migrations 038-040, recursive CTE, reports_to, 4 roles, 11 routes, upward visibility | P1 | ✅ DONE |
| B17 | Zoho Import — 54K records bulk import (persons + affiliations), industry normalization | P1 | ✅ DONE |
| B18 | Company + Industry Filter — ILIKE search on affiliations via LATERAL JOIN | P1 | ✅ DONE |
| B19 | Data Transfer — Suer→Elif ownership transfer for templates/senders/campaigns | P1 | ✅ DONE |

## C. KNOWN ISSUES

| # | Task | Priority | Status |
|---|------|----------|--------|
| C1 | /api/stats 401 Unauthorized — sidebar polling | P2 | ✅ DONE |
| C2 | Prospects page search backend missing | P3 | OPEN |
| C3 | Template editor HTML escaping — pasted raw HTML tags shown as text in emails | P1 | ✅ DONE |
| C4 | Campaign analytics Sent=0 — worker not recording sent events to campaign_events | P1 | ✅ DONE |
| C5 | Import-all deadlock cascade — PG transaction aborted state causes batch-wide failure | P1 | ✅ DONE |
| C6 | Import-all background crash silent failure — setImmediate + async .catch() + import_status='failed' update | P1 | ✅ DONE |
| C7 | Lists created_by_user_id NULL — 4 list creation paths missing created_by_user_id, invisible to non-owner users | P1 | ✅ DONE |

## D. TECHNICAL DEBT

| # | Task | Priority | Status |
|---|------|----------|--------|
| D1 | Performance indexes on campaign_events | P2 | ✅ DONE |
| D2 | Pagination metrics in mining_job_logs | P3 | TODO |

## E. PHASE 4 — LEGACY REMOVAL

| # | Task | Priority | Status |
|---|------|----------|--------|
| E1 | prospects table dual-write removal | P2 | TODO — TODO [Phase 4] comments added in leads.js, miningResults.js, lists.js |
| E2 | list_members.person_id (migration 029) — queries migrated | P2 | ✅ DONE |
| E3 | campaign_recipients.person_id (migration 028) | P2 | ✅ DONE |
| E4 | email_logs table archive/drop | P3 | ✅ DONE |
| E5 | Migration 034 — re-backfill person_id + NULL tracking indexes | P2 | ✅ DONE (not applied) |
| E6 | Backfill script — backend/scripts/backfill_person_ids.js (idempotent, --dry-run) | P2 | ✅ DONE |
| E7 | Campaign resolve canonical path with fallback — UNION (person_id path + prospect email fallback) | P2 | ✅ DONE |
| E8 | Visibility columns — migration 033, lists.js enforcement | P2 | ✅ DONE (not applied) |
| E9 | Dashboard stat fix — COUNT(DISTINCT email) for rates | P1 | ✅ DONE |
| E10 | Migration 035 — campaign_sequences + sequence_recipients | P1 | ✅ DONE (not applied) |
| E11 | Migration 036 — template_id nullable for sequence campaigns | P1 | ✅ DONE (not applied) |
| E12 | Migration 037 — action_items table | P1 | ✅ DONE (not applied) |

## F. NEW MINERS

| # | Task | Priority | Status |
|---|------|----------|--------|
| F1 | URL test results → identify new miner needs | P1 | TESTING |
| F2 | flipbookMiner production test — Ghana Yellow Pages 834 pages, 9,246 results, 77% company coverage | P1 | ✅ DONE |
| F3 | reedExpoMiner — generic ReedExpo platform miner (infinite scroll + GraphQL API) | P1 | ✅ DONE |
| F4 | reedExpoMailtoMiner — mailto fallback for ReedExpo emailless orgs (company-name enrichment) | P1 | ✅ DONE |
| F5 | playwrightTableMiner column-aware parse — multilingual header detection (ZH/RU/TR/EN) | P1 | ✅ DONE |
| F6 | playwrightTableMiner timeout fix — 30s→60s + networkidle→domcontentloaded | P1 | ✅ DONE |
| F7 | nashel.ru/cn/info/sttexpo/ — 1152 contact, company isimleri doldu | P1 | ✅ DONE |
| F8 | batimat.com — reedExpoMailtoMiner enrichment test et (emailless org'lar zenginleşmeli) | P1 | PENDING |
| F9 | expoPlatformMiner — ExpoPlatform trade fair sites (POST API + Playwright detail pages). digital.agritechnica.com 2918 exhibitors test. | P1 | ✅ DONE |
| F10 | Local miner batch posting — postResults() 200-item chunks (Payload Too Large fix) | P1 | ✅ DONE |
| F11 | Manual mining email — organizer pollution detection (1-2 results, foreign domain email) | P1 | ✅ DONE |
| F12 | labelValueMiner — `<b>` company name + `<br>` separated label:value directory listings (nigeriagalleria.com pattern). 30 entries/page, flat HTML, no table/card structure. | P1 | ✅ DONE |

## G. EMAIL TRACKING & PROSPECTS

| # | Task | Priority | Status |
|---|------|----------|--------|
| G1 | Reply detection Stage 1 — inbound webhook endpoint, VERP parser, auto-reply filter (commit: e1e05f8) | P1 | ✅ DONE |
| G2 | Reply detection Stage 2 — VERP reply-to generation in campaignSend.js + worker.js (short format, RFC 5321 safe) | P1 | ✅ DONE |
| G3 | Reply detection Stage 3 — wrapper forward to organizer inbox + collision guard + URL path secret + multer multipart (commits: 03e7a0d, 878a28a, bf88167) | P1 | ✅ DONE |
| G4 | Reply detection DNS + SendGrid config — reply.liffy.app MX record + Inbound Parse URL + INBOUND_WEBHOOK_SECRET env var | P1 | ✅ DONE |
| G5 | Reply count in campaign analytics UI (commit: 9b88042 liffy-ui) | P2 | ✅ DONE |
| G6 | Unsubscribe tracking — unsubscribe olanları UI'da göster | P1 | ✅ DONE |
| G7 | Unsubscribe listesi sayfası — kim, ne zaman, hangi campaign'den unsubscribe oldu | P2 | ✅ DONE |
| G8 | Prospect conversion — reply detected → lead becomes prospect | P2 | ✅ DONE |
| G9 | Reply forward template sadeleştirme — banner/footer kaldır, truncation kaldır, clean subject | P1 | ✅ DONE |
| G10 | Replied status overwrite bug fix — open/click event'leri replied/unsubscribed status'u koruyor | P1 | ✅ DONE |
| G11 | Reply UX — VERP display name (sender name in reply-to) + forward FROM format ("Reply: Name") | P1 | ✅ DONE |
| G12 | Reply Email Quality — click tracking disabled, reply body in timeline (2000 chars), forward fallback to creator email | P1 | ✅ DONE |
| G13 | JWT Auth Fix — `id` vs `user_id` normalization across 28 auth middleware instances (critical production bug) | P1 | ✅ DONE |
| G14 | Reply Detection v2→v4 — VERP→hidden tag→unsubscribe token→plus addressing. Final: `sender+c-xxx-r-xxx@domain.com`, Gmail Content Compliance header match, 3 detection methods, person_id consolidated. | P1 | ✅ DONE |
| G15 | Action Engine reply trigger fix — person_id resolved once, 4 redundant lookups eliminated, recordCampaignEvent uses pre-resolved person_id | P1 | ✅ DONE |
| G16 | Action Engine reply dedup removed — every reply creates new P1 action item, migration 041, insertActionItem (no ON CONFLICT), reconcile skips reply_received | P1 | ✅ DONE |

### Context

**Current state (Reply Detection v4 — Plus Addressing):**
- ✅ Click tracking works (campaign_events, event_type='click')
- ✅ Open tracking works (campaign_events, event_type='open')
- ✅ Reply detection v4 LIVE — plus-addressed Reply-To + Gmail Content Compliance header match
- ✅ Reply-To = `sender+c-{8hex}-r-{8hex}@domain.com` (natural Gmail thread, +tag ignored)
- ✅ 3 detection methods: plus address (primary) → unsubscribe URL token (fallback) → email match (last resort)
- ✅ Forward REMOVED — salesperson has reply in Gmail, LİFFY only records + triggers Action Engine
- ✅ person_id resolved ONCE in inbound handler — used by all downstream operations
- ✅ Action Engine: every reply = new P1 action item (no dedup, migration 041)
- ✅ DNS: reply.liffy.app MX → mx.sendgrid.net. inbound.liffy.app has NO MX (unused)
- ✅ Unsubscribe tracking UI — /campaigns/unsubscribes page with stats, search, source filter, campaign attribution

**Reply detection approach:** Plus-addressed Reply-To + Gmail Content Compliance
- Reply-To: `sender+c-{campaignId8}-r-{recipientId8}@domain.com`
- Endpoint: `POST /api/webhooks/inbound/:secret` (multer multipart middleware)
- Detection: parsePlusAddress() from To header (primary), detectReplySource() from body (fallback), email match (last resort)
- Auto-reply filter: RFC 3834 headers, OOO subjects, mailer-daemon from patterns
- No forward — salesperson gets reply directly via Reply-To

**Gmail Content Compliance required:** Admin must configure:
- Inbound, Advanced content match, **Full headers**, Contains text, `+c-`
- Also deliver to: `parse@reply.liffy.app`

**Live:** Reply detection v4 is fully operational.

**Unsubscribe:**
- ✅ SendGrid handles unsubscribe links in emails
- ✅ campaign_events records unsubscribe events from webhook
- ✅ UI page at /campaigns/unsubscribes — search, source filter, campaign attribution, pagination
- ✅ Unsubscribed contacts already suppressed from future campaigns (campaign resolve filters them)

**Prospect flow:** Lead (persons) → receives campaign → replies → becomes Prospect

Note: Zoho CRM push is optional (P3), not part of core prospect flow.

## H. UI IMPROVEMENTS

| # | Task | Priority | Status |
|---|------|----------|--------|
| H1 | Re-mine butonu — mevcut job'u tekrar başlat (aynı URL + config ile yeni job) | P2 | ✅ DONE |
| H2 | New Mining Job formunda Free mode default olsun (şu an AI mode default) | P1 | ✅ DONE |
| H3 | Campaign scheduling — gün ve saat seçerek otomatik gönderim | P2 | ✅ DONE |
| H4 | Mining Jobs Strategy kolonu — miner_used, mining_mode, flow2_status detaylı gösterim | P1 | ✅ DONE |
| H5 | Excel/CSV Export buttons — mining results, contacts, list detail pages (commit: 72d175f liffy-ui) | P1 | ✅ DONE |
| H6 | Real-time UI refresh — WebSocket/SSE for mining job status updates (polling yerine push) | P3 | FUTURE |

## I. EMAIL SCALABILITY (120K Campaign)

| # | Task | Priority | Status |
|---|------|----------|--------|
| I1 | Batch size artır — EMAIL_BATCH_SIZE 5 → 50 (env configurable) | P1 | ✅ DONE |
| I2 | 429 retry — SendGrid rate limit exponential backoff (2s, 4s, 8s, max 3 retry) | P1 | ✅ DONE |
| I3 | Parallel sends — Promise.all with concurrency 10 (50 batch = 5 chunk × 10 concurrent, 500ms pause) | P1 | ✅ DONE |
| I4 | Progress endpoint — GET /api/campaigns/:id/progress (sent/total/failed real-time) | P2 | TODO |
| I5 | Campaign pause/resume — UI button to stop/continue sending | P2 | TODO |
| I6 | Domain throttle — ISP-based rate limits (Gmail 500/hr, Outlook 500/hr) | P2 | FUTURE |
| I7 | IP warm-up schedule — gradual daily volume increase (500 → 1K → 5K → 50K → 120K) | P2 | FUTURE |
| I8 | Bounce rate monitor — auto-pause campaign at >5% bounce rate | P2 | FUTURE |
| I9 | BullMQ migration — replace setInterval worker with Redis-backed job queue | P3 | FUTURE |

## J. PHASE 6 — CONVERSATION LAYER (FUTURE)

| # | Task | Priority | Status |
|---|------|----------|--------|
| J1 | Message storage — reply body'leri DB'de persist et (messages/reply_bodies table) | P2 | FUTURE |
| J2 | Thread view — campaign email + reply'ları kronolojik conversation timeline'da göster | P2 | FUTURE |
| J3 | Reply composer — UI'dan prospect'e reply yazıp gönder (send-on-behalf via SendGrid) | P2 | FUTURE |
| J4 | Inbox page — tüm reply'ları tek sayfada göster, conversation navigate | P2 | FUTURE |
| J5 | Email threading headers — Message-ID, In-Reply-To, References (RFC 5322 threading) | P3 | FUTURE |

## K. PENDING / NEXT UP

| # | Task | Priority | Status |
|---|------|----------|--------|
| K1 | Bengü kullanıma alınacak — reply detection çalışıyor, isolation çalışıyor, role=sales_rep | P1 | ✅ DONE |
| K2 | Company entity — affiliations'tan company view sayfası | P2 | ✅ DONE |
| K3 | Gmail API OAuth — Phase 2 reply detection, auto-forward replace | P2 | FUTURE |
| K4 | WhatsApp Channel — campaign gönderim kanalı | P3 | FUTURE |
| K5 | Overview Screen — ELIZA shared DB, fuar/etkinlik genel görünümü | P3 | FUTURE |
| K6 | Source Discovery + Mining Jobs merge — tek ekranda birleştir | P2 | ✅ DONE |
| K7 | Campaign/List'te owner bilgisi UI'da göster — "By" column + campaign detail header | P3 | ✅ DONE |
| K8 | Inbox / email takip — Phase 6 conversation layer | P2 | FUTURE |
| K9 | Campaign delete bug fix — ON DELETE SET NULL + uq_prospect_intent çakışması | P1 | ✅ DONE |
| K10 | Migration 041 production'da uygulandı — reply_received dedup index exclude | P1 | ✅ DONE |
| K11 | Bengü role update — user → sales_rep | P1 | ✅ DONE |
| K12 | Reply Signature Parsing — signatureParser.js + webhooks.js enrichment | P1 | ✅ DONE |
| K13 | Data Cleanup Migration 042 — email domain company names + industry typos | P1 | ✅ DONE |
| K14 | Admin bug fixes — sidebar manager visibility, VALID_ROLES fix, sequenceWorker daily limit scoping | P1 | ✅ DONE |
| K15 | Companies 500 fix — 5 column name errors (country_code, website, verification_status, a.phone) | P1 | ✅ DONE |
| K16 | Lead Mining merge — Source Discovery + Mining Jobs → single /mining page with tabs | P1 | ✅ DONE |
| K17 | Reply Timeline expand/collapse — From/Subject header + Show full reply toggle | P1 | ✅ DONE |
| K18 | Sender Identity Edit/Delete — PUT endpoint + Settings UI (Edit modal, Delete confirm, campaign_count) | P1 | ✅ DONE |
| K19 | Senders 500 fix — sender_identity_id → sender_id column name | P1 | ✅ DONE |
| K20 | Login sidebar fix — flat login response → liffy_user not stored → Admin hidden. Construct user object in login page. | P1 | ✅ DONE |
| K21 | Duplicate send fix (CAS) — Render redeploy overlap causes double send. CAS claim in worker.js, campaignSend.js, sequenceService.js. | P1 | ✅ DONE |
| K22 | Daily email usage visibility — GET /api/campaigns/email-usage + Dashboard progress bar card | P2 | ✅ DONE |
| K23 | Contact campaign history — GET /api/persons/:id/campaigns + Contact Detail campaign history table | P2 | ✅ DONE |
| K24 | Sequence engine CAS guard — CAS claim in sequenceService.js (active→sending→active/completed) + error recovery | P1 | ✅ DONE |
| K25 | inlineContactMiner — Cheerio-based inline contact extraction from raw HTML, multi-language labels, DOM context | P1 | ✅ DONE |
| K26 | Execution plan + poison fix — inlineContactMiner in ALL plans, isPoisoned() false positive for large pages | P1 | ✅ DONE |
