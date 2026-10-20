-- =============================================================
-- t24：补齐 M5 契约（消息时序/已读、草稿引用与降级、模板、事件重放）
--
-- additive：只加列/加默认/放宽枚举/加索引/建新表；不删列、不改已有必填。
--
-- 1) message：platform、sender_role、read_at、event_seq（序列）、platform_sent_at、
--    raw_object_key；content_type 增加 quote；索引 ix_message_conv_seq / ix_message_unread。
-- 2) reply_draft：conversation_id、evidence_refs、fallback_reason、model_call_id、latency_ms；
--    degraded=true 时 fallback_reason 必填。
-- 3) reply_template：name、category、priority、usage_count、last_used_at、approved_at、
--    effective_from/to；索引 ix_reply_template_pick。
-- 4) conversation：biz_line、company_ref、contact_ref。
-- 5) event_log 新表（SSE 重放 7 天）：seq bigserial PK、user_id、topic、payload、created_at。
-- =============================================================

-- -------------------------------------------------------------
-- 1) message
-- -------------------------------------------------------------
ALTER TABLE message ADD COLUMN platform TEXT;
UPDATE message m
SET platform = c.platform
FROM conversation c
WHERE c.id = m.conversation_id AND m.platform IS NULL;

ALTER TABLE message ADD COLUMN sender_role TEXT;
ALTER TABLE message ADD CONSTRAINT ck_msg_sender_role
  CHECK (sender_role IS NULL OR sender_role IN ('buyer','agent','system','bot'));

ALTER TABLE message ADD COLUMN read_at TIMESTAMPTZ;

-- event_seq：全局单调（SSE id / 断线重放游标）。已有行按默认值一次性回填。
CREATE SEQUENCE IF NOT EXISTS message_event_seq_seq;
ALTER TABLE message ADD COLUMN event_seq BIGINT NOT NULL DEFAULT nextval('message_event_seq_seq');
ALTER SEQUENCE message_event_seq_seq OWNED BY message.event_seq;

ALTER TABLE message ADD COLUMN platform_sent_at TIMESTAMPTZ;
ALTER TABLE message ADD COLUMN raw_object_key TEXT;

-- 1688 报价单
ALTER TABLE message DROP CONSTRAINT IF EXISTS ck_msg_content_type;
ALTER TABLE message ADD CONSTRAINT ck_msg_content_type
  CHECK (content_type IN ('text','image','video','order_card','product_card','system','quote'));

CREATE INDEX ix_message_conv_seq ON message (conversation_id, event_seq);
CREATE INDEX ix_message_unread ON message (conversation_id) WHERE read_at IS NULL;

-- -------------------------------------------------------------
-- 2) reply_draft
-- -------------------------------------------------------------
ALTER TABLE reply_draft ADD COLUMN conversation_id UUID;
UPDATE reply_draft d
SET conversation_id = m.conversation_id
FROM message m
WHERE m.id = d.message_id AND d.conversation_id IS NULL;

ALTER TABLE reply_draft
  ADD CONSTRAINT fk_reply_draft_conversation
  FOREIGN KEY (conversation_id) REFERENCES conversation(id) ON DELETE CASCADE;

ALTER TABLE reply_draft ADD COLUMN evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE reply_draft ADD COLUMN fallback_reason TEXT;
ALTER TABLE reply_draft ADD COLUMN model_call_id UUID;
ALTER TABLE reply_draft ADD COLUMN latency_ms INT;

ALTER TABLE reply_draft ADD CONSTRAINT ck_reply_draft_fallback
  CHECK (degraded = false OR fallback_reason IS NOT NULL);
ALTER TABLE reply_draft ADD CONSTRAINT ck_reply_draft_fallback_reason
  CHECK (fallback_reason IS NULL OR fallback_reason IN ('timeout','no_evidence','model_error'));

-- -------------------------------------------------------------
-- 3) reply_template
-- -------------------------------------------------------------
ALTER TABLE reply_template ADD COLUMN name TEXT;
ALTER TABLE reply_template ADD COLUMN category TEXT;
ALTER TABLE reply_template ADD COLUMN priority INT NOT NULL DEFAULT 0;
ALTER TABLE reply_template ADD COLUMN usage_count INT NOT NULL DEFAULT 0;
ALTER TABLE reply_template ADD COLUMN last_used_at TIMESTAMPTZ;
ALTER TABLE reply_template ADD COLUMN approved_at TIMESTAMPTZ;
ALTER TABLE reply_template ADD COLUMN effective_from TIMESTAMPTZ;
ALTER TABLE reply_template ADD COLUMN effective_to TIMESTAMPTZ;

CREATE INDEX ix_reply_template_pick
  ON reply_template (platform, intent, status, priority DESC, updated_at DESC);

-- -------------------------------------------------------------
-- 4) conversation
-- -------------------------------------------------------------
ALTER TABLE conversation ADD COLUMN biz_line TEXT;
UPDATE conversation
SET biz_line = CASE platform
  WHEN 'pdd' THEN 'pdd_retail'
  WHEN '1688' THEN '1688_wholesale'
  ELSE NULL
END
WHERE biz_line IS NULL;

ALTER TABLE conversation ADD CONSTRAINT ck_conversation_biz_line
  CHECK (biz_line IS NULL OR biz_line IN ('pdd_retail','1688_wholesale'));
ALTER TABLE conversation ADD COLUMN company_ref TEXT;
ALTER TABLE conversation ADD COLUMN contact_ref TEXT;

-- -------------------------------------------------------------
-- 5) event_log（SSE 重放；保留 7 天由应用清理）
-- -------------------------------------------------------------
CREATE TABLE event_log (
  seq        BIGSERIAL PRIMARY KEY,
  user_id    UUID,
  topic      TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_event_log_created ON event_log (created_at);
