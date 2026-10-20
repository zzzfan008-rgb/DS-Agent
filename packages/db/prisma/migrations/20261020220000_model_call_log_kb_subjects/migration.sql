-- =============================================================
-- t33：model_call_log.subject_type 增加知识库归属类型
--
-- 背景：知识库 embedding 调用此前只能记 subject_type='other'，M7 真实使用后
-- 成本无法归集到文档/切片。放宽 CHECK，加入 kb_document、kb_chunk。
-- additive：只放宽枚举，不删列、不改必填。
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
    'kb_document',
    'kb_chunk',
    'other'
  ));
