# AI Miner Generator — Proje Raporu v2 (Yeni Yaklaşım)

> **Status:** AKTİF GELİŞTİRME — Park'tan çıkarıldı, yeni mimari ile devam
> **Tarih:** 2025-03-06 v2
> **Review:** ChatGPT (selector discovery önerisi), Gemini (AXTree + Self-Healing REPL + HITL raporu)

---

## 1. İlk Deneme Özeti (v1 — Park Edildi)

### Ne yapıldı
- 8 commit, ~1200 satır kod, 2 gün geliştirme
- 7 adımlı pipeline: fetch → sanitize → Claude API → security scan → sandbox test → validate → save
- Multi-step extraction (listing → detail page crawl)
- 6 katmanlı güvenlik, admin API (7 endpoint), pipeline hook

### Neden park edildi
- **Başarı oranı %20-29** — sadece email'leri DOM'da doğrudan gösteren basit sayfalarda çalıştı
- Zor siteler (SPA, detail page, click-to-reveal) çözülemedi
- Claude **uydurma CSS selector** üretiyordu (`.company-card`, `.directory-item` — gerçekte yok)
- 100KB raw HTML gönderiliyordu — çok gürültülü, Claude asıl veriyi bulamıyordu

### Kök nedenler (3 reviewer'ın ortak tespiti)
1. **Ham HTML → LLM çok gürültülü** — 100KB HTML'de %95'i gereksiz (reklam, script, style, nav, footer)
2. **CSS selector halüsinasyonu** — Claude genel web bilgisiyle selector tahmin ediyor, site-specific class name'leri bilemez
3. **Doğrusal akış** — tek deneme, başarısız olursa bitir. Self-healing yok.

---

## 2. Yeni Yaklaşım (v2 — 3 Reviewer'ın Sentezi)

### 3 Temel Değişiklik

| # | Değişiklik | Kaynak | Etki |
|---|-----------|--------|------|
| 1 | **AXTree (Accessibility Tree)** — Ham HTML yerine Playwright ariaSnapshot() YAML | Gemini | %95 token tasarrufu, halüsinasyon riski sıfır, semantik selector'lar |
| 2 | **Self-Healing REPL Loop** — tek deneme yerine iteratif düzeltme döngüsü (max 3-5) | Gemini | Başarı oranı %29 → tahmini %60-80 |
| 3 | **Config-driven extraction** — AI kod yazmaz, selector config üretir, sabit template çalıştırır | ChatGPT | Kırılganlık azalır, güvenlik riski düşer |

### Yeni Pipeline

```
URL → Playwright render → ariaSnapshot() YAML (2-5KB)
  → Claude'a YAML gönder: "Tekrar eden entity blokları bul, selector'ları döndür"
  → Claude JSON config döner (kod değil!):
    {
      entity_selector: "role=listitem",
      name: "heading level=3",
      detail_link: "link 'View Profile'",
      email: "link name=/mailto:/",
      phone: "text /\\+?\\d/"
    }
  → Sabit GenericExtractor template config ile çalışır
  → Başarısız olursa: hata + güncel AXTree → Claude'a geri gönder → düzeltsin (max 3 deneme)
  → Başarılıysa: config DB'ye kaydet, sonraki mining'lerde reuse
```

### Neden bu çalışacak

| Eski yaklaşım | Yeni yaklaşım |
|---------------|---------------|
| 100KB raw HTML → Claude | 2-5KB YAML AXTree → Claude |
| Claude 200 satır JS üretir | Claude 10 satır JSON config üretir |
| CSS selector tahmin (halüsinasyon) | Semantik role/name selector (kesin) |
| Tek deneme, başarısız → bitir | 3-5 iterasyon, hata feedback ile düzelt |
| Her site farklı kod | Her site aynı template, farklı config |
| eval() + sandbox riski | Sabit kod, güvenlik riski yok |

---

## 3. AXTree Detayı (Gemini)

### Accessibility Tree nedir?
Her browser DOM'dan iki ağaç oluşturur:
1. **DOM** — tüm HTML, CSS, JS dahil (dev, karmaşık)
2. **Accessibility Tree** — filtrelenmiş, anlamsal, ekran okuyucular için (temiz, küçük)

AXTree dekoratif div'leri, SVG'leri, reklam frame'lerini otomatik atar. Sadece eylemsel/anlamsal değer taşıyan roller kalır.

### Playwright ariaSnapshot()
```javascript
const snapshot = await page.accessibility.snapshot();
// veya
const yaml = await page.locator('body').ariaSnapshot();
```

Çıktı (YAML):
```yaml
- navigation:
  - link "Home"
  - link "Exhibitors"
- main:
  - heading "Exhibitor Directory" [level=1]
  - list:
    - listitem:
      - heading "ThermoCool SAS" [level=3]
      - text "France"
      - link "View Profile" [href="/exhibitor/123"]
    - listitem:
      - heading "Daikin Europe" [level=3]
      - text "Germany"  
      - link "View Profile" [href="/exhibitor/456"]
```

Bu 2-5KB. Raw HTML'in 100KB'sı yerine. Claude bunu görünce:
- `heading level=3` = company name ✅
- `link "View Profile"` = detail URL ✅
- Uydurma `.company-card` class'ı yok ✅

### getByRole vs CSS Selector

| | CSS Selector | getByRole (AXTree) |
|---|---|---|
| Örnek | `page.locator('.sc-fRBNxp')` | `page.getByRole('heading', { level: 3 })` |
| Site değişince | KIRILIR (class name değişir) | ÇALIŞIR (role değişmez) |
| Halüsinasyon | Yüksek | Sıfır |
| Token | 50K-150K | 2K-5K |

---

## 4. Self-Healing REPL Loop (Gemini)

### Eski akış (doğrusal)
```
Claude kod yaz → çalıştır → 0 sonuç → BİTTİ ❌
```

### Yeni akış (iteratif)
```
İterasyon 1:
  Claude → AXTree'den config üret → template çalıştır → 0 sonuç
  → Hata: "entity_selector 'listitem' bulunamadı"
  → Güncel AXTree'yi tekrar al → Claude'a gönder

İterasyon 2:
  Claude → "Pardon, doğru selector 'article' imiş" → config güncelle → template çalıştır → 28 company, 0 email
  → Hata: "email selector bulunamadı, detay sayfada olabilir"
  → Örnek detail page AXTree al → Claude'a gönder

İterasyon 3:
  Claude → detail page config üret → template çalıştır → 28 company, 22 email
  → ✅ BAŞARILI → config DB'ye kaydet

Max 3-5 iterasyon. Her iterasyonda Claude güncel durumu görüyor.
```

### Feedback içeriği
Her iterasyonda Claude'a şunlar gönderilir:
- Önceki config
- Hata mesajı veya validation failure sebebi
- **Güncel AXTree** (sayfa durumu değişmiş olabilir)
- Bulunan element sayıları ("28 heading bulundu ama 0 link[mailto:]")

---

## 5. Config-Driven Extraction (ChatGPT)

### Eski: AI kod yazıyor (kırılgan)
```javascript
// Claude'un ürettiği kod — her site farklı
const cards = document.querySelectorAll('.exhibitor-card');
cards.forEach(card => {
  const name = card.querySelector('.company-name')?.textContent;
  // ...200 satır daha
});
```

### Yeni: AI config üretiyor (stabil)
```json
{
  "type": "directory_listing",
  "listing": {
    "entity_role": "listitem",
    "name_selector": "heading level=3",
    "country_selector": "text after heading",
    "detail_link": "link 'View Profile'"
  },
  "detail": {
    "email_selector": "link name=/mailto:/",
    "phone_selector": "link name=/tel:/",
    "website_selector": "link name=/http/ not same-domain",
    "address_selector": "text role=paragraph near 'Address'"
  },
  "pagination": {
    "next_selector": "link 'Next'",
    "max_pages": 10
  }
}
```

### Sabit Template Miner'lar
```
GenericDirectoryMiner(config) — card/list layout
GenericTableMiner(config) — table layout
GenericDetailCrawler(config) — listing + detail page
```

Claude sıfırdan kod yazmak yerine doğru template'i seçip config'i doldurur. Kod hiç değişmez — sadece config değişir.

---

## 6. HITL (Human-in-the-Loop) — ChatGPT + Gemini Ortak

### Konsept
%100 otonom değil, %90 AI + %10 insan. Mevcut `pending_approval` altyapımız bunu zaten destekliyor.

### Admin Approval Dashboard (Gelecek UI)
```
┌─────────────────────────────────────────────┐
│ AI Miner Generator — Pending Approval        │
│                                              │
│ Domain: valveworldexpo.com                   │
│ Config: { entity: "listitem", name: "h3" }  │
│ Test results: 28 company, 22 email           │
│ Sample: ThermoCool → contact@thermocool.fr   │
│                                              │
│ [Preview Page] [Edit Config] [Approve] [Reject] │
└─────────────────────────────────────────────┘
```

Admin config'i görebilir, düzeltebilir, onaylayabilir. Sıfırdan 3-6 saat miner yazmak yerine 1 dakika review.

---

## 7. Implementation Plan (Yeni Yaklaşım)

### Step 1: AXTree Integration
- [ ] `aiMinerGenerator.js` → `getPageAXTree(page)` method ekle
- [ ] Playwright `ariaSnapshot()` veya `accessibility.snapshot()` kullan
- [ ] `buildSystemPrompt()` güncelle — "YAML AXTree analiz et, JSON config üret"
- [ ] `buildUserPrompt()` güncelle — HTML yerine AXTree gönder
- [ ] Test: bilinen URL'lerde AXTree çıktısını kontrol et

### Step 2: Config-Driven Templates
- [ ] `GenericDirectoryExtractor` template — config-driven listing + detail
- [ ] `GenericTableExtractor` template — config-driven table extraction
- [ ] Claude'un ürettiği config'i template'e besle
- [ ] `generated_miners.miner_code` → artık config JSON (kod değil)

### Step 3: Self-Healing REPL Loop
- [ ] `generateMinerWithHealing()` — max 3-5 iterasyon
- [ ] Her iterasyonda: çalıştır → hata varsa güncel AXTree + hata → Claude'a geri gönder
- [ ] İterasyon logu DB'ye kaydet (debugging için)

### Step 4: Multi-Step (Listing + Detail)
- [ ] İlk iterasyonda listing AXTree → config
- [ ] Detail page yoksa → single page template
- [ ] Detail page varsa → örnek detail AXTree al → detail config üret
- [ ] Listing + detail config birleşik kaydet

### Step 5: Test & Validate
- [ ] Phase 0'da başarısız olan tüm URL'leri tekrar test et
- [ ] Yeni başarı oranını ölç
- [ ] Hedef: %60+ (eski %29'dan)

---

## 8. Mevcut Altyapı (Aynen Kalıyor)

Yeni yaklaşım mevcut altyapıyı KULLANIR, silmez:

| Bileşen | Durum | Değişecek mi |
|---------|-------|-------------|
| `generated_miners` DB tablosu | ✅ Production | `miner_code` artık JSON config olacak |
| `aiMinerGenerator.js` service | ✅ 800+ satır | Prompt + execution güncellenir, skeleton kalır |
| Admin API (7 endpoint) | ✅ Çalışıyor | Değişmez |
| Pipeline hook (flowOrchestrator) | ✅ Çalışıyor | Değişmez |
| Security scan | ✅ 20 pattern | Config-driven'da daha az risk, ama kalır |
| Output validation | ✅ Çalışıyor | Değişmez |
| HTML sanitization | ⚠️ Çalışıyor | AXTree ile gereksiz olabilir ama fallback olarak kalır |
| Smart truncation | ⚠️ Çalışıyor | AXTree ile gereksiz ama fallback olarak kalır |
| Test CLI | ✅ Çalışıyor | AXTree modunu destekleyecek |

---

## 9. Beklenen Sonuçlar

| Metrik | v1 (Park) | v2 (Hedef) |
|--------|-----------|------------|
| Basit HTML sayfalar | %100 (2/2) | %100 |
| Directory listing | %0 | %60-70 |
| Listing + detail | %0 | %50-60 |
| SPA (rendered) | %0 | %40-50 |
| Genel başarı oranı | %29 (2/7) | **%60+** |
| Token kullanımı | 15-40K per call | **2-5K per call (%90 düşüş)** |
| Maliyet per site | $0.10-0.30 | **$0.01-0.05** |
| Halüsinasyon oranı | Yüksek | **~Sıfır** |
| Self-healing | Yok (tek deneme) | **3-5 iterasyon** |

---

## 10. Dosyalar

| Dosya | Satır | Durum |
|-------|-------|-------|
| `backend/migrations/024_create_generated_miners.sql` | 35 | ✅ Production — değişmez |
| `backend/services/aiMinerGenerator.js` | ~800 | 🔄 Güncellenecek (AXTree + config + REPL) |
| `backend/routes/adminAIMiner.js` | ~150 | ✅ Değişmez |
| `backend/scripts/testAIMinerGenerator.js` | ~50 | 🔄 AXTree modu eklenecek |
| `RFC_v3_AI_Miner_Generator.md` | ~300 | 🔄 v4 olarak güncellenecek |
| `AI_Miner_Generator_Report.md` | Bu dosya | v2 güncel |

---

## 11. Sonuç

AI Miner Generator fikri doğruydu, ilk implementasyon yaklaşımı yanlıştı. 3 bağımsız reviewer (ChatGPT, Gemini, Claude) aynı sonuca ulaştı:

1. **Ham HTML → LLM gürültülü** → AXTree ile çöz
2. **Kod üretimi kırılgan** → Config üretimi ile çöz  
3. **Tek deneme yetersiz** → Self-healing REPL ile çöz

Mevcut 1200 satır altyapı çöpe atılmıyor — üzerine 3 katman ekleniyor. Yeni yaklaşımla aynı URL'lerde %60+ başarı oranı hedefleniyor.

**ASE (Autonomous Sales Engine) için mining %80+ başarı oranına ihtiyaç duyuyor. Bu hedefe 40 miner + AI Miner Generator v2 kombinasyonuyla ulaşılacak.**
