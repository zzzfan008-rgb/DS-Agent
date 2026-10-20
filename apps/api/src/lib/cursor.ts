/** 游标分页：不透明 base64url(JSON)，客户端不得构造（docs/12 §5）。 */
import type { ZodType } from 'zod';
import { ApiError } from './errors.js';

export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T>(cursor: string, schema: ZodType<T>): T {
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error('cursor shape');
    return parsed.data;
  } catch {
    throw new ApiError('validation_failed', '游标无效', { detail: { field: 'cursor' } });
  }
}

export function parseLimit(raw: unknown, fallback = 20, max = 100): number {
  if (raw === undefined || raw === '') return fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new ApiError('validation_failed', `limit 必须是 1-${max} 的整数`, {
      detail: { field: 'limit' },
    });
  }
  return limit;
}
