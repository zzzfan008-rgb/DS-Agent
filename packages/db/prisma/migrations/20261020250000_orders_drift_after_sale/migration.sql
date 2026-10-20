-- =============================================================
-- t37：补齐 drift_log / orders / order_items / after_sale
--
-- 背景：docs/12 §3.9 声明订单/售后同步、docs/18/docs/20 引用 drift_log，
-- 但 docs/06 与 t1 均未建表，M8 对账只能停在 listing 维度。
-- additive：四张新表 + 约束/索引/触发器；不改既有表。
-- =============================================================

CREATE TABLE "drift_log" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "platform" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "drift_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fixed_at" TIMESTAMPTZ,
    "fixed_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,
    CONSTRAINT "drift_log_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "platform" TEXT NOT NULL,
    "platform_order_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "total_cents" INTEGER NOT NULL DEFAULT 0,
    "freight_cents" INTEGER NOT NULL DEFAULT 0,
    "discount_cents" INTEGER NOT NULL DEFAULT 0,
    "paid_cents" INTEGER NOT NULL DEFAULT 0,
    "buyer_ref" TEXT NOT NULL,
    "buyer_note" TEXT,
    "platform_created_at" TIMESTAMPTZ NOT NULL,
    "paid_at" TIMESTAMPTZ,
    "shipped_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "cancelled_at" TIMESTAMPTZ,
    "raw_object_key" TEXT,
    "synced_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,
    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "order_id" UUID NOT NULL,
    "listing_id" UUID,
    "sku_id" UUID,
    "platform_sku_ref" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "color_id" TEXT,
    "size_code" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unit_price_cents" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "attrs" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,
    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "after_sale" (
    "id" UUID NOT NULL,
    "org_id" BIGINT NOT NULL DEFAULT 1,
    "platform" TEXT NOT NULL,
    "platform_after_sale_id" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "amount_cents" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "opened_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ,
    "raw_object_key" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ,
    CONSTRAINT "after_sale_pkey" PRIMARY KEY ("id")
);

-- -------------------------------------------------------------
-- CHECK：枚举 / 金额 / 长度 / 公共字段
-- -------------------------------------------------------------
ALTER TABLE drift_log
  ADD CONSTRAINT ck_drift_platform CHECK (platform IN ('pdd','1688')),
  ADD CONSTRAINT ck_drift_key_len CHECK (char_length(drift_key) BETWEEN 1 AND 200),
  ADD CONSTRAINT ck_drift_kind_len CHECK (char_length(kind) BETWEEN 1 AND 64),
  ADD CONSTRAINT ck_drift_severity_len CHECK (char_length(severity) BETWEEN 1 AND 32),
  ADD CONSTRAINT ck_drift_detail_json CHECK (jsonb_typeof(detail) = 'object'),
  ADD CONSTRAINT ck_drift_org_id CHECK (org_id > 0),
  ADD CONSTRAINT ck_drift_version CHECK (version >= 1);

ALTER TABLE orders
  ADD CONSTRAINT ck_order_platform CHECK (platform IN ('pdd','1688')),
  ADD CONSTRAINT ck_order_platform_id_len CHECK (char_length(platform_order_id) BETWEEN 1 AND 128),
  ADD CONSTRAINT ck_order_status CHECK (status IN (
    'pending','paid','shipped','delivered','completed','refunding','refunded','cancelled')),
  ADD CONSTRAINT ck_order_amounts CHECK (
    total_cents >= 0 AND freight_cents >= 0 AND discount_cents >= 0 AND paid_cents >= 0),
  -- buyer_ref 只允许 sha256 小写十六进制：禁止把昵称/手机号等明文写进订单表
  ADD CONSTRAINT ck_order_buyer_ref_hash CHECK (
    char_length(buyer_ref) = 64 AND buyer_ref ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT ck_order_buyer_note_len CHECK (buyer_note IS NULL OR char_length(buyer_note) <= 1000),
  ADD CONSTRAINT ck_order_org_id CHECK (org_id > 0),
  ADD CONSTRAINT ck_order_version CHECK (version >= 1);

ALTER TABLE order_items
  ADD CONSTRAINT ck_order_item_qty CHECK (qty > 0),
  ADD CONSTRAINT ck_order_item_prices CHECK (unit_price_cents >= 0 AND amount_cents >= 0),
  ADD CONSTRAINT ck_order_item_attrs_json CHECK (jsonb_typeof(attrs) = 'object'),
  ADD CONSTRAINT ck_order_item_ref_len CHECK (char_length(platform_sku_ref) BETWEEN 1 AND 128),
  ADD CONSTRAINT ck_order_item_title_len CHECK (char_length(title) BETWEEN 1 AND 500),
  ADD CONSTRAINT ck_order_item_org_id CHECK (org_id > 0),
  ADD CONSTRAINT ck_order_item_version CHECK (version >= 1);

ALTER TABLE after_sale
  ADD CONSTRAINT ck_after_sale_platform CHECK (platform IN ('pdd','1688')),
  ADD CONSTRAINT ck_after_sale_platform_id_len CHECK (char_length(platform_after_sale_id) BETWEEN 1 AND 128),
  ADD CONSTRAINT ck_after_sale_kind CHECK (kind IN ('refund_only','return_refund','exchange')),
  ADD CONSTRAINT ck_after_sale_status_len CHECK (char_length(status) BETWEEN 1 AND 32),
  ADD CONSTRAINT ck_after_sale_amount CHECK (amount_cents >= 0),
  ADD CONSTRAINT ck_after_sale_reason_len CHECK (reason IS NULL OR char_length(reason) <= 1000),
  ADD CONSTRAINT ck_after_sale_org_id CHECK (org_id > 0),
  ADD CONSTRAINT ck_after_sale_version CHECK (version >= 1);

-- -------------------------------------------------------------
-- FK：订单级联明细；售后 RESTRICT 订单；listing/sku 可空 SET NULL
-- -------------------------------------------------------------
ALTER TABLE drift_log
  ADD CONSTRAINT fk_drift_fixed_by FOREIGN KEY (fixed_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_drift_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE orders
  ADD CONSTRAINT fk_order_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE order_items
  ADD CONSTRAINT fk_order_item_order_id FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_order_item_listing_id FOREIGN KEY (listing_id) REFERENCES listing(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_order_item_sku_id FOREIGN KEY (sku_id) REFERENCES product_sku(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_order_item_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE after_sale
  ADD CONSTRAINT fk_after_sale_order_id FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_after_sale_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- -------------------------------------------------------------
-- 唯一/索引
-- -------------------------------------------------------------
CREATE UNIQUE INDEX uq_drift_day ON drift_log (platform, day, drift_key)
  WHERE archived_at IS NULL;
CREATE INDEX ix_drift_open ON drift_log (day, severity) WHERE fixed_at IS NULL;

CREATE UNIQUE INDEX uq_order_platform ON orders (platform, platform_order_id)
  WHERE archived_at IS NULL;
CREATE INDEX ix_order_day ON orders (platform, platform_created_at);
CREATE INDEX ix_order_status ON orders (status, platform_created_at);

CREATE UNIQUE INDEX uq_order_item ON order_items (order_id, platform_sku_ref)
  WHERE archived_at IS NULL;

CREATE UNIQUE INDEX uq_after_sale ON after_sale (platform, platform_after_sale_id)
  WHERE archived_at IS NULL;
CREATE INDEX ix_after_sale_order ON after_sale (order_id);

-- -------------------------------------------------------------
-- 公共字段触发器：updated_at 刷新 + version 乐观锁
-- -------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['drift_log','orders','order_items','after_sale'] LOOP
    EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    EXECUTE format('CREATE TRIGGER trg_bump_version BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION bump_version()', t);
  END LOOP;
END $$;
