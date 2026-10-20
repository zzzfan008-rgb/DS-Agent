/**
 * 脱敏工具：请求/响应留档与录制 fixture 共用。
 *
 * 原则：
 * - 凭据、签名材料、收件人 PII 一律不落盘；
 * - 键名大小写不敏感，`-` / `_` 归一后比较；
 * - 输出两种占位符：留档 `[REDACTED]`，fixture `<redacted:键名>`（与 tests/contract 的格式一致）。
 */

const SENSITIVE_KEYS = new Set([
  'appkey',
  'appsecret',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'cookie',
  'setcookie',
  'sign',
  'signature',
  'secret',
  'password',
  'token',
  'xrequestid',
  'xpddsignature',
  'xpddsignaturescheme',
  'xpddaccesstoken',
  'xpddappkey',
  'xpddsignaturematerial',
  'timestamp',
  'nonce',
  'mobile',
  'phone',
  'receivername',
  'receiveraddress',
  'buyernick',
  'shopname',
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

export type RedactMode = 'archive' | 'fixture';

function placeholder(key: string, mode: RedactMode): string {
  if (mode === 'fixture') return `<redacted:${key.toLowerCase()}>`;
  return '[REDACTED]';
}

/**
 * 深拷贝并脱敏；不修改入参。
 * `null` / 非对象原样返回，数字/布尔不扫描（避免把正常业务数字当敏感值）。
 */
export function redactDeep(value: unknown, mode: RedactMode = 'archive'): unknown {
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, mode));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? placeholder(key, mode) : redactDeep(child, mode);
    }
    return out;
  }
  return value;
}

export function redactHeaders(
  headers: Record<string, string>,
  mode: RedactMode = 'archive',
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = isSensitiveKey(key) ? placeholder(key, mode) : value;
  }
  return out;
}

/** 对 JSON 文本做脱敏；解析失败则返回原文本（不猜测结构）。 */
export function redactJsonText(text: string, mode: RedactMode = 'archive'): unknown {
  try {
    return redactDeep(JSON.parse(text), mode);
  } catch {
    return text;
  }
}
