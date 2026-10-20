-- =============================================================
-- 回滚（手工执行；Prisma 不执行 down migration）
-- 仅回滚 listing.platform_category_id 追加。
-- =============================================================

DROP TRIGGER IF EXISTS trg_listing_category_platform ON listing;
DROP FUNCTION IF EXISTS check_listing_category_platform() CASCADE;
ALTER TABLE listing DROP CONSTRAINT IF EXISTS fk_listing_platform_category_id;
DROP INDEX IF EXISTS ix_listing_platform_category;
ALTER TABLE listing DROP COLUMN IF EXISTS platform_category_id;
