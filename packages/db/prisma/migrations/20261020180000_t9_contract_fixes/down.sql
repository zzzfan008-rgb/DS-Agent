-- =============================================================
-- t20 回滚（手工执行；Prisma 不执行 down migration）
--
-- 注意：回滚会收窄 CHECK；若已有数据使用 uncertain/guard 或
-- listing/provider 作用域，回滚将失败（这是有意的：不允许静默丢语义）。
-- =============================================================

DROP INDEX IF EXISTS ix_approval_status_sla;
CREATE INDEX ix_approval_sla ON approval (status, sla_due_at);

DROP INDEX IF EXISTS ix_approval_batch;
ALTER TABLE approval DROP CONSTRAINT IF EXISTS fk_approval_second_confirm_by;
ALTER TABLE approval DROP CONSTRAINT IF EXISTS ck_approval_second_confirm_distinct;
ALTER TABLE approval DROP COLUMN IF EXISTS batch_id;
ALTER TABLE approval DROP COLUMN IF EXISTS payload_patch;
ALTER TABLE approval DROP COLUMN IF EXISTS second_confirm_by;

ALTER TABLE workflow_run DROP CONSTRAINT IF EXISTS ck_workflow_error_class;
ALTER TABLE workflow_run ADD CONSTRAINT ck_workflow_error_class
  CHECK (error_class IS NULL OR error_class IN ('retryable','manual','permanent'));

ALTER TABLE media_job DROP CONSTRAINT IF EXISTS ck_error_class;
ALTER TABLE media_job ADD CONSTRAINT ck_error_class
  CHECK (error_class IS NULL OR error_class IN ('retryable','manual','permanent'));

ALTER TABLE kill_switch DROP CONSTRAINT IF EXISTS ck_switch_scope;
ALTER TABLE kill_switch ADD CONSTRAINT ck_switch_scope
  CHECK (scope_type IN ('global','platform','category','task_type'));
