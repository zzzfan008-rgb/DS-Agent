-- =============================================================
-- t13：listing 平台类目的状态守卫（docs/06 v3 §3.4 / §4.5.1）
--
-- 背景：`listing.platform_category_id`、`fk_listing_platform_category_id`、
-- `ix_listing_platform_category`、触发器 `trg_listing_category_platform` 已在
-- 20261020145000_listing_platform_category 落地（t12 追加）。本迁移只补 t13 的
-- 第 3 条约束：草稿态允许类目为空，但 `publishing` / `published` 必须已有类目。
--
-- 分工（二选一的理由）：
--   - 跨表规则（platform_category.platform = listing.platform）无法用 CHECK 表达，
--     保留在触发器 trg_listing_category_platform（20261020145000）；
--   - 同行状态规则（status 与 platform_category_id 的关系）用 CHECK：
--     原子生效、对全部写入方（Prisma、raw SQL、运维脚本）一致生效、
--     不受触发器触发时机/顺序影响，且可被应用层用同一表达式预判；
--     应用层仍做可读错误提示 —— 即「CHECK + 触发器双保险」。
--
-- 只加约束，不改 t1 / t12 的迁移文件，不改已有列语义。
-- =============================================================

ALTER TABLE listing
  ADD CONSTRAINT ck_listing_published_category
  CHECK (status NOT IN ('publishing','published') OR platform_category_id IS NOT NULL);
