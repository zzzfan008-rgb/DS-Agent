-- =============================================================
-- t33 回滚（手工执行；Prisma 不执行 down migration）
-- 注意：若已有 subject_type 为 kb_document/kb_chunk 的调用日志，回滚会因 CHECK 收窄失败。
-- =============================================================

ALTER TABLE model_call_log DROP CONSTRAINT IF EXISTS ck_mcl_subject_type;
ALTER TABLE model_call_log ADD CONSTRAINT ck_mcl_subject_type
  CHECK (subject_type IN (
    'content_draft',
    'judgment',
    'media_job',
    'workflow_run',
    'kb_query',
    'conversation',
    'other'
  ));
