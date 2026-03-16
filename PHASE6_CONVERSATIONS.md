# Phase 6 — Conversations / Inbox Layer

## Mimari Kararlar (2026-03-16)

### Kullanici Profili
- Su an: Internal, tek kullanici (Elif, elan-expo.com = Google Workspace)
- 1 yil icinde: Internal, 10-15 kisi, karisik email provider
  - elan-expo.com → Google Workspace (Gmail)
  - elanexpo.net → Natro Hosting (IMAP/SMTP)
- Sonra: Belki external multi-tenant SaaS

### Uc Ray Modeli
- SendGrid → kampanya rayi (outbound batch)
- IMAP/SMTP veya Gmail → insan rayi (provider agnostik)
- Liffy → workflow + gorunurluk rayi

### Temel Prensipler
- Email provider agnostik: Gmail OAuth ve IMAP/SMTP
  her ikisi de desteklenmeli
- Gmail-only mimari kurma: Natro kullanicilari da
  ayni inbox'ta calisabilmeli
- Core conversations Google'dan bagimsiz ship edilmeli
- conversation = email thread (prospect degil)
- Ayni kisiyle birden fazla bagimsiz conversation olabilir
- Draft-first P1'de yok: gmail.compose restricted scope,
  riskli — sonraki fazlara birakildi
- notify@liffy.app wrapper → sadece fallback/degraded mode
- messages ve conversations = operational layer
- CampaignEvent = event ledger (degismez)
- ProspectIntent = intent truth (degismez)
- UI pages are views, not data owners (Constitution kurali)

### Gmail OAuth Riski
- Internal uygulama (Google Workspace admin onayi) →
  review muafiyeti mumkun
- gmail.send → sensitive scope, hizli approve
- gmail.readonly, gmail.modify, gmail.insert,
  gmail.compose → restricted scope, uzun review
- draft-first (users.drafts.create) → gmail.compose
  restricted — P1'den cikarildi
- Iki ayri OAuth client:
  - LIFFY Send: sadece gmail.send
  - LIFFY Sync Beta: restricted scope'lar (gated)

---

## Veri Modeli

### connected_mailboxes
- id, organizer_id, user_id
- provider: 'gmail' | 'imap' | 'smtp'
- mailbox_email, display_name
- Gmail: oauth_access_token, oauth_refresh_token,
  watch_expiration, last_history_id
- IMAP/SMTP: imap_host, imap_port, smtp_host,
  smtp_port, username, password (encrypted)
- default_send_as_alias, status, last_sync_at

### conversations
- id, organizer_id, mailbox_id
- person_email, subject
- root_rfc_message_id
- gmail_thread_id (nullable)
- first_campaign_id (nullable)
- status: open / waiting / closed / snoozed
- last_message_at, last_inbound_at, last_outbound_at
- unread_count

### messages
- id, conversation_id
- direction: inbound / outbound
- transport: sendgrid / gmail / imap / smtp
- from, to, cc, subject
- text_body, html_body, snippet
- raw_mime_storage_key
- rfc_message_id, in_reply_to, references
- provider_message_id
- gmail_message_id, gmail_thread_id (nullable)
- campaign_id, campaign_recipient_id (nullable)
- sent_at / received_at

### mailbox_sync_state
- mailbox_id, last_history_id (Gmail)
- last_imap_uid (IMAP)
- full_sync_checkpoint, error_state, needs_reauth

---

## Akislar

### Campaign Outbound
Liffy → SendGrid → Prospect
→ RFC Message-ID + provider_message_id kaydet
→ messages tablosuna outbound kaydi ekle

### Prospect Reply (VERP)
Prospect → reply.liffy.app
→ Liffy inbound ingest (mevcut VERP pipeline)
→ messages tablosuna full body kaydet (raw MIME)
→ CampaignEvent(reply) + ProspectIntent(if first)
→ conversation olustur veya guncelle
→ in-app notification ("Open in Liffy" CTA)
→ notify wrapper sadece fallback

### Human Reply — IMAP/SMTP (Natro)
Satisci mail client'inda reply eder
→ IMAP polling ile Liffy yakalar
→ messages tablosuna append
→ conversation guncellenir

### Human Reply — Gmail
Satisci Gmail'de reply eder
→ Gmail watch/history sync ile Liffy yakalar
→ messages tablosuna append
→ conversation guncellenir

### Reply Compose — SendGrid path (Faz 1)
Satisci Liffy'den "Reply" yazar
→ SendGrid sender identity ile gonderilir
→ messages tablosuna outbound kaydi

### Reply Compose — Gmail path (Faz 2, gated)
→ gmail.send OAuth onaylandiktan sonra
→ Satiscinin Gmail kimligiyle gonderilir

---

## UI

### /conversations
Inbox listesi. Filtreler:
- my threads / unread / waiting for me
- campaign-originated / replied today
- no response > X gun

Her satir: kisi, sirket, konu, son mesaj snippet,
owner, stage, son aktivite, unread badge,
"Open in Gmail" (Gmail kullanicilari icin)

### /conversations/:id
Sol: tam mesaj akisi, quoted history collapse,
     signature collapse, attachments, reply composer
Sag panel: person + affiliation, linked campaign,
           ProspectIntent.stage, notes, owner,
           activity timeline (sent/open/click/reply)

Aksiyonlar: Reply (SendGrid), Open in Gmail,
            Assign owner, Change stage,
            Add note, Snooze, Mark waiting/closed

---

## Roadmap

### Faz 0 — Kararlar + Hazirlik (1 hafta)
- [ ] Google Workspace admin'den internal app onayi al
- [ ] LIFFY Send OAuth client ac (gmail.send only)
- [ ] LIFFY Sync Beta OAuth client ac (restricted, gated)
- [ ] IMAP/SMTP credential encryption stratejisi belirle
- [ ] Constitution addendum: conversations/messages kurallari
- [ ] Retention ve erisim politikasi

### Faz 1 — Core Conversations, Google'dan Bagimsiz (2-3 hafta)
- [ ] Migration: connected_mailboxes, conversations,
      messages, mailbox_sync_state tablolari
- [ ] Outbound Message-ID + provider_id persist
- [ ] Inbound full body + raw MIME persist
- [ ] VERP pipeline → conversation olusturma
- [ ] notify wrapper → fallback/degraded mode
- [ ] /conversations inbox UI
- [ ] /conversations/:id thread view
- [ ] Reply composer (SendGrid path)
- [ ] IMAP polling (Natro destegi)

### Faz 2 — Gmail Send (2 hafta, gated)
- [ ] gmail.send OAuth onayi netlestikten sonra basla
- [ ] Gmail OAuth connect + send path
- [ ] "Send via Gmail" secenegi reply composer'da
- [ ] Gmail watch + history tabanli sync (readonly)

### Faz 3 — Working Inbox (2-4 hafta)
- [ ] Owner assignment
- [ ] Stage + notes side panel
- [ ] Unread / waiting / snooze
- [ ] Search ve filters
- [ ] In-app notifications
- [ ] Prospect detail'da linked conversation panel

### Faz 4 — Zoho Replacement Hardening (3-5 hafta)
- [ ] Attachments
- [ ] Reminders / tasks
- [ ] Shared team views
- [ ] Branded reply domains
- [ ] GDPR retention controls
- [ ] Reporting: first response time, aging, workload
- [ ] Gmail draft create (restricted scope onayi sonrasi)
- [ ] Gmail import/mirror (restricted scope onayi sonrasi)

---

## Kritik Uyarilar
- Gmail-only mimari kurma — IMAP/SMTP Faz 1'de sart
- E1-E3 legacy removal Phase 6 Faz 1'den once tamamlanmali
- draft-first Faz 4'e ertelendi (gmail.compose restricted)
- messages/conversations ayri operational layer —
  prospects/campaign_recipients/email_logs'a yamama
- Google review baslamadan Faz 2'ye gecme

## Referanslar
- Audit: Eliza FORENSIC TECHNICAL AUDIT (2026-03-16)
- ChatGPT analizi (2026-03-16) — Gmail OAuth risk
- LIFFY_TODO.md — I1-I5 (Phase 6 items)
- CLAUDE.md — Constitution kurallari
- PHASE6 karar tarihi: 2026-03-16
