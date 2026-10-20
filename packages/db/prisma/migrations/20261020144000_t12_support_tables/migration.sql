-- =============================================================
-- t12 结构补齐（docs/21 §17-3 / §17-5 / §17-6）
--
-- 内容：
--   1) listing.main_image_id（uuid 可空，FK media_asset ON DELETE SET NULL）
--   2) kill_switch.mode（block|drain，默认 block；readonly 与 drain 互斥）
--   3) 8 张支撑表（docs/12 §9.2，P0）：
--        listing_snapshot / listing_write_log / reply_draft / reply_template
--        idempotency_key / cost_ledger / events_outbox / workflow_dead_letter
--
-- 生成方式：
--   prisma migrate diff --from-schema-datamodel <t11 后的 schema> \
--                       --to-schema-datamodel prisma/schema.prisma --script
-- 手工追加：CHECK、外键、索引、触发器（Prisma schema 无法表达）。
--
-- 约束：
--   - 只加列/加表，不改已存在 31 张表的语义列；workflow_run.state 默认值保持 'pending'；
--   - 金额列一律 int4（amount_cents），不使用 bigint 金额；
--   - 枚举列全部建 CHECK。
-- =============================================================

-- AlterTable
ALTER TABLE "listing" ADD COLUMN     "main_image_id" UUID;

-- AlterTable
ALTER TABLE "kill_switch" ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'block';

-- CreateTable
CREATE TABLE "listing_snapshot" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "listing_id" UUID NOT NULL,
    "snapshot_hash" TEXT NOT NULL,
    "captured_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'pre_write',
    "fields" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "listing_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_write_log" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "listing_id" UUID NOT NULL,
    "approval_id" UUID,
    "workflow_run_id" UUID,
    "level" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "restored_from_snapshot" BOOLEAN NOT NULL DEFAULT false,
    "platform_response" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "listing_write_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reply_draft" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "message_id" UUID NOT NULL,
    "draft_text" TEXT NOT NULL,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "template_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "reply_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reply_template" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "platform" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "weight" INTEGER NOT NULL DEFAULT 100,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "reply_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_flight',
    "response_snapshot" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_ledger" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "kind" TEXT NOT NULL,
    "model_id" UUID,
    "ref_type" TEXT NOT NULL,
    "ref_id" UUID NOT NULL,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "seconds" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "amount_cents" INTEGER NOT NULL DEFAULT 0,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "cost_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events_outbox" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "topic" TEXT NOT NULL,
    "aggregate_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "published_at" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "events_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_dead_letter" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "workflow_run_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "replayable" BOOLEAN NOT NULL DEFAULT true,
    "replayed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "workflow_dead_letter_pkey" PRIMARY KEY ("id")
);


-- -------------------------------------------------------------
-- 手工追加：约束 / 外键 / 索引 / 触发器
-- -------------------------------------------------------------

-- 1. listing 主图（为空回落到 product.main_asset_id）
CREATE INDEX ix_listing_main_image ON listing (main_image_id) WHERE main_image_id IS NOT NULL;
ALTER TABLE listing
  ADD CONSTRAINT fk_listing_main_image_id
  FOREIGN KEY (main_image_id) REFERENCES media_asset(id) ON DELETE SET NULL;

-- 2. kill_switch 模式：action 决定"停什么"，mode 决定"怎么停"
ALTER TABLE kill_switch
  ADD CONSTRAINT ck_switch_mode CHECK (mode IN ('block','drain')),
  ADD CONSTRAINT ck_switch_readonly_mode CHECK (action <> 'readonly' OR mode = 'block');

-- 3. 新表公共字段约束（org_id > 0 / version >= 1）
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'listing_snapshot','listing_write_log','reply_draft','reply_template',
    'idempotency_key','cost_ledger','events_outbox','workflow_dead_letter'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (org_id > 0)', t, 'ck_' || t || '_org_id');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (version >= 1)', t, 'ck_' || t || '_version');
  END LOOP;
END $$;

-- 4. 枚举与字段 CHECK
ALTER TABLE listing_snapshot
  ADD CONSTRAINT ck_listing_snapshot_source CHECK (source IN ('pre_write','post_write','platform_sync','manual')),
  ADD CONSTRAINT ck_listing_snapshot_hash CHECK (char_length(snapshot_hash) = 64),
  ADD CONSTRAINT ck_listing_snapshot_fields_json CHECK (jsonb_typeof(fields) = 'object');

ALTER TABLE listing_write_log
  ADD CONSTRAINT ck_listing_write_log_level CHECK (level IN ('A','B','C')),
  ADD CONSTRAINT ck_listing_write_log_action CHECK (action IN (
    'publish','update_price','update_stock','replace_main_image','change_category',
    'send_reply','send_quote','upload_video','batch_offline')),
  ADD CONSTRAINT ck_listing_write_log_payload_hash CHECK (char_length(payload_hash) = 64),
  ADD CONSTRAINT ck_listing_write_log_idem_len CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  ADD CONSTRAINT ck_listing_write_log_response_json CHECK (jsonb_typeof(platform_response) = 'object'),
  -- 禁止伪回滚：只有 A 级可声明"从快照恢复"（docs/11 §6.3）
  ADD CONSTRAINT ck_restore_a_only CHECK (level = 'A' OR restored_from_snapshot = false);

ALTER TABLE reply_draft
  ADD CONSTRAINT ck_reply_draft_status CHECK (status IN ('draft','approved','sent','discarded','failed')),
  ADD CONSTRAINT ck_reply_draft_text_len CHECK (char_length(draft_text) BETWEEN 1 AND 5000);

ALTER TABLE reply_template
  ADD CONSTRAINT ck_reply_template_platform CHECK (platform IN ('pdd','1688')),
  ADD CONSTRAINT ck_reply_template_status CHECK (status IN ('draft','approved','retired')),
  ADD CONSTRAINT ck_reply_template_intent CHECK (intent ~ '^[a-z][a-z0-9_]{1,31}$'),
  ADD CONSTRAINT ck_reply_template_content_len CHECK (char_length(content) BETWEEN 1 AND 2000),
  ADD CONSTRAINT ck_reply_template_weight CHECK (weight BETWEEN 0 AND 1000);

ALTER TABLE idempotency_key
  ADD CONSTRAINT ck_idempotency_status CHECK (status IN ('in_flight','succeeded','failed')),
  ADD CONSTRAINT ck_idempotency_scope_len CHECK (char_length(scope) BETWEEN 1 AND 128),
  ADD CONSTRAINT ck_idempotency_key_len CHECK (char_length(key) = 64),
  ADD CONSTRAINT ck_idempotency_request_hash CHECK (char_length(request_hash) = 64),
  ADD CONSTRAINT ck_idempotency_response_json CHECK (jsonb_typeof(response_snapshot) = 'object');

ALTER TABLE cost_ledger
  ADD CONSTRAINT ck_cost_ledger_kind CHECK (kind IN ('model','media')),
  ADD CONSTRAINT ck_cost_ledger_ref_type CHECK (ref_type IN (
    'model_call_log','media_job','media_asset','listing','approval','content_draft','judgment')),
  ADD CONSTRAINT ck_cost_ledger_tokens CHECK (tokens >= 0),
  ADD CONSTRAINT ck_cost_ledger_seconds CHECK (seconds >= 0),
  ADD CONSTRAINT ck_cost_ledger_amount CHECK (amount_cents >= 0);

ALTER TABLE events_outbox
  ADD CONSTRAINT ck_events_outbox_topic CHECK (topic ~ '^[a-z][a-z0-9_.]{1,63}$'),
  ADD CONSTRAINT ck_events_outbox_attempts CHECK (attempts >= 0),
  ADD CONSTRAINT ck_events_outbox_payload_json CHECK (jsonb_typeof(payload) = 'object');

ALTER TABLE workflow_dead_letter
  ADD CONSTRAINT ck_dead_letter_reason_len CHECK (char_length(reason) BETWEEN 1 AND 2000),
  ADD CONSTRAINT ck_dead_letter_payload_json CHECK (jsonb_typeof(payload) = 'object');

-- 5. 外键（fk_<表>_<列>）
ALTER TABLE listing_snapshot
  ADD CONSTRAINT fk_listing_snapshot_listing_id
  FOREIGN KEY (listing_id) REFERENCES listing(id) ON DELETE CASCADE;

ALTER TABLE listing_write_log
  ADD CONSTRAINT fk_listing_write_log_listing_id
  FOREIGN KEY (listing_id) REFERENCES listing(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_listing_write_log_approval_id
  FOREIGN KEY (approval_id) REFERENCES approval(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_listing_write_log_workflow_run_id
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_run(id) ON DELETE SET NULL;

ALTER TABLE reply_draft
  ADD CONSTRAINT fk_reply_draft_message_id
  FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_reply_draft_template_id
  FOREIGN KEY (template_id) REFERENCES reply_template(id) ON DELETE SET NULL;

ALTER TABLE cost_ledger
  ADD CONSTRAINT fk_cost_ledger_model_id
  FOREIGN KEY (model_id) REFERENCES model(id) ON DELETE SET NULL;

ALTER TABLE workflow_dead_letter
  ADD CONSTRAINT fk_workflow_dead_letter_workflow_run_id
  FOREIGN KEY (workflow_run_id) REFERENCES workflow_run(id) ON DELETE RESTRICT;

-- created_by → users(id)：新表统一按 docs/06 §0.6 建外键
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'listing_snapshot','listing_write_log','reply_draft','reply_template',
    'idempotency_key','cost_ledger','events_outbox','workflow_dead_letter'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL',
                   t, 'fk_' || t || '_created_by');
  END LOOP;
END $$;

-- 6. 索引
CREATE UNIQUE INDEX uq_listing_snapshot_hash ON listing_snapshot (snapshot_hash) WHERE archived_at IS NULL;
CREATE INDEX ix_listing_snapshot_listing ON listing_snapshot (listing_id, captured_at DESC);

CREATE UNIQUE INDEX uq_listing_write_log_key ON listing_write_log (listing_id, idempotency_key);
CREATE INDEX ix_listing_write_log_listing ON listing_write_log (listing_id, occurred_at DESC);
CREATE INDEX ix_listing_write_log_approval ON listing_write_log (approval_id);

CREATE INDEX ix_reply_draft_message ON reply_draft (message_id, created_at DESC);
CREATE INDEX ix_reply_draft_status ON reply_draft (status);
CREATE INDEX ix_reply_template_lookup ON reply_template (platform, intent, status);

CREATE UNIQUE INDEX uq_idempotency_scope_key ON idempotency_key (scope, key) WHERE archived_at IS NULL;
CREATE INDEX ix_idempotency_expires ON idempotency_key (expires_at);

CREATE INDEX ix_cost_ledger_ref ON cost_ledger (ref_type, ref_id);
CREATE INDEX ix_cost_ledger_occurred ON cost_ledger (occurred_at);
CREATE INDEX ix_cost_ledger_model ON cost_ledger (model_id);

CREATE INDEX ix_events_outbox_published ON events_outbox (published_at);
CREATE INDEX ix_events_outbox_pending ON events_outbox (created_at) WHERE published_at IS NULL;

CREATE INDEX ix_workflow_dead_letter_run ON workflow_dead_letter (workflow_run_id);
CREATE INDEX ix_workflow_dead_letter_replayable ON workflow_dead_letter (replayed_at)
  WHERE replayable AND replayed_at IS NULL;

-- 7. updated_at / version 触发器（与 t1 的 27 张表一致）
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'listing_snapshot','listing_write_log','reply_draft','reply_template',
    'idempotency_key','cost_ledger','events_outbox','workflow_dead_letter'
  ] LOOP
    EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    EXECUTE format('CREATE TRIGGER trg_bump_version BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION bump_version()', t);
  END LOOP;
END $$;
