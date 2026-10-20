/**
 * MinIO 对象键（docs/10 §6.2）与桶策略。
 *
 * 任务口径（t26）：三个逻辑桶
 *   media          原图/视频（源对象）
 *   media-variants 变体（缩略图/详情/平台主图/尺码表）
 *   media-raw      平台原始物料与下载临时区
 * 注：docs/10 §6.1 把上述域表达为单桶 dssaas-media 的顶层前缀（raw/derived/...），
 * 实现上以三个桶默认，可用环境变量覆盖为单桶前缀模式（见 README/验收记录“已知差异”）。
 *
 * 键格式：`<kind>/<org_id>/<yyyy>/<mm>/<asset_id>/<name>.<ext>`
 * 仅 [a-z0-9._/-]，不含中文与商品名。
 */
export const MEDIA_BUCKET = process.env.MEDIA_BUCKET ?? 'media';
export const VARIANTS_BUCKET = process.env.MEDIA_VARIANTS_BUCKET ?? 'media-variants';
export const RAW_BUCKET = process.env.MEDIA_RAW_BUCKET ?? 'media-raw';

const KEY_SEGMENT = /^[a-z0-9._-]+$/i;

function assertSegment(value: string): string {
  if (!KEY_SEGMENT.test(value)) throw new Error(`非法对象键片段：${value}`);
  return value;
}

export function datePrefix(at: Date): string {
  const yyyy = at.getUTCFullYear().toString().padStart(4, '0');
  const mm = (at.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${yyyy}/${mm}`;
}

export function objectKeyBase(input: {
  kind: string;
  orgId: bigint | number;
  at: Date;
  assetId: string;
}): string {
  return [
    assertSegment(input.kind),
    String(input.orgId),
    datePrefix(input.at),
    assertSegment(input.assetId),
  ].join('/');
}

export function sourceObjectKey(input: {
  kind: string;
  orgId: bigint | number;
  at: Date;
  assetId: string;
  ext: string;
}): string {
  return `${objectKeyBase(input)}/source.${assertSegment(input.ext)}`;
}

export function variantObjectKey(input: {
  kind: string;
  orgId: bigint | number;
  at: Date;
  assetId: string;
  variantKey: string;
  ext: string;
}): string {
  return `${objectKeyBase(input)}/${assertSegment(input.variantKey)}.${assertSegment(input.ext)}`;
}

export function chartObjectKey(input: {
  kind: string;
  orgId: bigint | number;
  at: Date;
  assetId: string;
  dataVersion: string;
}): string {
  return `${objectKeyBase(input)}/chart_${assertSegment(input.dataVersion)}.png`;
}

/** 下载/渲染临时区：取消任务时按前缀清理。 */
export function tempPrefix(jobId: string): string {
  return `_tmp/${assertSegment(jobId)}/`;
}

export function mimeToExt(mime: string): 'png' | 'jpg' | 'webp' | 'mp4' {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'video/mp4':
      return 'mp4';
    default:
      throw new Error(`不支持的 MIME：${mime}`);
  }
}
