/** ID / 哈希 / 规范化工具：请求 ID、UUID v7、ULID、稳定 JSON 与常量时间比较。 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** UUID v7：48-bit 毫秒时间戳 + 版本/变体位 + 随机。与 DB 的 uuid v7 口径一致。 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(now);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** ULID：26 字符 Crockford Base32（时间 10 + 随机 16）。 */
export function ulid(now: number = Date.now()): string {
  let time = BigInt(now);
  let timePart = '';
  for (let i = 0; i < 10; i += 1) {
    timePart = CROCKFORD[Number(time & 31n)]! + timePart;
    time >>= 5n;
  }
  let random = BigInt(`0x${randomBytes(10).toString('hex')}`);
  let randomPart = '';
  for (let i = 0; i < 16; i += 1) {
    randomPart = CROCKFORD[Number(random & 31n)]! + randomPart;
    random >>= 5n;
  }
  return timePart + randomPart;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** 客户端 X-Request-Id 合法则沿用，否则服务端生成 `req_` + ULID。 */
export function normalizeRequestId(incoming: string | string[] | undefined): string {
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  if (value && REQUEST_ID_PATTERN.test(value)) return value;
  return `req_${ulid()}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 稳定 JSON：对象键排序、Date→ISO、BigInt→字符串，用于哈希与幂等比较。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child !== undefined) sorted[key] = canonicalize(child);
    }
    return sorted;
  }
  return value;
}

export function sha256Json(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function hashEmail(email: string): string {
  return sha256Hex(`email:${email.trim().toLowerCase()}`);
}

/** 常量时间字符串比较；长度不同直接 false（不泄漏长度以外信息）。 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
