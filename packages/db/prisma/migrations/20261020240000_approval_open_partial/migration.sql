-- =============================================================
-- t35：uq_approval_open 改为仅约束“活跃审批”
--
-- 现状缺陷：索引把 approved/approved_with_edit 也算“活跃”，同一对象同一动作
-- 一旦审批通过（或被驳回前后的历史行），后续重新提交会被 P2002 挡住。
-- 目标：只有 pending / scheduled 参与唯一；其余状态（approved、approved_with_edit、
-- rejected、executed、failed、expired、cancelled、invalidated）均视为已结束。
--
-- 保留 archived_at IS NULL：软删的 pending 行不应继续占用唯一槽位。
-- =============================================================

DROP INDEX IF EXISTS uq_approval_open;

CREATE UNIQUE INDEX uq_approval_open ON approval (subject_type, subject_id, action)
  WHERE status IN ('pending', 'scheduled') AND archived_at IS NULL;
