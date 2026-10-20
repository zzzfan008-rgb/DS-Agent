-- =============================================================
-- t12 追加（docs/06 修订到 v3 后补）：listing.platform_category_id
--
-- 依据：
--   - docs/21 §17-1：平台类目按 listing 维度记，同一商品在两个平台类目可不同；
--   - docs/06 v3 §4.5.1：uuid 可空，FK platform_category(id) ON DELETE RESTRICT，
--     且须 platform_category.platform = listing.platform；
--   - docs/06 v3 §8.2：触发器名 trg_listing_category_platform。
--
-- 生成方式：prisma migrate diff（t12 后 schema → 加列后的 schema）。
-- 本迁移只加列 + 索引 + 外键 + 触发器，不改已有列语义。
-- =============================================================

-- AlterTable
ALTER TABLE "listing" ADD COLUMN     "platform_category_id" UUID;


-- 平台类目索引（上架/资质校验按 listing 维度取类目）
CREATE INDEX ix_listing_platform_category ON listing (platform_category_id);

-- 外键：类目是字典表，软删为主，删除用 RESTRICT
ALTER TABLE listing
  ADD CONSTRAINT fk_listing_platform_category_id
  FOREIGN KEY (platform_category_id) REFERENCES platform_category(id) ON DELETE RESTRICT;

-- 守护：类目行的 platform 必须与 listing.platform 一致（docs/06 §8.2）
CREATE OR REPLACE FUNCTION check_listing_category_platform() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.platform_category_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM platform_category c
      WHERE c.id = NEW.platform_category_id
        AND c.platform = NEW.platform
    ) THEN
      RAISE EXCEPTION 'listing.platform_category_id % does not belong to platform %',
        NEW.platform_category_id, NEW.platform USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_listing_category_platform
  BEFORE INSERT OR UPDATE OF platform, platform_category_id ON listing
  FOR EACH ROW EXECUTE FUNCTION check_listing_category_platform();
