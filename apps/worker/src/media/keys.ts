/**
 * MinIO 对象键（docs/10 §6.1/§6.2）：**单桶 + 前缀**。
 *
 * 桶：`dssaas-media`（可用 MEDIA_BUCKET 覆盖）。
 * 前缀：
 *   raw/      平台原始物料 / 供应商源文件
 *   derived/  变体（缩略图/详情/平台主图/尺码表）
 *   mock/     演练产物与下载临时区（取消时按 `_tmp/<job_id>/` 清理）
 *   exports/  上架包等导出物
 *
 * 键格式：`<prefix>/<kind>/<org_id>/<yyyy>/<mm>/<asset_id>/<name>.<ext>`
 * 仅 [a-z0-9._/-]，不含中文与商品名。
 */
export const MEDIA_BUCKET = process.env.MEDIA_BUCKET ?? 'dssaas-media';

export const PREFIX = {
  raw: 'raw',
  derived: 'derived',
  mock: 'mock',
  exports: 'exports',
} as const;

export type ObjectPrefix = keyof typeof PREFIX;

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

function objectKeyBase(input: {
  prefix: ObjectPrefix;
  kind: string;
  orgId: bigint | number;
  at: Date;
  assetId: string;
}): string {
  return [
    assertSegment(PREFIX[input.prefix]),
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
  return `${objectKeyBase({ ...input, prefix: 'raw' })}/source.${assertSegment(input.ext)}`;
}

export function variantObjectKey(input: {
  kind: string;
  orgId: bigint | number;
  at: Date;
  assetId: string;
  variantKey: string;
  ext: string;
}): string {
  return `${objectKeyBase({ ...input, prefix: 'derived' })}/${assertSegment(input.variantKey)}.${assertSegment(input.ext)}`;
}

export function chartObjectKey(input: {
  kind: string;
  orgId: bigint | number;
  at: Date;
  assetId: string;
  dataVersion: string;
}): string {
  return `${objectKeyBase({ ...input, prefix: 'derived' })}/chart_${assertSegment(input.dataVersion)}.png`;
}

/** 导出物（上架包/报表）：`exports/<name>`，调用方负责命名合法化。 */
export function exportObjectKey(name: string): string {
  return `${PREFIX.exports}/${name
    .split('/')
    .map((segment) => assertSegment(segment))
    .join('/')}`;
}

/** 下载/渲染临时区（演练产物）：取消任务时按前缀清理。 */
export function tempPrefix(jobId: string): string {
  return `${PREFIX.mock}/_tmp/${assertSegment(jobId)}/`;
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
