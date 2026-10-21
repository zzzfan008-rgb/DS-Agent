-- =============================================================
-- t53 回滚脚本（手工执行；Prisma 不执行 down migration）
-- 仅回滚 t53 新增的 platform_account 表（含其索引/触发器/外键，随表 CASCADE）。
-- 既有 44 张表与 set_updated_at() / bump_version() 函数不动。
-- 注意：仓库中已无该表时重复执行为 no-op（IF EXISTS），可用于演练。
-- =============================================================

DROP TABLE IF EXISTS platform_account CASCADE;
