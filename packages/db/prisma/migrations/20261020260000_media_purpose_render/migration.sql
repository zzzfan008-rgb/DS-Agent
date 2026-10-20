-- =============================================================
-- t39（F-E2E-02）：media_job.purpose 增加 render
-- M6 的尺码表渲染用 purpose=render，旧 CHECK 只允许 image/video，
-- DB 路径无法建渲染任务。additive：仅放宽 CHECK，不动数据。
-- =============================================================

ALTER TABLE media_job DROP CONSTRAINT IF EXISTS ck_media_purpose;

ALTER TABLE media_job
  ADD CONSTRAINT ck_media_purpose CHECK (purpose IN ('image','video','render'));
