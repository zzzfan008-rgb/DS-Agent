-- =============================================================
-- t35 回滚（手工执行；Prisma 不执行 down migration）
-- 注意：恢复旧口径会把 approved/approved_with_edit 重新纳入唯一，可能导致
-- 同对象同动作的多条历史审批无法共存；若已有该数据，回滚会失败。
-- =============================================================

DROP INDEX IF EXISTS uq_approval_open;

CREATE UNIQUE INDEX uq_approval_open ON approval (subject_type, subject_id, action)
  WHERE status IN ('pending','scheduled','approved','approved_with_edit') AND archived_at IS NULL;
