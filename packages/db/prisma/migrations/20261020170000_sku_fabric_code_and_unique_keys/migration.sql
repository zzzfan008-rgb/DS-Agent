-- =============================================================
-- t19：数据建模修正（docs/21 §18）
--
-- 18-1 SKU 面料身份改用稳定编码：
--   - 新增 product_sku.fabric_code，从 fabric_id → fabric_composition.fabric_code 回填；
--   - 自然键改为 (product_id, color_id, size_code, fabric_code)；
--   - 删除 fabric_id 外键与列（当前无生产数据，直接替换；down.sql 保留还原路径）。
--   - fabric_composition 仍版本化（fabric_code + version_no + materials + status），
--     换版本不改变 SKU 身份。
-- 18-2 platform_attribute_mapping 唯一键改为
--      (platform, platform_category_id, attr_path, internal_value) WHERE archived_at IS NULL。
-- 18-3 message 的 platform_message_id 唯一键改为会话内唯一；
--      outbound_idempotency_key 已是 (conversation_id, ...)，无需变更（见注释）。
-- 18-4 listing.platform_item_id 已是条件唯一（NULL 不参与），不改；多店铺边界见验收记录。
-- 18-5 kb_document 的 source_id 为空时不参与唯一（手工文档可多行）。
--
-- 说明：docs/21 §18 使用 "source_ref" 一词，实际列名为 kb_document.source_id（docs/06 §4.9.1），
--       本迁移按实际列名实现。
-- =============================================================

-- -------------------------------------------------------------
-- 18-1 SKU 面料身份
-- -------------------------------------------------------------
ALTER TABLE product_sku ADD COLUMN fabric_code TEXT;

UPDATE product_sku s
SET fabric_code = f.fabric_code
FROM fabric_composition f
WHERE f.id = s.fabric_id;

-- 历史数据必须全部回填；fabric_id 原为 NOT NULL + FK，正常不会为空。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM product_sku WHERE fabric_code IS NULL) THEN
    RAISE EXCEPTION 'product_sku.fabric_code backfill failed: some rows have no fabric_composition match';
  END IF;
END $$;

ALTER TABLE product_sku ALTER COLUMN fabric_code SET NOT NULL;

DROP INDEX IF EXISTS uq_sku_natural;
ALTER TABLE product_sku DROP CONSTRAINT IF EXISTS fk_product_sku_fabric_id;
ALTER TABLE product_sku DROP COLUMN fabric_id;

CREATE UNIQUE INDEX uq_sku_natural
  ON product_sku (product_id, color_id, size_code, fabric_code)
  WHERE archived_at IS NULL;

-- -------------------------------------------------------------
-- 18-2 平台属性映射：唯一键带类目，去掉 internal_field
-- -------------------------------------------------------------
DROP INDEX IF EXISTS uq_pam;
CREATE UNIQUE INDEX uq_pam
  ON platform_attribute_mapping (platform, platform_category_id, attr_path, internal_value)
  WHERE archived_at IS NULL;

-- -------------------------------------------------------------
-- 18-3 消息去重按会话隔离
-- -------------------------------------------------------------
DROP INDEX IF EXISTS uq_msg_platform;
CREATE UNIQUE INDEX uq_msg_platform
  ON message (conversation_id, platform_message_id)
  WHERE platform_message_id IS NOT NULL;

-- uq_msg_outbound 已是 (conversation_id, outbound_idempotency_key)
--   WHERE outbound_idempotency_key IS NOT NULL，满足 18-3，无需变更。

-- -------------------------------------------------------------
-- 18-4 listing：现有 uq_listing_item 已带 WHERE platform_item_id IS NOT NULL
--      （完整定义：(org_id, platform, platform_item_id) WHERE platform_item_id IS NOT NULL
--       AND archived_at IS NULL），无需变更；不引入 shop_id。
-- -------------------------------------------------------------

-- -------------------------------------------------------------
-- 18-5 知识库：source_id 为空（手工文档）不参与唯一
-- -------------------------------------------------------------
DROP INDEX IF EXISTS uq_kb_doc;
CREATE UNIQUE INDEX uq_kb_doc
  ON kb_document (org_id, source_type, source_id, version_no)
  WHERE archived_at IS NULL AND source_id IS NOT NULL;

DROP INDEX IF EXISTS uq_kb_doc_active;
CREATE UNIQUE INDEX uq_kb_doc_active
  ON kb_document (org_id, source_type, source_id)
  WHERE status = 'active' AND archived_at IS NULL AND source_id IS NOT NULL;
