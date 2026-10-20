/**
 * 拼多多适配层配置（M1）。
 *
 * 核心安全语义：**缺省即 dry-run**。
 * - 没有 appKey/appSecret/accessToken/baseUrl 时，`mode='dry_run'`，客户端不会发起任何网络请求；
 * - 半配置（只有 key 没有 secret）直接 fail fast，避免"以为在真跑、实际配置错了"的静默失败；
 * - `PDD_DRY_RUN=0` 只是"希望真跑"，仍要凭据与 baseUrl 齐全才会切到 live。
 *
 * 待核验项（docs/01）不在这里编造：
 * - 生产/沙箱调用域名 → `PDD_API_BASE_URL`，无默认值；
 * - 签名算法 → `src/http/signer.ts` 的占位实现；
 * - 平台限流 → 这里只配置**本地节流** `PDD_INTERNAL_QPS`（保守占位值，不是平台事实）。
 */

import path from 'node:path';
import { configError } from './errors.js';
import { REPO_ROOT } from './util/ids.js';

export type PddMode = 'dry_run' | 'live';

export type PddDryRunReason =
  | 'forced_by_env'
  | 'missing_credentials'
  | 'missing_access_token'
  | 'missing_base_url';

export type PddEnvironment = 'production' | 'sandbox' | 'unknown';

export interface PddConfig {
  mode: PddMode;
  dryRun: boolean;
  dryRunReason: PddDryRunReason | null;
  warnings: string[];
  appKey: string | null;
  appSecret: string | null;
  accessToken: string | null;
  baseUrl: string | null;
  environment: PddEnvironment;
  timeoutMs: number;
  maxAttempts: number;
  maxResponseBytes: number;
  /** 本地令牌桶速率（QPS），仅内部节流；不是平台限流事实。 */
  internalQps: number;
  /** 签名时间窗容忍（毫秒）；占位默认值，待 docs/01 §3 #6 核验后调整。 */
  clockSkewWindowMs: number;
  archiveDir: string;
}

export interface PddConfigSummary {
  mode: PddMode;
  dry_run_reason: PddDryRunReason | null;
  environment: PddEnvironment;
  base_url_configured: boolean;
  app_key_configured: boolean;
  app_secret_configured: boolean;
  access_token_configured: boolean;
  timeout_ms: number;
  max_attempts: number;
  internal_qps: number;
  archive_dir: string;
  warnings: string[];
}

const PLACEHOLDER_RE = /^(|changeme|change-me|change_me|todo|tbd|placeholder|example|xxx+|your[-_].*|<.*>)$/i;

function readString(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '' || PLACEHOLDER_RE.test(value)) return null;
  return value;
}

function readBool(env: NodeJS.ProcessEnv, key: string): boolean | null {
  const raw = readString(env, key);
  if (raw === null) return null;
  const normalized = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw configError(`${key} 必须是布尔值（1/0、true/false、yes/no、on/off），实际为 "${raw}"`);
}

function readPositiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  const raw = readString(env, key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw configError(`${key} 必须是 ${min}..${max} 的整数，实际为 "${raw}"`);
  }
  return value;
}

function readPositiveNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  { min = 0.01, max = 1000 }: { min?: number; max?: number } = {},
): number {
  const raw = readString(env, key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw configError(`${key} 必须是 ${min}..${max} 的数值，实际为 "${raw}"`);
  }
  return value;
}

function readBaseUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = readString(env, 'PDD_API_BASE_URL');
  if (raw === null) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw configError(`PDD_API_BASE_URL 不是合法 URL：${raw}`);
  }
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw configError('PDD_API_BASE_URL 必须是 https（本机回放测试允许 http://127.0.0.1）');
  }
  return url.toString().replace(/\/$/, '');
}

function readEnvironment(env: NodeJS.ProcessEnv): PddEnvironment {
  const raw = readString(env, 'PDD_ENVIRONMENT');
  if (raw === null) return 'unknown';
  if (raw === 'production' || raw === 'sandbox') return raw;
  throw configError(`PDD_ENVIRONMENT 只能是 production|sandbox，实际为 "${raw}"`);
}

export interface LoadPddConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** 留档目录；默认 `<repo>/artifacts/pdd-http-archive`。 */
  archiveDir?: string;
}

export function loadPddConfig(options: LoadPddConfigOptions = {}): PddConfig {
  const env = options.env ?? process.env;
  const warnings: string[] = [];

  const appKey = readString(env, 'PDD_APP_KEY');
  const appSecret = readString(env, 'PDD_APP_SECRET');
  const accessToken = readString(env, 'PDD_ACCESS_TOKEN');
  const baseUrl = readBaseUrl(env);
  const environment = readEnvironment(env);
  const forceDryRun = readBool(env, 'PDD_DRY_RUN') === true;

  if ((appKey === null) !== (appSecret === null)) {
    throw configError('PDD_APP_KEY 与 PDD_APP_SECRET 必须同时配置（当前只配置了其中一个）');
  }
  if (accessToken !== null && appKey === null) {
    throw configError('配置了 PDD_ACCESS_TOKEN 但缺少 PDD_APP_KEY/PDD_APP_SECRET');
  }

  const archiveDir = path.resolve(options.archiveDir ?? readString(env, 'PDD_ARCHIVE_DIR') ?? path.join(REPO_ROOT, 'data/pdd-http-archive'));
  const timeoutMs = readPositiveInt(env, 'PDD_TIMEOUT_MS', 10_000, { min: 100, max: 120_000 });
  const maxAttempts = readPositiveInt(env, 'PDD_MAX_ATTEMPTS', 3, { min: 1, max: 6 });
  const maxResponseBytes = readPositiveInt(env, 'PDD_MAX_RESPONSE_BYTES', 2 * 1024 * 1024, {
    min: 1024,
    max: 64 * 1024 * 1024,
  });
  const internalQps = readPositiveNumber(env, 'PDD_INTERNAL_QPS', 0.5, { min: 0.01, max: 100 });
  const clockSkewWindowMs = readPositiveInt(env, 'PDD_CLOCK_SKEW_WINDOW_MS', 5 * 60_000, {
    min: 1000,
    max: 60 * 60_000,
  });

  let dryRunReason: PddDryRunReason | null = null;
  if (forceDryRun) {
    dryRunReason = 'forced_by_env';
    warnings.push('PDD_DRY_RUN 为真：即使凭据齐全也只做 dry-run，不发起平台调用。');
  } else if (appKey === null) {
    dryRunReason = 'missing_credentials';
  } else if (accessToken === null) {
    dryRunReason = 'missing_access_token';
  } else if (baseUrl === null) {
    dryRunReason = 'missing_base_url';
    warnings.push('PDD_API_BASE_URL 未配置：调用域名未核验（docs/01 §3），保持 dry-run。');
  }

  if (environment === 'unknown') {
    warnings.push('PDD_ENVIRONMENT 未配置：生产/沙箱域名未核验（docs/01 §3 #2），无法区分环境。');
  }

  return {
    mode: dryRunReason === null ? 'live' : 'dry_run',
    dryRun: dryRunReason !== null,
    dryRunReason,
    warnings,
    appKey,
    appSecret,
    accessToken,
    baseUrl,
    environment,
    timeoutMs,
    maxAttempts,
    maxResponseBytes,
    internalQps,
    clockSkewWindowMs,
    archiveDir,
  };
}

/** 安全摘要：绝不包含 secret/token 明文，可进日志与验收记录。 */
export function describePddConfig(config: PddConfig): PddConfigSummary {
  return {
    mode: config.mode,
    dry_run_reason: config.dryRunReason,
    environment: config.environment,
    base_url_configured: config.baseUrl !== null,
    app_key_configured: config.appKey !== null,
    app_secret_configured: config.appSecret !== null,
    access_token_configured: config.accessToken !== null,
    timeout_ms: config.timeoutMs,
    max_attempts: config.maxAttempts,
    internal_qps: config.internalQps,
    archive_dir: config.archiveDir,
    warnings: [...config.warnings],
  };
}

/** 把 .env 读进 process.env（已存在键不覆盖）；文件缺失静默跳过。 */
export function loadPddEnvFiles(candidates: string[] = ['.env']): void {
  for (const candidate of candidates) {
    try {
      process.loadEnvFile(candidate);
    } catch {
      // 缺省即 dry-run 的入口：不在这里报错。
    }
  }
}
