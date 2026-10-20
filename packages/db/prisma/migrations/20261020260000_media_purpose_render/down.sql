-- t39 回滚（手工执行；Prisma 不执行 down migration）
-- 注意：若已存在 purpose='render' 的行，回滚会失败；需先迁移这些行。
ALTER TABLE media_job DROP CONSTRAINT IF EXISTS ck_media_purpose;

ALTER TABLE media_job
  ADD CONSTRAINT ck_media_purpose CHECK (purpose IN ('image','video'));
