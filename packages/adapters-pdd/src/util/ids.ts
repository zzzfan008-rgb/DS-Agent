import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 全链路 request_id（docs/12 §6）：适配层生成，写入留档与日志。 */
export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

/** 随机 nonce（防重放材料的一部分，不是平台事实）。 */
export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

/** UTC 日期目录名 YYYY-MM-DD（留档文件分日存放，避免单目录过大）。 */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isoNow(ms: number): string {
  return new Date(ms).toISOString();
}

/** 仓库根目录：packages/adapters-pdd/src/util/ids.ts → D:\DSSAAS */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
