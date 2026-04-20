# LİFFY Quick Start — New Chat Reference

> Bu dosya yeni Claude chat session'larında hızlı context yüklemek için kullanılır.
> Detaylı bilgi: [CLAUDE.md](./CLAUDE.md), [CLAUDE_DB.md](./CLAUDE_DB.md), [CLAUDE_FEATURES.md](./CLAUDE_FEATURES.md), [CLAUDE_UI.md](./CLAUDE_UI.md), [LIFFY_TODO.md](./LIFFY_TODO.md)

---

## Kim?

- **Suer**: Founder/owner, technical lead. Kod yazmaz, Claude Code'a prompt verir. Turkce konusur.
- **Elif AY**: Sales Manager (elif@elan-expo.com). LİFFY'nin ana kullanicisi. UI disinda hicbir seye dokunmaz.
- **Bengu**: Sales rep (bengu@elan-expo.com). Elif'e raporlar.

## Ne?

- **LİFFY** (liffy.app / api.liffy.app): B2B sales outreach platformu. Email campaign, lead mining, reply detection, action engine.
- **ELIZA**: Event management (Leena EMS'in yeni adi)
- **LEENA**: CRM + exhibitor/visitor management
- **ELL**: ELIZA + LİFFY + LEENA mimarisi

---

## Repolar

| Repo | Stack | URL |
|------|-------|-----|
| `Nsueray/liffyv1` | Node.js/Express | api.liffy.app (Render) |
| `Nsueray/liffy-ui` | Next.js (App Router) | liffy.app (Render) |
| `liffy-local-miner` | Node.js CLI | Private (local mining) |

## Tech Stack

- **Backend:** Node.js + Express + PostgreSQL 17 + Redis
- **Frontend:** Next.js 16 (App Router) + Tailwind + Radix UI
- **Email:** SendGrid API (delivery + inbound parse), ZeroBounce (verification)
- **Deploy:** Render (liffy-api + liffy-worker-docker services)
- **AI:** Anthropic Claude API (claude-3-haiku for AI mining)
- **DB:** Raw SQL with `pg` library. NO ORMs (no Sequelize, no Prisma, no Knex)

---

## Calisma Yontemi

1. Suer bu chat'te (Claude.ai) mimari kararlar, analiz, prompt hazirligi yapar
2. Implementation icin Claude Code'a prompt verilir — bu chat hazirlar, Suer kopyalar
3. Suer kod yazmaz — tum degisiklikler Claude Code uzerinden
4. Komutlar: tam dosya icerigi veya terminal komutu olarak verilir (diff/snippet yok)
5. Multi-AI review: buyuk mimari kararlar ChatGPT + Gemini'ye de sorulur
6. Session sonunda dokumantasyon guncellenir: CLAUDE.md, CLAUDE_FEATURES.md, CLAUDE_DB.md, CLAUDE_UI.md, LIFFY_TODO.md

---

## DB Erisimi

```bash
PGPASSWORD=qefNejbasKyxmRomREYaL6CkrAfeE5pU psql -h dpg-d39adoemcj7s738stkqg-a.oregon-postgres.render.com -U liffy_user liffy
```

## Kullanicilar

| Kullanici | ID | Email | Role | PW |
|-----------|----|-------|------|----|
| Suer | cfb66f28 | suer@elan-expo.com | owner | Becks2021 |
| Elif | 1798e4e3 | elif@elan-expo.com | manager | Liffy2026 |
| Bengu | c845b557 | bengu@elan-expo.com | sales_rep | Liffy2026 |

**Organizer ID:** `63b52d61-ae2c-4dad-b429-48151b1b16d6`

## Hiyerarsi

```
Suer (owner) → Elif (manager, reports_to=Suer) → Bengu (sales_rep, reports_to=Elif)
```

---

## Reply Detection (Plus Addressing — v4 Final)

- **Reply-To:** `sender+c-{8hex}-r-{8hex}@domain.com`
- **Gmail Content Compliance:** Advanced content match, Full headers, `+c-`
- **Also deliver to:** `parse@reply.liffy.app` (MX: mx.sendgrid.net)
- **inbound.liffy.app:** MX YOK — kullanilmaz
- **Detection siralama:** plus addressing → unsubscribe URL token → email match fallback
- **Forward YOK** — salesperson reply'i Gmail'de goruyor, LİFFY sadece kaydediyor + Action Engine trigger

---

## Onemli Kurallar

- **Liffy Constitution:** miners disposable plugin, orchestrator/normalizer frozen
- **No silent data loss** — column/table drop yasak (explicit instruction gerekli)
- **Multi-tenant always** — her query'de `organizer_id` filtrelemesi zorunlu
- **Enrichment only** — mevcut veriyi ustune yazma, sadece bos alanlari doldur
- **Mining is discovery** — mining ASLA lead/prospect/contact olusturmaz
- **Separation of concerns** — extraction / normalization / aggregation / communication ayri katmanlar
- **ADR'ler** ile mimari kararlar dokumante edilir
- **Migration dosyalari** yazilir ama Suer uygular (production'da)

---

## Son Durum (Nisan 2026)

- **~75K persons**, ~86K affiliations, ~75K companies
- **42 migrations** applied (001-042)
- **15+ campaigns** gonderildi, 11K+ email
- **Reply detection** calisiyor (plus addressing v4)
- **Action Engine:** 6 trigger, P1-P4 priority, 15-min reconciliation
- **Lead Mining:** Source Discovery + Mining Jobs merged → `/mining` (tabs)
- **Companies sayfasi:** aggregated view + contact drawer
- **Signature parsing:** reply'dan phone/title/company extraction
- **3 users:** Suer (owner), Elif (manager), Bengu (sales_rep)
- **Elif'in ilk production campaign'i** gonderildi

---

## Siradaki Isler

Detay icin [LIFFY_TODO.md](./LIFFY_TODO.md) Section K'ya bak.

| Task | Priority |
|------|----------|
| Inbox / Conversations (Phase 6 — thread view, reply composer) | P2 |
| WhatsApp channel | P3 |
| Gmail API OAuth (auto-forward yerine) | P2 |
| Zoho CRM Push UI | P3 |
| Action Screen improvements (inline reply, bulk actions) | P2 |
| Mining console page (log writing + /logs endpoint) | P3 |

---

## Dosya Haritasi (Key Files)

### Backend (liffyv1)
| Dosya | Ne yapar |
|-------|----------|
| `server.js` | Express app, route mounting |
| `worker.js` | Campaign send worker (background) |
| `routes/campaigns.js` | Campaign CRUD + send + analytics |
| `routes/companies.js` | Company entity aggregation |
| `routes/persons.js` | Contacts (persons + affiliations) |
| `routes/webhooks.js` | SendGrid event webhook + inbound reply parse |
| `routes/userManagement.js` | User CRUD (owner/admin only) |
| `services/campaignSend.js` | API-triggered email send |
| `services/sequenceService.js` | Multi-touch sequence step processing |
| `services/sequenceWorker.js` | Sequence polling worker |
| `services/actionEngine.js` | 6 triggers, priority scoring, reconciliation |
| `utils/templateProcessor.js` | Unified template processor (single source of truth) |
| `utils/signatureParser.js` | Reply email signature extraction |
| `utils/exportHelper.js` | Excel/CSV export utility |
| `middleware/auth.js` | JWT auth middleware |
| `middleware/userScope.js` | Role-based visibility (ADR-015) |

### Frontend (liffy-ui)
| Dosya | Ne yapar |
|-------|----------|
| `app/page.tsx` | Action Center (homepage) |
| `app/campaigns/page.tsx` | Campaigns list |
| `app/campaigns/[id]/page.tsx` | Campaign detail + analytics |
| `app/mining/page.tsx` | Lead Mining (Discover + Jobs tabs) |
| `app/companies/page.tsx` | Company entity page |
| `app/leads/[id]/page.tsx` | Person detail (CRM tabs) |
| `app/admin/page.tsx` | Owner/admin panel |
| `app/pipeline/page.tsx` | Sales pipeline Kanban |
| `components/sidebar.tsx` | Navigation sidebar |
| `components/layout-client.tsx` | Auth guard + JWT decode |
