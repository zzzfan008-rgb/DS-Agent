-- t37 回滚（手工执行；Prisma 不执行 down migration）
-- 先删子表/触发器所在表，避免 FK 依赖。
DROP TABLE IF EXISTS after_sale;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS drift_log;
