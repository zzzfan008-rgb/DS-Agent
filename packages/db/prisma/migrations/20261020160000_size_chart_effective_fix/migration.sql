-- =============================================================
-- t17：修复 size_chart 生效版本唯一性（多码商品被旧索引挡住）
--
-- 问题：
--   旧索引 uq_size_chart_effective (product_id) WHERE status='effective' AND archived_at IS NULL
--   限制「一个商品最多一行 effective」，但模型是「一尺码一行、一个版本多行」，
--   插入同版本第 2 个尺码就冲突 → 多码商品无法创建（t8 实测）。
--
-- 修复思路：
--   任务书给的 UNIQUE (product_id, version_no) WHERE effective 仍会挡住同版本多码
--   （同版本多行的 product_id+version_no 完全相同），与行为验收矛盾；因此改用
--   EXCLUDE 约束表达同一语义：
--     - 同一 product_id 下，version_no 必须相同（即只允许一个 effective 版本）；
--     - 同一版本内允许多行（多个 sku_size_code）。
--   需要 btree_gist（Postgres contrib，pgvector/pgvector:pg16 已内置）。
--
-- 同时保留：
--   - uq_size_chart (product_id, version_no, sku_size_code) WHERE archived_at IS NULL（版本内唯一）；
--   - 触发器 check_sku_size_exists 语义不变：SKU 的尺码必须出现在该商品 effective 版本中。
--
-- 同类排查补齐：
--   - media_asset 缺 uq_asset_object (bucket, object_key)（docs/06 §4.4.1 要求，t1 漏建）。
--
-- 只加约束/索引，不改列语义；additive 迁移。
-- =============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1) 删除旧的「一个商品一行 effective」错误索引
DROP INDEX IF EXISTS uq_size_chart_effective;

-- 2) 一个商品只允许一个 effective 版本；同一版本内允许多尺码行
ALTER TABLE size_chart
  ADD CONSTRAINT ex_size_chart_one_effective_version
  EXCLUDE USING gist (product_id WITH =, version_no WITH <>)
  WHERE (status = 'effective' AND archived_at IS NULL);

-- 3) 同类排查补齐：媒体对象键唯一（bucket + object_key），软删后允许重建
CREATE UNIQUE INDEX uq_asset_object ON media_asset (bucket, object_key) WHERE archived_at IS NULL;
