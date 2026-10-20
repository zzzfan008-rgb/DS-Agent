-- =============================================================
-- 回滚（手工执行；Prisma 不执行 down migration）
-- 仅移除 t13 新增的状态守卫 CHECK。
-- =============================================================

ALTER TABLE listing DROP CONSTRAINT IF EXISTS ck_listing_published_category;
