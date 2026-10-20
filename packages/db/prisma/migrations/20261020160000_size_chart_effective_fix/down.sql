-- =============================================================
-- 回滚（手工执行；Prisma 不执行 down migration）
-- 恢复 t17 之前的状态：移除 exclusion 约束与 uq_asset_object，
-- 重建旧的 uq_size_chart_effective（注意：旧索引会重新阻挡多码商品）。
-- =============================================================

DROP INDEX IF EXISTS uq_asset_object;
ALTER TABLE size_chart DROP CONSTRAINT IF EXISTS ex_size_chart_one_effective_version;

CREATE UNIQUE INDEX IF NOT EXISTS uq_size_chart_effective
  ON size_chart (product_id)
  WHERE status = 'effective' AND archived_at IS NULL;
