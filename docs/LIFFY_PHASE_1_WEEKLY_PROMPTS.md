# LIFFY Phase 1 — Weekly Claude Code Prompts

> **Purpose:** Executable Claude Code prompts for each week of Phase 1 MVP.
> **Companion to:** `LIFFY_PHASE_1_MVP_PLAN.md`
> **Usage:** At the start of each week, paste the corresponding prompt to Claude Code. Wait for completion and Suer review before next week.

---

## Week 1 — Reference Tables + Companies Table

**Goal:** Foundation tables exist in production (empty or seeded), schema documented.

**Why this first:** Migration in Week 2 needs both `companies` table and reference data (sectors, countries) to exist. Without canonical sector_id, dedup is impossible.

**Two parallel tracks:**
- Track A (ELIZA repo): Reference tables creation — **ELL chat writes the prompt, Suer feeds it to ELIZA Claude Code. LİFFY side waits.**
- Track B (LİFFY repo): Companies table creation — **Suer feeds prompt to LİFFY Claude Code (provided below).**

**Both tracks must complete before Week 2 starts.** Track B's `companies` table FK references Track A's `core_countries.code` and `core_sectors.id`, so Track A's schema must be agreed first (already done in ELL_RULES v4).

### Claude Code Prompt — Track A (ELIZA repo) — written by ELL chat

> **Note:** This prompt is written and maintained by ELL chat. It is reproduced here for reference only. Do not modify; if changes needed, coordinate with ELL chat. Schema authoritative source: ELL_RULES.md v4 "REFERENCE DATA TABLES" section.

The Track A prompt creates:
- `core_countries` (PK: `code CHAR(2)` ISO 3166-1 alpha-2, full ISO seed)
- `core_sectors` (PK: `id SERIAL`, `parent_id` self-FK, hierarchical, ELL-curated seed from Zoho data)
- `core_currencies` (PK: `code CHAR(3)` ISO 4217, seed: EUR/USD/TRY/NGN/MAD/KES/DZD/GHS)
- `core_languages` (PK: `code CHAR(2)` ISO 639-1, seed: en/tr/fr/ar)
- ELIZA service `referenceDataService.js` with caching
- Read-only API endpoints exposed to LİFFY/LEENA

For exact SQL, see ELL_RULES.md v4. ELL chat's prompt to ELIZA Claude Code will derive from there.

### Claude Code Prompt — Track B (liffyv1 repo)

```
liffyv1 repo'sunda companies tablosunu oluştur. ADR-014 (updated 2026-04-29) gereği Company entity Phase 1'e taşındı. ELL_RULES v4'teki schema'ya uyumlu olacak.

ÖNEMLİ — ELL_RULES v4 reference:
- core_countries.code CHAR(2) (ISO 3166-1 alpha-2) — companies.country_code FK olarak buna işaret edecek
- core_sectors.id SERIAL — companies.sector_id FK olarak buna işaret edecek
- Bu FK'lar cross-system "soft references" — gerçek FK CONSTRAINT eklenmiyor (R1: ELIZA writes core_*, LIFFY okur)

Görev:
1. Migration dosyası oluştur: backend/migrations/NNN_create_companies.sql
   (sıradaki migration numarasını kontrol et — büyük ihtimalle 043)

2. companies tablosu:
   - id UUID PRIMARY KEY DEFAULT gen_random_uuid()
   - organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE
   - name VARCHAR(500) NOT NULL  -- normalize edilmiş canonical name
   - name_normalized VARCHAR(500) NOT NULL  -- lowercased, trimmed, dedup için
   - country_code CHAR(2)  -- soft FK to core_countries.code (cross-system, no FK constraint)
   - city VARCHAR(200)
   - sector_id INTEGER  -- soft FK to core_sectors.id (cross-system, no FK constraint)
   - website VARCHAR(500)
   - phone VARCHAR(50)
   - email VARCHAR(320)  -- general company email (info@, contact@)
   - employee_count VARCHAR(50)  -- '1-10', '11-50', '51-200', '201-500', '500+', NULL
   - company_type VARCHAR(50)  -- 'manufacturer', 'distributor', 'agent', 'contractor', 'other'
   - source VARCHAR(50)  -- 'zoho_import', 'manual', 'mining', 'data_entry_form', 'lead_convert'
   - zoho_account_id VARCHAR(50)  -- nullable, for Zoho migration mapping
   - tags TEXT[]  -- ['past_exhibitor', 'vip', 'pavilion', 'do_not_contact']
   - notes TEXT
   - created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
   - assigned_to_user_id UUID REFERENCES users(id) ON DELETE SET NULL  -- primary owner sales rep
   - created_at TIMESTAMPTZ DEFAULT NOW()
   - updated_at TIMESTAMPTZ DEFAULT NOW()
   - UNIQUE (organizer_id, name_normalized)  -- dedup constraint

3. Indexes:
   - idx_companies_organizer (organizer_id)
   - idx_companies_country (country_code)
   - idx_companies_sector (sector_id)
   - idx_companies_assigned_user (assigned_to_user_id)
   - idx_companies_name_trgm USING gin(name gin_trgm_ops) — fuzzy search için (pg_trgm extension)
   - idx_companies_zoho_id (zoho_account_id) WHERE zoho_account_id IS NOT NULL — partial

4. Trigger: updated_at otomatik güncelleme.

5. affiliations tablosuna nullable company_id ekle:
   - ALTER TABLE affiliations ADD COLUMN company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
   - CREATE INDEX idx_affiliations_company ON affiliations(company_id) WHERE company_id IS NOT NULL;
   - DİKKAT: company_id şu an NULL kalacak. Migration Week 2'de yapılacak. ŞİMDİ backfill yapma.

6. CLAUDE_DB.md güncelle:
   - companies tablosunu "Canonical Tables" altında ekle
   - Soft FK'lara not düş (country_code, sector_id — cross-system)
   - affiliations'taki yeni company_id kolonunu not et
   - Migration listesi sonuna 043_create_companies ekle

7. Henüz API endpoint yapma — Week 4'te Company sayfası ile birlikte gelecek.

8. CRITICAL — yapma:
   - companies tablosuna data INSERT yapma (Week 2 migration script'in işi)
   - core_countries veya core_sectors'a yazma (R1 violation, ELIZA-only)
   - country_code veya sector_id için FK CONSTRAINT ekleme (R1 + Phase 2 work, R7 mantığı)
   - Mevcut affiliations data'sına dokunma (sadece kolon ekle)

9. Commit mesajı: "feat(companies): create companies table + affiliations.company_id column (ADR-014, Phase 1, ELL_RULES v4)"

Bitince rapor ver: migration başarılı mı, indexes oluştu mu, mevcut affiliations sayısı ne (SELECT COUNT(*)), tabloya örnek bir INSERT denedin mi (sonra DELETE etmeyi unutma).
```

---

## Week 2 — Migration: Affiliations → Companies

**Goal:** ~17K canonical companies populated, all affiliations linked via company_id, sectors and countries mapped to reference IDs.

**Dependencies:** Week 1 (Track A + Track B) complete.

### Claude Code Prompt — Week 2

```
liffyv1 repo'sunda affiliations → companies migration script'i çalıştır. Bu Phase 1'in en kritik veri işidir. Yanlış olursa similar-companies, auto-assignment, Company sayfası — hepsi bozuk olur.

Görev — script (NOT migration; bu data migration, ayrı çalıştırılır):
backend/scripts/migrate_affiliations_to_companies.js

ADIM 1 — Sector mapping
1. affiliations.industry kolonundaki tüm distinct değerleri çek (SELECT DISTINCT industry FROM affiliations WHERE industry IS NOT NULL ORDER BY industry).
2. Her değer için core_sectors'a fuzzy match yap (pg_trgm benzerlik veya manual mapping):
   - "Furniture", "furniture", "Mobilya" → core_sectors WHERE slug='design.furniture'
   - "HVAC", "hvac", "Heating" → core_sectors WHERE slug='hvac'
   - "Construction", "construction", "İnşaat", "Building" → core_sectors WHERE slug='construction'
   - "Decor", "decoration", "Home Décor", "Dekor" → core_sectors WHERE slug='design.decoration'
   - vb.
3. Çıktı: backend/scripts/migration_data/sector_mapping.json
   {"Furniture": "design.furniture", "Mobilya": "design.furniture", "Decor": "design.decoration", ...}
4. Eşleşmeyen değerleri (>%5 threshold) ayrı bir liste yap: unmapped_sectors.txt — bunlar manuel review gerektirir.
5. Suer'e rapor: kaç distinct sector var, kaçı mapped, kaçı unmapped, top 20 unmapped örnek.

DURDUR — Suer review etsin, unmapped'leri manuel ekle. Devam onayı al.

ADIM 2 — Country mapping
1. affiliations.country kolonundaki distinct değerleri çek.
2. core_countries.name_en, name_tr, name_fr, iso_code'a fuzzy match yap.
   - "Türkiye", "Turkey", "TR" → TR
   - "Nigeria" → NG
   - "Ghana" → GH
   - "Maroc", "Morocco", "MA" → MA
3. Çıktı: country_mapping.json
4. Unmapped'leri Suer'e raporla.

DURDUR — Suer review.

ADIM 3 — Company dedup ve creation
1. SELECT organizer_id, company_name, country, industry, COUNT(*) as person_count, ARRAY_AGG(DISTINCT person_id) as person_ids FROM affiliations WHERE company_name IS NOT NULL GROUP BY organizer_id, company_name, country, industry;
2. company_name'i normalize et:
   - lowercase
   - trim
   - "GmbH", "Ltd.", "S.A.", "Inc.", "Limited", "Şirketi", "Sanayi ve Ticaret" gibi suffix'leri kaldır (ama orijinali sakla)
   - Çoklu boşluk → tek boşluk
   - Sonuna "_normalized" key ekle
3. Aynı (organizer_id, name_normalized) olanları MERGE et:
   - En çok person'a bağlı olan rekoru "winner" kabul et
   - Diğerlerinin person_ids'lerini birleştir
4. Conservative merge: sadece exact normalized match'te merge. "Bosch GmbH" ve "Bosch Türkiye" ayrı kalır (sonra admin UI'da manuel merge edilir).
5. Her unique company için companies tablosuna INSERT:
   - name = orijinal company_name (winner record'unkı)
   - name_normalized = normalize edilmiş hali
   - country_code = country_mapping.json'dan (CHAR(2) ISO kod, ELL_RULES v4)
   - sector_id = sector_mapping.json'dan (INTEGER, core_sectors.id)
   - source = 'zoho_import' (eğer affiliation source'u zoho ise) veya 'mining' veya 'manual'
   - assigned_to_user_id = en çok person'a sahip olan affiliation'ın person'ının pipeline_assigned_user_id (eğer varsa)
   - tags = []
   - created_by_user_id = NULL (sistem migration)
6. INSERT'lerden sonra her affiliation'ın company_id'sini güncelle:
   UPDATE affiliations SET company_id = (SELECT id FROM companies WHERE organizer_id = affiliations.organizer_id AND name_normalized = NORMALIZE(affiliations.company_name)) WHERE company_id IS NULL;

ADIM 4 — Validation
1. SELECT COUNT(*) FROM companies; — beklenen ~15-20K
2. SELECT COUNT(*) FROM affiliations WHERE company_id IS NULL; — affiliations'ın yüzde kaçı eşleşemedi (company_name NULL olanlar hariç)
3. SELECT sector_id, COUNT(*) FROM companies GROUP BY sector_id ORDER BY 2 DESC LIMIT 20; — sector dağılımı sağlıklı mı
4. SELECT country_code, COUNT(*) FROM companies GROUP BY country_code ORDER BY 2 DESC LIMIT 20; — country dağılımı sağlıklı mı
5. Sample 50 companies çek, name'leri çıktıla — Suer manuel review etsin

ADIM 5 — Rollback plan
- Migration script'i idempotent yapma; yerine BEGIN; ... COMMIT; ile transaction kullan
- Bir backup table oluştur ÖNCE: CREATE TABLE companies_backup_20260429 AS TABLE companies; (boş olur ama schema kopyası)
- Eğer Suer "rollback" derse: TRUNCATE companies CASCADE; UPDATE affiliations SET company_id = NULL;

KESİNLİKLE YAPMA:
- Persons tablosuna dokunma (Week 3'ün işi)
- affiliations.industry ve country kolonlarını silme (mapped değerlere ek olarak orijinaller kalsın, audit için)
- Reference tablolarına yazma (R1 violation)
- Production'da BAŞLAMA — önce dev/staging'de tam simülasyon, raporu Suer'e göster, sonra production onayı al.

Commit mesajı: "feat(migration): affiliations → companies migration script + sector/country mapping"

Bitince detaylı rapor ver: dev/staging'de kaç company oluştu, ne kadar süre aldı, hata var mı, Suer'in onaylaması gereken örnekler nedir.
```

---

## Week 3 — persons.lifecycle_stage + Lead → Contact Convert Flow

**Goal:** Every person has a lifecycle_stage. Convert API exists and works. Audit trail in place.

### Claude Code Prompt — Week 3

```
liffyv1 repo'sunda persons.lifecycle_stage enum'u ve Lead → Contact convert flow'u ekle.

Görev 1 — Migration: backend/migrations/044_add_lifecycle_stage.sql

1. Enum type oluştur:
   CREATE TYPE lifecycle_stage_enum AS ENUM ('lead', 'mql', 'sql', 'contact', 'customer');

2. persons tablosuna kolonlar ekle:
   ALTER TABLE persons ADD COLUMN lifecycle_stage lifecycle_stage_enum;
   ALTER TABLE persons ADD COLUMN lifecycle_changed_at TIMESTAMPTZ;
   ALTER TABLE persons ADD COLUMN company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
   CREATE INDEX idx_persons_lifecycle ON persons(lifecycle_stage);
   CREATE INDEX idx_persons_company ON persons(company_id) WHERE company_id IS NOT NULL;

3. Audit table:
   CREATE TABLE person_lifecycle_history (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     person_id UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
     from_stage lifecycle_stage_enum,
     to_stage lifecycle_stage_enum NOT NULL,
     changed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
     reason VARCHAR(100),
     changed_at TIMESTAMPTZ DEFAULT NOW()
   );
   CREATE INDEX idx_person_lifecycle_history_person ON person_lifecycle_history(person_id, changed_at DESC);

Görev 2 — Backfill script: backend/scripts/backfill_lifecycle_stage.js

Smart backfill (Risk 3 — Plan'da belirtilen):
- Person reply atmış (campaign_events.event_type='reply' VAR) → 'contact'
- Person aktif kampanyada (campaign_recipients.status IN ('sent', 'opened', 'clicked')) → 'mql'
- Person'un signed quote'u VAR (Phase 1.5 sonrası, şu an: skip) → 'customer'
- Geri kalan → 'lead'

person_lifecycle_history'e migration olarak (changed_by_user_id = NULL, reason = 'system_backfill') tek satır ekle.

Görev 3 — Persons.company_id backfill:
- affiliations'tan en güncel olanı al (max(created_at) per person_id)
- O affiliation'ın company_id'sini person'a yaz
- Bu kısım Week 2 migration'ından sonra mantıklı çalışır

Görev 4 — Convert API: backend/routes/persons.js içine ekle

POST /api/persons/:id/convert
Body: { target_stage: 'contact', company_id?: 'uuid', reason?: 'reply_received' | 'manual' | 'quote_started' }

Logic:
1. Auth + organizer_id check
2. Hierarchical visibility check (ADR-015)
3. Validate target_stage transition (lead→mql→sql→contact→customer; backward = manual reason gerekli)
4. UPDATE persons SET lifecycle_stage=target, lifecycle_changed_at=NOW(), company_id=COALESCE($company_id, company_id) WHERE id=$id
5. INSERT INTO person_lifecycle_history (...)
6. Return updated person + new company link

GET /api/persons/:id/lifecycle-history
- Audit trail döndür
- Hierarchical visibility check

Görev 5 — Auto-convert trigger (BACKEND, sessizce çalışır):
- Reply detection webhook'u (mevcut backend/services/webhooks.js)
- Eğer reply gelen person'un lifecycle_stage='lead' veya 'mql' ise → otomatik 'contact'a çevir
- person_lifecycle_history'e reason='auto_reply_received' ile log

Görev 6 — UI minimal değişiklik:
- liffy-ui'de mevcut Contact Detail page'inde lifecycle_stage badge ekle (henüz büyük UI rebuild Week 6'da)
- Convert butonu ekle: "Convert to Contact" / "Convert to Customer"
- Konfirmasyon modal: target_stage, company select (optional), reason (dropdown)

Görev 7 — Test:
- Backfill script'i staging'de çalıştır
- 100 random person sample → lifecycle_stage doğru atandı mı?
- Convert API → 1 lead'i contact'a çevir, history'de görünüyor mu?
- Reply webhook → manual reply simulate et, auto-convert oldu mu?

Commit mesajları (3 ayrı commit):
1. "feat(persons): add lifecycle_stage enum, company_id, lifecycle_history table"
2. "chore(backfill): smart lifecycle_stage backfill from campaign_events"
3. "feat(persons): convert API + auto-convert on reply"

CLAUDE_DB.md güncelle: lifecycle_stage_enum, person_lifecycle_history, persons yeni kolonları.
LIFFY_TODO.md'ye Week 3 task'larını ekle, ✅ DONE işaretle.

YAPMA:
- Existing convert/conversion mekanizmalarına dokunma (varsa)
- Eski persons rekorlarını silme
- Forbidden terms kullanma — "customer" sadece enum value, UI'da "Customer" gösterirken italic veya farklı renk kullan ki forbidden term tartışması açılmasın
- Bu hafta Quote ile ilgili hiçbir şey yapma
```

---

## Week 4 — Company Detail Page

**Goal:** `/companies/:id` page exists with Zoho parity. Sales rep can find any company and see everything about it.

### Claude Code Prompt — Week 4

```
liffyv1 + liffy-ui'de Company sayfasını kur.

Backend (liffyv1):

Görev 1 — API endpoints: backend/routes/companies.js (yeni dosya)

GET /api/companies
  Query params: search, country_id, sector_id, assigned_to_user_id, page, limit, sort
  Hierarchical visibility (ADR-015): default sales_rep kendi assigned_to'sunu + ekibinin assigned_to'sunu görür
  Response: { companies: [...], total, page, limit }

GET /api/companies/:id
  Full company detail + summary stats
  Response: {
    company: {...},  // tablodan
    stats: {
      contacts_count: N,
      campaigns_sent: N,
      replies_count: N,
      last_activity_at: timestamp,
      pending_actions_count: N
    },
    contacts: [...],  // ilk 10 contact (paginate ileride)
    recent_activities: [...],  // son 10 contact_activity
    related_companies: [...]   // similar (same sector + country, top 5)
  }

POST /api/companies
  Manual company creation (sales rep tarafından)
  Body: { name, country_id, sector_id, website, ...}
  Validate: name + organizer_id duplicate check (UNIQUE constraint zaten engeller ama 409 döndür güzel mesajla)

PATCH /api/companies/:id
  Edit (only assigned_to_user_id veya manager+ üstü)
  Audit log: contact_activities'e ekle (activity_type='company_updated')

DELETE /api/companies/:id  
  Soft delete (deleted_at kolon ekle veya status field). HARD delete yapma — referential integrity riski.

GET /api/companies/:id/timeline
  Cross-channel timeline: campaigns (gönderilen), email events, replies, notes, activities
  ORDER BY timestamp DESC, paginated

Frontend (liffy-ui):

Görev 2 — Pages
- pages/companies/index.tsx — list view
- pages/companies/[id].tsx — detail view
- pages/companies/new.tsx — create form

Görev 3 — Components
- components/companies/CompanyList.tsx — table + filters (country, sector, assignedTo)
- components/companies/CompanyDetail.tsx — main detail
- components/companies/CompanyHeader.tsx — name, country, sector, assigned rep
- components/companies/CompanyContacts.tsx — contacts list (related to this company)
- components/companies/CompanyTimeline.tsx — chronological activity feed
- components/companies/CompanyStats.tsx — stat cards (contacts, campaigns, replies)
- components/companies/RelatedCompanies.tsx — "5 similar companies in your portfolio"
  Format: "12 Moroccan HVAC companies in your portfolio. 4 attended Madesign 2025." (conversation ammunition style, NOT analytics dashboard)
- components/companies/CompanyEditModal.tsx — edit
- components/companies/CompanyCreateForm.tsx — manual create

Görev 4 — Routing
- /companies → list
- /companies/[id] → detail
- /companies/new → create

Görev 5 — Sidebar entry (geçici, Week 6'da reboot olacak)
- Sidebar'a "Companies" linki ekle (geçici, sales rep'in test edebilmesi için)

Görev 6 — Reference data integration
- ELIZA referenceDataService API'lerini kullan (GET /api/reference/countries, /sectors)
- Cache yap (5 dakika TTL veya SWR pattern)

Acceptance criteria:
- Sales rep "Bosch" ararken company detail görür
- Company detail sayfasında 12 contact, 5 kampanya geçmişi, 3 reply var
- "Similar companies" bölümü: "12 German HVAC companies in your portfolio" gösteriyor
- Sales rep yeni company yaratabiliyor (form çalışıyor)
- Edit/delete çalışıyor, audit log yazılıyor
- Hierarchical visibility çalışıyor: sales rep kendi + ekibinin company'sini görüyor, manager + ekibini görüyor, owner her şeyi görüyor

YAPMA:
- "Customer" / "Client" / "Account" kelimelerini UI'da kullanma — sadece "Company"
- Pipeline kanban yapma (R5)
- Reference data'yı LİFFY tarafında writes yapma
- Quote ile ilgili hiçbir şey ekleme

Commit mesajları (backend ve frontend ayrı):
1. (liffyv1) "feat(companies): API endpoints — list, detail, create, update, timeline"
2. (liffy-ui) "feat(companies): Company detail page, list, create form"
```

---

## Week 5 — Contact Detail Page Enrichment

**Goal:** `/contacts/:id` (existing page) is enriched with lifecycle, company link, similar contacts, conversation ammunition.

### Claude Code Prompt — Week 5

```
liffyv1 + liffy-ui'de mevcut Contact (Person) Detail sayfasını zenginleştir. Mevcut page var, baştan yazma — geliştir.

Backend (liffyv1):

Görev 1 — Mevcut GET /api/persons/:id endpoint'ini genişlet:
- lifecycle_stage + lifecycle_changed_at döndür
- Linked company (company_id varsa companies'dan join et)
- Last 5 lifecycle_history entry
- Conversation ammunition data:
  * "X companies from same sector in your portfolio"
  * "Y companies from same country in your portfolio"
  * "Z companies attended Z expo last edition"
  (Sentence-based, NOT raw counts. Backend'de SQL hesapla, frontend'de cümle olarak göster.)

Görev 2 — Yeni endpoint: GET /api/persons/:id/conversation-context
- Sales rep arıyorken kullanır
- Returns:
  {
    similar_in_portfolio: "12 Moroccan HVAC companies in your portfolio",
    past_engagement: "Last contacted 14 days ago, opened 2 emails",
    expo_history: "Attended Madesign 2025, did not attend SIEMA 2024",
    current_campaigns: ["Mega Clima Ghana 2026 campaign — sent Apr 22"]
  }

Frontend (liffy-ui):

Görev 3 — Components
- components/contacts/LifecycleStageBadge.tsx — colored badge: Lead (gray), MQL (yellow), SQL (orange), Contact (blue), Customer (green)
- components/contacts/CompanyLink.tsx — eğer company_id varsa company sayfasına link
- components/contacts/ConversationAmmunition.tsx — "Talking to this person? Useful facts:" panel (3-4 cümle)
- components/contacts/LifecycleHistoryTimeline.tsx — convert geçmişi
- components/contacts/SimilarContacts.tsx — same sector + same country (top 5)

Görev 4 — Mevcut Contact Detail page'ini güncelle:
- Üst kısımda: name, lifecycle_stage badge, company link
- Conversation Ammunition panel — sağ tarafta sticky, sales rep telefondayken görür
- Mevcut Timeline (campaign events) altında lifecycle history'i de göster
- "Convert" butonu (Week 3'te eklendi) görünür yap

Görev 5 — Mobile-friendly
- Conversation Ammunition panel mobilde collapsible
- Buttons büyük (touch target ≥44px)

Acceptance criteria:
- Sales rep contact detail açtığında lifecycle stage net görünür
- Company link tıklanabilir, Company detail'a gider
- Conversation Ammunition panel'de 3-4 yararlı cümle var ("12 Moroccan HVAC companies in your portfolio. Last contacted 14 days ago.")
- Convert butonu çalışıyor (Week 3 endpoint'i çağırıyor)
- Mobile'da kullanılabilir

YAPMA:
- Yeni table create etme
- Mevcut /api/persons/:id'i breaking change yapma — backwards compatible kalsın
- Forbidden terms

Commit mesajları:
1. (liffyv1) "feat(contacts): enrich /api/persons/:id with lifecycle + company + conversation context"
2. (liffy-ui) "feat(contacts): Contact detail enrichment — lifecycle badge, company link, conversation ammunition"
```

---

## Week 6 — UI Sidebar Reboot — Today, Portfolio

**Goal:** Sales rep opens LİFFY → sees Today (Action homepage) and Portfolio (their numbers). Old sidebar collapsed.

### Claude Code Prompt — Week 6

```
liffy-ui'de sidebar'ı baştan yapılandır. Mevcut Action Screen'i homepage yap, Portfolio dashboard'unu ekle.

ÖNEMLİ — kullanıcı şokunu azalt:
- Mevcut sidebar items SİLME, sadece "admin only" kategorisine taşı (admin role'lü user görür)
- Sales rep göremesin (4 ana item: Today, Portfolio, Discover [admin], Settings)
- Bu deploy CUMA AKŞAMI yap, Pazartesi sabahı Elif'e 5 satırlık "ne değişti" emaili gitsin

Görev 1 — Sidebar refactor: components/Sidebar.tsx (veya benzer)

Sales rep view (default):
- 🎯 Today (current Action Screen, /action route'u / olarak yeniden mapla)
- 📊 Portfolio (yeni page, /portfolio)
- ⚙️ Settings (kişisel ayarlar)

Manager view: yukarısı + 
- 👥 Team (zaten varsa kalsın, yoksa skip)

Owner/Admin view: yukarısı + 
- 🔧 Admin (collapsible, içinde):
  - Lists, Templates, Senders, Verification, Mining Jobs, Prospects, Campaigns (eski hali), Reports, hepsi
  - Companies (Week 4'te eklenen geçici link buraya taşınır)
  - Contacts (mevcut)

Görev 2 — Today page (homepage rebuild)
- Mevcut Action Screen'i homepage'e taşı
- Route: GET / → Today component
- Her action card'ın altına "Why am I seeing this?" expandable section ekle:
  Trigger: reply_received → "Bu kişi 2 saat önce kampanyana cevap verdi"
  Trigger: quote_stale → "7 gün önce teklif gönderildi, henüz cevap yok"
  Trigger: rebooking → "ABC Manufacturing geçen yıl katıldı, bu yıl konuşmadın"
  vb.
- Filter bar: All / Replies / Stale / Rebooking / Manual

Görev 3 — Portfolio page (yeni)
- Route: /portfolio
- Üst kısımda 4 stat card:
  * Companies in your portfolio: N (link → /companies)
  * Contacts: N (link → /contacts)
  * Active campaigns: N (link → /admin/campaigns yetki varsa)
  * Replies last 30 days: N (link → /today?filter=replies)
- Recent activity feed:
  * Son 10 reply
  * Son 5 yeni company added
  * Son 5 lifecycle convert
- "Hot prospects" widget: lifecycle_stage IN ('mql', 'sql') with engagement signal (recent open/click)
- Hierarchical visibility — sales rep sadece kendi rakamlarını görür, manager team rakamları, owner her şey

Görev 4 — Backend support
- GET /api/portfolio/stats — counts + breakdowns
- GET /api/portfolio/recent-activity — latest events
- GET /api/portfolio/hot-prospects — engaged + recent

Görev 5 — Permission middleware update
- Admin sidebar items sadece role IN ('owner', 'manager') veya specific permissions
- Sales rep / staff bu route'lara direct URL ile gidemesin (403 döndür)

Acceptance criteria:
- Sales rep login → / → Today görüyor
- Sales rep sidebar'da 3 item görüyor: Today, Portfolio, Settings
- Action card'larında "Why am I seeing this?" çalışıyor
- Portfolio'da company sayısı, contact sayısı, kampanya sayısı, reply sayısı
- Owner login → Admin alt menüsü açık, eski sidebar'daki her şey orada

YAPMA:
- Eski sayfaları 404 yapma — admin'de erişilebilir kalsın
- Sales rep direct URL (örn /lists) ile admin sayfaya gidebilirse 403 göster
- Pipeline kanban (R5)
- Forbidden terms

Deploy:
1. Staging'de tam test
2. Suer manuel test eder
3. Cuma akşamı 18:00'dan sonra production deploy
4. Pazartesi sabahı Elif'e email taslağı hazırla (Suer gönderir)

Commit:
1. (liffy-ui) "feat(ui): sidebar reboot — Today as homepage, Portfolio dashboard, admin grouping"
2. (liffyv1) "feat(portfolio): stats + recent activity + hot prospects endpoints"
```

---

## Week 7 — UI Reboot Continued: Discover (admin), Settings consolidation

**Goal:** Discover (mining) admin-only. Settings consolidated. Old technical pages cleanly hidden.

### Claude Code Prompt — Week 7

```
Sidebar reboot Phase 2 — Discover ve Settings sadeleştir.

Görev 1 — Discover (admin-only)
- /admin/discover — mevcut Source Discovery + Mining Jobs (zaten merge edilmiş, K16'da yapıldı)
- Sales rep göremiyor — sidebar'da Admin altında
- "Add Source" butonu öne çıkar — manual URL ekleme (Discover otomasyonu YOK, üç AI da uyardı)
- Mining job list, status, retry, results
- AI Miner Generator referansı YOK (retired)

Görev 2 — Settings sadeleştir
- Mevcut Settings sayfası bölünmüş olabilir, tek bir yere konsolide et:
  - Profile (kullanıcı kendi bilgisi)
  - Notification preferences (henüz yok ama placeholder ekle)
  - Email signature
  - Display preferences (dark/light, language: tr/en/fr)
  - Sales rep'e açık olan kısım minimal
- Admin Settings ayrı:
  - Users management (mevcut)
  - Sender identities (admin)
  - Email templates (admin)
  - Verification config (admin)
  - Zoho integration (admin)

Görev 3 — Audit
- Sidebar'da hangi route'lar admin-only, kontrol et:
  /lists, /templates, /senders, /verification, /mining/*, /prospects, /campaigns, /reports
  Hepsi /admin/* prefix'ine taşınsın veya middleware ile sales rep redirect edilsin /today'e

Görev 4 — Forbidden terms cleanup
- grep -ri "customer\|client\|account" liffy-ui/src --include="*.tsx" --include="*.ts"
- "Customer" → "Contact" veya "Customer" (eğer lifecycle_stage value'ysa kalır)
- "Client" → "Company"
- "Account" → "Company"
- liffyv1'de aynı grep
- Yarısı false positive olur — "customerStripe", "discountAmount" vb. dokunma. Sadece kullanıcı görünür stringler.

Görev 5 — Test
- Sales rep login → görmemesi gereken hiçbir şey görmüyor
- Owner login → her şeye erişimi var
- Manager login → kendi yetkisine göre

YAPMA:
- Eski page kodlarını sil (Phase 2'ye bırak — bu hafta sadece visibility)
- Bütün sidebar'ı baştan yaz — Week 6'da yapıldı, sadece Discover ve Settings

Acceptance:
- Sales rep sidebar: Today, Portfolio, Settings (3 item)
- Owner sidebar: Today, Portfolio, Settings + Admin > Discover, Lists, Templates, Senders, Verification, Mining Jobs, Companies, Contacts, Campaigns, Reports
- Forbidden terms grep: zero user-facing matches

Commit:
1. (liffy-ui) "feat(ui): sidebar reboot phase 2 — Discover admin, Settings consolidate, route guards"
2. (liffy-ui) "chore(terms): replace forbidden terms (client/customer/account → Company/Contact)"
```

---

## Week 8 — Auto-Assignment Routing

**Goal:** New mining results, new manual entries, new lead conversions auto-assign to correct sales rep based on rules.

### Claude Code Prompt — Week 8

```
liffyv1'de auto-assignment routing sistemini kur. Mining results ve yeni lead'ler otomatik doğru sales rep'e atanır.

Görev 1 — Migration: 045_create_assignment_rules.sql

CREATE TABLE assignment_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  rule_type VARCHAR(20) NOT NULL CHECK (rule_type IN ('country', 'sector', 'fallback')),
  match_value VARCHAR(100),  -- country_id veya sector_id (string olarak), fallback için NULL
  assigned_to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 100,  -- düşük sayı = yüksek öncelik
  is_active BOOLEAN DEFAULT true,
  created_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_assignment_rules_org ON assignment_rules(organizer_id, is_active, priority);

CREATE TABLE assignment_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type VARCHAR(20) NOT NULL,  -- 'company', 'person'
  entity_id UUID NOT NULL,
  rule_id UUID REFERENCES assignment_rules(id),
  assigned_to_user_id UUID NOT NULL REFERENCES users(id),
  reason VARCHAR(200),  -- "country=NG → Jude", "sector=HVAC → Elif", "fallback → Elif"
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_assignment_audit_entity ON assignment_audit(entity_type, entity_id, created_at DESC);

Görev 2 — Service: backend/services/assignmentService.js

assignToUser(entity_type, entity_id, context):
  1. context = { organizer_id, country_id, sector_id, ... }
  2. Get active rules for this organizer ordered by priority
  3. Match logic (priority order):
     - Exact (country_id + sector_id) match: rare, advanced
     - Sector match (rule_type='sector', match_value=sector_id)
     - Country match (rule_type='country', match_value=country_id)
     - Fallback (rule_type='fallback')
  4. Tiebreak: country > sector (configurable, default country wins)
  5. UPDATE entity SET assigned_to_user_id = matched_user
  6. INSERT INTO assignment_audit
  7. Return { user_id, rule_id, reason }

Görev 3 — Hook: mining results
- backend/services/superMiner/services/aggregationTrigger.js (veya wherever mining results land)
- Yeni person ve/veya company yaratıldığında assignmentService.assignToUser() çağır
- Eğer rule match yoksa fallback user

Görev 4 — Hook: manual lead creation
- POST /api/persons (eğer yoksa create et) → auto-assign
- POST /api/companies (Week 4'te eklendi) → auto-assign

Görev 5 — Hook: data entry form (Week 9'da gelecek)
- Form submit → person + company create → auto-assign
- Şimdilik bu hook'u placeholder olarak ekle (Week 9'da bağlanır)

Görev 6 — Admin UI: assignment rules management
- Page: /admin/assignment-rules
- List rules with priority order
- Add rule: rule_type (dropdown), match_value (country/sector dropdown), assigned_to_user (dropdown), priority
- Edit, delete, toggle is_active
- Test panel: "Test rule with: country=NG, sector=HVAC → Result: Elif (rule: sector=HVAC, priority=10)"

Görev 7 — Audit page
- /admin/assignment-audit — son 100 assignment, filter by entity, user, date
- Sales rep auditi göremesin (admin only)

Görev 8 — Seed initial rules (Suer'le confirm et önce, MIGRATION SCRIPT olarak)

ÖNEMLİ — D14: Seed kurallar **migration script** olarak yazılır, kod içinde hardcode olmaz.

Hafta 8 başında Suer ile konuş, gerçek isimleri al:
- country=NG → ? (Nigeria sales rep)
- country=GH → ? (Ghana sales rep)
- country=MA → ? (Morocco sales rep)
- sector=HVAC → ? (HVAC specialist)
- sector=design.* → ? (Design specialist)
- fallback → ? (varsayılan)

Suer cevap verince, ayrı bir migration script yaz:
backend/migrations/047_seed_assignment_rules.sql

İçeriği şu yapıda:
INSERT INTO assignment_rules (organizer_id, rule_type, match_value, assigned_to_user_id, priority, created_by_user_id)
VALUES
  ('<organizer_uuid>', 'sector', '<hvac_sector_id>', '<elif_uuid>', 10, '<suer_uuid>'),
  ('<organizer_uuid>', 'country', 'NG', '<jude_uuid>', 20, '<suer_uuid>'),
  ...
  ('<organizer_uuid>', 'fallback', NULL, '<elif_uuid>', 100, '<suer_uuid>');

Bu sayede:
- Kurallar DB'de yaşar, kod'da değil
- Admin UI'dan değiştirilebilir
- Yeni sales rep eklenirse migration ile değil admin UI'dan eklenir
- Audit trail var (created_by_user_id)

Görev 9 — Test
- 10 yeni mining result simulate et — doğru rep'e atandı mı?
- Rule değiştir, retroactive uygulanıyor mu? (Hayır, sadece YENI atamalar — mevcut atamalar manuel reassign)
- Audit log doluyor mu?

Acceptance:
- Yeni mining result → otomatik doğru rep'in portfolio'sunda
- Sales rep "kendiminiş" gibi data gerçekten kendi country/sector'üne uyuyor
- Admin rule değiştirebiliyor, audit log var
- Fallback user assign rule yoksa devreye giriyor

Commit:
1. (liffyv1) "feat(assignment): assignment_rules + assignment_audit tables, assignmentService"
2. (liffyv1) "feat(assignment): hooks in mining results + manual creation"
3. (liffy-ui) "feat(admin): assignment rules management + audit pages"
```

---

## Week 9 — Public Data Entry Form URL

**Goal:** Freelancer/data-entry staff can enter companies via public URL without LİFFY login.

### Claude Code Prompt — Week 9

```
liffyv1 + liffy-ui'de public data entry form URL'si yarat. Zoho Form mantığında — login yok, token bazlı access.

Görev 1 — Migration: 046_create_data_entry_forms.sql

CREATE TABLE data_entry_forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  token VARCHAR(40) UNIQUE NOT NULL,  -- random 32-char + checksum
  name VARCHAR(200) NOT NULL,  -- internal admin name: "Lagos Data Entry — Q2 2026"
  is_active BOOLEAN DEFAULT true,
  rate_limit_per_ip INTEGER DEFAULT 10,  -- per minute
  rate_limit_per_token INTEGER DEFAULT 100,  -- per hour
  fields_config JSONB,  -- which fields shown, required vs optional
  default_assigned_to_user_id UUID REFERENCES users(id),  -- override assignment rules
  default_lifecycle_stage lifecycle_stage_enum DEFAULT 'lead',
  created_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_data_entry_forms_token ON data_entry_forms(token) WHERE is_active = true;

CREATE TABLE data_entry_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id UUID NOT NULL REFERENCES data_entry_forms(id) ON DELETE CASCADE,
  submitter_ip INET NOT NULL,
  submitter_email VARCHAR(320),  -- optional, freelancer'ın kendi emaili
  submission_data JSONB NOT NULL,
  created_person_id UUID REFERENCES persons(id) ON DELETE SET NULL,
  created_company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'pending_review',  -- pending_review, approved, rejected, duplicate
  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_data_entry_submissions_status ON data_entry_submissions(form_id, status, created_at DESC);

Görev 2 — Public API (no auth, rate limited): backend/routes/publicForms.js

GET /api/public/forms/:token
  Returns form config (fields, organizer name, branded info)
  Rate limit: 60/min per IP

POST /api/public/forms/:token/submit
  Body: { 
    company_name, country, sector, website, phone, email,
    contact_name, contact_email, contact_phone, contact_title,
    notes, submitter_email
  }
  Logic:
  1. Rate limit check (per IP per minute, per token per hour)
  2. CAPTCHA verify (Cloudflare Turnstile or hCaptcha)
  3. Validate form is active
  4. Insert into data_entry_submissions (status='pending_review')
  5. Background job:
     - Duplicate check (company name match against existing companies)
     - If unique: create person + company (lifecycle_stage='lead', source='data_entry_form')
     - Apply assignment rules (Week 8 service)
     - Update submission status='approved' or 'duplicate'
  6. Return { success: true, message: "Submission received, will be reviewed" }
  RATE LIMIT: 10/min per IP, 100/hour per token

GET /api/public/forms/:token/duplicate-check?company_name=...
  Live duplicate check (autocomplete)
  Rate limit: 20/min per IP

Görev 3 — Public form UI: liffy-ui/pages/data-entry/[token].tsx

- Public route, no auth required
- Beautiful, simple form (NOT LİFFY's main UI)
- Branded with organizer name + logo
- Fields:
  * Company name * (required, with autocomplete duplicate check)
  * Country * (dropdown from core_countries)
  * Sector (dropdown from core_sectors, optional)
  * Website
  * Phone
  * Email
  * Contact name
  * Contact email
  * Contact title
  * Notes
- CAPTCHA before submit
- After submit: success page "Thanks, your submission is being reviewed"
- Mobile-friendly (freelancer phone'dan giriyor olabilir)
- Multilingual: form interface tr/en/fr (browser language detect, lang query param override)

Görev 4 — Admin UI: /admin/data-entry-forms
- List forms (active/inactive)
- Create form: name, fields_config, default_assigned_to, link generated token
- View submissions per form
- Approve/reject pending submissions
- Statistics: total submissions, approved %, duplicates %, top submitters

Görev 5 — Submissions review page: /admin/data-entry-submissions
- Pending submissions list
- Quick approve / reject
- Edit before approve
- Bulk operations

Görev 6 — Notification (optional, nice-to-have)
- Email to admin daily digest: "5 new data entry submissions today"
- In-app notification: "Pending submissions: 12" badge

Görev 7 — Test
- Create a test form via admin
- Open public URL incognito
- Fill form, submit
- Pending review'da görünüyor mu
- Approve → person + company yaratıldı mı
- Assignment doğru çalıştı mı (Week 8 entegrasyonu)
- Duplicate test: aynı company name 2. kez submit, "duplicate" işaretlendi mi
- Rate limit test: 11 submission per minute, 11. block oldu mu

YAPMA:
- Direct INSERT — her zaman pending_review queue üzerinden
- Authentication ekleme (point of failure)
- Approval olmadan auto-create (spam riski)

Commit:
1. (liffyv1) "feat(public-forms): data_entry_forms + submissions tables, public API"
2. (liffy-ui) "feat(public-forms): public submission form UI (no auth, multilingual)"
3. (liffy-ui) "feat(admin): data entry forms management + submissions review"
```

---

## Week 10 — Observation (No Code)

**Goal:** Real-use feedback collected from Elif/Bengü. Issue list compiled for Phase 1.5 prioritization.

**Why this week exists:** ELL chat 2026-04-29 raised a valid risk: if Phase 1.5 (Quote) starts immediately after Week 9, sales reps still go to Zoho for Quote creation, creating "two-system fatigue." This week is for catching real issues from real use, not AI-suggested observation.

**This is NOT shadow session.** Shadow session was rejected for Week 1 because Elif wasn't using LİFFY. By Week 10, she IS using it. Real workflow data is now available.

### Activities for Week 10

**Day 1 — Monday morning:**
- Suer + Elif sit together for 60-90 minutes
- Elif walks through her Monday morning workflow in LİFFY
- Suer takes notes silently (no fixing during the session)
- Specifically watch for: moments she switches to Zoho, hesitations, confusion, repeated tasks

**Day 1-3 — Daily check-ins:**
- Brief 15-minute Slack/call with Elif at end of each day
- "Anything that didn't work today?"
- Document in `LIFFY_PHASE_1_OBSERVATIONS.md` (new file in liffyv1/docs/)

**Day 4 — Bengü session:**
- Same format as Day 1 with Bengü (different role, may surface different issues)

**Day 5 — Synthesis:**
- Compile observations
- Categorize: critical (blocks daily work) / important (slows daily work) / nice-to-have (cosmetic)
- Match against Phase 1.5 plan (Quote module)
- Decide: any critical observations require pre-Phase-1.5 fix? Any observations change Quote module priorities?

### Deliverable
`LIFFY_PHASE_1_OBSERVATIONS.md` — committed to liffyv1/docs/. Contains:
- Real workflow observations from Elif and Bengü
- Issue list with priorities
- Phase 1.5 plan adjustments (if any)
- Suer's reflections on what worked / what didn't in Phase 1 implementation

### NOT this week
- No new feature development
- No bug fixes that require >1 hour work (queue them for Phase 1.5 intake)
- Don't start Phase 1.5 prematurely "to use the time"

If Elif/Bengü report no critical issues by Day 3, it's tempting to start Phase 1.5 early. **Resist this.** The observation buffer protects against unknown unknowns. Use the remaining days for documentation cleanup, ChatGPT/Gemini review of Phase 1 outcomes, or just rest.

---

## End of Phase 1 — Verification Checklist

After Week 9, before declaring Phase 1 done, verify:

- [ ] All 9 weeks committed and deployed to production
- [ ] CLAUDE_DB.md, CLAUDE_FEATURES.md, LIFFY_TODO.md fully updated
- [ ] Reference data (countries, sectors) seeded and used
- [ ] companies table populated (~17K), all affiliations linked
- [ ] All persons have lifecycle_stage set
- [ ] Sales rep can do full flow: search company → see contacts → see timeline → convert lead → reply detected → action item shown
- [ ] Auto-assignment working: new mining result → correct sales rep
- [ ] Public form URL working: freelancer can submit, admin can review/approve
- [ ] Sidebar collapsed: 3 items for sales rep, full admin for owner
- [ ] Forbidden terms: zero user-facing matches
- [ ] Elif tested it for 1 week, no critical complaints

Once verified → Phase 1 MVP complete → start Phase 1.5 (Quote module).

---

## Notes for Suer

- **Don't fast-forward.** If Week 2 (migration) takes 3 weeks, that's fine. Don't skip to Week 3 with bad data.
- **Multi-AI review per week.** At end of each week, paste the diff to ChatGPT + Gemini for sanity check before next week.
- **Keep Elif informed.** Cuma akşamı deploys, Pazartesi sabahı brief email, Çarşamba check-in. Don't overload her.
- **Buffer for emergencies.** If something breaks in production (Render deploy issue, DB problem), pause the plan. Don't plow through.
- **Weekly retro.** Hafta sonu 30 dakika: ne çalıştı, ne çalışmadı, gelecek hafta neyi farklı yaparsın.
