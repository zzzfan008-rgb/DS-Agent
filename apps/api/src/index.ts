/**
 * apps/api 入口：加载配置 → 装配 Fastify → 监听 → 优雅退出。
 *
 * 启动前置条件：
 * - DATABASE_URL 可达且已执行 `pnpm db:deploy`；
 * - 生产必须显式设置 COOKIE_SECURE=true（或 NODE_ENV=production）。
 */
import { ConfigError, checkPoolCapacity, loadConfig, loadEnvFiles, redactDatabaseUrl } from './config.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  loadEnvFiles();
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
    } else {
      console.error('配置加载失败', error);
    }
    process.exitCode = 1;
    return;
  }

  // t51（M9 P1：F3）：连接池容量校验 —— 只 WARNING，不阻断启动。
  // 池子多大是部署决策，代码没资格因为"配置不理想"就让服务起不来；但必须让人在启动日志里看见。
  const poolCheck = checkPoolCapacity({
    databaseUrl: config.databaseUrl,
    apiInstanceCount: config.apiInstanceCount,
    pgMaxConnections: config.pgMaxConnections,
  });
  for (const warning of poolCheck.warnings) {
    console.warn(`[pool] WARNING: ${warning}`);
  }

  const app = await buildApp(config);
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'api shutting down');
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error({ err: error }, 'api listen failed');
    process.exitCode = 1;
    await app.close();
    return;
  }

  app.log.info(
    {
      host: config.host,
      port: config.port,
      node_env: config.nodeEnv,
      database: redactDatabaseUrl(config.databaseUrl),
      session_store: 'memory',
      contract_version: config.contractVersion,
      // t51：池容量进启动日志，便于事后复盘"当时配了多少"。
      pool: {
        connection_limit: poolCheck.connectionLimit,
        instances: config.apiInstanceCount,
        effective: poolCheck.effectiveLimit,
        pg_max_connections: config.pgMaxConnections,
      },
    },
    'api ready',
  );
  if (!config.cookieSecure) {
    app.log.warn(
      'COOKIE_SECURE=false（开发模式）；生产必须启用 Secure Cookie 与 __Host- 前缀（docs/14 §4.2）',
    );
  }
}

void main();
