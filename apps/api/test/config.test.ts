/** 配置加载与校验（不依赖数据库）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig, redactDatabaseUrl } from '../src/config.js';
import { parseTotpSecrets } from '../src/lib/totp.js';
import { canonicalJson, normalizeRequestId, uuidv7, ulid } from '../src/lib/ids.js';

test('缺少 DATABASE_URL 时抛 ConfigError 且带字段名', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'test' }),
    (error: unknown) =>
      error instanceof ConfigError && error.issues.some((issue) => issue.includes('DATABASE_URL')),
  );
});

test('生产默认 Secure + __Host- cookie；开发默认非 Secure', () => {
  const production = loadConfig({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  });
  assert.equal(production.cookieSecure, true);
  assert.equal(production.sessionCookieName, '__Host-dssaas_sid');
  assert.equal(production.csrfRequireOrigin, true);

  const development = loadConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  });
  assert.equal(development.cookieSecure, false);
  assert.equal(development.sessionCookieName, 'dssaas_sid');
});

test('TOTP secrets JSON 解析容错', () => {
  assert.deepEqual(parseTotpSecrets('{"a":"JBSWY3DPEHPK3PXP"}'), { a: 'JBSWY3DPEHPK3PXP' });
  assert.deepEqual(parseTotpSecrets(''), {});
  assert.deepEqual(parseTotpSecrets('not-json'), {});
  assert.deepEqual(parseTotpSecrets('{"a":1}'), {});
});

test('ID 工具：UUIDv7 格式、ULID 长度、request_id 校验、稳定 JSON', () => {
  assert.match(uuidv7(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(ulid(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(normalizeRequestId('client-req-1'), 'client-req-1');
  assert.match(normalizeRequestId('bad id with spaces'), /^req_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test('DATABASE_URL 日志脱敏', () => {
  const redacted = redactDatabaseUrl('postgresql://user:secret@localhost:5432/db');
  assert.ok(!redacted.includes('secret'));
  assert.ok(redacted.includes('user'));
});
