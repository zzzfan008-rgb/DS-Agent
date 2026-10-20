-- =============================================================
-- t30：message.delivery_mode（区分真实发送与演练）
--
-- 背景：t21 的 dry-run 发送把 status 写成 sent，但消息并未离开系统（偏差 R10）。
-- 本迁移只加列 + 回填 + CHECK + 索引；status 语义不变。
--
-- 回填规则：
--   1) 新列默认 'live'；
--   2) 历史行中 status='sent' 且 raw_object_key IS NULL 的视为演练，改为 'dry_run'。
--      （当前无真实发送，回填风险为零；迁移输出会打印实际命中行数）
-- =============================================================

ALTER TABLE message ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'live';

-- 历史演练数据：已标记 sent、但没有真实出口凭据（raw_object_key 为空）
UPDATE message
SET delivery_mode = 'dry_run'
WHERE status = 'sent' AND raw_object_key IS NULL;

-- 回填数量供运维核对（迁移日志可见）
DO $$
DECLARE
  dry_run_count BIGINT;
BEGIN
  SELECT count(*) INTO dry_run_count FROM message WHERE delivery_mode = 'dry_run';
  RAISE NOTICE 'message.delivery_mode backfill: % row(s) marked dry_run', dry_run_count;
END $$;

ALTER TABLE message ADD CONSTRAINT ck_msg_delivery_mode
  CHECK (delivery_mode IN ('live','dry_run'));

CREATE INDEX ix_message_delivery ON message (conversation_id, delivery_mode);
