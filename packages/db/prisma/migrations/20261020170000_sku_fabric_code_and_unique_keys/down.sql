-- =============================================================
-- t19 回滚（手工执行；Prisma 不执行 down migration）
--
-- 注意：本回滚为「尽力还原」：
--   - 会重新引入 fabric_id 版本耦合（SKU 身份随面料版本变化）；
--   - fabric_id 按 (product_id, fabric_code, 最大 version_no) 回填，若原数据已被清理可能为 NULL；
--   - 若存在同 product/color/size/fabric_code 的重复自然键，旧索引创建会失败。
-- =============================================================

DROP INDEX IF EXISTS uq_kb_doc_active;
CREATE UNIQUE INDEX uq_kb_doc_active
  ON kb_document (org_id, source_type, source_id)
  WHERE status = 'active' AND archived_at IS NULL;

DROP INDEX IF EXISTS uq_kb_doc;
CREATE UNIQUE INDEX uq_kb_doc
  ON kb_document (org_id, source_type, source_id, version_no)
  WHERE archived_at IS NULL;

DROP INDEX IF EXISTS uq_msg_platform;
CREATE UNIQUE INDEX uq_msg_platform
  ON message (org_id, platform_message_id)
  WHERE platform_message_id IS NOT NULL;

DROP INDEX IF EXISTS uq_pam;
CREATE UNIQUE INDEX uq_pam
  ON platform_attribute_mapping (platform, platform_category_id, attr_path, internal_field, internal_value)
  WHERE archived_at IS NULL;

DROP INDEX IF EXISTS uq_sku_natural;
ALTER TABLE product_sku ADD COLUMN fabric_id UUID;

UPDATE product_sku s
SET fabric_id = f.id
FROM fabric_composition f
WHERE f.product_id = s.product_id
  AND f.fabric_code = s.fabric_code
  AND f.version_no = (
    SELECT max(f2.version_no)
    FROM fabric_composition f2
    WHERE f2.product_id = s.product_id AND f2.fabric_code = s.fabric_code
  );

ALTER TABLE product_sku
  ADD CONSTRAINT fk_product_sku_fabric_id
  FOREIGN KEY (fabric_id) REFERENCES fabric_composition(id) ON DELETE RESTRICT;

ALTER TABLE product_sku DROP COLUMN fabric_code;

CREATE UNIQUE INDEX uq_sku_natural
  ON product_sku (product_id, color_id, size_code, fabric_id)
  WHERE archived_at IS NULL;
