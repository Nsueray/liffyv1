# Phase 6 — Conversations / Inbox Layer

## Mimari Karar (2026-03-16)

### Üç Ray Modeli
- SendGrid → kampanya rayı (outbound batch)
- Gmail → insan rayı (human replies + compose)
- Liffy → workflow + görünürlük rayı

### Temel Prensipler
- Gmail'i replace etme, üstüne otur
- conversation = email thread (prospect değil)
- Aynı kişiyle birden fazla bağımsız conversation olabilir
- Draft-first: Liffy "Reply" butonu → Gmail draft açar
- notify@liffy.app wrapper → sadece fallback/degraded mode
- messages ve conversations = operational layer
- CampaignEvent = event ledger (değişmez)
- ProspectIntent = intent truth (değişmez)

---

## Veri Modeli

### connected_mailboxes
- id, organizer_id, mailbox_email
- oauth_access_token, oauth_refresh_token
- watch_expiration, last_history_id
- default_send_as_alias, status

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
- transport: sendgrid / gmail / import
- from, to, cc, subject
- text_body, html_body, snippet
- raw_mime_storage_key
- rfc_message_id, in_reply_to, references
- provider_message_id
- gmail_message_id, gmail_thread_id
- campaign_id, campaign_recipient_id (nullable)
- sent_at / received_at

### mailbox_sync_state
- mailbox_id, last_history_id
- full_sync_checkpoint, error_state, needs_reauth

---

## Akış

### Campaign Outbound
Liffy → SendGrid → Prospect
→ RFC Message-ID + provider_message_id kaydet
→ seed copy Gmail'e import et (label: LIFFY/Campaigns)

### Prospect Reply
Prospect → reply.liffy.app
→ Liffy inbound ingest
→ messages tablosuna kaydet (full body, raw MIME)
→ CampaignEvent(reply) + ProspectIntent(if first)
→ original MIME Gmail'e import et (doğal thread)
→ in-app notification (sadece "Open in Liffy" CTA)

### Human Reply
Elif → Gmail'de reply eder
→ Gmail watch/history → Liffy sync
→ messages tablosuna append

### Opsiyonel
Elif → Liffy'de "Create Gmail Draft" butonu
→ Gmail draft oluşturulur
→ Elif Gmail'de düzenleyip gönderir

---

## UI

### /conversations
Inbox listesi. Filtreler:
- my threads / unread / waiting for me
- campaign-originated / replied today / no response > X gün

Her satır: kişi, şirket, konu, son mesaj snippet,
owner, stage, son aktivite, unread badge

### /conversations/:id
Sol: tam mesaj akışı, quoted history collapse,
     signature collapse, attachments
Sağ panel: person + affiliation, linked campaign,
           ProspectIntent.stage, notes, owner,
           activity timeline

Aksiyonlar: Open in Gmail, Create Gmail Draft,
            Assign owner, Change stage,
            Add note, Snooze, Mark waiting/closed

---

## Roadmap

### Faz 0 — Ürün kararı + teknik sözleşme (1 hafta)
- [ ] Gmail OAuth scope kararı + Google verification başlat
- [ ] Constitution addendum: conversations/messages kuralları
- [ ] sender_identity ↔ Gmail mailbox ↔ send-as eşleşme kuralı
- [ ] Retention ve erişim politikası

### Faz 1 — Foundation (2-3 hafta)
- [ ] Outbound Message-ID + provider_id persist
- [ ] Inbound full body + raw MIME persist
- [ ] connected_mailboxes, conversations, messages,
      mailbox_sync_state tabloları (migration)
- [ ] notify wrapper → fallback/degraded mode'a al
- [ ] Gmail OAuth connect + first mailbox sync

### Faz 2 — Gmail Mirror MVP (2-3 hafta)
- [ ] SendGrid outbound sonrası Gmail'e seed import
- [ ] Inbound reply sonrası Gmail'e original MIME import
- [ ] Gmail watch + history tabanlı incremental sync
- [ ] Read-only /conversations + /conversations/:id
- [ ] Prospect detail'da linked conversation panel

### Faz 3 — Working Inbox / Draft-first (2-4 hafta)
- [ ] Owner assignment
- [ ] Stage + notes side panel
- [ ] Unread / waiting / snooze
- [ ] "Create Gmail Draft" action
- [ ] "Open in Gmail"
- [ ] Search ve filters
- [ ] In-app notifications

### Faz 4 — Zoho Replacement Hardening (3-5 hafta)
- [ ] Optional inline send via Gmail API
- [ ] Attachments
- [ ] Reminders / tasks
- [ ] Shared team views
- [ ] Branded reply domains (reply.company.com)
- [ ] GDPR retention controls
- [ ] Reporting: first response time, aging, owner workload

---

## Kritik Uyarılar
- Gmail OAuth review süreci uzun sürebilir — Faz 0'da başlat
- E1-E3 legacy removal Faz 1'den önce tamamlanmalı
- messages/conversations prospect veya campaign_recipients'e
  yamamalı — ayrı operational layer olarak kalsın
- UI pages are views, not data owners (Constitution kuralı)

## Referanslar
- Audit: Eliza FORENSIC TECHNICAL AUDIT (2026-03-16)
- ChatGPT analizi (2026-03-16)
- LIFFY_TODO.md — I1-I5 (Phase 6 items)
- CLAUDE.md — Constitution kuralları
