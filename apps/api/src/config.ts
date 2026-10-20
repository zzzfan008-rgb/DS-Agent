/**
 * 配置加载与校验（t2）。
 *
 * 原则：
 * - 进程启动即校验，缺项/非法值 fail fast，打印可读的字段级错误；
 * - 不在模块加载时读取环境变量，便于测试注入；
 * - 生产默认 Secure Cookie；开发允许 Secure=false，但启动时打警告（docs/14 §4.2）。
 */
import { z } from 'zod';

export type NodeEnv = 'development' | 'test' | 'production';

const envBool = (fallback: boolean) =>
  z.preprocess(
    (value) =>
      value === undefined || value === ''
        ? fallback
        : typeof value === 'boolean'
          ? value
          : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase()),
    z.boolean(),
  );

const optionalBool = z.preprocess(
  (value) =>
    value === undefined || value === ''
      ? undefined
      : typeof value === 'boolean'
        ? value
        : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase()),
  z.boolean().optional(),
);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 必填（Postgres 连接串）'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  CONTRACT_VERSION: z.string().min(1).default('2'),
  BUILD_SHA: z.string().optional(),

  /** 会话：空闲 8h / admin 空闲 30min / 绝对 12h（docs/14 §4.1）。 */
  SESSION_IDLE_SECONDS: z.coerce.number().int().min(60).default(8 * 3600),
  SESSION_ADMIN_IDLE_SECONDS: z.coerce.number().int().min(60).default(30 * 60),
  SESSION_ABSOLUTE_SECONDS: z.coerce.number().int().min(60).default(12 * 3600),
  COOKIE_SECURE: optionalBool,

  /** CSRF：非 GET 必须带 X-CSRF-Token；生产默认校验 Origin（docs/14 §4.2）。 */
  CSRF_REQUIRE_ORIGIN: optionalBool,

  /** 登录限流与锁定（docs/14 §3.1）。 */
  AUTH_LOGIN_RATE_MAX: z.coerce.number().int().min(1).default(5),
  AUTH_LOGIN_RATE_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  AUTH_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
  TOTP_ISSUER: z.string().default('DSSAAS'),
  /** 开发/PoC 的 TOTP 密钥表（JSON: {"ref":"BASE32"}）；生产应由 DSH/Vault 解析。 */
  DSSAAS_TOTP_SECRETS: z.string().optional(),

  /** Prometheus 抓取令牌（可选）；优先仍可用 admin 会话。 */
  METRICS_TOKEN: z.string().min(16).optional(),

  /** seed 脚本使用（不进运行期依赖）。 */
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().optional(),
  SEED_ADMIN_NAME: z.string().optional(),
  SEED_ADMIN_TOTP_SECRET: z.string().optional(),
});

export interface AppConfig {
  nodeEnv: NodeEnv;
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  contractVersion: string;
  buildSha: string | null;

  sessionIdleSeconds: number;
  sessionAdminIdleSeconds: number;
  sessionAbsoluteSeconds: number;
  cookieSecure: boolean;
  sessionCookieName: string;
  csrfCookieName: string;
  csrfRequireOrigin: boolean;

  loginRateMax: number;
  loginRateWindowMs: number;
  maxFailedAttempts: number;
  lockMinutes: number;

  totpIssuer: string;
  totpSecretsJson: string | null;
  metricsToken: string | null;
  version: string;

  /** seed 脚本专用；运行期 API 不依赖。 */
  seedAdminEmail: string | null;
  seedAdminPassword: string | null;
  seedAdminName: string | null;
  seedAdminTotpSecret: string | null;
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`配置校验失败：\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** 把 .env 读进 process.env（已存在的键不覆盖）；文件缺失时静默跳过。 */
export function loadEnvFiles(candidates: string[] = ['.env', 'packages/db/.env', '../../packages/db/.env']): void {
  for (const candidate of candidates) {
    try {
      process.loadEnvFile(candidate);
    } catch {
      // 文件不存在/无权限：交给 loadConfig 报告必填项
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  const raw = parsed.data;
  const cookieSecure = raw.COOKIE_SECURE ?? raw.NODE_ENV === 'production';
  return {
    nodeEnv: raw.NODE_ENV,
    host: raw.API_HOST,
    port: raw.API_PORT,
    databaseUrl: raw.DATABASE_URL,
    logLevel: raw.LOG_LEVEL,
    contractVersion: raw.CONTRACT_VERSION,
    buildSha: raw.BUILD_SHA ?? null,
    sessionIdleSeconds: raw.SESSION_IDLE_SECONDS,
    sessionAdminIdleSeconds: raw.SESSION_ADMIN_IDLE_SECONDS,
    sessionAbsoluteSeconds: raw.SESSION_ABSOLUTE_SECONDS,
    cookieSecure,
    sessionCookieName: cookieSecure ? '__Host-dssaas_sid' : 'dssaas_sid',
    csrfCookieName: 'dssaas_csrf',
    csrfRequireOrigin: raw.CSRF_REQUIRE_ORIGIN ?? raw.NODE_ENV === 'production',
    loginRateMax: raw.AUTH_LOGIN_RATE_MAX,
    loginRateWindowMs: raw.AUTH_LOGIN_RATE_WINDOW_MS,
    maxFailedAttempts: raw.AUTH_MAX_FAILED_ATTEMPTS,
    lockMinutes: raw.AUTH_LOCK_MINUTES,
    totpIssuer: raw.TOTP_ISSUER,
    totpSecretsJson: raw.DSSAAS_TOTP_SECRETS ?? null,
    metricsToken: raw.METRICS_TOKEN ?? null,
    version: '0.1.0',
    seedAdminEmail: raw.SEED_ADMIN_EMAIL ?? null,
    seedAdminPassword: raw.SEED_ADMIN_PASSWORD ?? null,
    seedAdminName: raw.SEED_ADMIN_NAME ?? null,
    seedAdminTotpSecret: raw.SEED_ADMIN_TOTP_SECRET ?? null,
  };
}

/** 日志/启动横幅用：隐去连接串口令。 */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<invalid DATABASE_URL>';
  }
}
