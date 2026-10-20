-- =============================================================
-- t30 回滚（手工执行；Prisma 不执行 down migration）
-- 注意：回滚会丢失 delivery_mode 区分（演练/真实无法再还原）。
-- =============================================================

DROP INDEX IF EXISTS ix_message_delivery;
ALTER TABLE message DROP CONSTRAINT IF EXISTS ck_msg_delivery_mode;
ALTER TABLE message DROP COLUMN IF EXISTS delivery_mode;
