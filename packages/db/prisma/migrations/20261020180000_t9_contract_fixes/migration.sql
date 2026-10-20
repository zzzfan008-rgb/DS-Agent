-- =============================================================
-- t20：补齐 t9 写入门所需的 DB 契约（additive；不删列、不改必填）
--
-- 依据 docs/11 §4.1（失败五类）、t9 写入门登记：
--   1) workflow_run.error_class / media_job.error_class 放宽为五类：
--      retryable | manual | permanent | uncertain | guard
--      （uncertain = 写操作“可能已生效”，必须先对账；语义由应用保证，DB 只允许该值）
--   2) approval 增加三列：
--      second_confirm_by（C 级四眼第二审批人，不得与 decided_by 相同）
--      payload_patch（“修改后批准”的实际差异，payload_hash 由应用重算）
--      batch_id（批量审批分组）+ ix_approval_batch
--   3) 补 SLA 查询索引 ix_approval_status_sla (status, sla_due_at)
--   4) kill_switch.scope_type 扩到六类：
--      global | platform | category | task_type | listing | provider
--
-- 只加列/放宽 CHECK/加索引；不改任何已有列的 NOT NULL 与语义。
-- =============================================================

-- -------------------------------------------------------------
-- 1) 失败分类五类（docs/11 §4.1）
-- -------------------------------------------------------------
ALTER TABLE workflow_run DROP CONSTRAINT IF EXISTS ck_workflow_error_class;
ALTER TABLE workflow_run ADD CONSTRAINT ck_workflow_error_class
  CHECK (error_class IS NULL OR error_class IN ('retryable','manual','permanent','uncertain','guard'));

ALTER TABLE media_job DROP CONSTRAINT IF EXISTS ck_error_class;
ALTER TABLE media_job ADD CONSTRAINT ck_error_class
  CHECK (error_class IS NULL OR error_class IN ('retryable','manual','permanent','uncertain','guard'));

-- -------------------------------------------------------------
-- 2) 审批三列（C 级四眼 / 修改后批准 / 批量审批）
-- -------------------------------------------------------------
ALTER TABLE approval ADD COLUMN second_confirm_by UUID;
ALTER TABLE approval ADD COLUMN payload_patch JSONB;
ALTER TABLE approval ADD COLUMN batch_id UUID;

-- 四眼：第二审批人不得与第一审批人相同；未决定（decided_by 为空）时允许预填第二审批人
ALTER TABLE approval ADD CONSTRAINT ck_approval_second_confirm_distinct
  CHECK (second_confirm_by IS NULL OR second_confirm_by <> decided_by);

-- 第二审批人必须是真实用户（与 decided_by 同口径）
ALTER TABLE approval ADD CONSTRAINT fk_approval_second_confirm_by
  FOREIGN KEY (second_confirm_by) REFERENCES users(id) ON DELETE SET NULL;

-- 批量审批分组：只索引有批次的行
CREATE INDEX ix_approval_batch ON approval (batch_id) WHERE batch_id IS NOT NULL;

-- SLA 查询与积压统计（原 ix_approval_sla 改名为契约要求的名字）
DROP INDEX IF EXISTS ix_approval_sla;
CREATE INDEX ix_approval_status_sla ON approval (status, sla_due_at);

-- -------------------------------------------------------------
-- 3) 应急开关作用域六类（t9 fail-closed 需要按 listing/provider 精确停写）
-- -------------------------------------------------------------
ALTER TABLE kill_switch DROP CONSTRAINT IF EXISTS ck_switch_scope;
ALTER TABLE kill_switch ADD CONSTRAINT ck_switch_scope
  CHECK (scope_type IN ('global','platform','category','task_type','listing','provider'));
