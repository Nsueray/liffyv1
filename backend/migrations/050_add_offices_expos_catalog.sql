-- 050_add_offices_expos_catalog.sql
-- Quote/Catalog altyapisi Faz 0: offices, expos, products, product_prices, exchange_rates tablolari.
-- users.office_id eklenir. Quote tablolari henuz YOK — bu migration sadece referans verilerini kurar.
--
-- Konvansiyonlar (046_create_companies referans):
--   PK: UUID DEFAULT gen_random_uuid()
--   Tenant: organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE
--   Audit: created_at/updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_by_user_id UUID
--   FK ownership: REFERENCES users(id) ON DELETE SET NULL
--   Index: idx_{table}_{column}
--   Idempotent: IF NOT EXISTS her yerde, trigger'lar DROP IF EXISTS + CREATE
--
-- Bagimllik sirasi: offices -> users (ALTER) -> expos -> products -> product_prices -> exchange_rates
-- Hepsi bagimsiz tablolar (birbirine FK yok, product_prices haric).

BEGIN;

-- ============================================================
-- 1) OFFICES — Elan Expo ofis/ulke tanimlari
-- ============================================================
-- code = ISO 3166-1 alpha-2, AF-number prefix'i (Q{code}-) buradan gelir.
-- Tenant-bagimsiz: tum organizer'lar ayni ofis setini gorur (organizer_id YOK).
CREATE TABLE IF NOT EXISTS offices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code CHAR(2) NOT NULL,
    name TEXT NOT NULL,
    default_currency CHAR(3),  -- NULL = henuz belirlenmedi (TR icin Suer secer: EUR/USD)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_offices_code UNIQUE (code)
);

CREATE INDEX IF NOT EXISTS idx_offices_code ON offices(code);

-- Trigger: auto-update updated_at
CREATE OR REPLACE FUNCTION update_offices_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_offices_updated_at ON offices;
CREATE TRIGGER trg_offices_updated_at
    BEFORE UPDATE ON offices
    FOR EACH ROW
    EXECUTE FUNCTION update_offices_updated_at();

-- SEED: bilinen ofisler
-- TR default_currency = NULL: Suer EUR veya USD sececek (HQ icin iki para birimi de kullaniliyor).
INSERT INTO offices (code, name, default_currency) VALUES
    ('TR', 'Turkey / HQ',  NULL),
    ('NG', 'Nigeria',       'NGN'),
    ('MA', 'Morocco',       'MAD'),
    ('KE', 'Kenya',         'KES'),
    ('CN', 'China',         'CNY'),
    ('DZ', 'Algeria',       'DZD'),
    ('GH', 'Ghana',         'GHS')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- 2) USERS: office_id kolonu
-- ============================================================
-- Mevcut 13 kolon; office_id cakismasi yok (dogrulandi).
-- NULL = henuz atanmamis. Suer manuel atar.
ALTER TABLE users ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES offices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_office ON users(office_id) WHERE office_id IS NOT NULL;

-- ============================================================
-- 3) EXPOS — Fuar/etkinlik tanimlari
-- ============================================================
-- organizer_id = tenant scope (her organizer kendi fuar setini yonetir).
-- canonical_expo_id = ileride LEENA/ELIZA entegrasyonu icin hazirlik (FK YOK, sadece UUID referansi).
-- payment_deadline = odeme son tarihi (subject ve validity period hesabi icin).
CREATE TABLE IF NOT EXISTS expos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,

    name TEXT NOT NULL,
    country_code CHAR(2),       -- fuarin yapildigi ulke (ISO 3166-1 alpha-2)
    city TEXT,
    start_date DATE,
    end_date DATE,
    payment_deadline DATE,      -- odeme son tarihi (quote validity'ye baglanir)
    default_currency CHAR(3),   -- bu fuar icin varsayilan para birimi (NULL = ofis default'u kullanilir)

    canonical_expo_id UUID,     -- ileride LEENA/ELIZA expos.id ile eslesme (FK YOK — cross-system soft ref)

    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    -- Ownership
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expos_organizer ON expos(organizer_id);
CREATE INDEX IF NOT EXISTS idx_expos_country ON expos(country_code);
CREATE INDEX IF NOT EXISTS idx_expos_active ON expos(organizer_id) WHERE is_active = TRUE;

-- Trigger: auto-update updated_at
CREATE OR REPLACE FUNCTION update_expos_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_expos_updated_at ON expos;
CREATE TRIGGER trg_expos_updated_at
    BEFORE UPDATE ON expos
    FOR EACH ROW
    EXECUTE FUNCTION update_expos_updated_at();

COMMENT ON TABLE expos IS 'Expo/fair definitions per organizer. Payment deadline drives quote validity. canonical_expo_id is a soft ref to LEENA/ELIZA (no FK).';
COMMENT ON COLUMN expos.canonical_expo_id IS 'Soft reference to LEENA/ELIZA expos table. No FK constraint — cross-system integration key.';
COMMENT ON COLUMN expos.payment_deadline IS 'Payment deadline date. Quote subject line and validity period derive from this.';

-- ============================================================
-- 4) PRODUCTS — Urun/hizmet katalogu
-- ============================================================
-- organizer_id = tenant scope.
-- code = organizer icinde benzersiz urun kodu (ornek: "STAND-RAW", "ELECTRICITY-KW").
-- unit_type: 'm2' (metrekare bazli) veya 'unit' (adet bazli).
-- SEED YOK — 242 urun sonra import edilecek.
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,

    code TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT,              -- serbest gruplama (ornek: "Stand", "Services", "Sponsorship")
    unit_type TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,

    -- Ownership
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_products_unit_type CHECK (unit_type IN ('m2', 'unit')),
    CONSTRAINT uq_products_organizer_code UNIQUE (organizer_id, code)
);

CREATE INDEX IF NOT EXISTS idx_products_organizer ON products(organizer_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(organizer_id, category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_active ON products(organizer_id) WHERE is_active = TRUE;

-- Trigger: auto-update updated_at
CREATE OR REPLACE FUNCTION update_products_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
CREATE TRIGGER trg_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW
    EXECUTE FUNCTION update_products_updated_at();

COMMENT ON TABLE products IS 'Product/service catalog per organizer. code is unique per organizer. unit_type determines pricing model (m2 vs unit).';

-- ============================================================
-- 5) PRODUCT_PRICES — Ofis bazli urun fiyatlari
-- ============================================================
-- Her urun her ofiste farkli para birimi ve fiyata sahip olabilir.
-- UNIQUE(product_id, office_id): bir urunun bir ofiste tek fiyati olur.
-- SEED YOK — Suer girer.
CREATE TABLE IF NOT EXISTS product_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,

    currency CHAR(3) NOT NULL,         -- ISO 4217 (EUR, USD, NGN, etc.)
    unit_price NUMERIC NOT NULL,       -- birim fiyat (m2 basina veya adet basina)

    -- Ownership
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_product_prices_unit_price_nonneg CHECK (unit_price >= 0),
    CONSTRAINT uq_product_prices_product_office UNIQUE (product_id, office_id)
);

CREATE INDEX IF NOT EXISTS idx_product_prices_product ON product_prices(product_id);
CREATE INDEX IF NOT EXISTS idx_product_prices_office ON product_prices(office_id);

-- Trigger: auto-update updated_at
CREATE OR REPLACE FUNCTION update_product_prices_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_product_prices_updated_at ON product_prices;
CREATE TRIGGER trg_product_prices_updated_at
    BEFORE UPDATE ON product_prices
    FOR EACH ROW
    EXECUTE FUNCTION update_product_prices_updated_at();

COMMENT ON TABLE product_prices IS 'Per-office pricing for products. One price per product per office. Currency follows office default or can be overridden.';

-- ============================================================
-- 6) EXCHANGE_RATES — Doviz kurlari (EUR bazli)
-- ============================================================
-- Konvansiyon: rate_to_eur = 1 birim currency'nin EUR karsiligi.
-- Ornek: 1 NGN = 0.00058 EUR -> rate_to_eur = 0.00058
-- Hesaplama: EUR_tutari = yerel_tutar * rate_to_eur
-- EUR satirinin rate_to_eur = 1 (sabit).
-- Kur guncellemesi manuel (Suer veya admin gunceller).
CREATE TABLE IF NOT EXISTS exchange_rates (
    currency CHAR(3) PRIMARY KEY,
    rate_to_eur NUMERIC NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,

    CONSTRAINT chk_exchange_rates_rate_positive CHECK (rate_to_eur > 0)
);

-- Trigger: auto-update updated_at
CREATE OR REPLACE FUNCTION update_exchange_rates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_exchange_rates_updated_at ON exchange_rates;
CREATE TRIGGER trg_exchange_rates_updated_at
    BEFORE UPDATE ON exchange_rates
    FOR EACH ROW
    EXECUTE FUNCTION update_exchange_rates_updated_at();

-- SEED: sadece EUR (sabit 1:1). Diger kurlari Suer girer.
INSERT INTO exchange_rates (currency, rate_to_eur, updated_at, updated_by)
VALUES ('EUR', 1, NOW(), NULL)
ON CONFLICT (currency) DO NOTHING;

COMMENT ON TABLE exchange_rates IS 'Manual exchange rates. rate_to_eur = how many EUR per 1 unit of currency. EUR_amount = local_amount * rate_to_eur.';

COMMIT;

-- ============================================================
-- ROLLBACK (manuel — sorun cikarsa asagidaki blogu elle uygula):
-- BEGIN;
--   DROP TRIGGER IF EXISTS trg_product_prices_updated_at ON product_prices;
--   DROP FUNCTION IF EXISTS update_product_prices_updated_at();
--   DROP TABLE IF EXISTS product_prices;
--   DROP TRIGGER IF EXISTS trg_products_updated_at ON products;
--   DROP FUNCTION IF EXISTS update_products_updated_at();
--   DROP TABLE IF EXISTS products;
--   DROP TRIGGER IF EXISTS trg_expos_updated_at ON expos;
--   DROP FUNCTION IF EXISTS update_expos_updated_at();
--   DROP TABLE IF EXISTS expos;
--   DROP INDEX IF EXISTS idx_users_office;
--   ALTER TABLE users DROP COLUMN IF EXISTS office_id;
--   DROP TRIGGER IF EXISTS trg_exchange_rates_updated_at ON exchange_rates;
--   DROP FUNCTION IF EXISTS update_exchange_rates_updated_at();
--   DROP TABLE IF EXISTS exchange_rates;
--   DROP TRIGGER IF EXISTS trg_offices_updated_at ON offices;
--   DROP FUNCTION IF EXISTS update_offices_updated_at();
--   DROP TABLE IF EXISTS offices;
-- COMMIT;
-- (Ters bagimsizlik sirasi: once FK veren tablolar, sonra referans alinanlar.)
-- ============================================================
