-- =============================================================
-- t34：media_job 多实例租约（locked_by / locked_until）
--
-- 背景：进程内 poller 在多实例下会重复推进；poll_after 语义是“下次轮询时间”，
-- 不能兼职租约（长任务超过租约会被重复抢）。新增显式租约列 + 部分索引。
-- additive：只加列/索引，不改已有列。
-- =============================================================

ALTER TABLE media_job ADD COLUMN locked_by TEXT;
ALTER TABLE media_job ADD COLUMN locked_until TIMESTAMPTZ;

-- 只索引当前持有租约的行，供“可抢占任务”查询与运维排查
CREATE INDEX ix_media_job_lease ON media_job (status, locked_until) WHERE locked_by IS NOT NULL;
