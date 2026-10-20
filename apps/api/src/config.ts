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
  /** 开发/PoC 的模型供应商凭据表（JSON: {"credential_ref":"secret"}）；生产由 DSH 凭据解析。 */
  DSSAAS_MODEL_CREDENTIALS: z.string().optional(),
  /** 仅 dev/test 的入站模拟端点开关；默认关闭，生产不得开启。 */
  DSSAAS_ENABLE_INTERNAL_SIMULATION: envBool(false),

  /** Prometheus 抓取令牌（可选）；优先仍可用 admin 会话。 */
  METRICS_TOKEN: z.string().min(16).optional(),

  // ---- DSH 桥接（docs/17 §3.3、docs/16 §7.3）----
  /** 桥接基地址；api 拼接 `/internal/agent/run` 与 `/internal/health`。 */
  DSH_BRIDGE_URL: z.string().url().default('http://127.0.0.1:43180'),
  /** 生产从 0600 令牌文件读取；开发可显式注入 DSH_BRIDGE_TOKEN（不含 `/connect`）。 */
  DSH_BRIDGE_TOKEN_FILE: z.string().min(1).optional(),
  DSH_BRIDGE_TOKEN: z.string().min(16).optional(),
  /** 建连超时（docs/17 §2.2 ⑥：3s）。 */
  DSH_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(3000),
  /** 健康探针超时（api `/ready` 与 POST 前置检查）。 */
  DSH_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(1500),
  DSH_HEALTH_CACHE_MS: z.coerce.number().int().min(0).max(60_000).default(2000),

  // ---- Agent 驱动（docs/17 §4.2）----
  AGENT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  AGENT_QUEUE_LIMIT: z.coerce.number().int().min(0).max(1000).default(30),
  AGENT_QUEUE_WAIT_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
  AGENT_USER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  AGENT_SESSION_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(1),
  AGENT_RUN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(120_000),
  AGENT_MAX_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(600_000),
  AGENT_FIRST_TOKEN_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(8000),
  AGENT_HEARTBEAT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),
  /** run 终态后保留查询/事件回放的时长（docs/12 §8.3：30 分钟）。 */
  AGENT_RUN_RETENTION_MS: z.coerce.number().int().min(60_000).max(24 * 3600 * 1000).default(30 * 60 * 1000),
  /** 桥接连接期指数退避重试（只在首个业务事件前重试，避免重复输出）。 */
  AGENT_BRIDGE_RECONNECT_ATTEMPTS: z.coerce.number().int().min(0).max(5).default(2),
  AGENT_BRIDGE_RECONNECT_BASE_MS: z.coerce.number().int().min(10).max(5000).default(250),

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
  modelCredentialsJson: string | null;
  enableInternalSimulation: boolean;
  metricsToken: string | null;
  version: string;

  /** DSH 桥接（docs/17 §3.3）；URL 含协议与端口，api 自行拼接内部路径。 */
  dshBridgeUrl: string;
  dshBridgeTokenFile: string | null;
  dshBridgeToken: string | null;
  dshConnectTimeoutMs: number;
  dshHealthTimeoutMs: number;
  dshHealthCacheMs: number;

  /** Agent 并发/超时/重试（docs/17 §4.2、§6.5）。 */
  agentMaxConcurrency: number;
  agentQueueLimit: number;
  agentQueueWaitMs: number;
  agentUserConcurrency: number;
  agentSessionConcurrency: number;
  agentRunTimeoutMs: number;
  agentMaxTimeoutMs: number;
  agentFirstTokenTimeoutMs: number;
  agentHeartbeatMs: number;
  agentRunRetentionMs: number;
  agentBridgeReconnectAttempts: number;
  agentBridgeReconnectBaseMs: number;

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
    modelCredentialsJson: raw.DSSAAS_MODEL_CREDENTIALS ?? null,
    enableInternalSimulation: raw.DSSAAS_ENABLE_INTERNAL_SIMULATION,
    metricsToken: raw.METRICS_TOKEN ?? null,
    version: '0.1.0',
    dshBridgeUrl: raw.DSH_BRIDGE_URL.replace(/\/+$/, ''),
    dshBridgeTokenFile: raw.DSH_BRIDGE_TOKEN_FILE ?? null,
    dshBridgeToken: raw.DSH_BRIDGE_TOKEN ?? null,
    dshConnectTimeoutMs: raw.DSH_CONNECT_TIMEOUT_MS,
    dshHealthTimeoutMs: raw.DSH_HEALTH_TIMEOUT_MS,
    dshHealthCacheMs: raw.DSH_HEALTH_CACHE_MS,
    agentMaxConcurrency: raw.AGENT_MAX_CONCURRENCY,
    agentQueueLimit: raw.AGENT_QUEUE_LIMIT,
    agentQueueWaitMs: raw.AGENT_QUEUE_WAIT_MS,
    agentUserConcurrency: raw.AGENT_USER_CONCURRENCY,
    agentSessionConcurrency: raw.AGENT_SESSION_CONCURRENCY,
    agentRunTimeoutMs: raw.AGENT_RUN_TIMEOUT_MS,
    agentMaxTimeoutMs: raw.AGENT_MAX_TIMEOUT_MS,
    agentFirstTokenTimeoutMs: raw.AGENT_FIRST_TOKEN_TIMEOUT_MS,
    agentHeartbeatMs: raw.AGENT_HEARTBEAT_MS,
    agentRunRetentionMs: raw.AGENT_RUN_RETENTION_MS,
    agentBridgeReconnectAttempts: raw.AGENT_BRIDGE_RECONNECT_ATTEMPTS,
    agentBridgeReconnectBaseMs: raw.AGENT_BRIDGE_RECONNECT_BASE_MS,
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
