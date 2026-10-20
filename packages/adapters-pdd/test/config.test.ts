import assert from 'node:assert/strict';
import test from 'node:test';
import { describePddConfig, loadPddConfig } from '../src/config.js';
import { isPddError } from '../src/errors.js';

const FULL_ENV = {
  PDD_APP_KEY: 'key-123',
  PDD_APP_SECRET: 'secret-456',
  PDD_ACCESS_TOKEN: 'token-789',
  PDD_API_BASE_URL: 'https://api.pdd.example.invalid',
  PDD_ENVIRONMENT: 'sandbox',
} as const;

test('缺省配置进入 dry-run（missing_credentials），且不包含任何凭据', () => {
  const config = loadPddConfig({ env: {} });
  assert.equal(config.mode, 'dry_run');
  assert.equal(config.dryRun, true);
  assert.equal(config.dryRunReason, 'missing_credentials');
  assert.equal(config.appKey, null);
  assert.equal(config.appSecret, null);
  assert.equal(config.accessToken, null);
  assert.equal(config.baseUrl, null);
  assert.ok(config.warnings.some((warning) => warning.includes('PDD_ENVIRONMENT')));
});

test('完整配置 + 显式 PDD_DRY_RUN=1 → forced_by_env', () => {
  const config = loadPddConfig({ env: { ...FULL_ENV, PDD_DRY_RUN: '1' } });
  assert.equal(config.mode, 'dry_run');
  assert.equal(config.dryRunReason, 'forced_by_env');
  assert.ok(config.warnings.some((warning) => warning.includes('PDD_DRY_RUN')));
});

test('只有 appKey 没有 appSecret → config_error（半配置 fail fast）', () => {
  assert.throws(
    () => loadPddConfig({ env: { PDD_APP_KEY: 'only-key' } }),
    (error: unknown) => {
      assert.equal(isPddError(error), true);
      assert.equal((error as { code: string }).code, 'config_error');
      assert.match((error as Error).message, /必须同时配置/);
      return true;
    },
  );
});

test('缺少 access token / baseUrl 分别给出明确 dry-run 原因', () => {
  const noToken = loadPddConfig({
    env: {
      PDD_APP_KEY: 'key',
      PDD_APP_SECRET: 'secret',
      PDD_API_BASE_URL: 'https://api.pdd.example.invalid',
    },
  });
  assert.equal(noToken.mode, 'dry_run');
  assert.equal(noToken.dryRunReason, 'missing_access_token');

  const noBase = loadPddConfig({
    env: {
      PDD_APP_KEY: 'key',
      PDD_APP_SECRET: 'secret',
      PDD_ACCESS_TOKEN: 'token',
    },
  });
  assert.equal(noBase.mode, 'dry_run');
  assert.equal(noBase.dryRunReason, 'missing_base_url');
  assert.ok(noBase.warnings.some((warning) => warning.includes('PDD_API_BASE_URL')));
});

test('凭据 + token + https baseUrl → live', () => {
  const config = loadPddConfig({ env: { ...FULL_ENV } });
  assert.equal(config.mode, 'live');
  assert.equal(config.dryRunReason, null);
  assert.equal(config.baseUrl, 'https://api.pdd.example.invalid');
  assert.equal(config.environment, 'sandbox');
});

test('非本机 http baseUrl 被拒绝（只允许 https）', () => {
  assert.throws(
    () => loadPddConfig({ env: { ...FULL_ENV, PDD_API_BASE_URL: 'http://api.pdd.example.invalid' } }),
    /必须是 https/,
  );
});

test('占位符凭据视为未配置（不会被当成真实密钥）', () => {
  const config = loadPddConfig({ env: { PDD_APP_KEY: 'changeme', PDD_APP_SECRET: 'TODO' } });
  assert.equal(config.mode, 'dry_run');
  assert.equal(config.dryRunReason, 'missing_credentials');
});

test('describePddConfig 不返回密钥明文', () => {
  const config = loadPddConfig({ env: { ...FULL_ENV } });
  const summary = describePddConfig(config);
  const text = JSON.stringify(summary);
  assert.equal(text.includes('secret-456'), false);
  assert.equal(text.includes('token-789'), false);
  assert.equal(summary.app_secret_configured, true);
  assert.equal(summary.access_token_configured, true);
});

test('非法数值配置立即报错', () => {
  assert.throws(() => loadPddConfig({ env: { ...FULL_ENV, PDD_TIMEOUT_MS: 'abc' } }), /PDD_TIMEOUT_MS/);
  assert.throws(() => loadPddConfig({ env: { ...FULL_ENV, PDD_MAX_ATTEMPTS: '0' } }), /PDD_MAX_ATTEMPTS/);
  assert.throws(() => loadPddConfig({ env: { ...FULL_ENV, PDD_ENVIRONMENT: 'prod' } }), /PDD_ENVIRONMENT/);
});
