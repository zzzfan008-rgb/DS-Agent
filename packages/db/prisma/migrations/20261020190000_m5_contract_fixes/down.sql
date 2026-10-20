-- =============================================================
-- t24 回滚（手工执行；Prisma 不执行 down migration）
-- 注意：回滚会删除新增列/表；若已有引用数据（event_log / 草稿降级原因等）会丢失。
-- =============================================================

DROP TABLE IF EXISTS event_log;

ALTER TABLE conversation DROP CONSTRAINT IF EXISTS ck_conversation_biz_line;
ALTER TABLE conversation DROP COLUMN IF EXISTS contact_ref;
ALTER TABLE conversation DROP COLUMN IF EXISTS company_ref;
ALTER TABLE conversation DROP COLUMN IF EXISTS biz_line;

DROP INDEX IF EXISTS ix_reply_template_pick;
ALTER TABLE reply_template DROP COLUMN IF EXISTS effective_to;
ALTER TABLE reply_template DROP COLUMN IF EXISTS effective_from;
ALTER TABLE reply_template DROP COLUMN IF EXISTS approved_at;
ALTER TABLE reply_template DROP COLUMN IF EXISTS last_used_at;
ALTER TABLE reply_template DROP COLUMN IF EXISTS usage_count;
ALTER TABLE reply_template DROP COLUMN IF EXISTS priority;
ALTER TABLE reply_template DROP COLUMN IF EXISTS category;
ALTER TABLE reply_template DROP COLUMN IF EXISTS name;

ALTER TABLE reply_draft DROP CONSTRAINT IF EXISTS ck_reply_draft_fallback_reason;
ALTER TABLE reply_draft DROP CONSTRAINT IF EXISTS ck_reply_draft_fallback;
ALTER TABLE reply_draft DROP COLUMN IF EXISTS latency_ms;
ALTER TABLE reply_draft DROP COLUMN IF EXISTS model_call_id;
ALTER TABLE reply_draft DROP COLUMN IF EXISTS fallback_reason;
ALTER TABLE reply_draft DROP COLUMN IF EXISTS evidence_refs;
ALTER TABLE reply_draft DROP CONSTRAINT IF EXISTS fk_reply_draft_conversation;
ALTER TABLE reply_draft DROP COLUMN IF EXISTS conversation_id;

DROP INDEX IF EXISTS ix_message_unread;
DROP INDEX IF EXISTS ix_message_conv_seq;
ALTER TABLE message DROP CONSTRAINT IF EXISTS ck_msg_content_type;
ALTER TABLE message ADD CONSTRAINT ck_msg_content_type
  CHECK (content_type IN ('text','image','video','order_card','product_card','system'));
ALTER TABLE message DROP COLUMN IF EXISTS raw_object_key;
ALTER TABLE message DROP COLUMN IF EXISTS platform_sent_at;
ALTER TABLE message DROP COLUMN IF EXISTS event_seq;
ALTER TABLE message DROP COLUMN IF EXISTS read_at;
ALTER TABLE message DROP CONSTRAINT IF EXISTS ck_msg_sender_role;
ALTER TABLE message DROP COLUMN IF EXISTS sender_role;
ALTER TABLE message DROP COLUMN IF EXISTS platform;
DROP SEQUENCE IF EXISTS message_event_seq_seq;
