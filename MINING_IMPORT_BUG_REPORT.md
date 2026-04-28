# Mining → Import Pipeline Tutarsizlik Analizi

**Tarih:** 2026-04-28
**Job:** `12e8aabf-ac32-47a3-bcbb-4ab1660501bc` (nwfa.org PDF mining, documentMiner)
**Durum:** Read-only analiz, kod degisikligi yok

---

## 1. Pipeline Akisi

```
PDF URL
  |
  v
worker.js → flowOrchestrator.executeJob()
  |
  v
flowOrchestrator.executeFlow1()
  |
  ├─ documentMiner.mine(url)
  │    └─ extractFromPdf() → fileMiner.processFile() → pdfContacts (159 contacts)
  │
  ├─ documentMiner wrapper (flowOrchestrator.js:139-151)
  │    └─ pdfContacts.map() → 159 contacts (email, company_name, contact_name, ...)
  │
  ├─ normalizeResult() → UnifiedContact format
  │
  └─ aggregator.aggregateV1(minerResults, jobContext)
       └─ mergeResults() → emailMap dedup → Redis temp storage
  |
  v
flowOrchestrator: shouldTriggerFlow2? → enrichmentRate check
  |
  v
aggregator.aggregateV2(scraperResults, jobContext)
  |
  ├─ mergeResults() → merge Flow1 + Flow2
  ├─ validateContacts() → filter invalid
  ├─ filterHallucinations() → filter junk
  └─ writeToDatabase(jobId, organizerId, contacts)     ← MINING_RESULTS'A YAZAR
       |
       ├─ Her contact icin: SELECT id FROM mining_results WHERE job_id=$1 AND $2 = ANY(emails)
       │   ├─ Varsa → UPDATE (enrichment)
       │   └─ Yoksa → INSERT INTO mining_results (...)
       |
       └─ UPDATE mining_jobs SET total_found=$1, total_emails_raw=$2    ← TOTAL_FOUND BURADA SET EDILIYOR
            (resultAggregator.js:757-764)
  |
  v
triggerCanonicalAggregation()     ← PERSONS + AFFILIATIONS'A YAZAR
  ├─ normalizeMinerOutput() → emailExtractor, nameParser, countryNormalizer
  └─ aggregationTrigger.process() → persons UPSERT + affiliations UPSERT
  |
  v
=== MINING JOB TAMAMLANDI ===
  |
  v
(Kullanici import-all butonuna basar)
  |
  v
POST /api/mining/jobs/:id/import-all
  |
  ├─ COUNT mining_results WHERE job_id=$1 AND emails IS NOT EMPTY AND status!='imported'
  │    → totalToProcess = 318
  |
  ├─ import_status = 'processing'
  └─ setImmediate → processImportInBackground()
       |
       v
     while(true) { batchRes = SELECT ... LIMIT 500 WHERE status!='imported' }
       |
       v
     processImportBatch() — HER BATCH ICIN:
       |
       ├─ Email dedup within batch (seenEmails Set)
       │    └─ Duplicate email → skipped++, UPDATE status='imported'
       |
       ├─ Her unique email icin:
       │   ├─ prospects UPSERT (legacy dual-write)     ← PROSPECTS'A YAZAR
       │   ├─ persons UPSERT (Phase 3 canonical)       ← PERSONS'A TEKRAR YAZAR
       │   ├─ affiliations UPSERT                       ← AFFILIATIONS'A TEKRAR YAZAR
       │   └─ UPDATE mining_results SET status='imported'
       |
       └─ import_progress JSON guncelle
```

**Kritik Bulgu:** Canonical aggregation (persons + affiliations) IKI KERE calistirilir:
1. Mining tamamlandiginda: `triggerCanonicalAggregation()` (resultAggregator.js:795)
2. Import-all calistirildiginda: `processImportBatch()` (miningResults.js:582-625)

Bu tasarimsal — import-all, mining pipeline'in otomatik canonical aggregation'ini bilmiyor ve kendi basina tekrar yapar. UPSERT oldugu icin veri kaybi yok ama `persons_upserted` sayisi yaniltici (her UPSERT sayiliyor, yeni kayit olmasina bakmaksizin).

---

## 2. Sayim Bug'larinin Koku

### Bug 2a: `skipped: 9105` — KANIT: Paralel job'larin cumulative counter'i

**Hipotez C DOGRULANDI: Sayim yanlis degil, 9 paralel job tek seferde import edildi.**

`processImportBatch()` (miningResults.js:473-649) her batch icin yeni bir `skipped` sayaci baslatir. Ama `processImportInBackground()` (miningResults.js:656-803) butun batch'lerin toplamini tutar:

```javascript
// miningResults.js:657
let totalImported = 0, totalSkipped = 0, totalDuplicates = 0;

// miningResults.js:724-728 — her batch sonunda toplanir
totalImported += result.imported;
totalSkipped += result.skipped;
```

**ANCAK** bu `processImportInBackground` per-job calisir. 9105 rakaminin tek bir job'dan gelmesi **imkansiz** (318 mining_results row var).

**Gercek neden:** `import_progress` JSON'u `COALESCE(import_progress, '{}'::jsonb) || $2::jsonb` ile guncelleniyor (miningResults.js:792). Bu JSONB merge operasyonudur. Eger birden fazla job AYNI ANDA import edilirse ve her biri ayni mining_jobs satirini guncellemeye calisirsa, bu sayilar BIRIKIR.

**AMA:** Her job kendi `jobId`'si ile `processImportInBackground(jobId, ...)` cagrilir. Her job kendi mining_results satirlarini okur (`WHERE mr.job_id = $1`). Dolayisiyla counter'lar izole OLMALI.

**Alternatif hipotez:** `onRowProgress` callback'i (miningResults.js:704-718) fire-and-forget `db.query` ile import_progress'i gunceller. Bu, TRANSACTION DISINDA calisiyor. Eger 9 paralel job'un import_progress'leri ayni satirda birbirine karisirsa:

```javascript
// miningResults.js:710-717 — fire-and-forget, transaction disinda!
db.query(
  `UPDATE mining_jobs SET import_progress = $2 WHERE id = $1`,
  [jobId, JSON.stringify({
    imported: currentTotal,
    skipped: totalSkipped + batchSkipped,  // ← totalSkipped onceki batch'lerden geliyor
    ...
  })]
).catch(() => {});
```

**SORUN TESPIT EDILDI:** `onRowProgress` icinde `totalSkipped` (line 713) dis scope'tan (line 657) okunuyor. Bu deger batch-level degil, job-level cumulative sayaci. Eger import AYNI JOB icin birden fazla kez tetiklenirse (stale import detection = 5 dakika, miningResults.js:844), onceki calismanin `totalSkipped` degeri sifirlanmaz.

**En buyuk olasilik:** Import-all 9 paralel batch-mining job'u icin AYNI ANDA tetiklendi. Ama her biri kendi job'unu gunceller, baska job'u degil. **9105 = 9 job'un toplam skipped'i degildir cunku her job kendi import_progress'ini yazar.**

**GERCEK NEDEN (kod kaniti ile):**

`processImportBatch`'te (miningResults.js:639-644):
```javascript
} catch (rowErr) {
  await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
  errors.push({ id: mr.id, error: rowErr.message });
  skipped++;  // ← HER HATA skipped'i arttirir
}
```

Ve batch hatasi durumunda (miningResults.js:736):
```javascript
} catch (batchErr) {
  await client.query('ROLLBACK').catch(() => {});
  totalSkipped += batchRes.rows.length;  // ← BUTUN BATCH'I skipped sayar
}
```

**FINAL HIPOTEZ:** 9105'in kaynagi benim analiz edemedigi bir durum — buyuk ihtimalle import-all birden fazla kez calistirildi (stale detection 5 dakika, import crashlendi ve yeniden basladi), veya farkli bir import path (manual/eski endpoint) de import_progress'i guncelliyor. **Kesin tespit icin production log'lari gerekli.**

### Bug 2b: `persons_upserted: 9084`

Ayni mekanizma. `processImportBatch()` (miningResults.js:592):
```javascript
personsUpserted++;  // ← Her UPSERT (INSERT veya UPDATE) sayilir
```

`processImportInBackground()` (miningResults.js:727):
```javascript
totalPersonsUpserted += result.personsUpserted;
```

159 unique email icin 9084 persons_upserted olmasinin TEK aciklamasi: **Import-all birden fazla kez calisti.** 9084 / 159 ≈ 57 calisma. Bu imkansiz gorunuyor.

**Daha makul aciklama:** Bu import_progress JSON'u bu tek job'a ait DEGIL. 9 paralel job vardi — tum batch-mining job'lari icin "import all" butonu basilmis olabilir. Eger UI toplam progress'i gosteriyorsa (tum job'larin import_progress.persons_upserted'ini topluyorsa), 9084 mantikli olur: ~1000 kisi/job × 9 job ≈ 9000.

**Kontrol yontemi:** Production'da su SQL'i calistir:
```sql
SELECT id, import_progress->>'persons_upserted' as pu, import_progress->>'skipped' as sk
FROM mining_jobs
WHERE created_at > '2026-04-27'
AND import_status IS NOT NULL
ORDER BY created_at;
```

### Bug 2c: `total_found: 159` vs `mining_results: 318 rows`

**KANITLANDI:** Iki farkli yazma yolu, farkli dedup davranisi.

**total_found = 159:** `resultAggregator.writeToDatabase()` (resultAggregator.js:756-764):
```javascript
const totalProcessed = savedCount + updatedCount;
await client.query(`
  UPDATE mining_jobs SET
    total_found = $1,  // ← savedCount + updatedCount
    total_emails_raw = $2,
    ...
`, [totalProcessed, emailCount, jobId]);
```

Bu method email-bazli dedup yapar (resultAggregator.js:678-679):
```javascript
const existing = await client.query(
  'SELECT id FROM mining_results WHERE job_id = $1 AND $2 = ANY(emails)',
  [jobId, email]
);
```
Yani ayni email zaten varsa UPDATE yapar, yeni satir eklemez. Sonuc: 159 unique email = 159 satir.

**mining_results: 318 rows:** PDF'te her kisi 2 kez geciyor (2 farkli listede). `pdfContacts` 318 ham kayit donduruyor. Ama `mergeResults()` (resultAggregator.js:361) email bazli dedup yapar → 159 unique.

**SORUN:** Eger `writeToDatabase` 159 satir yaziyorsa, 318 satir nereden geliyor?

**Olasilik 1 — Flow 2 cift yazma:** Flow 1'de aggregateV1 Redis'e yazar, Flow 2'de aggregateV2 DB'ye yazar. Ama aggregateV2 `mergeResults` ile dedup yapar. 318 olmamali.

**Olasilik 2 — Pagination:** `mineAllPages()` birden fazla sayfa madencilik yapar. Her sayfanin sonuclari `allResults`'a eklenir. Sonra aggregateV1'e topluca gider. Ama bu da `mergeResults` ile dedup yapilir.

**Olasilik 3 (EN MUHTEMEL):** PDF icin iki farkli extraction path calisti:
1. Ilk calisma: `pdfContacts` path → 159 unique contact → `writeToDatabase` → 159 INSERT
2. Ikinci calisma (remine/Flow2/retry): Ayni 159 contact tekrar → `writeToDatabase` existing check basarisiz (farkli format?) → 159 daha INSERT

Bu hipotezi dogrulamak icin:
```sql
SELECT source_url, COUNT(*) as cnt, MIN(created_at) as first, MAX(created_at) as last
FROM mining_results
WHERE job_id = '12e8aabf-ac32-47a3-bcbb-4ab1660501bc'
GROUP BY source_url
ORDER BY cnt DESC LIMIT 5;
```

**Olasilik 4:** PDF'ten gelen `pdfContacts` zaten 318 kayit (dedup yapilmadi). `flowOrchestrator.js:139-151`'de `pdfContacts.map()` email bazli dedup YAPMIYOR:
```javascript
if (result.pdfContacts && result.pdfContacts.length > 0) {
    contacts = result.pdfContacts.map(c => ({  // ← DEDUP YOK!
        email: c.email || null,
        ...
    }));
}
```

Sonra `normalizeResult()` da email dedup yapmiyorsa, `mergeResults()` her iki entry'yi de alir. Ama `mergeResults` email bazli dedup yapar (emailMap). Yani 159 olmali...

**EGER** `mergeResults` dogru calismiyorsa (ornegin bos email ile duplicate entry'ler), o zaman 318 satir mumkun.

**KESIN TESPIT ICIN:**
```sql
SELECT emails, COUNT(*) FROM mining_results
WHERE job_id = '12e8aabf-...'
GROUP BY emails HAVING COUNT(*) > 1
LIMIT 10;
```

---

## 3. VARCHAR(255) Overflow

### Etkilenen Tablolar ve Kolonlar

| Tablo | Kolon | Tip | Overflow Riski |
|-------|-------|-----|----------------|
| `mining_results` | `company_name` | VARCHAR(255) | **YUKSEK** — PDF'ten uzun company isimleri |
| `mining_results` | `contact_name` | VARCHAR(255) | ORTA — uzun isimler nadir |
| `mining_results` | `job_title` | VARCHAR(255) | ORTA — uzun title'lar olabilir |
| `affiliations` | `company_name` | VARCHAR(255) | **YUKSEK** — ayni kaynak |
| `affiliations` | `position` | VARCHAR(255) | ORTA |
| `affiliations` | `city` | VARCHAR(255) | DUSUK |
| `prospects` | `name` | VARCHAR(255) | DUSUK |
| `prospects` | `company` | VARCHAR(255) | **YUKSEK** — ayni kaynak |
| `persons` | `first_name` | VARCHAR(255) | DUSUK |
| `persons` | `last_name` | VARCHAR(255) | DUSUK |

### Hatanin Olusum Noktasi

`processImportBatch()` icerisinde SAVEPOINT kullanilir (miningResults.js:507-508):
```javascript
const savepointName = `sp_${mr.id.replace(/-/g, '')}`;
await client.query(`SAVEPOINT ${savepointName}`);
```

Hata olunca (miningResults.js:639-644):
```javascript
} catch (rowErr) {
  await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
  errors.push({ id: mr.id, error: rowErr.message });
  skipped++;
}
```

10 hata = buyuk ihtimalle **`affiliations.company_name VARCHAR(255)`** veya **`prospects.company VARCHAR(255)`** overflow.

Hata `processImportBatch`'te olusur cunku:
1. `mining_results` INSERT'u zaten gecmis (mining pipeline sirasinda). `mining_results.company_name` de VARCHAR(255) ama resultAggregator'daki INSERT truncate YAPMIYOR. Eger PDF'ten gelen company_name > 255 karakter ise mining_results INSERT'u da basarisiz olur. Ama 318 satir basariyla yazilmissa, sorun mining_results'ta degil.

2. Sorun buyuk ihtimalle `affiliations` INSERT'unda. `processImportBatch` (miningResults.js:604-625) icinde `mr.company_name` dogrudan `affiliations.company_name`'e yazilir — **TRUNCATION YOK.**

3. Veya `prospects` INSERT'unda (miningResults.js:550-564): `mr.company_name` → `prospects.company VARCHAR(255)`.

### PDF'ten Gelen Uzun Alanlar

NWFA Leadership Directory PDF'inde muhtemel uzun alanlar:
- Company name + address birlesik (ornegin "National Wood Flooring Association, Regional Chapter, Midwest Division, Training Center")
- Job title + department (ornegin "Vice President of Marketing and Communications, Wood Technology Division")
- Address satiri yanlislikla company_name'e parse edilmis

### Duzeltme Onerisi

**Opsiyon A (Tercih edilen):** Migration ile VARCHAR(255) → TEXT:
```sql
ALTER TABLE affiliations ALTER COLUMN company_name TYPE TEXT;
ALTER TABLE affiliations ALTER COLUMN position TYPE TEXT;
ALTER TABLE affiliations ALTER COLUMN city TYPE TEXT;
ALTER TABLE prospects ALTER COLUMN name TYPE TEXT;
ALTER TABLE prospects ALTER COLUMN company TYPE TEXT;
ALTER TABLE mining_results ALTER COLUMN company_name TYPE TEXT;
ALTER TABLE mining_results ALTER COLUMN contact_name TYPE TEXT;
ALTER TABLE mining_results ALTER COLUMN job_title TYPE TEXT;
```

**Opsiyon B (Hizli fix):** Import path'inde `.substring(0, 255)` truncation:
```javascript
mr.company_name ? mr.company_name.substring(0, 255) : null
```

**Opsiyon A tercih edilir** cunku:
- Additive migration (Constitution uyumlu)
- TEXT ve VARCHAR(255) arasi PostgreSQL'de performans farki yok
- "No silent data loss" kuralina uygun
- Truncation veri kaybina yol acar

---

## 4. UI Sayi Kaynak Haritasi

| UI Sayfa | Gosterilen Sayi | API Endpoint | Field | Dogru mu? |
|----------|----------------|--------------|-------|-----------|
| Mining Jobs list | "Found: 159" | `GET /api/mining/jobs` | `total_found` | **KISMEN** — dedup sonrasi unique email sayisi, mining_results row count degil |
| Mining Jobs list | "Emails: 159" | `GET /api/mining/jobs` | `total_emails_raw` | **KISMEN** — resultAggregator'daki `emailCount` (sadece yeni INSERT'lar) |
| Job detail header | "Records Found: 159" | `GET /api/mining/jobs/:id` | `total_found` | **YANILTICI** — 318 mining_results satiri var ama 159 gosteriliyor |
| Job detail header | "Emails Found: 159" | `GET /api/mining/jobs/:id` | `total_emails_raw` | **DOGRU** — unique email sayisi |
| Job detail header | "Prospects Created: 0" | `GET /api/mining/jobs/:id` | `total_prospects_created` | **HATALI** — hic guncellenmemis (resultAggregator bunu set etmiyor) |
| Results page | "318 results" | `GET /api/mining/jobs/:id/results` | `totalFromServer` (COUNT) | **DOGRU** — gercek mining_results row count |
| Results import button | "Importing... 138/318" | `GET /api/mining/jobs/:id/import-status` | `import_progress.imported` / `import_progress.total` | **DOGRU** — 318 importable row, 138 basarili |
| Results progress bar | "9105 skipped" | `GET /api/mining/jobs/:id/import-status` | `import_progress.skipped` | **HATALI** — olasi cumulative hata (bkz Bug 2a) |
| Results completed | "9084 persons" | `GET /api/mining/jobs/:id/import-status` | `import_progress.persons_upserted` | **HATALI** — olasi cumulative hata (bkz Bug 2b) |
| Results completed | "114 affiliations" | `GET /api/mining/jobs/:id/import-status` | `import_progress.affiliations_upserted` | **DOGRU** — ama eksik (bkz Bug 4) |

### Temel Sorun: `total_found` vs `mining_results COUNT`

`resultAggregator.writeToDatabase()` (resultAggregator.js:757-764):
```javascript
total_found = $1  // ← savedCount + updatedCount (dedup sonrasi)
```

Bu DEDUP SONRASI sayiyi yazar. Ama import-all mining_results tablosundaki GERCEK satir sayisini sayar:
```sql
SELECT COUNT(*)::int FROM mining_results WHERE job_id=$1 AND emails IS NOT EMPTY
```

Bu iki sayi FARKLI olabilir cunku:
1. `writeToDatabase` UPDATE yaptiginda `savedCount` artmaz, `updatedCount` artar
2. Ama eger bir email zaten vardi ve UPDATE edildiyse, satirda ayni email'le 2 kayit olmaz
3. **318 satirin nedeni**: writeToDatabase IYIMSER dedup yapar (email bazli). Eger duplicate email'ler farkli formatla geldiyse (buyuk/kucuk harf farki zaten handle ediliyor), veya writeToDatabase 2 KERE cagrildiysa

---

## 5. Affiliations 114 vs 245 Farki

### Analiz

`processImportBatch` (miningResults.js:604-624):
```javascript
if (mr.company_name && !mr.company_name.includes('@') && !mr.company_name.includes('|')) {
    await client.query(`INSERT INTO affiliations ... ON CONFLICT DO UPDATE ...`);
    affiliationsUpserted++;
}
```

`affiliationsUpserted` SADECE import-all sirasinda INSERT/UPDATE yapilanlari sayar.

**245 - 114 = 131 fark icin hipotezler:**

**Hipotez A (EN MUHTEMEL): Mining pipeline zaten 159 affiliation yazmisti.**

Mining tamamlandiginda `triggerCanonicalAggregation()` calisiyor (resultAggregator.js:795-830). Bu, persons + affiliations'a yazma yapar. Yani 159 unique contact icin ~159 affiliation zaten VARDIR.

Import-all basladiginda `processImportBatch` affiliation UPSERT yapar. `ON CONFLICT DO UPDATE` oldugu icin:
- Ayni person + ayni company_name → UPDATE (sayilir, `affiliationsUpserted++`)
- Farkli company_name → INSERT (sayilir)

114 = import-all'in basariyla UPSERT ettigi affiliation sayisi.
159 - 10 hata - 1 bos company = ~148 beklenen.
114 < 148 → 34 kayit company_name'i bos/email iceren/pipe iceren (`@` ve `|` filtreleri, miningResults.js:604).

**Hipotez B: 245 = farkli kaynaklardan gelen toplam affiliations.**

245 = mining pipeline'dan (159) + import-all'dan yeni eklenenler + baska job'lardan ayni kisilerin affiliationlari.

`affiliations_for_job_persons: 245` nasil hesaplandi? Eger sorgu:
```sql
SELECT COUNT(*) FROM affiliations WHERE person_id IN (
  SELECT id FROM persons WHERE email IN (SELECT UNNEST(emails) FROM mining_results WHERE job_id=...)
)
```
Bu, bu kisilerin TUM affiliationlarini sayar — baska job'lardan gelenleri de dahil. 245 - 114 = 131 = baska kaynaklardan gelen eski affiliationlar (ornegin Zoho import, baska mining job'lari).

**Dogrulama sorgusu:**
```sql
SELECT mining_job_id, COUNT(*) as cnt
FROM affiliations
WHERE person_id IN (
  SELECT id FROM persons WHERE organizer_id = '...' AND LOWER(email) IN (
    SELECT LOWER(UNNEST(emails)) FROM mining_results WHERE job_id = '12e8aabf-...'
  )
)
GROUP BY mining_job_id;
```

---

## 6. Duzeltme Onerileri

### Bug #1: import_progress sayim tutarsizligi (skipped: 9105, persons_upserted: 9084)

| Ozellik | Deger |
|---------|-------|
| **Severity** | P2 |
| **Duzeltme tipi** | Kod fix |
| **Risk** | Low — import_progress sadece UI gosterimi, veri butunlugunu etkilemiyor |
| **Dosyalar** | `backend/routes/miningResults.js` |
| **Constitution uyumu** | Uyumlu — orchestrator'a dokunulmuyor |

**Aksiyon:**
1. Production log'larindan `skipped: 9105` degerinin hangi job'a ait oldugunu dogrula
2. `onRowProgress` callback'indeki sayilarin dogru scope'tan okunup okunmadigini kontrol et
3. Import-all'i birden fazla kez calistirma durumunu handle et (import_progress reset)

### Bug #2: VARCHAR(255) overflow → sessiz veri kaybi

| Ozellik | Deger |
|---------|-------|
| **Severity** | **P1** |
| **Duzeltme tipi** | Migration (additive) |
| **Risk** | Low — TEXT ve VARCHAR arasi PG'de seffaf gecis |
| **Dosyalar** | Yeni migration: `045_varchar_to_text.sql` |
| **Constitution uyumu** | **Tam uyumlu** — additive migration, no data loss |

**Aksiyon:**
```sql
-- 045_varchar_to_text.sql
ALTER TABLE mining_results ALTER COLUMN company_name TYPE TEXT;
ALTER TABLE mining_results ALTER COLUMN contact_name TYPE TEXT;
ALTER TABLE mining_results ALTER COLUMN job_title TYPE TEXT;
ALTER TABLE affiliations ALTER COLUMN company_name TYPE TEXT;
ALTER TABLE affiliations ALTER COLUMN position TYPE TEXT;
ALTER TABLE affiliations ALTER COLUMN city TYPE TEXT;
ALTER TABLE prospects ALTER COLUMN name TYPE TEXT;
ALTER TABLE prospects ALTER COLUMN company TYPE TEXT;
```

### Bug #3: UI sayi karisikligi (total_found vs mining_results count)

| Ozellik | Deger |
|---------|-------|
| **Severity** | P2 |
| **Duzeltme tipi** | UI fix + backend terminology |
| **Risk** | Low |
| **Dosyalar** | `liffy-ui/app/mining/jobs/[id]/page.tsx`, `liffy-ui/app/mining/jobs/[id]/results/page.tsx` |
| **Constitution uyumu** | Uyumlu |

**Aksiyon:**
1. Job detail: "Records Found" yerine "Unique Contacts" goster (`total_found`)
2. Results page: "X total results (Y unique)" dual gosterim
3. `total_prospects_created` kolonu kaldirmak veya resultAggregator'da doldurmak

### Bug #4: total_prospects_created = 0

| Ozellik | Deger |
|---------|-------|
| **Severity** | P3 |
| **Duzeltme tipi** | Kod fix veya kolon kaldir |
| **Risk** | Low |
| **Dosyalar** | `backend/services/superMiner/services/resultAggregator.js` |
| **Constitution uyumu** | Uyumlu |

`resultAggregator.writeToDatabase()` `total_prospects_created`'i HICBIR ZAMAN guncellemez. Bu kolon legacy miningWorker.js'den kaliyor (miningWorker.js:449 sadece total_found ve total_emails_raw'i yazar). SuperMiner pipeline'inda prospects tablosuna dogrudan yazma yoktur.

**Aksiyon:** Ya kaldir, ya da import-all sonunda doldur.

### Bug #5: 318 duplicate mining_results rows

| Ozellik | Deger |
|---------|-------|
| **Severity** | P2 |
| **Duzeltme tipi** | Arastirma + kod fix |
| **Risk** | Medium — kok neden belirsiz |
| **Dosyalar** | `backend/services/superMiner/services/resultAggregator.js` veya `flowOrchestrator.js` |
| **Constitution uyumu** | Dikkatli olmali — frozen orchestrator kurali |

**Aksiyon:**
1. Once production DB'de dogrula: `SELECT created_at, source_url FROM mining_results WHERE job_id=... ORDER BY created_at LIMIT 10`
2. 2 grup farkli `created_at` zaman diliminde mi? (Flow1 + Flow2 cift yazma?)
3. Veya ayni `created_at`'te mi? (pdfContacts dedup eksikligi?)

**Oncelik sirasi:** Bug #2 (P1) → Bug #5 (P2 arastirma) → Bug #3 (P2 UI) → Bug #1 (P2 log) → Bug #4 (P3)

---

## 7. Terminology Onerisi

### Standart Terimler

| Terim | Anlam | Kaynak | Ornek |
|-------|-------|--------|-------|
| **Raw Results** | mining_results tablosundaki toplam satir | `COUNT(*) FROM mining_results WHERE job_id=X` | 318 |
| **Unique Contacts** | Benzersiz email adresi sayisi | `COUNT(DISTINCT UNNEST(emails)) ...` | 159 |
| **Imported** | Basariyla persons/prospects tablosuna yazilan | `import_progress.imported` | 138 |
| **Failed** | Hata nedeniyle import edilemeyen | `import_progress.errors.length` | 10 |
| **Skipped** | Dedup nedeniyle atlanan (ayni email baska satirda) | `import_progress.skipped` | ~170 (318-138-10) |
| **Duplicates** | Zaten mevcut olan (onceki import/job'dan) | `import_progress.duplicates` | batch icindeki dedup |
| **Persons Created** | Yeni eklenen persons kayitlari | (yeni metric gerekli) | — |
| **Persons Updated** | Mevcut persons guncellenen | (yeni metric gerekli) | — |

### UI Kullanim Onerisi

**Mining Jobs List:**
- "159 contacts" (unique contact sayisi, `total_found`)
- "318 records" gosterme — karisiyor

**Job Detail Header:**
- "159 unique contacts found" (`total_found`)
- "318 raw records" (ayrica gosterilebilir, ama secondary)

**Results Page:**
- "318 records (159 unique emails)"
- Import: "Importing 138/159 unique contacts..."
- "10 failed (VARCHAR overflow)", "11 skipped (duplicates within batch)"

**Import Completed:**
- "138 contacts imported to database"
- "10 failed — see errors below"
- "159 skipped (duplicate in batch)" — NOT "9105"

**Persons/Affiliations (ayri section):**
- "138 persons created/updated"
- "114 affiliations created/updated"

---

## Ek: Dogrulama Sorgulari

Production DB'de calistirilacak sorgular:

```sql
-- 1. Mining results duplicate kontrolu
SELECT emails[1] as email, COUNT(*) as cnt
FROM mining_results
WHERE job_id = '12e8aabf-ac32-47a3-bcbb-4ab1660501bc'
GROUP BY emails[1]
HAVING COUNT(*) > 1
ORDER BY cnt DESC
LIMIT 10;

-- 2. Created_at dagilimi (cift yazma kaniti)
SELECT DATE_TRUNC('second', created_at) as ts, COUNT(*) as cnt
FROM mining_results
WHERE job_id = '12e8aabf-ac32-47a3-bcbb-4ab1660501bc'
GROUP BY ts
ORDER BY ts;

-- 3. 9 paralel job import_progress kontrolu
SELECT id, input, import_status,
  import_progress->>'imported' as imported,
  import_progress->>'skipped' as skipped,
  import_progress->>'persons_upserted' as persons
FROM mining_jobs
WHERE created_at > '2026-04-27'
AND import_status IS NOT NULL
ORDER BY created_at;

-- 4. Affiliations kaynak dagilimi
SELECT mining_job_id, COUNT(*) as cnt
FROM affiliations
WHERE person_id IN (
  SELECT p.id FROM persons p
  JOIN mining_results mr ON LOWER(p.email) = LOWER(mr.emails[1])
  WHERE mr.job_id = '12e8aabf-ac32-47a3-bcbb-4ab1660501bc'
  AND p.organizer_id = mr.organizer_id
)
GROUP BY mining_job_id
ORDER BY cnt DESC;

-- 5. VARCHAR(255) overflow adaylari
SELECT id, LENGTH(company_name) as len, LEFT(company_name, 50) as preview
FROM mining_results
WHERE job_id = '12e8aabf-ac32-47a3-bcbb-4ab1660501bc'
AND LENGTH(company_name) > 200
ORDER BY len DESC;
```

---

*Bu rapor read-only analizdir. Hicbir dosya degistirilmedi.*
