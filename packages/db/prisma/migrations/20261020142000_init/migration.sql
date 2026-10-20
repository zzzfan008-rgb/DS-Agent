-- =============================================================
-- M1 初始迁移：双平台服装电商运营系统核心表（31 张 = docs/06 的 30 张 + docs/21 §8 的 media_quota）
--
-- 生成方式（表/列/主键部分）：
--   prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
-- 手工追加（Prisma schema 无法表达，见文件后半段）：
--   1) pgcrypto / vector 扩展（vector 必须在 vector 列之前）；
--   2) 全部枚举与字段 CHECK（docs/06 §2/§4；词表按 docs/21 裁决）；
--   3) 命中 docs/06 §5.1 的索引（含部分唯一索引、HNSW、GIN）；
--   4) 全部外键（fk_<表>_<列>）与 created_by 外键；
--   5) 触发器与函数：updated_at / version / 审计只插不改 / model_call_log 白名单 /
--      product.fact_version / SKU 尺码存在性 / 事实来源枚举；
--   6) roles 种子数据（viewer/operator/admin）。
--
-- 金额口径（docs/21 §1）：全部 *_cents，整数分；不使用 Decimal 金额。
-- 主键口径（docs/21 §10）：id uuid v7（Prisma 客户端生成），audit_log 另有单调 seq。
-- =============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "totp_secret_ref" TEXT,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_login_at" TIMESTAMPTZ,
    "failed_attempts" SMALLINT NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "locale" TEXT NOT NULL DEFAULT 'zh-CN',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_system" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "granted_by" UUID,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID,
    "request_id" TEXT NOT NULL,
    "before" JSONB NOT NULL DEFAULT '{}',
    "after" JSONB NOT NULL DEFAULT '{}',
    "diff" JSONB NOT NULL DEFAULT '{}',
    "irreversible" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "user_agent" TEXT,
    "chain_prev" TEXT,
    "chain_hash" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_ref" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'provider',
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_rotated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "credential_ref_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "vendor" TEXT NOT NULL DEFAULT 'other',
    "base_url" TEXT,
    "credential_ref" TEXT NOT NULL,
    "auth_scheme" TEXT NOT NULL DEFAULT 'bearer',
    "timeout_ms" INTEGER NOT NULL DEFAULT 60000,
    "max_concurrency" SMALLINT NOT NULL DEFAULT 8,
    "rate_limit" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'configuring',
    "connectivity" TEXT NOT NULL DEFAULT 'unknown',
    "last_check_at" TIMESTAMPTZ,
    "last_check_latency_ms" INTEGER,
    "last_error_code" TEXT,
    "balance_cents" INTEGER,
    "balance_checked_at" TIMESTAMPTZ,
    "region" TEXT,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "provider_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "external_model_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "purpose_support" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "params_schema" JSONB NOT NULL,
    "default_params" JSONB NOT NULL DEFAULT '{}',
    "price" JSONB NOT NULL,
    "price_version" INTEGER NOT NULL DEFAULT 1,
    "rate_limit" JSONB NOT NULL DEFAULT '{}',
    "context_tokens" INTEGER,
    "max_output_tokens" INTEGER,
    "embed_dim" SMALLINT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "published_at" TIMESTAMPTZ,
    "published_by" UUID,
    "deprecated_at" TIMESTAMPTZ,
    "sunset_at" TIMESTAMPTZ,
    "docs_url" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "model_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_route" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "scope_type" TEXT NOT NULL DEFAULT 'org',
    "scope_role_id" UUID,
    "scope_user_id" UUID,
    "purpose" TEXT NOT NULL,
    "model_id" UUID NOT NULL,
    "fallback_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "priority" INTEGER NOT NULL DEFAULT 100,
    "rpm" INTEGER,
    "tpm" INTEGER,
    "concurrency" INTEGER,
    "daily_calls" INTEGER,
    "daily_cost_cents" INTEGER,
    "monthly_cost_cents" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "effective_from" TIMESTAMPTZ,
    "effective_to" TIMESTAMPTZ,
    "label" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "model_route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_call_log" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "request_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "provider_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "route_id" UUID,
    "fallback_from_model_id" UUID,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "subject_type" TEXT NOT NULL DEFAULT 'other',
    "subject_id" UUID,
    "prompt_version" TEXT,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "image_count" INTEGER NOT NULL DEFAULT 0,
    "image_pixels" BIGINT,
    "video_seconds" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "error_code" TEXT,
    "tokens_source" TEXT NOT NULL DEFAULT 'provider_usage',
    "cost_cents" INTEGER NOT NULL DEFAULT 0,
    "price_snapshot" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "model_call_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_category" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "platform" TEXT NOT NULL,
    "external_category_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "level" SMALLINT NOT NULL DEFAULT 1,
    "parent_external_id" TEXT,
    "is_leaf" BOOLEAN NOT NULL DEFAULT true,
    "required_attrs" JSONB NOT NULL DEFAULT '[]',
    "qualification_requirements" JSONB NOT NULL DEFAULT '[]',
    "fee_rules" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "fetched_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contract_version" TEXT,
    "raw" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "platform_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "spu_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "season" TEXT NOT NULL DEFAULT 'all',
    "year" SMALLINT,
    "fit" TEXT,
    "style_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "category_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "qualification" JSONB NOT NULL DEFAULT '{}',
    "care_instructions" JSONB NOT NULL DEFAULT '{}',
    "origin_country" CHAR(2),
    "launch_date" DATE,
    "main_asset_id" UUID,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "fact_version" INTEGER NOT NULL DEFAULT 1,
    "data_source" TEXT NOT NULL DEFAULT 'import',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_sku" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "sku_code" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "color_id" TEXT NOT NULL,
    "color_name" TEXT NOT NULL,
    "size_code" TEXT NOT NULL,
    "fabric_id" UUID NOT NULL,
    "barcode" TEXT,
    "price_cents" INTEGER NOT NULL,
    "list_price_cents" INTEGER,
    "sale_price_cents" INTEGER,
    "price_tiers" JSONB NOT NULL DEFAULT '[]',
    "price_source" TEXT NOT NULL DEFAULT 'import',
    "cost_cents" INTEGER,
    "stock_qty" INTEGER NOT NULL DEFAULT 0,
    "safety_stock" INTEGER NOT NULL DEFAULT 0,
    "stock_source" TEXT NOT NULL DEFAULT 'import',
    "min_order_qty" INTEGER NOT NULL DEFAULT 1,
    "lead_time_days" SMALLINT,
    "weight_g" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "product_sku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "size_chart" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "product_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "size_system" TEXT NOT NULL DEFAULT 'alpha',
    "sku_size_code" TEXT NOT NULL,
    "size_order" SMALLINT NOT NULL DEFAULT 0,
    "measurements" JSONB NOT NULL,
    "recommend_height_min" SMALLINT,
    "recommend_height_max" SMALLINT,
    "recommend_weight_min" SMALLINT,
    "recommend_weight_max" SMALLINT,
    "fit_note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "effective_from" TIMESTAMPTZ NOT NULL,
    "effective_to" TIMESTAMPTZ,
    "checksum" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "size_chart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fabric_composition" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "product_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL DEFAULT 1,
    "fabric_code" TEXT NOT NULL,
    "fabric_name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'main',
    "materials" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "checksum" TEXT NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "fabric_composition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_attribute_mapping" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "platform" TEXT NOT NULL,
    "platform_category_id" UUID NOT NULL,
    "product_id" UUID,
    "sku_id" UUID,
    "attr_path" TEXT NOT NULL,
    "attr_type" TEXT NOT NULL DEFAULT 'enum',
    "internal_field" TEXT NOT NULL,
    "internal_value" TEXT NOT NULL,
    "platform_value_id" TEXT,
    "platform_value_name" TEXT,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "verified_at" TIMESTAMPTZ,
    "verified_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "platform_attribute_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_draft" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "product_id" UUID NOT NULL,
    "sku_id" UUID,
    "platform" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "structured" JSONB NOT NULL DEFAULT '{}',
    "facts" JSONB NOT NULL,
    "fact_check" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "judge_id" UUID,
    "approval_id" UUID,
    "model_call_id" UUID,
    "prompt_version" TEXT,
    "tone" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'zh-CN',
    "word_count" INTEGER NOT NULL DEFAULT 0,
    "risk_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "supersedes_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "content_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "judgment" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "verdict" TEXT,
    "severity" TEXT,
    "l1_result" JSONB NOT NULL DEFAULT '{}',
    "l1_hit_rule_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "l2_result" JSONB,
    "evidence_refs" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT,
    "repair_hint" TEXT,
    "model_call_id" UUID,
    "rule_set_version" TEXT NOT NULL,
    "lexicon_version" TEXT,
    "prompt_version" TEXT,
    "facts_hash" TEXT,
    "cost_cents" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER,
    "appeal_status" TEXT NOT NULL DEFAULT 'none',
    "appeal_reason" TEXT,
    "appealed_by" UUID,
    "appealed_at" TIMESTAMPTZ,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "final_verdict" TEXT,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "judgment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_asset" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "product_id" UUID,
    "sku_id" UUID,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "bucket" TEXT NOT NULL DEFAULT 'dssaas-media',
    "object_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "bytes" BIGINT NOT NULL,
    "duration_ms" INTEGER,
    "variants" JSONB NOT NULL DEFAULT '[]',
    "aigc_labeled" BOOLEAN NOT NULL DEFAULT false,
    "aigc_meta" JSONB,
    "license" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending_review',
    "review_note" TEXT,
    "media_job_id" UUID,
    "cost_cents" INTEGER NOT NULL DEFAULT 0,
    "platform_asset_ids" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "media_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_job" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "purpose" TEXT NOT NULL,
    "provider_id" UUID NOT NULL,
    "model_id" UUID NOT NULL,
    "route_id" UUID,
    "params" JSONB NOT NULL DEFAULT '{}',
    "prompt" TEXT,
    "input_ref" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "idempotency_key" TEXT NOT NULL,
    "external_job_id" TEXT,
    "poll_after" TIMESTAMPTZ,
    "poll_count" INTEGER NOT NULL DEFAULT 0,
    "result_url" TEXT,
    "result_expires_at" TIMESTAMPTZ,
    "media_asset_id" UUID,
    "estimated_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "cost_cents" INTEGER NOT NULL DEFAULT 0,
    "attempt" SMALLINT NOT NULL DEFAULT 0,
    "max_attempts" SMALLINT NOT NULL DEFAULT 3,
    "error_class" TEXT,
    "error_code" TEXT,
    "subject_type" TEXT NOT NULL DEFAULT 'other',
    "subject_id" UUID,
    "submitted_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "media_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_quota" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "sku_id" UUID,
    "batch_key" TEXT,
    "period" TEXT NOT NULL DEFAULT 'day',
    "max_images" INTEGER,
    "max_video_seconds" INTEGER,
    "used_images" INTEGER NOT NULL DEFAULT 0,
    "used_video_seconds" INTEGER NOT NULL DEFAULT 0,
    "window_start" TIMESTAMPTZ NOT NULL,
    "window_end" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "media_quota_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "platform" TEXT NOT NULL,
    "product_id" UUID NOT NULL,
    "platform_item_id" TEXT,
    "platform_shop_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "platform_state" TEXT,
    "title" TEXT,
    "category_external_id" TEXT,
    "sku_bindings" JSONB NOT NULL DEFAULT '[]',
    "price_tiers" JSONB NOT NULL DEFAULT '[]',
    "published_snapshot" JSONB NOT NULL DEFAULT '{}',
    "snapshot_at" TIMESTAMPTZ,
    "published_at" TIMESTAMPTZ,
    "last_synced_at" TIMESTAMPTZ,
    "reject_meta" JSONB NOT NULL DEFAULT '{}',
    "last_error_code" TEXT,
    "approval_id" UUID,
    "workflow_run_id" UUID,
    "contract_version" TEXT,
    "stop_loss_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_cursor" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "platform" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL DEFAULT 'default',
    "resource" TEXT NOT NULL,
    "cursor" TEXT,
    "watermark_at" TIMESTAMPTZ,
    "page_size" SMALLINT NOT NULL DEFAULT 100,
    "last_run_at" TIMESTAMPTZ,
    "last_success_at" TIMESTAMPTZ,
    "consecutive_failures" SMALLINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lease_owner" TEXT,
    "lease_until" TIMESTAMPTZ,
    "error_code" TEXT,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "sync_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "platform" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL DEFAULT 'default',
    "platform_conversation_id" TEXT NOT NULL,
    "buyer_ref" TEXT NOT NULL,
    "buyer_nick" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'pre_sale',
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigned_user_id" UUID,
    "last_message_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_inbound_at" TIMESTAMPTZ,
    "first_response_at" TIMESTAMPTZ,
    "first_response_due_at" TIMESTAMPTZ,
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "priority" SMALLINT NOT NULL DEFAULT 0,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "related_order_ref" TEXT,
    "related_product_id" UUID,
    "risk_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "conversation_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "platform_message_id" TEXT,
    "content_type" TEXT NOT NULL DEFAULT 'text',
    "content" TEXT NOT NULL DEFAULT '',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "sent_at" TIMESTAMPTZ,
    "status" TEXT NOT NULL DEFAULT 'received',
    "outbound_idempotency_key" TEXT,
    "approval_id" UUID,
    "judge_id" UUID,
    "ai_generated" BOOLEAN NOT NULL DEFAULT false,
    "error_code" TEXT,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_run" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "type" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "stage" TEXT,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "attempt" SMALLINT NOT NULL DEFAULT 0,
    "max_attempts" SMALLINT NOT NULL DEFAULT 5,
    "parent_run_id" UUID,
    "next_run_at" TIMESTAMPTZ,
    "locked_by" TEXT,
    "lock_until" TIMESTAMPTZ,
    "deadline_at" TIMESTAMPTZ,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB NOT NULL DEFAULT '{}',
    "error_class" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "request_id" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ,
    "finished_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "workflow_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "operation_level" TEXT NOT NULL DEFAULT 'A',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decision" TEXT,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_note" TEXT,
    "target_hash" TEXT NOT NULL,
    "fact_snapshot" JSONB NOT NULL DEFAULT '{}',
    "risk_meta" JSONB NOT NULL DEFAULT '{}',
    "diff" JSONB NOT NULL DEFAULT '{}',
    "judge_id" UUID,
    "sla_due_at" TIMESTAMPTZ,
    "escalated_to" UUID,
    "scheduled_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL DEFAULT now() + interval '72 hours',
    "executed_at" TIMESTAMPTZ,
    "invalidated_at" TIMESTAMPTZ,
    "invalid_reason" TEXT,
    "request_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensating_ticket" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL,
    "related_approval_id" UUID,
    "related_listing_id" UUID,
    "platform" TEXT,
    "action_taken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "owner_user_id" UUID,
    "due_at" TIMESTAMPTZ,
    "resolution" TEXT,
    "resolved_at" TIMESTAMPTZ,
    "audit_log_id" UUID,
    "impact" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "compensating_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kill_switch" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "scope_type" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL DEFAULT '*',
    "action" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "enabled_by" UUID NOT NULL,
    "enabled_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabled_by" UUID,
    "disabled_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "drill" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "kill_switch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_document" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "source_type" TEXT NOT NULL,
    "source_id" UUID,
    "title" TEXT NOT NULL,
    "doc_type" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "owner_role_code" TEXT NOT NULL DEFAULT 'operator',
    "owner_user_id" UUID,
    "acl_roles" TEXT[] DEFAULT ARRAY['viewer', 'operator', 'admin']::TEXT[],
    "version_no" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "effective_from" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ,
    "review_due_at" TIMESTAMPTZ,
    "checksum" TEXT NOT NULL,
    "uri" TEXT,
    "mime" TEXT,
    "bytes" BIGINT,
    "lang" TEXT NOT NULL DEFAULT 'zh-CN',
    "parser_version" TEXT NOT NULL DEFAULT 'parser@1.0.0',
    "index_status" TEXT NOT NULL DEFAULT 'pending',
    "indexed_at" TIMESTAMPTZ,
    "embed_model_id" UUID,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "supersedes_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "kb_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_chunk" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "document_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "section_path" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "chunk_type" TEXT NOT NULL DEFAULT 'text',
    "content" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "content_tokens" INTEGER NOT NULL DEFAULT 0,
    "embedding" vector(1024),
    "embedding_model_id" UUID,
    "embedding_dim" SMALLINT,
    "tsv" tsvector,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "acl_roles" TEXT[],
    "effective_from" TIMESTAMPTZ NOT NULL,
    "effective_to" TIMESTAMPTZ,
    "status" TEXT NOT NULL DEFAULT 'active',
    "superseded_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "kb_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_query_log" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "request_id" TEXT NOT NULL,
    "actor_id" UUID,
    "role_code" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'retrieval',
    "query" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'hybrid',
    "top_k" SMALLINT NOT NULL DEFAULT 8,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "hit_count" INTEGER NOT NULL DEFAULT 0,
    "hits" JSONB NOT NULL DEFAULT '[]',
    "citations" JSONB NOT NULL DEFAULT '[]',
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "degrade_reason" TEXT,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "rerank_used" BOOLEAN NOT NULL DEFAULT false,
    "rerank_cost_cents" INTEGER NOT NULL DEFAULT 0,
    "feedback" TEXT NOT NULL DEFAULT 'none',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "kb_query_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_seq_key" ON "audit_log"("seq");


-- =============================================================
-- 手工追加部分（Prisma schema 无法表达）
-- 依据：docs/06-领域模型与数据字典.md §2/§4/§5/§7/§8，
--       冲突处按 docs/21-接口契约裁决.md（金额 *_cents、uuid v7、
--       workflow_run.state / listing.status 词表、model_route 配额列、
--       provider.credential_ref 无外键、media_quota 表）。
-- =============================================================

-- -------------------------------------------------------------
-- 1. 函数（先定义，供 CHECK 与触发器使用）
-- -------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version IS NOT DISTINCT FROM OLD.version THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$;

-- 事实来源枚举兜底（docs/06 §7.4）：来源词表刻意不含 model
CREATE OR REPLACE FUNCTION forbid_unknown_fact_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.price_source NOT IN ('import','erp','manual','platform_sync','supplier') THEN
    RAISE EXCEPTION 'invalid price_source: %', NEW.price_source USING ERRCODE = '23514';
  END IF;
  IF NEW.stock_source NOT IN ('import','erp','manual','platform_sync','supplier') THEN
    RAISE EXCEPTION 'invalid stock_source: %', NEW.stock_source USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- 面料成分合计 100（docs/06 §6.2.2）。用 CASE 保证非数组/非数字不会抛类型错误。
CREATE OR REPLACE FUNCTION fabric_materials_valid(m jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN jsonb_typeof(m) <> 'array' THEN false
    WHEN jsonb_array_length(m) NOT BETWEEN 1 AND 8 THEN false
    ELSE COALESCE((
      SELECT bool_and(
        CASE
          WHEN jsonb_typeof(e -> 'percent') <> 'number' THEN false
          ELSE (e ->> 'percent')::numeric = trunc((e ->> 'percent')::numeric)
           AND (e ->> 'percent')::numeric BETWEEN 1 AND 100
        END)
      FROM jsonb_array_elements(m) e
    ), false)
    AND (SELECT COALESCE(sum((e ->> 'percent')::numeric), 0)
           FROM jsonb_array_elements(m) e) = 100
  END;
$$;

-- 事实信封结构（docs/06 §6.5/§7.4）。source 词表不含 model，source_table 不含 judgment。
CREATE OR REPLACE FUNCTION fact_envelope_valid(f jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN jsonb_typeof(f) <> 'object' THEN false
    WHEN NOT (f ? 'facts_hash') THEN false
    WHEN (f ->> 'facts_hash') !~ '^[0-9a-f]{64}$' THEN false
    WHEN jsonb_typeof(f -> 'items') <> 'array' THEN false
    WHEN jsonb_array_length(f -> 'items') < 1 THEN false
    ELSE COALESCE((
      SELECT bool_and(
        CASE
          WHEN jsonb_typeof(e -> 'source') <> 'string'
            OR NOT ((e ->> 'source') = ANY (ARRAY['import','erp','manual','platform_sync','supplier','kb'])) THEN false
          WHEN jsonb_typeof(e -> 'source_table') <> 'string'
            OR NOT ((e ->> 'source_table') = ANY (ARRAY['product','product_sku','size_chart','fabric_composition','platform_category','kb_document'])) THEN false
          ELSE true
        END)
      FROM jsonb_array_elements(f -> 'items') e
    ), false)
  END;
$$;

-- 审计只插入不更新（docs/06 §4.8.4 / docs/21 §10）
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '42501';
END $$;

-- model_call_log 仅允许 5 分钟内回填白名单列（docs/06 §4.1.5）
CREATE OR REPLACE FUNCTION mcl_immutable_cols() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF now() > OLD.created_at + interval '5 minutes' THEN
    RAISE EXCEPTION 'model_call_log row is immutable after 5 minutes' USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - 'finished_at' - 'status' - 'cost_cents' - 'error_code')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'finished_at' - 'status' - 'cost_cents' - 'error_code') THEN
    RAISE EXCEPTION 'model_call_log only allows finished_at/status/cost_cents/error_code updates'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- 子表硬事实变更 → product.fact_version + 1（docs/06 §3.1/§8.2）
CREATE OR REPLACE FUNCTION bump_product_fact_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid;
BEGIN
  pid := COALESCE(NEW.product_id, OLD.product_id);
  UPDATE product SET fact_version = fact_version + 1 WHERE id = pid;
  RETURN COALESCE(NEW, OLD);
END $$;

-- SKU 尺码必须存在于该商品 effective 尺码表（docs/06 §8.2）
CREATE OR REPLACE FUNCTION check_sku_size_exists() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM size_chart c
    WHERE c.product_id = NEW.product_id
      AND c.status = 'effective'
      AND c.archived_at IS NULL
      AND c.sku_size_code = NEW.size_code
  ) THEN
    RAISE EXCEPTION 'size_code % not in effective size_chart of product %',
      NEW.size_code, NEW.product_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- -------------------------------------------------------------
-- 2. 公共字段约束（org_id > 0 / version >= 1）
-- -------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','roles','memberships','audit_log','credential_ref','provider','model',
    'model_route','model_call_log','platform_category','product','product_sku',
    'size_chart','fabric_composition','platform_attribute_mapping','content_draft',
    'judgment','media_asset','media_job','media_quota','listing','sync_cursor',
    'conversation','message','workflow_run','approval','compensating_ticket',
    'kill_switch','kb_document','kb_chunk','kb_query_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (org_id > 0)', t, 'ck_' || t || '_org_id');
  END LOOP;

  FOREACH t IN ARRAY ARRAY[
    'users','roles','memberships','credential_ref','provider','model','model_route',
    'platform_category','product','product_sku','size_chart','fabric_composition',
    'platform_attribute_mapping','content_draft','judgment','media_asset','media_job',
    'media_quota','listing','sync_cursor','conversation','message','workflow_run',
    'approval','compensating_ticket','kill_switch','kb_document'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (version >= 1)', t, 'ck_' || t || '_version');
  END LOOP;
END $$;

-- -------------------------------------------------------------
-- 3. 枚举与字段级 CHECK（docs/06 §2/§4；词表按 docs/21 覆盖）
-- -------------------------------------------------------------

-- 4.1 供应商与模型
ALTER TABLE provider
  ADD CONSTRAINT ck_provider_kind CHECK (kind IN ('text','image','video','embedding')),
  ADD CONSTRAINT ck_provider_vendor CHECK (vendor IN ('deepseek','volcengine','aliyun','openai_compatible','other')),
  ADD CONSTRAINT ck_provider_status CHECK (status IN ('configuring','active','degraded','disabled')),
  ADD CONSTRAINT ck_provider_connectivity CHECK (connectivity IN ('unknown','ok','failed')),
  ADD CONSTRAINT ck_provider_auth_scheme CHECK (auth_scheme IN ('bearer','header','query','ak_sk','none')),
  ADD CONSTRAINT ck_provider_name CHECK (name ~ '^[a-z][a-z0-9_]{2,39}$'),
  ADD CONSTRAINT ck_provider_base_url CHECK (base_url IS NULL OR base_url ~ '^https://'),
  ADD CONSTRAINT ck_provider_timeout CHECK (timeout_ms BETWEEN 1000 AND 600000),
  ADD CONSTRAINT ck_provider_concurrency CHECK (max_concurrency BETWEEN 1 AND 256),
  ADD CONSTRAINT ck_provider_latency CHECK (last_check_latency_ms IS NULL OR last_check_latency_ms >= 0),
  ADD CONSTRAINT ck_provider_balance CHECK (balance_cents IS NULL OR balance_cents >= 0),
  ADD CONSTRAINT ck_provider_rate_limit_json CHECK (jsonb_typeof(rate_limit) = 'object'),
  ADD CONSTRAINT ck_provider_extra_json CHECK (jsonb_typeof(extra) = 'object');

ALTER TABLE model
  ADD CONSTRAINT ck_model_capability CHECK (capability IN ('text','image','video','embedding','rerank')),
  ADD CONSTRAINT ck_model_status CHECK (status IN ('draft','testing','published','suspended','archived')),
  ADD CONSTRAINT ck_model_purpose_support CHECK (purpose_support <@ ARRAY['copy','judge','image','video','embed','rerank']::text[]),
  ADD CONSTRAINT ck_model_name CHECK (name ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  ADD CONSTRAINT ck_model_external_id CHECK (char_length(external_model_id) BETWEEN 1 AND 128),
  ADD CONSTRAINT ck_model_params_schema_json CHECK (jsonb_typeof(params_schema) = 'object'),
  ADD CONSTRAINT ck_model_default_params_json CHECK (jsonb_typeof(default_params) = 'object'),
  ADD CONSTRAINT ck_model_price_json CHECK (jsonb_typeof(price) = 'object'),
  ADD CONSTRAINT ck_model_price_version CHECK (price_version >= 1),
  ADD CONSTRAINT ck_model_rate_limit_json CHECK (jsonb_typeof(rate_limit) = 'object'),
  ADD CONSTRAINT ck_model_embed_dim CHECK (embed_dim IS NULL OR embed_dim BETWEEN 1 AND 8192),
  ADD CONSTRAINT ck_model_context_positive CHECK (context_tokens IS NULL OR context_tokens > 0),
  ADD CONSTRAINT ck_model_output_positive CHECK (max_output_tokens IS NULL OR max_output_tokens > 0),
  ADD CONSTRAINT ck_model_embedding_dim_required CHECK (capability <> 'embedding' OR embed_dim IS NOT NULL),
  ADD CONSTRAINT ck_model_text_context_required CHECK (capability NOT IN ('text','rerank') OR context_tokens IS NOT NULL);

ALTER TABLE model_route
  ADD CONSTRAINT ck_route_scope CHECK (scope_type IN ('org','role','user')),
  ADD CONSTRAINT ck_route_status CHECK (status IN ('draft','active','paused','retired')),
  ADD CONSTRAINT ck_purpose CHECK (purpose IN ('copy','judge','image','video','embed','rerank')),
  ADD CONSTRAINT ck_route_scope_consistency CHECK (
    (scope_type = 'org'  AND scope_role_id IS NULL AND scope_user_id IS NULL) OR
    (scope_type = 'role' AND scope_role_id IS NOT NULL AND scope_user_id IS NULL) OR
    (scope_type = 'user' AND scope_user_id IS NOT NULL AND scope_role_id IS NULL)
  ),
  ADD CONSTRAINT ck_route_priority CHECK (priority BETWEEN 1 AND 999),
  ADD CONSTRAINT ck_route_fallback_len CHECK (array_length(fallback_ids, 1) IS NULL OR array_length(fallback_ids, 1) <= 3),
  ADD CONSTRAINT ck_route_not_self_fallback CHECK (NOT (model_id = ANY (fallback_ids))),
  ADD CONSTRAINT ck_route_effective_range CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to > effective_from),
  ADD CONSTRAINT ck_route_quota_nonneg CHECK (
    (rpm IS NULL OR rpm >= 0) AND (tpm IS NULL OR tpm >= 0) AND
    (concurrency IS NULL OR concurrency >= 0) AND (daily_calls IS NULL OR daily_calls >= 0) AND
    (daily_cost_cents IS NULL OR daily_cost_cents >= 0) AND
    (monthly_cost_cents IS NULL OR monthly_cost_cents >= 0)
  );

ALTER TABLE credential_ref
  ADD CONSTRAINT ck_credential_status CHECK (status IN ('active','rotating','revoked')),
  ADD CONSTRAINT ck_credential_name CHECK (name ~ '^[a-z][a-z0-9_]{2,63}$'),
  ADD CONSTRAINT ck_credential_purpose CHECK (char_length(purpose) BETWEEN 1 AND 64);

ALTER TABLE model_call_log
  ADD CONSTRAINT ck_mcl_purpose CHECK (purpose IN ('copy','judge','image','video','embed','rerank')),
  ADD CONSTRAINT ck_mcl_actor_type CHECK (actor_type IN ('user','agent','worker','system')),
  ADD CONSTRAINT ck_mcl_subject_type CHECK (subject_type IN ('content_draft','judgment','media_job','workflow_run','kb_query','conversation','other')),
  ADD CONSTRAINT ck_call_status CHECK (status IN ('succeeded','failed','timeout','quota_rejected','schema_invalid','cancelled')),
  ADD CONSTRAINT ck_tokens_source CHECK (tokens_source IN ('provider_usage','estimated')),
  ADD CONSTRAINT ck_mcl_request_len CHECK (char_length(request_id) BETWEEN 1 AND 64),
  ADD CONSTRAINT ck_mcl_tokens_nonneg CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND cached_input_tokens >= 0 AND
    image_count >= 0 AND video_seconds >= 0 AND latency_ms >= 0
  ),
  ADD CONSTRAINT ck_mcl_image_pixels CHECK (image_pixels IS NULL OR image_pixels >= 0),
  ADD CONSTRAINT ck_mcl_cost CHECK (cost_cents >= 0),
  ADD CONSTRAINT ck_mcl_finished CHECK (finished_at IS NULL OR finished_at >= started_at),
  ADD CONSTRAINT ck_mcl_price_snapshot_json CHECK (jsonb_typeof(price_snapshot) = 'object');

-- 4.2 商品
ALTER TABLE product
  ADD CONSTRAINT ck_product_status CHECK (status IN ('draft','active','inactive','archived')),
  ADD CONSTRAINT ck_season CHECK (season IN ('spring','summer','autumn','winter','all')),
  ADD CONSTRAINT ck_fit CHECK (fit IS NULL OR fit IN ('slim','regular','loose','oversize')),
  ADD CONSTRAINT ck_product_data_source CHECK (data_source IN ('import','erp','manual','platform_sync','supplier')),
  ADD CONSTRAINT ck_product_spu_code CHECK (spu_code ~ '^[A-Z0-9][A-Z0-9-]{3,39}$'),
  ADD CONSTRAINT ck_product_name_len CHECK (char_length(name) BETWEEN 1 AND 120),
  ADD CONSTRAINT ck_product_year CHECK (year IS NULL OR year BETWEEN 2000 AND 2100),
  ADD CONSTRAINT ck_product_style_tags CHECK (array_length(style_tags, 1) IS NULL OR array_length(style_tags, 1) <= 12),
  ADD CONSTRAINT ck_product_category_code CHECK (category_code ~ '^[A-Z][0-9]{4}(\.[0-9]{1,3})?$'),
  ADD CONSTRAINT ck_product_origin_country CHECK (origin_country IS NULL OR origin_country ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT ck_product_fact_version CHECK (fact_version >= 1),
  ADD CONSTRAINT ck_product_qualification_json CHECK (jsonb_typeof(qualification) = 'object'),
  ADD CONSTRAINT ck_product_care_json CHECK (jsonb_typeof(care_instructions) = 'object'),
  ADD CONSTRAINT ck_product_attributes_json CHECK (jsonb_typeof(attributes) = 'object');

ALTER TABLE product_sku
  ADD CONSTRAINT ck_sku_status CHECK (status IN ('active','inactive','archived')),
  ADD CONSTRAINT ck_sku_price_source CHECK (price_source IN ('import','erp','manual','platform_sync','supplier')),
  ADD CONSTRAINT ck_sku_stock_source CHECK (stock_source IN ('import','erp','manual','platform_sync','supplier')),
  ADD CONSTRAINT ck_sku_code CHECK (sku_code ~ '^[A-Z0-9][A-Z0-9-]{3,59}$'),
  ADD CONSTRAINT ck_sku_color_id CHECK (color_id ~ '^[A-Z]{2}-?[0-9A-Z]{2,8}$'),
  ADD CONSTRAINT ck_sku_size_code CHECK (size_code ~ '^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL|5XL|[0-9]{2,3}|ONE)$'),
  ADD CONSTRAINT ck_sku_price CHECK (price_cents > 0),
  ADD CONSTRAINT ck_sku_list_price CHECK (list_price_cents IS NULL OR list_price_cents > 0),
  ADD CONSTRAINT ck_sku_sale_price CHECK (sale_price_cents IS NULL OR (sale_price_cents > 0 AND sale_price_cents <= price_cents)),
  ADD CONSTRAINT ck_sku_cost CHECK (cost_cents IS NULL OR cost_cents >= 0),
  ADD CONSTRAINT ck_sku_stock CHECK (stock_qty >= 0 AND safety_stock >= 0),
  ADD CONSTRAINT ck_sku_min_order CHECK (min_order_qty >= 1),
  ADD CONSTRAINT ck_sku_lead_time CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 60),
  ADD CONSTRAINT ck_sku_weight CHECK (weight_g IS NULL OR weight_g > 0),
  ADD CONSTRAINT ck_sku_price_tiers_array CHECK (jsonb_typeof(price_tiers) = 'array');

ALTER TABLE size_chart
  ADD CONSTRAINT ck_chart_status CHECK (status IN ('draft','effective','superseded')),
  ADD CONSTRAINT ck_size_system CHECK (size_system IN ('alpha','numeric','height_weight','one_size')),
  ADD CONSTRAINT ck_size_chart_size_code CHECK (sku_size_code ~ '^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|2XL|3XL|4XL|5XL|[0-9]{2,3}|ONE)$'),
  ADD CONSTRAINT ck_size_chart_version_no CHECK (version_no >= 1),
  ADD CONSTRAINT ck_size_chart_order CHECK (size_order BETWEEN 0 AND 99),
  ADD CONSTRAINT ck_size_chart_measurements CHECK (jsonb_typeof(measurements) = 'object' AND measurements <> '{}'::jsonb),
  ADD CONSTRAINT ck_size_chart_height_min CHECK (recommend_height_min IS NULL OR recommend_height_min BETWEEN 100 AND 230),
  ADD CONSTRAINT ck_size_chart_height_max CHECK (recommend_height_max IS NULL OR recommend_height_max BETWEEN 100 AND 230),
  ADD CONSTRAINT ck_size_chart_weight_min CHECK (recommend_weight_min IS NULL OR recommend_weight_min BETWEEN 25 AND 200),
  ADD CONSTRAINT ck_size_chart_weight_max CHECK (recommend_weight_max IS NULL OR recommend_weight_max BETWEEN 25 AND 200),
  ADD CONSTRAINT ck_size_chart_height_range CHECK (
    recommend_height_min IS NULL OR recommend_height_max IS NULL OR recommend_height_max >= recommend_height_min
  ),
  ADD CONSTRAINT ck_size_chart_weight_range CHECK (
    recommend_weight_min IS NULL OR recommend_weight_max IS NULL OR recommend_weight_max >= recommend_weight_min
  ),
  ADD CONSTRAINT ck_size_chart_fit_note CHECK (fit_note IS NULL OR char_length(fit_note) <= 200),
  ADD CONSTRAINT ck_size_chart_source CHECK (source IN ('import','erp','manual','platform_sync','supplier')),
  ADD CONSTRAINT ck_size_chart_checksum CHECK (char_length(checksum) = 64),
  ADD CONSTRAINT ck_size_chart_dates CHECK (effective_to IS NULL OR effective_to > effective_from);

ALTER TABLE fabric_composition
  ADD CONSTRAINT ck_fabric_role CHECK (role IN ('main','lining','trim','accessory')),
  ADD CONSTRAINT ck_fabric_status CHECK (status IN ('draft','effective','superseded')),
  ADD CONSTRAINT ck_fabric_code CHECK (fabric_code ~ '^[A-Z0-9-]{2,16}$'),
  ADD CONSTRAINT ck_fabric_name_len CHECK (char_length(fabric_name) BETWEEN 1 AND 60),
  ADD CONSTRAINT ck_fabric_materials_valid CHECK (fabric_materials_valid(materials)),
  ADD CONSTRAINT ck_fabric_source CHECK (source IN ('import','erp','manual','platform_sync','supplier')),
  ADD CONSTRAINT ck_fabric_checksum CHECK (char_length(checksum) = 64),
  ADD CONSTRAINT ck_fabric_dates CHECK (effective_to IS NULL OR effective_to > effective_from),
  ADD CONSTRAINT ck_fabric_notes_len CHECK (notes IS NULL OR char_length(notes) <= 500);

ALTER TABLE platform_category
  ADD CONSTRAINT ck_category_platform CHECK (platform IN ('pdd','1688')),
  ADD CONSTRAINT ck_category_level CHECK (level BETWEEN 1 AND 6),
  ADD CONSTRAINT ck_category_status CHECK (status IN ('active','deprecated','unknown')),
  ADD CONSTRAINT ck_category_required_attrs_array CHECK (jsonb_typeof(required_attrs) = 'array'),
  ADD CONSTRAINT ck_category_qualification_array CHECK (jsonb_typeof(qualification_requirements) = 'array');

ALTER TABLE platform_attribute_mapping
  ADD CONSTRAINT ck_pam_platform CHECK (platform IN ('pdd','1688')),
  ADD CONSTRAINT ck_attr_type CHECK (attr_type IN ('enum','text','number','bool','range','multi_enum')),
  ADD CONSTRAINT ck_mapping_status CHECK (status IN ('draft','verified','stale')),
  ADD CONSTRAINT ck_mapping_source CHECK (source IN ('import','erp','manual','platform_sync','supplier')),
  ADD CONSTRAINT ck_pam_attr_path CHECK (attr_path ~ '^[a-z][a-z0-9_.]{1,63}$'),
  ADD CONSTRAINT ck_pam_internal_field CHECK (internal_field ~ '^(product|product_sku|size_chart|fabric_composition)\.[a-z_]+$'),
  ADD CONSTRAINT ck_pam_target CHECK (product_id IS NOT NULL OR sku_id IS NOT NULL),
  ADD CONSTRAINT ck_pam_extra_json CHECK (jsonb_typeof(extra) = 'object');

-- 4.3 内容
ALTER TABLE content_draft
  ADD CONSTRAINT ck_content_type CHECK (content_type IN ('title','selling_points','detail','faq','reply','quote')),
  ADD CONSTRAINT ck_draft_status CHECK (status IN (
    'draft','generating','generated','fact_checked','judged','pending_approval',
    'approved','published','rejected','needs_revision','discarded','failed','superseded')),
  ADD CONSTRAINT ck_draft_platform CHECK (platform IN ('pdd','1688')),
  ADD CONSTRAINT ck_draft_title_len CHECK (title IS NULL OR char_length(title) <= 200),
  ADD CONSTRAINT ck_draft_body_len CHECK (char_length(body) BETWEEN 1 AND 20000),
  ADD CONSTRAINT ck_draft_facts_valid CHECK (fact_envelope_valid(facts)),
  ADD CONSTRAINT ck_draft_tone CHECK (tone IS NULL OR tone IN ('专业','亲和','简洁','促销','批发')),
  ADD CONSTRAINT ck_draft_word_count CHECK (word_count >= 0);

ALTER TABLE judgment
  ADD CONSTRAINT ck_judgment_subject_type CHECK (subject_type IN ('content_draft','message','media_asset','listing','quote','kb_answer')),
  ADD CONSTRAINT ck_judgment_status CHECK (status IN ('pending','running','passed','needs_revision','rejected','escalated','failed','superseded')),
  ADD CONSTRAINT ck_verdict CHECK (verdict IS NULL OR verdict IN ('pass','needs_revision','reject','escalate')),
  ADD CONSTRAINT ck_final_verdict CHECK (final_verdict IS NULL OR final_verdict IN ('pass','needs_revision','reject','escalate')),
  ADD CONSTRAINT ck_severity CHECK (severity IS NULL OR severity IN ('info','low','medium','high','blocker')),
  ADD CONSTRAINT ck_appeal_status CHECK (appeal_status IN ('none','requested','upheld','overridden','withdrawn')),
  ADD CONSTRAINT ck_judgment_content_type CHECK (content_type IN ('title','selling_points','detail','faq','reply','quote')),
  ADD CONSTRAINT ck_judgment_platform CHECK (platform IN ('pdd','1688')),
  ADD CONSTRAINT ck_judgment_reason_len CHECK (reason IS NULL OR char_length(reason) <= 2000),
  ADD CONSTRAINT ck_judgment_repair_len CHECK (repair_hint IS NULL OR char_length(repair_hint) <= 1000),
  ADD CONSTRAINT ck_judgment_facts_hash CHECK (facts_hash IS NULL OR char_length(facts_hash) = 64),
  ADD CONSTRAINT ck_judgment_cost CHECK (cost_cents >= 0),
  ADD CONSTRAINT ck_judgment_latency CHECK (latency_ms IS NULL OR latency_ms >= 0);

-- 4.4 素材
ALTER TABLE media_asset
  ADD CONSTRAINT ck_asset_kind CHECK (kind IN ('main','white_bg','detail','scene','model','size_chart','video','short_video','concept','variant')),
  ADD CONSTRAINT ck_asset_source CHECK (source IN ('shoot','ai_generated','rendered','uploaded','platform_sync')),
  ADD CONSTRAINT ck_asset_status CHECK (status IN ('pending_review','approved','rejected','archived')),
  ADD CONSTRAINT ck_asset_sha CHECK (char_length(sha256) = 64),
  ADD CONSTRAINT ck_asset_mime CHECK (mime IN ('image/jpeg','image/png','image/webp','video/mp4','video/quicktime')),
  ADD CONSTRAINT ck_asset_dims CHECK ((width IS NULL OR width > 0) AND (height IS NULL OR height > 0)),
  ADD CONSTRAINT ck_asset_bytes CHECK (bytes > 0),
  ADD CONSTRAINT ck_asset_duration CHECK (duration_ms IS NULL OR duration_ms >= 0),
  ADD CONSTRAINT ck_asset_aigc CHECK (source <> 'ai_generated' OR aigc_labeled),
  ADD CONSTRAINT ck_asset_cost CHECK (cost_cents >= 0),
  ADD CONSTRAINT ck_asset_variants_array CHECK (jsonb_typeof(variants) = 'array'),
  ADD CONSTRAINT ck_asset_license_json CHECK (jsonb_typeof(license) = 'object'),
  ADD CONSTRAINT ck_asset_platform_ids_json CHECK (jsonb_typeof(platform_asset_ids) = 'object');

ALTER TABLE media_job
  ADD CONSTRAINT ck_media_purpose CHECK (purpose IN ('image','video')),
  ADD CONSTRAINT ck_media_job_status CHECK (status IN ('queued','submitted','polling','retrieved','stored','succeeded','failed','expired','cancelled')),
  ADD CONSTRAINT ck_error_class CHECK (error_class IS NULL OR error_class IN ('retryable','manual','permanent')),
  ADD CONSTRAINT ck_media_job_subject_type CHECK (subject_type IN ('content_draft','judgment','media_job','workflow_run','kb_query','conversation','other')),
  ADD CONSTRAINT ck_media_job_prompt_len CHECK (prompt IS NULL OR char_length(prompt) <= 4000),
  ADD CONSTRAINT ck_media_job_poll_count CHECK (poll_count >= 0),
  ADD CONSTRAINT ck_media_job_cost CHECK (estimated_cost_cents >= 0 AND cost_cents >= 0),
  ADD CONSTRAINT ck_media_job_attempt CHECK (attempt BETWEEN 0 AND 3),
  ADD CONSTRAINT ck_media_job_max_attempts CHECK (max_attempts BETWEEN 1 AND 5),
  ADD CONSTRAINT ck_media_job_params_json CHECK (jsonb_typeof(params) = 'object'),
  ADD CONSTRAINT ck_media_job_input_ref_json CHECK (jsonb_typeof(input_ref) = 'object');

ALTER TABLE media_quota
  ADD CONSTRAINT ck_media_quota_period CHECK (period IN ('day','month','total')),
  ADD CONSTRAINT ck_media_quota_scope CHECK (sku_id IS NOT NULL OR batch_key IS NOT NULL),
  ADD CONSTRAINT ck_media_quota_limits CHECK (
    (max_images IS NULL OR max_images >= 0) AND (max_video_seconds IS NULL OR max_video_seconds >= 0)
  ),
  ADD CONSTRAINT ck_media_quota_used CHECK (used_images >= 0 AND used_video_seconds >= 0),
  ADD CONSTRAINT ck_media_quota_window CHECK (window_end IS NULL OR window_end > window_start);

-- 4.5 平台
ALTER TABLE listing
  ADD CONSTRAINT ck_listing_platform CHECK (platform IN ('pdd','1688')),
  ADD CONSTRAINT ck_listing_status CHECK (status IN ('draft','publishing','published','rejected','archived')),
  ADD CONSTRAINT ck_listing_platform_state_len CHECK (platform_state IS NULL OR char_length(platform_state) <= 64),
  ADD CONSTRAINT ck_listing_snapshot_json CHECK (jsonb_typeof(published_snapshot) = 'object'),
  ADD CONSTRAINT ck_listing_sku_bindings_array CHECK (jsonb_typeof(sku_bindings) = 'array'),
  ADD CONSTRAINT ck_listing_price_tiers_array CHECK (jsonb_typeof(price_tiers) = 'array'),
  ADD CONSTRAINT ck_listing_reject_meta_json CHECK (jsonb_typeof(reject_meta) = 'object');

ALTER TABLE sync_cursor
  ADD CONSTRAINT ck_sync_platform CHECK (platform IN ('pdd','1688')),
  ADD CONSTRAINT ck_sync_resource CHECK (resource IN ('orders','products','messages','after_sale','stock')),
  ADD CONSTRAINT ck_sync_status CHECK (status IN ('active','paused','error')),
  ADD CONSTRAINT ck_sync_page_size CHECK (page_size BETWEEN 1 AND 500),
  ADD CONSTRAINT ck_sync_failures CHECK (consecutive_failures >= 0),
  ADD CONSTRAINT ck_sync_stats_json CHECK (jsonb_typeof(stats) = 'object');

-- 4.6 客服
ALTER TABLE conversation
  ADD CONSTRAINT ck_conversation_platform CHECK (platform IN ('pdd','1688')),
  ADD CONSTRAINT ck_conversation_kind CHECK (kind IN ('pre_sale','after_sale','logistics','inquiry','quote','complaint')),
  ADD CONSTRAINT ck_conversation_status CHECK (status IN ('open','pending','closed','archived')),
  ADD CONSTRAINT ck_conv_buyer_ref_len CHECK (char_length(buyer_ref) <= 64),
  ADD CONSTRAINT ck_conv_unread CHECK (unread_count >= 0),
  ADD CONSTRAINT ck_conv_priority CHECK (priority BETWEEN 0 AND 9);

ALTER TABLE message
  ADD CONSTRAINT ck_msg_direction CHECK (direction IN ('inbound','outbound')),
  ADD CONSTRAINT ck_msg_content_type CHECK (content_type IN ('text','image','video','order_card','product_card','system')),
  ADD CONSTRAINT ck_msg_status CHECK (status IN ('received','drafted','pending_approval','queued','sending','sent','failed','blocked','deduped')),
  ADD CONSTRAINT ck_msg_content_len CHECK (char_length(content) <= 5000),
  ADD CONSTRAINT ck_msg_latency CHECK (latency_ms IS NULL OR latency_ms >= 0),
  ADD CONSTRAINT ck_msg_attachments_array CHECK (jsonb_typeof(attachments) = 'array');

-- 4.7 流程
ALTER TABLE workflow_run
  ADD CONSTRAINT ck_workflow_type CHECK (type IN ('publish','price_change','stock_sync','media_generate','reply','quote','reconcile','kb_reindex','batch_offline')),
  ADD CONSTRAINT ck_workflow_state CHECK (state IN ('pending','running','waiting_human','succeeded','failed_retryable','failed_permanent','cancelled')),
  ADD CONSTRAINT ck_workflow_stage CHECK (stage IS NULL OR stage ~ '^[a-z][a-z0-9_]{1,31}$'),
  ADD CONSTRAINT ck_workflow_subject_type CHECK (subject_type IN ('product','listing','content_draft','media_job','conversation','product_sku')),
  ADD CONSTRAINT ck_workflow_attempt CHECK (attempt >= 0),
  ADD CONSTRAINT ck_workflow_max_attempts CHECK (max_attempts BETWEEN 1 AND 10),
  ADD CONSTRAINT ck_workflow_error_message_len CHECK (error_message IS NULL OR char_length(error_message) <= 1000),
  ADD CONSTRAINT ck_workflow_error_class CHECK (error_class IS NULL OR error_class IN ('retryable','manual','permanent')),
  ADD CONSTRAINT ck_workflow_payload_json CHECK (jsonb_typeof(payload) = 'object'),
  ADD CONSTRAINT ck_workflow_result_json CHECK (jsonb_typeof(result) = 'object');

ALTER TABLE approval
  ADD CONSTRAINT ck_approval_subject_type CHECK (subject_type IN ('content_draft','listing','message','quote','media_asset','price_change','batch_action')),
  ADD CONSTRAINT ck_approval_action CHECK (action IN ('publish','update_price','update_stock','replace_main_image','change_category','send_reply','send_quote','upload_video','batch_offline')),
  ADD CONSTRAINT ck_approval_platform CHECK (platform IN ('pdd','1688')),
  ADD CONSTRAINT ck_operation_level CHECK (operation_level IN ('A','B','C')),
  ADD CONSTRAINT ck_approval_status CHECK (status IN ('pending','approved','approved_with_edit','rejected','scheduled','executed','failed','expired','cancelled','invalidated')),
  ADD CONSTRAINT ck_approval_decision CHECK (decision IS NULL OR decision IN ('approve','approve_with_edit','reject','schedule')),
  ADD CONSTRAINT ck_approval_target_hash CHECK (char_length(target_hash) = 64),
  ADD CONSTRAINT ck_approval_fact_snapshot_json CHECK (jsonb_typeof(fact_snapshot) = 'object'),
  ADD CONSTRAINT ck_approval_risk_meta_json CHECK (jsonb_typeof(risk_meta) = 'object'),
  ADD CONSTRAINT ck_approval_diff_json CHECK (jsonb_typeof(diff) = 'object'),
  ADD CONSTRAINT ck_approval_risk_c CHECK (operation_level <> 'C' OR risk_meta ? 'impact_scope');

ALTER TABLE compensating_ticket
  ADD CONSTRAINT ck_ticket_source CHECK (source IN ('irreversible_action','incident','platform_reject','manual','drill')),
  ADD CONSTRAINT ck_ticket_status CHECK (status IN ('open','in_progress','resolved','wontfix','escalated')),
  ADD CONSTRAINT ck_ticket_severity CHECK (severity IN ('info','low','medium','high','blocker')),
  ADD CONSTRAINT ck_ticket_platform CHECK (platform IS NULL OR platform IN ('pdd','1688')),
  ADD CONSTRAINT ck_ticket_action_len CHECK (char_length(action_taken) <= 500),
  ADD CONSTRAINT ck_ticket_approval CHECK (related_approval_id IS NOT NULL OR source IN ('incident','manual','drill')),
  ADD CONSTRAINT ck_ticket_impact_json CHECK (jsonb_typeof(impact) = 'object');

ALTER TABLE kill_switch
  ADD CONSTRAINT ck_switch_scope CHECK (scope_type IN ('global','platform','category','task_type')),
  ADD CONSTRAINT ck_switch_action CHECK (action IN ('block_writes','block_replies','block_media','block_model','readonly')),
  ADD CONSTRAINT ck_switch_scope_key_len CHECK (char_length(scope_key) <= 64),
  ADD CONSTRAINT ck_switch_reason_len CHECK (char_length(reason) BETWEEN 3 AND 500);

-- 4.8 治理
ALTER TABLE users
  ADD CONSTRAINT ck_user_status CHECK (status IN ('active','disabled','locked')),
  ADD CONSTRAINT ck_users_failed_attempts CHECK (failed_attempts >= 0),
  ADD CONSTRAINT ck_users_password_argon2 CHECK (password_hash ~ '^[$]argon2id[$]');

ALTER TABLE roles
  ADD CONSTRAINT ck_role_code CHECK (code IN ('viewer','operator','admin')),
  ADD CONSTRAINT ck_roles_system CHECK (NOT is_system OR code IN ('viewer','operator','admin'));

ALTER TABLE memberships
  ADD CONSTRAINT ck_membership_status CHECK (status IN ('active','revoked','expired'));

ALTER TABLE audit_log
  ADD CONSTRAINT ck_audit_actor_type CHECK (actor_type IN ('user','agent','worker','system')),
  ADD CONSTRAINT ck_audit_action CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  ADD CONSTRAINT ck_audit_chain_prev CHECK (chain_prev IS NULL OR char_length(chain_prev) = 64),
  ADD CONSTRAINT ck_audit_chain_hash CHECK (char_length(chain_hash) = 64),
  ADD CONSTRAINT ck_audit_irreversible CHECK (NOT irreversible OR after ? 'operation_level'),
  ADD CONSTRAINT ck_audit_ip_format CHECK (ip IS NULL OR ip ~ '^[0-9A-Fa-f:.]+$');

-- 4.9 知识
ALTER TABLE kb_document
  ADD CONSTRAINT ck_kb_source CHECK (source_type IN ('product','size_chart','fabric','policy','faq','platform_rule','copy_sample','care','manual')),
  ADD CONSTRAINT ck_kb_domain CHECK (domain IN ('product','size','fabric','policy','platform','copy','service')),
  ADD CONSTRAINT ck_kb_doc_status CHECK (status IN ('draft','active','superseded','expired','archived')),
  ADD CONSTRAINT ck_kb_index_status CHECK (index_status IN ('pending','indexed','failed','stale')),
  ADD CONSTRAINT ck_kb_doc_type CHECK (doc_type IN ('spec','table','policy','faq','rule','sample','guide')),
  ADD CONSTRAINT ck_kb_owner_role CHECK (owner_role_code IN ('viewer','operator','admin')),
  ADD CONSTRAINT ck_kb_acl_roles CHECK (acl_roles <@ ARRAY['viewer','operator','admin']::text[]),
  ADD CONSTRAINT ck_kb_visibility CHECK (domain <> 'copy' OR NOT ('viewer' = ANY (acl_roles))),
  ADD CONSTRAINT ck_kb_doc_title_len CHECK (char_length(title) BETWEEN 1 AND 200),
  ADD CONSTRAINT ck_kb_doc_version CHECK (version_no >= 1),
  ADD CONSTRAINT ck_kb_doc_checksum CHECK (char_length(checksum) = 64),
  ADD CONSTRAINT ck_kb_doc_bytes CHECK (bytes IS NULL OR bytes >= 0),
  ADD CONSTRAINT ck_kb_doc_chunk_count CHECK (chunk_count >= 0),
  ADD CONSTRAINT ck_kb_doc_effective CHECK (effective_to IS NULL OR effective_to > effective_from);

ALTER TABLE kb_chunk
  ADD CONSTRAINT ck_kb_chunk_type CHECK (chunk_type IN ('text','table','list','qa','snippet')),
  ADD CONSTRAINT ck_kb_chunk_status CHECK (status IN ('active','superseded','disabled')),
  ADD CONSTRAINT ck_kb_chunk_seq CHECK (seq >= 0),
  ADD CONSTRAINT ck_kb_chunk_content_len CHECK (char_length(content) BETWEEN 1 AND 4000),
  ADD CONSTRAINT ck_kb_chunk_content_hash CHECK (char_length(content_hash) = 64),
  ADD CONSTRAINT ck_kb_chunk_tokens CHECK (content_tokens >= 0),
  ADD CONSTRAINT ck_kb_chunk_embedding_dim CHECK (embedding_dim IS NULL OR embedding_dim = 1024),
  ADD CONSTRAINT ck_kb_chunk_metadata_json CHECK (jsonb_typeof(metadata) = 'object');

ALTER TABLE kb_query_log
  ADD CONSTRAINT ck_kb_query_purpose CHECK (purpose IN ('retrieval','judge_evidence','reply_draft','quote','admin_test')),
  ADD CONSTRAINT ck_kb_query_mode CHECK (mode IN ('hybrid','vector','keyword')),
  ADD CONSTRAINT ck_kb_query_role CHECK (role_code IN ('viewer','operator','admin')),
  ADD CONSTRAINT ck_kb_query_len CHECK (char_length(query) BETWEEN 1 AND 500),
  ADD CONSTRAINT ck_kb_top_k CHECK (top_k BETWEEN 1 AND 50),
  ADD CONSTRAINT ck_kb_hit_count CHECK (hit_count >= 0),
  ADD CONSTRAINT ck_kb_latency CHECK (latency_ms >= 0),
  ADD CONSTRAINT ck_kb_rerank_cost CHECK (rerank_cost_cents >= 0),
  ADD CONSTRAINT ck_kb_feedback CHECK (feedback IN ('none','helpful','unhelpful')),
  ADD CONSTRAINT ck_kb_degrade_reason CHECK (degrade_reason IS NULL OR degrade_reason IN ('no_vector','embed_unavailable','timeout','no_citation')),
  ADD CONSTRAINT ck_kb_filters_json CHECK (jsonb_typeof(filters) = 'object'),
  ADD CONSTRAINT ck_kb_hits_array CHECK (jsonb_typeof(hits) = 'array'),
  ADD CONSTRAINT ck_kb_citations_array CHECK (jsonb_typeof(citations) = 'array');

-- -------------------------------------------------------------
-- 4. 索引（docs/06 §5.1，按 docs/21 字段改名调整）
--    部分唯一索引是默认形态：软删表一律 WHERE archived_at IS NULL。
-- -------------------------------------------------------------

-- 商品
CREATE INDEX ix_product_status ON product (status, updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX ix_product_category_code ON product (category_code);
CREATE UNIQUE INDEX uq_product_spu ON product (org_id, spu_code) WHERE archived_at IS NULL;

-- SKU
CREATE UNIQUE INDEX uq_sku_natural ON product_sku (product_id, color_id, size_code, fabric_id) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX uq_sku_code ON product_sku (org_id, sku_code) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX uq_sku_barcode ON product_sku (org_id, barcode) WHERE barcode IS NOT NULL AND archived_at IS NULL;
CREATE INDEX ix_sku_product_status ON product_sku (product_id, status);
CREATE INDEX ix_sku_low_stock ON product_sku (product_id) WHERE stock_qty <= safety_stock;

-- 尺码表 / 面料
CREATE UNIQUE INDEX uq_size_chart ON size_chart (product_id, version_no, sku_size_code) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX uq_size_chart_effective ON size_chart (product_id) WHERE status = 'effective' AND archived_at IS NULL;
CREATE UNIQUE INDEX uq_fabric ON fabric_composition (product_id, version_no, fabric_code) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX uq_fabric_effective ON fabric_composition (product_id, fabric_code) WHERE status = 'effective' AND archived_at IS NULL;

-- 平台类目与属性映射
CREATE UNIQUE INDEX uq_category ON platform_category (org_id, platform, external_category_id) WHERE archived_at IS NULL;
CREATE INDEX ix_category_platform_leaf ON platform_category (platform, is_leaf, status);
CREATE INDEX ix_category_parent ON platform_category (platform, parent_external_id);
CREATE UNIQUE INDEX uq_pam ON platform_attribute_mapping (platform, platform_category_id, attr_path, internal_field, internal_value) WHERE archived_at IS NULL;
CREATE INDEX ix_pam_lookup ON platform_attribute_mapping (platform, internal_field, internal_value, status);

-- 内容与判断
CREATE INDEX ix_draft_product_type ON content_draft (product_id, content_type, status);
CREATE INDEX ix_draft_status_updated ON content_draft (status, updated_at DESC);
CREATE INDEX ix_draft_platform ON content_draft (platform, status);
CREATE INDEX ix_judgment_subject ON judgment (subject_type, subject_id, created_at DESC);
CREATE INDEX ix_judgment_status ON judgment (status, created_at);
CREATE INDEX ix_judgment_appeal ON judgment (appeal_status, created_at) WHERE appeal_status <> 'none';

-- 素材
CREATE INDEX ix_asset_product_kind ON media_asset (product_id, kind, status);
CREATE INDEX ix_asset_pending ON media_asset (created_at) WHERE status = 'pending_review';
CREATE INDEX ix_asset_sha ON media_asset (sha256);
CREATE UNIQUE INDEX uq_media_job_idem ON media_job (org_id, idempotency_key);
CREATE INDEX ix_media_job_poll ON media_job (status, poll_after) WHERE status IN ('submitted','polling');
CREATE INDEX ix_media_job_subject ON media_job (subject_type, subject_id);
CREATE INDEX ix_media_quota_scope ON media_quota (sku_id, batch_key) WHERE archived_at IS NULL;

-- 平台
CREATE UNIQUE INDEX uq_listing_item ON listing (org_id, platform, platform_item_id) WHERE platform_item_id IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX uq_listing_product ON listing (org_id, platform, product_id) WHERE archived_at IS NULL;
CREATE INDEX ix_listing_status ON listing (platform, status, updated_at DESC);
CREATE INDEX ix_listing_published ON listing (platform, published_at);

-- 同步
CREATE UNIQUE INDEX uq_sync_cursor ON sync_cursor (org_id, platform, shop_id, resource) WHERE archived_at IS NULL;
CREATE INDEX ix_sync_due ON sync_cursor (status, last_run_at);

-- 客服
CREATE UNIQUE INDEX uq_conv ON conversation (org_id, platform, platform_conversation_id) WHERE archived_at IS NULL;
CREATE INDEX ix_conv_platform_last ON conversation (platform, last_message_at DESC);
CREATE INDEX ix_conv_assigned ON conversation (assigned_user_id, status);
CREATE INDEX ix_conv_due ON conversation (first_response_due_at) WHERE first_response_at IS NULL AND status = 'open';
CREATE UNIQUE INDEX uq_msg_platform ON message (org_id, platform_message_id) WHERE platform_message_id IS NOT NULL;
CREATE UNIQUE INDEX uq_msg_outbound ON message (conversation_id, outbound_idempotency_key) WHERE outbound_idempotency_key IS NOT NULL;
CREATE INDEX ix_msg_conv_time ON message (conversation_id, sent_at);
CREATE INDEX ix_msg_sending ON message (status) WHERE status IN ('queued','sending');

-- 流程
CREATE UNIQUE INDEX uq_wf_idem ON workflow_run (org_id, type, idempotency_key);
CREATE INDEX ix_wf_state ON workflow_run (state);
CREATE INDEX ix_wf_due ON workflow_run (next_run_at) WHERE state IN ('pending','failed_retryable');
CREATE INDEX ix_wf_subject ON workflow_run (subject_type, subject_id);
CREATE UNIQUE INDEX uq_approval_open ON approval (subject_type, subject_id, action)
  WHERE status IN ('pending','scheduled','approved','approved_with_edit') AND archived_at IS NULL;
CREATE INDEX ix_approval_sla ON approval (status, sla_due_at);
CREATE INDEX ix_approval_level ON approval (operation_level, status);
CREATE INDEX ix_ticket_status_due ON compensating_ticket (status, due_at);
CREATE UNIQUE INDEX uq_switch_active ON kill_switch (org_id, scope_type, scope_key, action) WHERE enabled AND archived_at IS NULL;

-- 治理
CREATE UNIQUE INDEX uq_users_email ON users (org_id, lower(email)) WHERE archived_at IS NULL;
CREATE INDEX ix_users_status ON users (org_id, status);
CREATE UNIQUE INDEX uq_roles_code ON roles (org_id, code) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX uq_membership_active ON memberships (user_id, role_id) WHERE status = 'active' AND archived_at IS NULL;
CREATE INDEX ix_audit_resource ON audit_log (resource_type, resource_id, occurred_at DESC);
CREATE INDEX ix_audit_actor ON audit_log (actor_id, occurred_at DESC);
CREATE INDEX ix_audit_request ON audit_log (request_id);
CREATE INDEX ix_mcl_created ON model_call_log (created_at);
CREATE INDEX ix_mcl_subject ON model_call_log (subject_type, subject_id);
CREATE INDEX ix_mcl_model_created ON model_call_log (model_id, created_at DESC);
CREATE INDEX ix_mcl_purpose_created ON model_call_log (purpose, created_at);

-- 模型
CREATE UNIQUE INDEX uq_provider_name ON provider (org_id, name) WHERE archived_at IS NULL;
CREATE INDEX ix_provider_kind_status ON provider (kind, status);
CREATE UNIQUE INDEX uq_model_name ON model (org_id, name) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX uq_model_provider_external ON model (provider_id, external_model_id);
CREATE INDEX ix_model_capability_status ON model (capability, status);
CREATE UNIQUE INDEX uq_credential_ref_name ON credential_ref (org_id, name) WHERE archived_at IS NULL;
CREATE INDEX ix_credential_ref_status ON credential_ref (status);
CREATE UNIQUE INDEX uq_route_org ON model_route (org_id, purpose, priority)
  WHERE scope_type = 'org' AND status = 'active' AND archived_at IS NULL;
CREATE UNIQUE INDEX uq_route_role ON model_route (org_id, scope_role_id, purpose, priority)
  WHERE scope_type = 'role' AND status = 'active' AND archived_at IS NULL;
CREATE UNIQUE INDEX uq_route_user ON model_route (org_id, scope_user_id, purpose, priority)
  WHERE scope_type = 'user' AND status = 'active' AND archived_at IS NULL;
CREATE INDEX ix_route_lookup ON model_route (org_id, purpose, status, priority);

-- 知识
CREATE UNIQUE INDEX uq_kb_doc ON kb_document (org_id, source_type, source_id, version_no) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX uq_kb_doc_active ON kb_document (org_id, source_type, source_id) WHERE status = 'active' AND archived_at IS NULL;
CREATE INDEX ix_kb_doc_review ON kb_document (review_due_at) WHERE status = 'active';
CREATE INDEX ix_kb_doc_domain ON kb_document (domain, status);
CREATE UNIQUE INDEX uq_chunk ON kb_chunk (document_id, version_no, seq);
CREATE INDEX ix_chunk_doc ON kb_chunk (document_id, version_no, seq);
CREATE INDEX ix_chunk_embedding ON kb_chunk USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64) WHERE archived_at IS NULL;
CREATE INDEX ix_chunk_tsv ON kb_chunk USING gin (tsv);
CREATE INDEX ix_chunk_meta ON kb_chunk USING gin (metadata jsonb_path_ops);
CREATE INDEX ix_chunk_active ON kb_chunk (org_id, status) WHERE status = 'active';
CREATE INDEX ix_kbq_created ON kb_query_log (created_at);
CREATE INDEX ix_kbq_actor ON kb_query_log (actor_id, created_at DESC);
CREATE INDEX ix_kbq_degraded ON kb_query_log (degraded, created_at) WHERE degraded;

-- -------------------------------------------------------------
-- 5. 外键（命名 fk_<表>_<列>；docs/06 §0.1）
-- -------------------------------------------------------------

-- created_by → users(id)：28 张带 created_by 的表（memberships/audit_log/kb_chunk 无此列）
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','roles','credential_ref','provider','model','model_route','model_call_log',
    'platform_category','product','product_sku','size_chart','fabric_composition',
    'platform_attribute_mapping','content_draft','judgment','media_asset','media_job',
    'media_quota','listing','sync_cursor','conversation','message','workflow_run',
    'approval','compensating_ticket','kill_switch','kb_document','kb_query_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL',
                   t, 'fk_' || t || '_created_by');
  END LOOP;
END $$;

ALTER TABLE memberships
  ADD CONSTRAINT fk_memberships_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_memberships_role_id FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_memberships_granted_by FOREIGN KEY (granted_by) REFERENCES users(id) ON DELETE SET NULL;

-- provider.credential_ref 指向 DSH 凭据名：docs/21 §9 明确不建外键（真值在外部存储）。

ALTER TABLE model
  ADD CONSTRAINT fk_model_provider_id FOREIGN KEY (provider_id) REFERENCES provider(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_model_published_by FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE model_route
  ADD CONSTRAINT fk_model_route_model_id FOREIGN KEY (model_id) REFERENCES model(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_model_route_scope_role_id FOREIGN KEY (scope_role_id) REFERENCES roles(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_model_route_scope_user_id FOREIGN KEY (scope_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE model_call_log
  ADD CONSTRAINT fk_model_call_log_provider_id FOREIGN KEY (provider_id) REFERENCES provider(id),
  ADD CONSTRAINT fk_model_call_log_model_id FOREIGN KEY (model_id) REFERENCES model(id),
  ADD CONSTRAINT fk_model_call_log_route_id FOREIGN KEY (route_id) REFERENCES model_route(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_model_call_log_fallback_from_model_id FOREIGN KEY (fallback_from_model_id) REFERENCES model(id) ON DELETE SET NULL;

ALTER TABLE product
  ADD CONSTRAINT fk_product_main_asset_id FOREIGN KEY (main_asset_id) REFERENCES media_asset(id) ON DELETE SET NULL;

ALTER TABLE product_sku
  ADD CONSTRAINT fk_product_sku_product_id FOREIGN KEY (product_id) REFERENCES product(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_product_sku_fabric_id FOREIGN KEY (fabric_id) REFERENCES fabric_composition(id) ON DELETE RESTRICT;

ALTER TABLE size_chart
  ADD CONSTRAINT fk_size_chart_product_id FOREIGN KEY (product_id) REFERENCES product(id) ON DELETE RESTRICT;

ALTER TABLE fabric_composition
  ADD CONSTRAINT fk_fabric_composition_product_id FOREIGN KEY (product_id) REFERENCES product(id) ON DELETE RESTRICT;

ALTER TABLE platform_attribute_mapping
  ADD CONSTRAINT fk_pam_platform_category_id FOREIGN KEY (platform_category_id) REFERENCES platform_category(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_pam_product_id FOREIGN KEY (product_id) REFERENCES product(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_pam_sku_id FOREIGN KEY (sku_id) REFERENCES product_sku(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_pam_verified_by FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE content_draft
  ADD CONSTRAINT fk_content_draft_product_id FOREIGN KEY (product_id) REFERENCES product(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_content_draft_sku_id FOREIGN KEY (sku_id) REFERENCES product_sku(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_content_draft_judge_id FOREIGN KEY (judge_id) REFERENCES judgment(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_content_draft_approval_id FOREIGN KEY (approval_id) REFERENCES approval(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_content_draft_model_call_id FOREIGN KEY (model_call_id) REFERENCES model_call_log(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_content_draft_supersedes_id FOREIGN KEY (supersedes_id) REFERENCES content_draft(id) ON DELETE SET NULL;

ALTER TABLE judgment
  ADD CONSTRAINT fk_judgment_model_call_id FOREIGN KEY (model_call_id) REFERENCES model_call_log(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_judgment_appealed_by FOREIGN KEY (appealed_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_judgment_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE media_asset
  ADD CONSTRAINT fk_media_asset_product_id FOREIGN KEY (product_id) REFERENCES product(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_media_asset_sku_id FOREIGN KEY (sku_id) REFERENCES product_sku(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_media_asset_media_job_id FOREIGN KEY (media_job_id) REFERENCES media_job(id) ON DELETE SET NULL;

ALTER TABLE media_job
  ADD CONSTRAINT fk_media_job_provider_id FOREIGN KEY (provider_id) REFERENCES provider(id),
  ADD CONSTRAINT fk_media_job_model_id FOREIGN KEY (model_id) REFERENCES model(id),
  ADD CONSTRAINT fk_media_job_route_id FOREIGN KEY (route_id) REFERENCES model_route(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_media_job_media_asset_id FOREIGN KEY (media_asset_id) REFERENCES media_asset(id) ON DELETE SET NULL;

ALTER TABLE media_quota
  ADD CONSTRAINT fk_media_quota_sku_id FOREIGN KEY (sku_id) REFERENCES product_sku(id) ON DELETE SET NULL;

ALTER TABLE listing
  ADD CONSTRAINT fk_listing_product_id FOREIGN KEY (product_id) REFERENCES product(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_listing_approval_id FOREIGN KEY (approval_id) REFERENCES approval(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_listing_workflow_run_id FOREIGN KEY (workflow_run_id) REFERENCES workflow_run(id) ON DELETE SET NULL;

ALTER TABLE conversation
  ADD CONSTRAINT fk_conversation_assigned_user_id FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_conversation_related_product_id FOREIGN KEY (related_product_id) REFERENCES product(id) ON DELETE SET NULL;

ALTER TABLE message
  ADD CONSTRAINT fk_message_conversation_id FOREIGN KEY (conversation_id) REFERENCES conversation(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_message_approval_id FOREIGN KEY (approval_id) REFERENCES approval(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_message_judge_id FOREIGN KEY (judge_id) REFERENCES judgment(id) ON DELETE SET NULL;

ALTER TABLE workflow_run
  ADD CONSTRAINT fk_workflow_run_parent_run_id FOREIGN KEY (parent_run_id) REFERENCES workflow_run(id) ON DELETE SET NULL;

ALTER TABLE approval
  ADD CONSTRAINT fk_approval_decided_by FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_approval_escalated_to FOREIGN KEY (escalated_to) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_approval_judge_id FOREIGN KEY (judge_id) REFERENCES judgment(id) ON DELETE SET NULL;

ALTER TABLE compensating_ticket
  ADD CONSTRAINT fk_compensating_ticket_related_approval_id FOREIGN KEY (related_approval_id) REFERENCES approval(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_compensating_ticket_related_listing_id FOREIGN KEY (related_listing_id) REFERENCES listing(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_compensating_ticket_owner_user_id FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_compensating_ticket_audit_log_id FOREIGN KEY (audit_log_id) REFERENCES audit_log(id) ON DELETE SET NULL;

ALTER TABLE kill_switch
  ADD CONSTRAINT fk_kill_switch_enabled_by FOREIGN KEY (enabled_by) REFERENCES users(id),
  ADD CONSTRAINT fk_kill_switch_disabled_by FOREIGN KEY (disabled_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE kb_document
  ADD CONSTRAINT fk_kb_document_owner_user_id FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_kb_document_embed_model_id FOREIGN KEY (embed_model_id) REFERENCES model(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_kb_document_supersedes_id FOREIGN KEY (supersedes_id) REFERENCES kb_document(id) ON DELETE SET NULL;

ALTER TABLE kb_chunk
  ADD CONSTRAINT fk_kb_chunk_document_id FOREIGN KEY (document_id) REFERENCES kb_document(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_kb_chunk_embedding_model_id FOREIGN KEY (embedding_model_id) REFERENCES model(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_kb_chunk_superseded_by FOREIGN KEY (superseded_by) REFERENCES kb_chunk(id) ON DELETE SET NULL;

ALTER TABLE kb_query_log
  ADD CONSTRAINT fk_kb_query_log_actor_id FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL;

-- -------------------------------------------------------------
-- 6. 触发器
-- -------------------------------------------------------------

-- 6.1 updated_at 刷新 + version 乐观锁（27 张有 updated_at/version 的表）
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','roles','memberships','credential_ref','provider','model','model_route',
    'platform_category','product','product_sku','size_chart','fabric_composition',
    'platform_attribute_mapping','content_draft','judgment','media_asset','media_job',
    'media_quota','listing','sync_cursor','conversation','message','workflow_run',
    'approval','compensating_ticket','kill_switch','kb_document'
  ] LOOP
    EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    EXECUTE format('CREATE TRIGGER trg_bump_version BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION bump_version()', t);
  END LOOP;
END $$;

-- 6.2 审计只插入不更新（追加写 + 哈希链）
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;

-- 6.3 model_call_log 白名单更新
CREATE TRIGGER trg_mcl_immutable_cols BEFORE UPDATE ON model_call_log
  FOR EACH ROW EXECUTE FUNCTION mcl_immutable_cols();

-- 6.4 硬事实变更 → product.fact_version + 1
CREATE TRIGGER trg_product_fact_version_sku AFTER INSERT OR UPDATE OF
  price_cents, list_price_cents, sale_price_cents, price_tiers, stock_qty, safety_stock, min_order_qty, lead_time_days
  ON product_sku FOR EACH ROW EXECUTE FUNCTION bump_product_fact_version();
CREATE TRIGGER trg_product_fact_version_size AFTER INSERT OR UPDATE OF
  measurements, recommend_height_min, recommend_height_max, recommend_weight_min, recommend_weight_max
  ON size_chart FOR EACH ROW EXECUTE FUNCTION bump_product_fact_version();
CREATE TRIGGER trg_product_fact_version_fabric AFTER INSERT OR UPDATE OF materials
  ON fabric_composition FOR EACH ROW EXECUTE FUNCTION bump_product_fact_version();

-- 6.5 事实来源枚举兜底（仅 SKU 的两列）
CREATE TRIGGER trg_sku_fact_source BEFORE INSERT OR UPDATE OF price_source, stock_source
  ON product_sku FOR EACH ROW EXECUTE FUNCTION forbid_unknown_fact_source();

-- 6.6 SKU 尺码必须存在于该商品 effective 尺码表
CREATE TRIGGER trg_sku_size_exists BEFORE INSERT OR UPDATE OF size_code, product_id
  ON product_sku FOR EACH ROW EXECUTE FUNCTION check_sku_size_exists();

-- -------------------------------------------------------------
-- 7. 种子数据（docs/06 §8.3）
--    roles 三行；口令/凭据不得写入迁移文件，管理员账号由部署脚本一次性注入。
-- -------------------------------------------------------------

INSERT INTO roles (id, org_id, code, name, permissions, is_system, created_at, updated_at, version)
VALUES
  (gen_random_uuid(), 1, 'viewer',   '只读',   ARRAY[]::text[], true, now(), now(), 1),
  (gen_random_uuid(), 1, 'operator', '运营',   ARRAY[]::text[], true, now(), now(), 1),
  (gen_random_uuid(), 1, 'admin',    '管理员', ARRAY[]::text[], true, now(), now(), 1)
ON CONFLICT (org_id, code) WHERE archived_at IS NULL DO NOTHING;
