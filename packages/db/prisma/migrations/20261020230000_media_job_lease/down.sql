-- t34 回滚（手工执行；Prisma 不执行 down migration）
DROP INDEX IF EXISTS ix_media_job_lease;
ALTER TABLE media_job DROP COLUMN IF EXISTS locked_until;
ALTER TABLE media_job DROP COLUMN IF EXISTS locked_by;
