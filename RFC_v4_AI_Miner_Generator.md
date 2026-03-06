# RFC v4: AI Miner Generator — AXTree + Config-Driven + Self-Healing

> **Status:** AKTİF GELİŞTİRME
> **Tarih:** 2025-03-06 (v4 — yeni yaklaşım)
> **Önceki:** v1-v3 park edildi (%29 başarı). v4 = tamamen farklı mimari.
> **Reviewer consensus:** ChatGPT + Gemini + Claude → 3 temel değişiklik gerekli

---

## Neden v4?

v1-v3: Claude'a 100KB raw HTML gönder → 200 satır JS üretsin → tek denemede başarsın
Sonuç: %29 başarı, park edildi.

v4: Claude'a 2-5KB AXTree YAML gönder → 10 satır JSON config üretsin → 3-5 iterasyonla düzeltsin
Hedef: %60+ başarı.

---

## 3 Temel Değişiklik

### 1. AXTree (Accessibility Tree) — HTML yerine
```
ESKİ: 100KB raw HTML → Claude → uydurma CSS selector
YENİ: 2-5KB AXTree YAML → Claude → semantik role/name selector
```

### 2. Config-Driven — Kod üretimi yerine
```
ESKİ: Claude 200 satır JavaScript üretir → kırılgan, güvenlik riski
YENİ: Claude 10 satır JSON config üretir → sabit template çalıştırır → stabil, güvenli
```

### 3. Self-Healing REPL — Tek deneme yerine
```
ESKİ: üret → çalıştır → 0 sonuç → BİTTİ
YENİ: üret → çalıştır → hata → güncel AXTree + hata gönder → düzelt → tekrar (max 5)
```

---

## Pipeline

```
URL
  │
  ▼
Playwright render + ariaSnapshot() → AXTree YAML (2-5KB)
  │
  ▼
Claude API: "Bu AXTree'de tekrar eden entity blokları bul"
  │
  ├─ Email var mı AXTree'de?
  │   ├─ Evet → Single-page config üret
  │   └─ Hayır → Multi-step config üret (listing + detail)
  │
  ▼
JSON Config döner:
  {
    type: "directory",
    listing: { entity: "listitem", name: "heading[3]", detail_link: "link 'Profile'" },
    detail: { email: "link[mailto]", phone: "link[tel]" },
    pagination: { next: "link 'Next'" }
  }
  │
  ▼
GenericExtractor template config ile çalıştırır
  │
  ├─ Başarılı → DB'ye kaydet → reuse
  │
  └─ Başarısız → Self-Healing Loop:
      ├─ Hata + güncel AXTree → Claude'a gönder
      ├─ Claude config düzeltir
      ├─ Template tekrar çalıştır
      └─ Max 3-5 iterasyon
```

---

## Implementation Steps

### Step 1: AXTree Integration
**Dosya:** `aiMinerGenerator.js`

```javascript
async getPageAXTree(url) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000); // SPA render
  
  // AXTree snapshot
  const snapshot = await page.locator('body').ariaSnapshot();
  
  await browser.close();
  return snapshot; // YAML string, 2-5KB
}
```

**Prompt güncelleme:**
```
ESKİ system prompt: "HTML analiz et, JavaScript extraction kodu yaz"
YENİ system prompt: "ARIA Accessibility Tree YAML analiz et, JSON selector config üret"
```

### Step 2: Config-Driven Templates

**Yeni dosya:** `backend/services/genericExtractor.js`

```javascript
class GenericExtractor {
  
  // Config-driven listing extraction
  async extractListing(page, config) {
    // config.listing.entity → page.getByRole() ile bul
    // config.listing.name → her entity içinde name çıkar
    // config.listing.detail_link → detail URL çıkar
    // Sabit kod, değişen sadece config
  }
  
  // Config-driven detail extraction  
  async extractDetail(page, config) {
    // config.detail.email → page.getByRole('link') + mailto filter
    // config.detail.phone → page.getByRole('link') + tel filter
    // Sabit kod, değişen sadece config
  }
  
  // Config-driven table extraction
  async extractTable(page, config) {
    // config.table.header_row → header mapping
    // config.table.data_rows → data extraction
  }
}
```

### Step 3: Self-Healing REPL Loop

```javascript
async generateWithHealing(url, maxIterations = 3) {
  let currentAXTree = await this.getPageAXTree(url);
  let currentConfig = null;
  let lastError = null;
  
  for (let i = 1; i <= maxIterations; i++) {
    console.log(`[AIMinerGen] Iteration ${i}/${maxIterations}`);
    
    // Claude'a gönder (ilk veya düzeltme)
    currentConfig = await this.callClaudeForConfig(currentAXTree, {
      previousConfig: currentConfig,
      previousError: lastError,
      iteration: i
    });
    
    // Template ile çalıştır
    const result = await this.executeWithTemplate(url, currentConfig);
    
    // Validate
    const validation = this.validateResults(result.contacts);
    
    if (validation.valid) {
      // BAŞARILI — kaydet
      await this.saveMiner({ url, config: currentConfig, testResult: validation.stats });
      return { success: true, contacts: result.contacts, iterations: i };
    }
    
    // Başarısız — feedback hazırla
    lastError = {
      reason: validation.reason,
      stats: validation.stats,
      foundElements: result.debugInfo, // hangi selector'lar kaç element buldu
      currentAXTree: await this.getPageAXTree(url) // güncel AXTree (sayfa değişmiş olabilir)
    };
    
    console.log(`[AIMinerGen] Iteration ${i} failed: ${validation.reason}. Retrying...`);
  }
  
  return { success: false, error: `Failed after ${maxIterations} iterations`, lastConfig: currentConfig };
}
```

### Step 4: Multi-Step (Listing + Detail)

```javascript
// Config'de detail varsa:
if (config.detail && config.listing.detail_link) {
  // 1. Listing'den company + detail URL topla
  const listings = await extractor.extractListing(page, config);
  
  // 2. İlk detail sayfanın AXTree'sini al
  const detailAXTree = await this.getPageAXTree(listings[0].detail_url);
  
  // 3. Detail config üret (veya config'de zaten varsa kullan)
  if (!config.detail.email) {
    const detailConfig = await this.callClaudeForDetailConfig(detailAXTree);
    config.detail = detailConfig;
  }
  
  // 4. Tüm detail page'leri crawl et
  for (const listing of listings) {
    const detail = await extractor.extractDetail(detailPage, config);
    // merge listing + detail
  }
}
```

---

## Mevcut Altyapı Kullanımı

| Bileşen | Kullanılıyor mu | Değişiklik |
|---------|----------------|------------|
| `generated_miners` DB | ✅ | `miner_code` → JSON config olarak kaydedilir |
| Admin API (7 endpoint) | ✅ | Değişmez |
| Pipeline hook | ✅ | Değişmez |
| Security scan | ✅ | Config-driven'da da çalışır (template kodu sabit) |
| Output validation | ✅ | Değişmez |
| Test CLI | ✅ | AXTree modu eklenir |

---

## Beklenen İyileşme

| Metrik | v1-v3 | v4 Hedef |
|--------|-------|----------|
| Token per call | 15-40K | 2-5K (%90↓) |
| Maliyet per site | $0.10-0.30 | $0.01-0.05 |
| Halüsinasyon | Yüksek | ~Sıfır |
| Basit HTML | %100 | %100 |
| Directory listing | %0 | %60-70 |
| Listing + detail | %0 | %50-60 |
| SPA rendered | %0 | %40-50 |
| **Genel başarı** | **%29** | **%60+** |

---

## Test Planı

v1'de başarısız olan URL'ler ile test:
1. `valveworldexpo.com/vis/v1/en/directory/a` — SPA directory
2. `ghanabusinessweb.com` — listing + detail
3. `mining-technology.com/buyers-guide/` — buyers guide + detail
4. `glmis.gov.gh/employmentagencies/Domestic?page=1` — regression test (çalışmalı)

Yeni URL'ler:
5. Herhangi bir fuar exhibitor listesi
6. Herhangi bir dernek üye listesi

Hedef: 6 URL'den 4+ başarılı (%66+)

---

## Gerçek Test Sonuçları

### v2 Step 1 Testleri (6 Mart 2025)

| URL | Hedef | Sonuç |
|-----|-------|-------|
| glmis.gov.gh/Domestic | Regression (v1'de çalışıyordu) | ✅ 11 contact, 3555 token — v1'den daha iyi |
| valveworldexpo.com | SPA directory | ❌ name_role null — container mode iyileştirmesi gerekli |
| ghanabusinessweb.com | Listing + detail | ❌ Yanlış detail URL'ler — link filtering gerekli |

### Kalan İyileştirmeler
- Container mode'da name extraction (listitem içinde heading/text bul)
- Detail link filtering (blog/homepage URL'leri filtrele, sadece profil/company URL'leri al)
- Daha fazla site testi (20 URL hedefi)
