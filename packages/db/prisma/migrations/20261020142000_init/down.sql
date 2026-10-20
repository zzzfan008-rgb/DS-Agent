-- =============================================================
-- 回滚脚本（手工执行；Prisma 不执行 down migration）
--
-- Prisma migrations 只有 up（migration.sql）。docs/06 §0.9 要求的「可回滚」
-- 在本项目中按以下方式落地：
--   1) 迁移本身可重复：空库连续 deploy 两次幂等（CI 校验）；
--   2) 需要回滚时，用本文件在目标库执行（先备份），再由 ops 记录变更；
--   3) 生产禁止直接 DROP：回滚演练在影子库/恢复卷上做（docs/20 §6）。
-- =============================================================

DROP TABLE IF EXISTS kb_query_log CASCADE;
DROP TABLE IF EXISTS kb_chunk CASCADE;
DROP TABLE IF EXISTS kb_document CASCADE;
DROP TABLE IF EXISTS kill_switch CASCADE;
DROP TABLE IF EXISTS compensating_ticket CASCADE;
DROP TABLE IF EXISTS approval CASCADE;
DROP TABLE IF EXISTS workflow_run CASCADE;
DROP TABLE IF EXISTS message CASCADE;
DROP TABLE IF EXISTS conversation CASCADE;
DROP TABLE IF EXISTS sync_cursor CASCADE;
DROP TABLE IF EXISTS listing CASCADE;
DROP TABLE IF EXISTS media_quota CASCADE;
DROP TABLE IF EXISTS media_job CASCADE;
DROP TABLE IF EXISTS media_asset CASCADE;
DROP TABLE IF EXISTS judgment CASCADE;
DROP TABLE IF EXISTS content_draft CASCADE;
DROP TABLE IF EXISTS platform_attribute_mapping CASCADE;
DROP TABLE IF EXISTS product_sku CASCADE;
DROP TABLE IF EXISTS fabric_composition CASCADE;
DROP TABLE IF EXISTS size_chart CASCADE;
DROP TABLE IF EXISTS product CASCADE;
DROP TABLE IF EXISTS platform_category CASCADE;
DROP TABLE IF EXISTS model_call_log CASCADE;
DROP TABLE IF EXISTS model_route CASCADE;
DROP TABLE IF EXISTS model CASCADE;
DROP TABLE IF EXISTS provider CASCADE;
DROP TABLE IF EXISTS credential_ref CASCADE;
DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS memberships CASCADE;
DROP TABLE IF EXISTS roles CASCADE;
DROP TABLE IF EXISTS users CASCADE;

DROP FUNCTION IF EXISTS check_sku_size_exists() CASCADE;
DROP FUNCTION IF EXISTS bump_product_fact_version() CASCADE;
DROP FUNCTION IF EXISTS mcl_immutable_cols() CASCADE;
DROP FUNCTION IF EXISTS reject_audit_mutation() CASCADE;
DROP FUNCTION IF EXISTS fact_envelope_valid(jsonb) CASCADE;
DROP FUNCTION IF EXISTS fabric_materials_valid(jsonb) CASCADE;
DROP FUNCTION IF EXISTS forbid_unknown_fact_source() CASCADE;
DROP FUNCTION IF EXISTS bump_version() CASCADE;
DROP FUNCTION IF EXISTS set_updated_at() CASCADE;

-- vector / pgcrypto 扩展可能被其他库共用，回滚时保留，由运维按实例决定。
