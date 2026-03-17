# RFC: Liffy WhatsApp Channel Architecture

> **Status:** FINAL — Multi-AI reviewed (2 rounds: ChatGPT, Gemini, Grok)
> **Version:** v3 (final review düzeltmeleri uygulanmış)
> **Tarih:** 2026-03-17
> **İlgili docs:** CLAUDE.md, CLAUDE_DB.md, CLAUDE_FEATURES.md, LIFFY_ASE_v2.md

---

## 1. AMAÇ

Liffy'nin mevcut email outreach altyapısının yanına WhatsApp'ı ikinci bir kanal olarak eklemek.

- Hedef pazarlar: Nigeria, Morocco, Ghana (WhatsApp > email etkisi)
- Rakip referans: DMG Events — verified business account ile video + CTA + template mesajlar gönderiyor
- WhatsApp, email gibi "başka bir gönderim kanalı" değil — conversation semantics'i farklı, policy kuralları farklı, tracking modeli farklı
- Doğru model: **campaign core ortak, conversation ve policy semantics kanal bazlı**

---

## 2. MEVCUT ALTYAPI

| Bileşen | Teknoloji | Durum |
|---------|-----------|-------|
| Backend | Node.js + Express | ✅ |
| Database | PostgreSQL 17 | ✅ |
| Frontend | Next.js + TypeScript | ✅ |
| Email gönderim | SendGrid API | ✅ |
| Email verification | ZeroBounce | ✅ |
| Reply Detection | VERP + SendGrid Inbound Parse | ✅ |
| Campaign Events | open, click, reply, bounce, unsubscribe | ✅ |
| Mining Engine | Playwright + 12+ miner | ✅ |
| CRM Push | Zoho CRM (OAuth2) | ✅ |
| Cache/Queue | Redis | ✅ |
| SMS/Voice | Twilio (hesap mevcut, kullanılmıyor) | ⏸ |

### Mevcut DB Tabloları (İlgili)

```
persons (id, organizer_id, email, full_name, phone, ...)
affiliations (person_id, organizer_id, company_name, job_title, ...)
campaigns (id, organizer_id, name, subject, status, ...)
campaign_recipients (id, campaign_id, person_id, email, status, meta JSONB, ...)
campaign_events (id, recipient_id, event_type, campaign_id, person_id, ...)
prospect_intents (id, person_id, intent_type, campaign_id, ...)
email_templates (id, organizer_id, name, subject, body, ...)
sender_identities (id, organizer_id, from_name, from_email, reply_to, ...)
unsubscribes (id, organizer_id, email, ...)
```

---

## 3. MİMARİ MODEL: SHARED CORE + CHANNEL ADAPTERS

> 3 AI consensus: "Tam unified tek model" aşırı karmaşık, "tamamen paralel silolar" ise veri tutarsızlığı yaratır. Doğru yol: **shared campaign core + channel-specific adapters**.

### 3.1 Campaign Core (Ortak)

Mevcut `campaigns`, `campaign_recipients`, `campaign_events` tabloları her iki kanal için de kullanılır.

```
campaigns.channel = 'email' | 'whatsapp' | 'sms'  (yeni kolon)
```

- campaign_recipients → targeting + send attempt scope (kanal-agnostik)
- campaign_events → delivery/engagement ledger (kanal-agnostik, event_type genişler)

### 3.2 Channel Adapters (Kanal Bazlı)

Campaign engine gönderim anında channel'a göre adapter seçer:

```
CampaignEngine
  ├── EmailAdapter → SendGrid API
  │     - subject/body/sender_identity
  │     - events: sent, delivered, open, click, bounce, reply, unsubscribe
  │
  └── WhatsAppAdapter → Twilio API
        - template_id, language, media, buttons
        - 24h window check
        - consent check
        - events: sent, delivered, read, failed, replied, opt_out
```

### 3.3 Merkezi Policy Function

```javascript
canSendWhatsApp(recipient, campaign, template, sender) → {
  eligible: boolean,
  reason: string,
  // Kontroller:
  // 1. consent var mı (communication_consents)
  // 2. phone var mı ve E.164 valid mi
  // 3. 24h window açık mı (session kontrolü)
  // 4. template approved mı
  // 5. sender/number aktif mi
  // 6. quality rating OK mi
  // 7. rate limit aşılmamış mı
  // 8. suppression listesinde mi (opt-out)
}
```

### 3.4 Dual-Write Kuralları (Truth Boundaries)

> 3 AI consensus: Dual-write doğru, ama her tablonun truth alanı net olmalı.

```
campaign_recipients  = orchestration / targeting / send-attempt truth
conversation_messages = actual message archive truth (body, template, provider_message_id)
campaign_events      = delivery lifecycle truth (sent, delivered, read, failed)
```

Cross-link: `conversation_messages.campaign_recipient_id` → iki yönlü referans sağlar.

---

## 4. VERİ MODELİ (YENİ TABLOLAR)

### 4.1 campaigns (MEVCUT — güncelleme)

```sql
ALTER TABLE campaigns ADD COLUMN channel VARCHAR(20) DEFAULT 'email';
-- Değerler: 'email', 'whatsapp', 'sms'
-- Mevcut tüm kampanyalar otomatik 'email' olur
```

### 4.2 campaign_events (MEVCUT — event_type genişlemesi + cross-link)

Yeni event type'lar eklenir (mevcut tabloya, şema değişikliği yok):

```
-- Ortak: queued, sent, delivered, failed, replied, opt_out
-- Email-specific: open, click, bounce, spam_report, unsubscribe, deferred
-- WhatsApp-specific: read, template_rejected, outside_session_window, number_not_whatsapp, quality_blocked
```

Cross-link için (son review — ChatGPT önerisi):

```sql
ALTER TABLE campaign_events ADD COLUMN provider_message_id VARCHAR(255);
-- conversation_messages ile sağlam bağlantı için
-- WhatsApp events'te Twilio MessageSid, email events'te SendGrid message_id
```

### 4.3 channel_senders (YENİ)

> Sender/number/organizer mapping. 3 AI consensus.

```sql
CREATE TABLE channel_senders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id),
    channel VARCHAR(20) NOT NULL,          -- 'email', 'whatsapp', 'sms'
    provider VARCHAR(20) NOT NULL,         -- 'sendgrid', 'twilio', 'meta_cloud'
    sender_type VARCHAR(30) NOT NULL,      -- 'whatsapp_number', 'email_identity'
    
    -- WhatsApp-specific
    phone_number VARCHAR(50),              -- E.164 format
    waba_id VARCHAR(100),                  -- WhatsApp Business Account ID
    display_name VARCHAR(255),             -- "Mega Clima Nigeria"
    
    -- Email-specific (mevcut sender_identities ile bridge — ileride controlled migration)
    sender_identity_id UUID,              -- FK → sender_identities (email için)
    
    -- Provider credentials
    external_sender_id VARCHAR(255),       -- Twilio number SID, etc.
    config_json JSONB,                     -- encrypted provider config
    
    -- Operational
    quality_rating VARCHAR(10),            -- 'GREEN', 'YELLOW', 'RED' (WhatsApp)
    is_default BOOLEAN DEFAULT false,
    status VARCHAR(20) DEFAULT 'active',   -- active, paused, suspended
    expo_id UUID,                          -- nullable — fuar bazlı numara mapping
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_channel_senders_org_channel ON channel_senders(organizer_id, channel);
```

> **Bridge kararı (3 AI consensus):** Şimdi sender_identity_id FK ile bridge. Mevcut email sistemi çalışmaya devam eder. İleride (Phase 3) email sender'lar da channel_senders üstünden okunabilir, ama sender_identities hemen kaldırılmaz.

### 4.4 communication_consents (YENİ)

> Kanal-agnostik consent modeli. 3 AI consensus: flag yetmez, ayrı tablo şart.

```sql
CREATE TABLE communication_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id),
    person_id UUID NOT NULL REFERENCES persons(id),
    channel VARCHAR(20) NOT NULL,          -- 'email', 'whatsapp', 'sms'
    destination VARCHAR(320) NOT NULL,     -- email adresi veya E.164 phone
    destination_normalized VARCHAR(320) NOT NULL, -- LOWER(email) veya E.164 normalized phone
    
    -- Consent state (current snapshot — history consent_events'te)
    status VARCHAR(20) NOT NULL DEFAULT 'opted_in',  
    -- opted_in, opted_out, pending, revoked
    
    -- Audit trail
    opt_in_source VARCHAR(50),             -- 'meta_ad', 'website_form', 'click_to_wa', 'manual', 'import'
    consent_category VARCHAR(20),          -- 'marketing', 'utility', 'all'
    policy_version VARCHAR(20),            -- hangi policy text'e onay verdi
    evidence_json JSONB,                   -- {ip, user_agent, form_url, ad_id, timestamp, ...}
    
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_consents_unique 
    ON communication_consents(organizer_id, person_id, channel, destination_normalized);
CREATE INDEX idx_consents_channel_status 
    ON communication_consents(organizer_id, channel, status);
```

### 4.5 consent_events (YENİ)

> Son review — 3 AI consensus: consent state değişiklik history'si immutable log olarak tutulmalı.
> communication_consents = current snapshot, consent_events = immutable audit log.

```sql
CREATE TABLE consent_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consent_id UUID NOT NULL REFERENCES communication_consents(id),
    
    event_type VARCHAR(30) NOT NULL,       -- 'opt_in', 'opt_out', 'revoke', 'imported', 'system_suppressed', 're_opt_in'
    previous_status VARCHAR(20),           -- önceki durum
    new_status VARCHAR(20) NOT NULL,       -- yeni durum
    
    source VARCHAR(50),                    -- 'reply_stop', 'manual', 'meta_ad', 'api', 'system'
    changed_by VARCHAR(50),                -- 'user', 'system', 'reply_stop', 'admin'
    evidence_json JSONB,                   -- {ip, reason, ...}
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_consent_events_consent ON consent_events(consent_id, created_at);
```

### 4.6 channel_templates (YENİ)

> WhatsApp template'leri email template'lerden yapısal olarak çok farklı — ayrı tablo doğru.

```sql
CREATE TABLE channel_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id),
    channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
    provider VARCHAR(20) NOT NULL,         -- 'twilio', 'meta_cloud'
    
    -- Template identity
    name VARCHAR(255) NOT NULL,
    language VARCHAR(10) NOT NULL,         -- 'en', 'fr', 'ar'
    category VARCHAR(20) NOT NULL,         -- 'marketing', 'utility', 'authentication'
    
    -- Content
    body_text TEXT NOT NULL,
    header_type VARCHAR(20),               -- 'text', 'image', 'video', NULL
    header_content TEXT,
    footer_text VARCHAR(60),
    buttons JSONB,                         -- [{type: 'url', text: 'Register', url: '...'}, ...]
    variables_schema JSONB,                -- [{index: 1, key: 'first_name', sample: 'Ahmed'}]
    
    -- Provider sync
    external_template_id VARCHAR(255),     -- Twilio ContentSid veya Meta template ID
    meta_status VARCHAR(20) DEFAULT 'draft', -- draft, pending, approved, rejected
    status_reason TEXT,                    -- rejection reason from Meta
    last_synced_at TIMESTAMPTZ,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_channel_templates_org ON channel_templates(organizer_id, channel, meta_status);
```

### 4.7 conversation_threads (YENİ)

> Thread + messages ayrımı. 24h window thread-level state.

```sql
CREATE TABLE conversation_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id),
    person_id UUID REFERENCES persons(id), -- NULL olabilir (henüz match edilmemiş inbound)
    channel VARCHAR(20) NOT NULL,          -- 'whatsapp', 'sms'
    phone VARCHAR(50) NOT NULL,            -- E.164
    sender_id UUID REFERENCES channel_senders(id),
    
    -- Session state
    window_expires_at TIMESTAMPTZ,         -- son inbound + 24h
    last_inbound_at TIMESTAMPTZ,
    last_outbound_at TIMESTAMPTZ,
    
    -- Conversation state (V1: basit enum, V2: FSM-ready)
    state VARCHAR(30) DEFAULT 'new',       -- new, active, qualified, handed_off, closed
    state_context JSONB,                   -- FSM context data (ileride XState uyumu)
    assigned_user_id UUID,                 -- manual handoff için
    
    -- Attribution (Phase 2'de aktif kullanılır)
    source VARCHAR(50),                    -- 'meta_ad', 'organic', 'campaign_reply', 'website'
    referral_metadata JSONB,               -- CTWA: {ctwa_clid, ad_id, headline, media_url}
    
    -- Campaign link
    campaign_id UUID,                      -- campaign-originated ise
    
    unread_count INTEGER DEFAULT 0,
    is_open BOOLEAN DEFAULT true,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- FIX: Son review — multi-tenant scope eklendi (sadece phone+sender_id dar kalıyordu)
CREATE UNIQUE INDEX idx_threads_unique 
    ON conversation_threads(organizer_id, channel, phone, sender_id);
CREATE INDEX idx_threads_org_state 
    ON conversation_threads(organizer_id, is_open, state);
```

### 4.8 conversation_messages (YENİ)

```sql
CREATE TABLE conversation_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES conversation_threads(id),
    
    direction VARCHAR(10) NOT NULL,        -- 'inbound', 'outbound'
    message_type VARCHAR(20) NOT NULL,     -- 'text', 'image', 'video', 'template', 'interactive'
    message_category VARCHAR(20),          -- 'marketing', 'utility', 'authentication', 'service' (fiyatlandırma takibi)
    
    -- Content
    body_text TEXT,
    media_url TEXT,
    template_id UUID,                      -- FK → channel_templates (outbound template ise)
    payload_json JSONB,                    -- raw provider payload (selective fields)
    
    -- Provider tracking
    provider_message_id VARCHAR(255),      -- Twilio MessageSid (idempotency key)
    status VARCHAR(20),                    -- queued, sent, delivered, read, failed
    error_code VARCHAR(20),               -- provider error code
    
    -- Timestamps
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    
    -- Campaign link
    campaign_recipient_id UUID,            -- campaign-originated outbound ise
    
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_messages_provider_id ON conversation_messages(provider_message_id);
CREATE INDEX idx_messages_thread ON conversation_messages(thread_id, created_at);
```

---

## 5. AKIŞLAR

### 5.1 Inbound (Meta Ads → Lead Capture)

```
Meta Ads (Click-to-WhatsApp CTA)
  ↓
Kullanıcı WhatsApp'ta mesaj gönderir
  ↓
Twilio webhook → POST /api/webhooks/whatsapp/inbound
  ↓
[1] Signature validation (Twilio SDK — X-Twilio-Signature)
[2] Duplicate check (provider_message_id UNIQUE)
[3] Thread lookup/create (organizer_id + channel + phone + sender_id)
[4] Person match/create (phone → persons)
[5] Window reset (window_expires_at = now + 24h, Redis TTL set)
[6] Consent record (communication_consents + consent_events)
[7] Message save (conversation_messages)
[8] Auto-reply (V1: rule-based qualification)
[9] Unread count update
```

> CTWA attribution parsing (step 4 arası) Phase 2'de aktif edilir.

### 5.2 Outbound (WhatsApp Campaign)

```
Liffy UI → Create WhatsApp Campaign
  ↓
Template seç (channel_templates — meta_status='approved')
Sender seç (channel_senders — quality_rating != 'RED')
Recipient listesi (persons + communication_consents filter)
  ↓
Campaign Engine → WhatsApp Adapter
  ↓
Per-recipient: canSendWhatsApp() policy check
  ├── consent ✓ (communication_consents.status = 'opted_in')
  ├── phone E.164 ✓ (destination_normalized)
  ├── template approved ✓
  ├── sender active ✓
  ├── rate limit ✓
  └── suppression check ✓
  ↓
Twilio API → WhatsApp delivery (throttled queue via Redis worker)
  ↓
campaign_recipients.status = 'sent'
conversation_messages INSERT (campaign_recipient_id linked)
campaign_events INSERT (event_type='sent', provider_message_id)
  ↓
Twilio status webhook → POST /api/webhooks/whatsapp/status
  ↓
[1] Signature validation
[2] Status update → conversation_messages (delivered/read/failed)
[3] Campaign event → campaign_events (delivered/read/failed + provider_message_id)
```

### 5.3 Leena Entegrasyonu (Phase 2)

```
Leena CRM UI → "Send WhatsApp" button
  ↓
POST /api/v1/whatsapp/send (Liffy API)
  ├── Auth: organizer token + rate limit
  ├── canSendWhatsApp() policy check
  ├── Twilio API call
  └── Response: message_id, status
  ↓
Tek WhatsApp altyapısı, iki frontend'den erişim
```

---

## 6. PROVIDER ABSTRACTION

> 3 AI consensus: Twilio ile başla, provider değişebilir yapı kur.

```
WhatsAppProvider (interface)
  ├── TwilioWhatsAppProvider (Phase 1 — mevcut hesap)
  │     - sendTemplate(phone, contentSid, variables)
  │     - sendFreeForm(phone, body, media)
  │     - getTemplateStatus(contentSid)
  │     - validateWebhook(request)
  │
  └── MetaCloudWhatsAppProvider (Phase 3 — maliyet optimizasyonu)
        - aynı interface, farklı implementation
```

**Karar:** Phase 1 Twilio direkt, Phase 2 provider abstraction layer, Phase 3 gerekirse Meta Cloud API migration.

---

## 7. 24-SAAT WINDOW ENFORCEMENT

> Backend'de hard business rule olarak implement edilmeli (3 AI consensus).

### Redis Session Layer

```
Inbound mesaj geldiğinde:
  SET session:wa:{phone}:{sender_id} = thread_id
  EXPIRE session:wa:{phone}:{sender_id} 86400  (24 saat)

Outbound göndermeden önce:
  EXISTS session:wa:{phone}:{sender_id}
  ├── var → free-form allowed (daha ucuz, template gerekmez)
  └── yok → sadece approved template allowed
```

### DB'de kalıcı kayıt

```
conversation_threads.window_expires_at = last_inbound_at + INTERVAL '24 hours'
```

Redis = hızlı erişim, PostgreSQL = audit/truth kaynağı.

---

## 8. RATE LIMITING & QUALITY MANAGEMENT

> WhatsApp email gibi sınırsız paralel gönderime izin vermez (Grok uyarısı).

- **Message rate:** Twilio pair rate limit (~80 msg/sec per WABA, yeni hesaplar daha düşük)
- **Tier system:** Yeni hesap = 1K msg/24h, tier upgrade ile 10K → 100K → unlimited
- **Queue:** Mevcut Redis worker + throttling (exponential backoff on 131056 errors)
- **Quality monitoring:** channel_senders.quality_rating — GREEN/YELLOW/RED
  - RED → campaign pause + organizer alert
  - Periyodik Meta API sorgusu ile güncelleme (Phase 2)

---

## 9. HESAP YAPISI (Multi-Tenant)

> Shared WABA quality rating riski var (Grok uyarısı).

### Kısa vade (Elan Expo)

- 1 WABA — Elan Expo adına
- Fuar başına ayrı numara (channel_senders tablosunda expo_id ile mapping)
- Tek Twilio account

### Uzun vade (Multi-tenant SaaS)

- Her organizer kendi WABA'sını bağlar
- Twilio subaccounts ile izolasyon (quality rating ayrışır)
- channel_senders.waba_id + config_json ile per-tenant credentials
- Twilio Embedded Signup ile organizer onboarding

---

## 10. WEBHOOK GÜVENLİK & İDEMPOTENCY

- **Signature validation:** Twilio SDK ile her webhook request'te X-Twilio-Signature doğrulama
- **Idempotency:** provider_message_id UNIQUE constraint → duplicate webhook işlenmez
- **Out-of-order handling:** Status update'ler sadece "ileri" yönde (sent → delivered → read, geriye gitmez)
- **Dead letter queue:** Failed webhook processing → Redis retry queue

---

## 11. COMPLIANCE

- **STOP/unsubscribe keyword handling:** "STOP" reply → otomatik opt-out (communication_consents + consent_events)
- **Per-organizer suppression scope:** Bir organizer'dan opt-out, diğerini etkilemez
- **E.164 phone normalization:** Tüm phone numaralar E.164 formatında saklanır ve destination_normalized'a yazılır
- **Consent evidence:** evidence_json ile opt-in kanıtı (ad_id, form_url, IP, timestamp)
- **Data retention:** conversation_messages — 90 gün retention policy (configurable)
- **Encryption:** config_json (provider credentials) encrypted at rest
- **Afrika compliance:** Nigeria NDPA 2023, Morocco CNDP (Law 09-08), Ghana Data Protection Act 2012 — tümü explicit consent + audit trail gerektirir (consent_events tablosu bu ihtiyacı karşılar)

---

## 12. PHASE PLANI

### Phase 1 — MVP

**DB Migrations:**
- [ ] campaigns.channel kolonu (ALTER)
- [ ] campaign_events.provider_message_id kolonu (ALTER)
- [ ] channel_senders tablosu
- [ ] communication_consents tablosu
- [ ] consent_events tablosu
- [ ] channel_templates tablosu
- [ ] conversation_threads tablosu
- [ ] conversation_messages tablosu

**Backend:**
- [ ] Twilio WhatsApp inbound webhook endpoint
- [ ] Twilio WhatsApp status webhook endpoint
- [ ] WhatsApp outbound send service (template + free-form)
- [ ] canSendWhatsApp() policy function
- [ ] 24h window enforcement (Redis TTL + DB)
- [ ] WhatsApp campaign send pipeline (queue + throttle)
- [ ] Basic auto-reply (rule-based)
- [ ] channel_senders CRUD API
- [ ] channel_templates CRUD API + manual status management
- [ ] communication_consents API (opt-in/opt-out + consent_events logging)

**Frontend:**
- [ ] WhatsApp campaign create/send page
- [ ] Basic conversations inbox (thread list + message display)

### Phase 2 — Enrichment

- [ ] CTWA attribution parsing (referral_metadata)
- [ ] Quality rating monitoring (Meta API polling + dashboard)
- [ ] Conversation FSM derinleştirme (XState veya custom)
- [ ] Template approval webhook lifecycle (auto-sync)
- [ ] Cost tracking per organizer / per campaign
- [ ] Leena API entegrasyonu ("Send WhatsApp" button)
- [ ] Frontend: Conversation detail + manual reply + handoff
- [ ] Provider abstraction layer (WhatsAppProvider interface)

### Phase 3 — Scale

- [ ] Meta Cloud API adapter (maliyet optimizasyonu)
- [ ] Multi-WABA per-tenant isolation
- [ ] Twilio Embedded Signup for organizer onboarding
- [ ] AI-powered reply classification (ASE Reply Intelligence ile birleşir)
- [ ] Meta Conversions API geri beslemesi (CTWA ROAS tracking)
- [ ] Email sender_identities → channel_senders controlled migration

---

## 13. YENİ TABLO ÖZETİ

| # | Tablo | Tip | Açıklama |
|---|-------|-----|----------|
| 1 | campaigns (güncelleme) | ALTER | channel kolonu eklenir |
| 2 | campaign_events (güncelleme) | ALTER | provider_message_id kolonu eklenir |
| 3 | channel_senders | YENİ | Sender/number/organizer mapping (email bridge + WA + SMS) |
| 4 | communication_consents | YENİ | Kanal-agnostik consent/opt-in (current snapshot) |
| 5 | consent_events | YENİ | İmmutable consent history / audit log |
| 6 | channel_templates | YENİ | WhatsApp (+ SMS) template'leri, Meta approval status |
| 7 | conversation_threads | YENİ | Thread-level state, 24h window, attribution |
| 8 | conversation_messages | YENİ | Message-level content + delivery tracking |

**Mevcut tablolar değişmez:** persons, affiliations, campaign_recipients, campaign_events (sadece 1 kolon eklenir), prospect_intents, email_templates, sender_identities — hepsi olduğu gibi kalır.

---

## 14. ASE UYUMU

> 3 AI consensus: Bu mimari ASE (Autonomous Sales Engine) vizyonuyla çok iyi hizalanıyor.

Bu yapı sayesinde ileride yapılabilecekler:
- Email → no reply → WhatsApp template (cross-channel sequence)
- WhatsApp inbound → qualified → CRM push
- Email + WhatsApp mixed multi-touch sequence
- Channel fallback (email fail → WhatsApp try)
- Per-channel suppression & scoring

ASE için ileride ek tablolar gerekecek (sequences, sequence_steps, person_channel_state, cooldown logic) ama bu mimari o tabakaya hazır bir temel oluşturuyor.

---

## 15. SON REVIEW ÖZETİ (Multi-AI Consensus)

| Karar | ChatGPT | Grok | Gemini | Sonuç |
|-------|---------|------|--------|-------|
| Shared core + channel adapters | ✅ | ✅ | ✅ | **Benimsendi** |
| Consent ayrı tablo | ✅ | ✅ | ✅ | **communication_consents** |
| Consent history immutable log | ✅ | ✅ | ✅ | **consent_events** |
| Thread + messages ayrımı | ✅ | ✅ | ✅ | **conversation_threads + messages** |
| channel_senders tablosu | ✅ | ✅ | ✅ | **Eklendi** |
| Bridge (sender_identities) | ✅ | ✅ | ✅ | **Şimdi bridge, ileride migrate** |
| Twilio ile başla | ✅ | ✅ | ✅ | **Phase 1 Twilio** |
| 24h backend enforcement | ✅ | ✅ | ✅ | **Redis TTL + DB** |
| Phase 1 scope daralt | ✅ | ✅ | ✅ | **CTWA, quality UI, FSM, Leena → Phase 2** |
| ASE uyumu | ✅ | ✅ | ✅ | **Temel hazır, sequence layer ileride** |

---

*Bu doküman 2 tur multi-AI review (ChatGPT, Gemini, Grok × 2) sonrası finalize edilmiştir.*
*Claude Code'a verilecek implementation guide olarak kullanılacaktır.*
