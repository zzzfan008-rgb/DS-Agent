-- =============================================================
-- t12 回滚脚本（手工执行；Prisma 不执行 down migration）
-- 仅回滚 t12 新增的 8 张表与 2 列；t1 的 31 张表不动。
-- =============================================================

DROP TABLE IF EXISTS workflow_dead_letter CASCADE;
DROP TABLE IF EXISTS events_outbox CASCADE;
DROP TABLE IF EXISTS cost_ledger CASCADE;
DROP TABLE IF EXISTS idempotency_key CASCADE;
DROP TABLE IF EXISTS reply_template CASCADE;
DROP TABLE IF EXISTS reply_draft CASCADE;
DROP TABLE IF EXISTS listing_write_log CASCADE;
DROP TABLE IF EXISTS listing_snapshot CASCADE;

ALTER TABLE listing DROP COLUMN IF EXISTS main_image_id;
ALTER TABLE kill_switch DROP COLUMN IF EXISTS mode;
