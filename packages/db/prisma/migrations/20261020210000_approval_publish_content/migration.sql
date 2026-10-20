-- =============================================================
-- t32：approval.action 增加 publish_content（内容发布独立审批）
--
-- 背景：内容发布此前复用 listing 的 publish（B 级），导致“内容审批”与“上架审批”
-- 在数据上不可区分（t28 拆分）。本迁移只放宽枚举，不删列、不改必填。
-- =============================================================

ALTER TABLE approval DROP CONSTRAINT IF EXISTS ck_approval_action;
ALTER TABLE approval ADD CONSTRAINT ck_approval_action
  CHECK (action IN (
    'publish',
    'update_price',
    'update_stock',
    'replace_main_image',
    'change_category',
    'send_reply',
    'send_quote',
    'upload_video',
    'batch_offline',
    'publish_content'
  ));
