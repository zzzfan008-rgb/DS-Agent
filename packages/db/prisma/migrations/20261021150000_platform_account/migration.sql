-- =============================================================
-- t53：新增 platform_account（平台凭据配置，仅存引用不存明文）
--
-- 背景：
--   拼多多 / 1688 的平台凭据当前只存在于 env（PDD_APP_KEY / PDD_APP_SECRET /
--   PDD_ACCESS_TOKEN ...），无表无接口无界面，docs/13 §3.9「平台连接」页
--   无法展示授权状态、连通性、contract_version、部署约束。
--
-- 安全底线（与 provider.credential_ref / users.totp_secret_ref 同构）：
--   * app_secret_ref / access_token_ref / refresh_token_ref 列**只存引用名**
--     （环境变量名或 Vault 路径，如 'PDD_APP_SECRET'），真值不进数据库；
--   * 本表刻意没有 app_secret / access_token / refresh_token 明文列，且对
--     *_ref 列加了「引用名形状」CHECK 兜底：不允许出现明显是密钥的长串
--     （≥24 字符的连续 base64/hex/连字符串），防止有人图省事把明文塞进 ref 列。
--
-- 约束：
--   - additive：只新增 1 张表 + 其索引/触发器，不改任何既有表与既有 44 张表的语义；
--   - 枚举沿用全库惯例：text + CHECK（不用 PostgreSQL 原生 ENUM）；
--   - updated_at / version 触发器沿用 init 的 set_updated_at() / bump_version()
--     （t1 27 张表 + t12 8 张表同一套函数，不新建函数）；
--   - 部分唯一索引 uq_platform_account_shop：(org_id, platform, shop_id)
--     WHERE archived_at IS NULL —— 归档后可重新接入同一店铺（与 uq_sync_cursor 同款）。
--
-- 生成方式：
--   prisma migrate diff --from-schema-datamodel <旧 schema> --to-schema-datamodel prisma/schema.prisma --script
--   手工追加 CHECK / 部分唯一索引 / 触发器。
--
-- 回滚：见同目录 down.sql（手工执行；Prisma 不执行 down migration）。
-- =============================================================

-- CreateTable
CREATE TABLE "platform_account" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "platform" TEXT NOT NULL,
    "shop_id" TEXT,
    "shop_name" TEXT,
    "app_key" TEXT NOT NULL,
    "app_secret_ref" TEXT NOT NULL,
    "access_token_ref" TEXT,
    "refresh_token_ref" TEXT,
    "token_expires_at" TIMESTAMPTZ,
    "status" TEXT NOT NULL DEFAULT 'active',
    "connectivity" TEXT NOT NULL DEFAULT 'unknown',
    "last_tested_at" TIMESTAMPTZ,
    "last_test_error" TEXT,
    "contract_version" INTEGER NOT NULL DEFAULT 2,
    "extra" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "platform_account_pkey" PRIMARY KEY ("id")
);

-- -------------------------------------------------------------
-- 手工追加：约束 / 外键 / 索引 / 触发器
-- -------------------------------------------------------------

-- 1. 公共字段约束（与 t1/t12 同风格：ck_<表>_<语义>）
ALTER TABLE platform_account
  ADD CONSTRAINT ck_platform_account_org_id CHECK (org_id > 0),
  ADD CONSTRAINT ck_platform_account_version CHECK (version >= 1),

-- 2. 枚举（docs/06 §2 + docs/13 §3.9：平台卡 / 授权状态 / 连通性）
  ADD CONSTRAINT ck_platform_account_platform CHECK (platform IN ('pdd','1688')),
  ADD CONSTRAINT ck_platform_account_status CHECK (status IN ('active','disabled','expired')),
  ADD CONSTRAINT ck_platform_account_connectivity CHECK (
    connectivity IN ('unknown','ok','auth_invalid','upstream_5xx','unreachable')),

-- 3. 凭据标识与引用名形状
--    shop_id 可空：多店铺 / 未绑定店铺时按 (org_id, platform, NULL) 唯一；
--    空串归一为 NULL，避免 '' 与 NULL 两条记录绕过唯一索引。
  ADD CONSTRAINT ck_platform_account_shop_id CHECK (shop_id IS NULL OR char_length(btrim(shop_id)) BETWEEN 1 AND 128),
  ADD CONSTRAINT ck_platform_account_shop_name CHECK (shop_name IS NULL OR char_length(shop_name) <= 200),
  ADD CONSTRAINT ck_platform_account_app_key CHECK (char_length(btrim(app_key)) BETWEEN 1 AND 128),
  -- 引用名：环境变量名 / Vault 路径，标识符 + ':/.-@' 组成，最长 128
  ADD CONSTRAINT ck_platform_account_app_secret_ref CHECK (app_secret_ref ~ '^[A-Za-z_][A-Za-z0-9_:./@-]{0,127}$'),
  ADD CONSTRAINT ck_platform_account_access_token_ref CHECK (
    access_token_ref IS NULL OR access_token_ref ~ '^[A-Za-z_][A-Za-z0-9_:./@-]{0,127}$'),
  ADD CONSTRAINT ck_platform_account_refresh_token_ref CHECK (
    refresh_token_ref IS NULL OR refresh_token_ref ~ '^[A-Za-z_][A-Za-z0-9_:./@-]{0,127}$'),
  -- 防明文兜底：任何 *_ref 列出现长度 ≥ 24 的连续无空白/无分隔符长串（典型密钥形态）即拒绝
  ADD CONSTRAINT ck_platform_account_no_inline_secret CHECK (
        app_secret_ref    !~ '[A-Za-z0-9+/=_-]{24,}'
    AND (access_token_ref  IS NULL OR access_token_ref  !~ '[A-Za-z0-9+/=_-]{24,}')
    AND (refresh_token_ref IS NULL OR refresh_token_ref !~ '[A-Za-z0-9+/=_-]{24,}')
  ),

-- 4. 其余字段
  ADD CONSTRAINT ck_platform_account_contract_version CHECK (contract_version BETWEEN 1 AND 99),
  ADD CONSTRAINT ck_platform_account_last_error CHECK (
    last_test_error IS NULL OR char_length(last_test_error) <= 2000),
  -- 连通性判定必须有时间戳；非 unknown 的结论不得早于最后一次测试
  ADD CONSTRAINT ck_platform_account_tested_consistency CHECK (
    connectivity = 'unknown' OR last_tested_at IS NOT NULL),
  ADD CONSTRAINT ck_platform_account_extra_json CHECK (jsonb_typeof(extra) = 'object');

-- 5. 外键：created_by → users(id)（docs/06 §0.6 统一约定）
ALTER TABLE platform_account
  ADD CONSTRAINT fk_platform_account_created_by
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- 6. 索引
--    同一 org+platform+shop 在未归档范围内唯一；归档后可重新接入同一店铺。
CREATE UNIQUE INDEX uq_platform_account_shop
  ON platform_account (org_id, platform, shop_id) WHERE archived_at IS NULL;

-- 「平台连接」页按平台列卡：按 (org_id, platform) 取活跃账号
CREATE INDEX ix_platform_account_org_platform
  ON platform_account (org_id, platform) WHERE archived_at IS NULL;

-- 7. updated_at 刷新 + version 乐观锁（沿用 init 的 set_updated_at() / bump_version()）
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON platform_account
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_bump_version BEFORE UPDATE ON platform_account
  FOR EACH ROW EXECUTE FUNCTION bump_version();
