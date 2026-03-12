# Liffy Miner Issues Log

## Format
Her kayıt:
- URL
- Miner(ler) denendi
- Sorun
- Çözüm / Durum
- Tarih

---

## Log

### batimat.com
- URL: https://www.batimat.com/en-gb/who-is-coming/exhibitors-list.html#/
- Miner: reedExpoMiner
- Sorun: 1037/1519 org için GraphQL "not_found" — bu org'lar API'de kayıtlı değil
- Çözüm: Beklenen davranış, düzeltme yok. reedExpoMailtoMiner fallback eklendi
- Email rate: %28 (430/1519)
- Tarih: 2026-03-12

### nashel.ru
- URL: https://nashel.ru/cn/info/sttexpo/
- Miner: playwrightTableMiner
- Sorun: 1153 email buldu ama company/contact kolonları boş — column-aware parse yoktu
- Çözüm: playwrightTableMiner'a column-aware parse eklendi (Çince/çok dilli header desteği)
- Tarih: 2026-03-12

### avrasyapencerekapifuari.com
- URL: https://www.avrasyapencerekapifuari.com/katilimci-listesi
- Miner: Tümü
- Sorun: Cloudflare engeli, sadece site iletişim emaili bulundu
- Çözüm: PENDING — Chrome DevTools API araştırması veya Scrape.do
- Tarih: 2026-03-11
