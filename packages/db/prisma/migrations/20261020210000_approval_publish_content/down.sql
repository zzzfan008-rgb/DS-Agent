-- =============================================================
-- t32 回滚（手工执行；Prisma 不执行 down migration）
-- 注意：若已有 publish_content 审批行，回滚会因 CHECK 收窄而失败（需先处理数据）。
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
    'batch_offline'
  ));
