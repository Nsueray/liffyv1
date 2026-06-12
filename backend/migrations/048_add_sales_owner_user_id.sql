-- 048_add_sales_owner_user_id.sql
-- Faz 1 scope izolasyonu hazirligi: persons/prospects/companies'e sahip-kullanici
-- (sales_owner_user_id) kolonu + backfill. Mevcut cross-user veri sizintisini
-- kapatmak icin scope filtresinin dayanacagi owner kolonu.
--
-- ID tipleri: users/persons/prospects/companies.id = uuid (canli sema ile dogrulandi).
-- Bu migration mining zincirinden (005->007 kirik ordering) BAGIMSIZ — yalniz
-- persons(015)/prospects(006)/companies(046)/users(004) tablolarina dokunur.
--
-- Atomik: tek transaction. Backfill owner bulamazsa RAISE EXCEPTION -> tum migration geri alinir.
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.

BEGIN;

-- 1) Kolonlar (nullable, users.id'ye FK, kullanici silinirse NULL'a duser)
ALTER TABLE persons   ADD COLUMN IF NOT EXISTS sales_owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS sales_owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sales_owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- 2) Index (scope sorgusu: WHERE sales_owner_user_id = $user)
CREATE INDEX IF NOT EXISTS idx_persons_sales_owner   ON persons(sales_owner_user_id);
CREATE INDEX IF NOT EXISTS idx_prospects_sales_owner ON prospects(sales_owner_user_id);
CREATE INDEX IF NOT EXISTS idx_companies_sales_owner ON companies(sales_owner_user_id);

-- 3) Backfill: mevcut persons + prospects kayitlarini owner kullaniciya ata.
--    Owner users tablosundan role='owner' ile bulunur (hardcode YOK).
--    Owner yoksa migration DURUR (sessizce gecmez).
--    companies bos (0 kayit) — backfill etkisiz, yine de tutarlilik icin dahil.
DO $$
DECLARE
  v_owner_id uuid;
BEGIN
  SELECT id INTO v_owner_id
  FROM users
  WHERE role = 'owner'
  ORDER BY id
  LIMIT 1;

  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'sales_owner backfill DURDURULDU: role=owner kullanici bulunamadi (users tablosu).';
  END IF;

  UPDATE persons   SET sales_owner_user_id = v_owner_id WHERE sales_owner_user_id IS NULL;
  UPDATE prospects SET sales_owner_user_id = v_owner_id WHERE sales_owner_user_id IS NULL;
  UPDATE companies SET sales_owner_user_id = v_owner_id WHERE sales_owner_user_id IS NULL;

  RAISE NOTICE 'sales_owner backfill tamam: owner=%', v_owner_id;
END $$;

COMMIT;

-- ============================================================
-- ROLLBACK (manuel — calistirmak icin asagidaki blogu elle uygula):
-- BEGIN;
--   DROP INDEX IF EXISTS idx_persons_sales_owner;
--   DROP INDEX IF EXISTS idx_prospects_sales_owner;
--   DROP INDEX IF EXISTS idx_companies_sales_owner;
--   ALTER TABLE persons   DROP COLUMN IF EXISTS sales_owner_user_id;
--   ALTER TABLE prospects DROP COLUMN IF EXISTS sales_owner_user_id;
--   ALTER TABLE companies DROP COLUMN IF EXISTS sales_owner_user_id;
-- COMMIT;
-- (DROP COLUMN, kolona bagli FK ve index'i de otomatik dusurur.)
-- ============================================================
