-- 051_add_quotes.sql
-- Quote altyapisi: quotes + quote_line_items tablolari, quote_af_seq sequence.
-- AF numarasi goruntusu DB'de saklanmaz — af_sequence (BIGINT sayac) + office.code (ISO) +
-- status (Q/A prefix) app katmaninda birlestirilir (D2 kurali).
--
-- Konvansiyonlar (050_add_offices_expos_catalog referans):
--   PK: UUID DEFAULT gen_random_uuid()
--   Tenant: organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE
--   Audit: created_at/updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_by_user_id UUID
--   FK ownership: REFERENCES users(id) ON DELETE SET NULL
--   Named constraints: CONSTRAINT chk_* / uq_*
--   Idempotent: IF NOT EXISTS + DROP TRIGGER IF EXISTS + CREATE TRIGGER
--
-- Bagimsizlik sirasi: quote_af_seq -> quotes -> quote_line_items
-- FK hedefleri dogrulandi (canli DB): expos.id, companies.id, persons.id, offices.id, users.id = hepsi UUID.
-- Satis sahibi kolon adi: sales_owner_user_id (persons tablosuyla tutarli).

BEGIN;

-- ============================================================
-- 1) SEQUENCE — Global AF sayaci
-- ============================================================
-- Tek sayac tum organizer'lar icin. AF goruntusu app'te turetilir:
--   Q{office.code}-{af_sequence} (draft/sent) veya A{office.code}-{af_sequence} (signed).
-- START WITH 100000: mevcut Eliza/manuel AF numaralariyla cakismayi onler.
CREATE SEQUENCE IF NOT EXISTS quote_af_seq START WITH 100000;

-- ============================================================
-- 2) QUOTES — Teklif ana tablosu
-- ============================================================
CREATE TABLE IF NOT EXISTS quotes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,

    -- AF numarasi: global sequence, goruntusu app'te turetilir
    af_sequence BIGINT NOT NULL DEFAULT nextval('quote_af_seq'),

    -- Referanslar
    office_id UUID NOT NULL REFERENCES offices(id),
    expo_id UUID NOT NULL REFERENCES expos(id),
    company_id UUID NOT NULL REFERENCES companies(id),
    person_id UUID REFERENCES persons(id) ON DELETE SET NULL,  -- muhatap kisi, opsiyonel

    -- Satis sahibi (persons.sales_owner_user_id ile ayni konvansiyon)
    sales_owner_user_id UUID NOT NULL REFERENCES users(id),

    -- Icerik
    subject TEXT NOT NULL,             -- app olusturma aninda uretir, duzenlenebilir; Sent'te donar (app kurali)
    status TEXT NOT NULL DEFAULT 'draft',
    currency CHAR(3) NOT NULL,
    exchange_rate_to_eur NUMERIC NOT NULL,  -- olusturmada exchange_rates'ten kopyalanir, dondurulur

    -- Tarihler
    valid_until DATE,                  -- expo.payment_deadline'dan prefill, duzenlenebilir; Expired = sorgu, status degil
    sent_at TIMESTAMPTZ,
    signed_at DATE,
    declined_at TIMESTAMPTZ,

    -- Ek
    signed_scan_url TEXT,              -- Drive linki; signed'a gecis sarti APP'te (DB'de degil)
    notes TEXT,

    -- Ownership
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT uq_quotes_af_sequence UNIQUE (af_sequence),
    CONSTRAINT chk_quotes_status CHECK (status IN ('draft', 'sent', 'signed', 'declined')),
    CONSTRAINT chk_quotes_rate_positive CHECK (exchange_rate_to_eur > 0)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_quotes_organizer ON quotes(organizer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_organizer_status ON quotes(organizer_id, status);
CREATE INDEX IF NOT EXISTS idx_quotes_expo ON quotes(expo_id);
CREATE INDEX IF NOT EXISTS idx_quotes_company ON quotes(company_id);
CREATE INDEX IF NOT EXISTS idx_quotes_sales_owner ON quotes(sales_owner_user_id);
CREATE INDEX IF NOT EXISTS idx_quotes_office ON quotes(office_id);

-- Trigger: auto-update updated_at
CREATE OR REPLACE FUNCTION update_quotes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quotes_updated_at ON quotes;
CREATE TRIGGER trg_quotes_updated_at
    BEFORE UPDATE ON quotes
    FOR EACH ROW
    EXECUTE FUNCTION update_quotes_updated_at();

COMMENT ON TABLE quotes IS 'Quote/proposal header. AF display = Q/A prefix (from status) + office.code (ISO) + af_sequence. Line totals and grand total are computed, not stored.';
COMMENT ON COLUMN quotes.af_sequence IS 'Global auto-increment from quote_af_seq. Display AF number is derived in app layer.';
COMMENT ON COLUMN quotes.exchange_rate_to_eur IS 'Snapshot of exchange rate at quote creation. Frozen — not updated when rates change.';
COMMENT ON COLUMN quotes.valid_until IS 'Expiry date. Prefilled from expo.payment_deadline. Expired = app query (valid_until < NOW()), not a status value.';
COMMENT ON COLUMN quotes.signed_scan_url IS 'URL to signed scan (Google Drive). Transition to signed status is enforced in app, not DB.';

-- ============================================================
-- 3) QUOTE_LINE_ITEMS — Teklif satir kalemleri
-- ============================================================
-- Snapshot deseni: description ve unit_type urun katalogundan kopyalanir ama satir bagimsiz yasir.
-- product_id = kaynak referansi; urun silinirse satir kalir (SET NULL).
-- line_total SAKLANMAZ: quantity * unit_price * (1 - discount_percent/100) * (1 + tax_percent/100) app'te hesaplanir.
-- EUR-equivalent = quote.exchange_rate_to_eur * line_total (app'te hesaplanir).
CREATE TABLE IF NOT EXISTS quote_line_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quote_id UUID NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,

    -- Urun referansi (snapshot — satir bagimsiz yasar)
    product_id UUID REFERENCES products(id) ON DELETE SET NULL,

    -- Satir icerigi
    description TEXT NOT NULL,         -- urun adindan kopyalanir, duzenlenebilir
    unit_type TEXT NOT NULL,           -- urunden kopyalanir ('m2' veya 'unit')
    quantity NUMERIC NOT NULL,
    unit_price NUMERIC NOT NULL,       -- product_prices'tan prefill, satir-bazli override
    discount_percent NUMERIC NOT NULL DEFAULT 0,
    tax_percent NUMERIC NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT chk_line_items_unit_type CHECK (unit_type IN ('m2', 'unit')),
    CONSTRAINT chk_line_items_quantity CHECK (quantity > 0),
    CONSTRAINT chk_line_items_unit_price CHECK (unit_price >= 0),
    CONSTRAINT chk_line_items_discount CHECK (discount_percent >= 0 AND discount_percent <= 100),
    CONSTRAINT chk_line_items_tax CHECK (tax_percent >= 0)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_quote_line_items_quote ON quote_line_items(quote_id);

-- Trigger: auto-update updated_at
CREATE OR REPLACE FUNCTION update_quote_line_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quote_line_items_updated_at ON quote_line_items;
CREATE TRIGGER trg_quote_line_items_updated_at
    BEFORE UPDATE ON quote_line_items
    FOR EACH ROW
    EXECUTE FUNCTION update_quote_line_items_updated_at();

COMMENT ON TABLE quote_line_items IS 'Quote line items. Snapshot pattern: description/unit_type copied from product catalog but live independently. Totals computed in app, not stored.';
COMMENT ON COLUMN quote_line_items.product_id IS 'Source product reference. SET NULL on product deletion — line item survives with its snapshot data.';

COMMIT;

-- ============================================================
-- ROLLBACK (manuel — sorun cikarsa asagidaki blogu elle uygula):
-- BEGIN;
--   DROP TRIGGER IF EXISTS trg_quote_line_items_updated_at ON quote_line_items;
--   DROP FUNCTION IF EXISTS update_quote_line_items_updated_at();
--   DROP TABLE IF EXISTS quote_line_items;
--   DROP TRIGGER IF EXISTS trg_quotes_updated_at ON quotes;
--   DROP FUNCTION IF EXISTS update_quotes_updated_at();
--   DROP TABLE IF EXISTS quotes;
--   DROP SEQUENCE IF EXISTS quote_af_seq;
-- COMMIT;
-- ============================================================
