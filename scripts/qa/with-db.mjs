#!/usr/bin/env node
/**
 * 测试数据库运行器（t16 自包含 + t29 隔离）。
 *
 * 三种运行路径：
 *   A. docker（默认）：起一次性 pgvector/pgvector:pg16 容器（随机端口/库名/口令、--rm），
 *      跑完销毁。适合干净机器；CI 不需要（CI 用 service）。
 *   B. reuse（DSSAAS_DB_REUSE=1 + DSSAAS_PG_BASE_URL）：连接既有 Postgres，
 *      为本次运行创建独立库 `dssaas_test_<6 hex>`，跑完 DROP；并发运行互不干扰。
 *   C. 自备库：不使用本脚本，直接 `TEST_DATABASE_URL=... pnpm test:api:local`。
 *
 * 并发保护：同一台机器/同一仓库同时只允许一个 with-db 运行（文件锁 + pid + 时间戳）。
 * 默认串行等待；`--parallel` 显式跳过锁并警告。
 *
 * 用法：
 *   node scripts/qa/with-db.mjs -- <command> [args...]
 *   node scripts/qa/with-db.mjs --parallel -- <command> [args...]
 *   pnpm test:api
 *
 * 环境变量：
 *   DSSAAS_DB_REUSE=1          启用既有库模式（需 DSSAAS_PG_BASE_URL）
 *   DSSAAS_PG_BASE_URL         既有 Postgres 的 URL（如 .../dssaas_test?schema=public）
 *   DSSAAS_DOCKER_BIN          docker 命令（默认 "docker"；可用 "wsl docker"）
 *   DSSAAS_DB_HOST             docker 容器连接主机（默认 127.0.0.1）
 *   DSSAAS_TEST_IMAGE          docker 镜像（默认 pgvector/pgvector:pg16）
 *   DSSAAS_KEEP_DB=1           成功也保留数据库/容器并打印连接串（默认失败才保留）
 *   DSSAAS_KEEP_DB=0           失败也强制清理（CI/批量脚本用）
 *   DSSAAS_EXPECT_DB_PREFIX    透传给 run.ts 的库名前缀守卫（本脚本自动设置）
 *
 * 退出码：
 *   0  成功且已清理
 *   2  用法/配置错误（缺命令、reuse 缺 base URL）
 *   3  docker 不可用（未安装 / daemon 未启动）
 *   4  创建库/容器、等待就绪（60s）、migrate、清理或等待锁超时
 *   其它  透传被包装命令的退出码
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMAGE = process.env.DSSAAS_TEST_IMAGE || 'pgvector/pgvector:pg16';
const DOCKER_PARTS = (process.env.DSSAAS_DOCKER_BIN || 'docker').trim().split(/\s+/);
const DB_HOST = process.env.DSSAAS_DB_HOST || '127.0.0.1';
const WAIT_TIMEOUT_MS = 60_000;
const LOCK_WAIT_MAX_MS = 30 * 60 * 1000;
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const LOCK_FILE = path.join(
  os.tmpdir(),
  `dssaas-with-db-${createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 12)}.lock`,
);

function usage() {
  console.error('用法：node scripts/qa/with-db.mjs [--parallel] -- <command> [args...]');
  console.error('示例：node scripts/qa/with-db.mjs -- node scripts/qa/workspace-task.mjs test --filter @dssaas/api');
  console.error('模式：默认 docker；DSSAAS_DB_REUSE=1 + DSSAAS_PG_BASE_URL 使用既有库独立库。');
}

function hex(bytes = 4) {
  return randomBytes(bytes).toString('hex');
}

function maskUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '(invalid-url)';
  }
}

function withDatabase(raw, database) {
  const url = new URL(raw);
  url.pathname = `/${database}`;
  return url.toString();
}

function databaseOf(raw) {
  const url = new URL(raw);
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}

function docker(args, options = {}) {
  return spawnSync(DOCKER_PARTS[0], [...DOCKER_PARTS.slice(1), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    ...options,
  });
}

function detail(result) {
  return (
    result.error?.message ||
    (result.stderr ?? '').trim() ||
    (result.stdout ?? '').trim() ||
    `exit=${result.status ?? 'unknown'}`
  );
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
  });
}

function prismaDbExecute(adminUrl, sql) {
  return runNode([path.join(REPO_ROOT, 'scripts/qa/prisma-cli.mjs'), 'db', 'execute', '--url', adminUrl, '--stdin'], {
    input: sql,
    env: childEnvForAdmin(adminUrl),
  });
}

function childEnvForAdmin(url) {
  const env = { ...process.env, DATABASE_URL: url };
  delete env.npm_execpath;
  delete env.npm_node_execpath;
  return env;
}

function childEnv(url, expectedPrefix) {
  const env = { ...process.env, TEST_DATABASE_URL: url, DATABASE_URL: url };
  if (expectedPrefix) env.DSSAAS_EXPECT_DB_PREFIX = expectedPrefix;
  delete env.npm_execpath;
  delete env.npm_node_execpath;
  return env;
}

function migrate(url) {
  return spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts/qa/prisma-cli.mjs'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    {
      cwd: REPO_ROOT,
      env: childEnvForAdmin(url),
      stdio: 'inherit',
      timeout: 120_000,
    },
  );
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* 运行锁                                                              */
/* ------------------------------------------------------------------ */

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function releaseLock() {
  const info = readLock();
  if (info?.pid !== process.pid) return;
  try {
    unlinkSync(LOCK_FILE);
    console.log(`[with-db] 已释放运行锁（${LOCK_FILE}）`);
  } catch (error) {
    console.warn(`[with-db] 释放运行锁失败：${error.message}`);
  }
}

async function acquireLock({ parallel }) {
  if (parallel) {
    console.warn('[with-db] --parallel：跳过运行锁；请确认并发运行不会争抢端口/资源（各运行库仍独立）。');
    return null;
  }

  const startedAt = Date.now();
  let lastLog = 0;
  for (;;) {
    try {
      const fd = openSync(LOCK_FILE, 'wx');
      writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          host: os.hostname(),
          startedAt: new Date().toISOString(),
          command: process.argv.slice(2).join(' '),
        }),
      );
      closeSync(fd);
      console.log(`[with-db] 已获取运行锁：${LOCK_FILE}（pid=${process.pid}）`);
      return { file: LOCK_FILE };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = readLock();
      const stale =
        !info ||
        !pidAlive(info.pid) ||
        !info.startedAt ||
        Date.now() - Date.parse(info.startedAt) > LOCK_STALE_MS;
      if (stale) {
        console.warn(`[with-db] 清理僵尸运行锁（pid=${info?.pid ?? 'unknown'}，startedAt=${info?.startedAt ?? 'unknown'}）`);
        try {
          unlinkSync(LOCK_FILE);
        } catch {
          /* 竞争下可能已被他人清理 */
        }
        continue;
      }
      if (Date.now() - startedAt > LOCK_WAIT_MAX_MS) {
        throw new Error(`等待运行锁超时（30min）：${LOCK_FILE}）`);
      }
      if (Date.now() - lastLog > 10_000) {
        console.log(
          `[with-db] 另一个测试运行占用锁（pid=${info.pid}，开始于 ${info.startedAt}），串行等待中…（--parallel 可跳过）`,
        );
        lastLog = Date.now();
      }
      await sleep(1_000);
    }
  }
}

/* ------------------------------------------------------------------ */
/* docker 路径（默认）                                                  */
/* ------------------------------------------------------------------ */

function probeDocker() {
  const probe = docker(['version', '--format', '{{.Server.Version}}'], { timeout: 15_000 });
  if (probe.error || probe.status !== 0) {
    console.error(`[with-db] Docker 不可用：${detail(probe)}`);
    console.error('[with-db] 请安装并启动 Docker，或使用既有库模式：');
    console.error('[with-db]   DSSAAS_DB_REUSE=1 DSSAAS_PG_BASE_URL=postgresql://.../dssaas_test?schema=public pnpm test:api');
    console.error('[with-db]   TEST_DATABASE_URL=postgresql://.../dssaas_test?schema=public pnpm test:api:local');
    console.error('[with-db] CI 使用 GitHub Actions service（postgres），不需要 docker-in-docker。');
    return false;
  }
  return true;
}

async function startContainer() {
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const port = await pickPort();
    const name = `dssaas-qa-${hex()}`;
    const database = `dssaas_${hex()}_test`;
    const password = hex(8);
    const result = docker([
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-e',
      'POSTGRES_USER=dssaas',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      `POSTGRES_DB=${database}`,
      '-p',
      `${port}:5432`,
      IMAGE,
    ]);
    if (result.status === 0) {
      return { kind: 'docker', name, database, password, port };
    }
    lastError = detail(result);
    const portConflict = /port is already allocated|address already in use|bind: address already in use/i.test(lastError);
    if (attempt === 1 && portConflict) {
      console.warn(`[with-db] 端口 ${port} 冲突，重试一次…`);
      continue;
    }
    throw new Error(`启动容器失败：${lastError}`);
  }
  throw new Error(`启动容器失败：${lastError}`);
}

async function waitReady(name, database) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    const result = docker(['exec', name, 'pg_isready', '-U', 'dssaas', '-d', database], { timeout: 5_000 });
    if (result.status === 0) return;
    last = detail(result);
    await sleep(500);
  }
  throw new Error(`等待数据库就绪超时（60s）：${last}`);
}

function cleanupDocker(name) {
  const removed = docker(['rm', '-f', name], { timeout: 30_000 });
  const inspect = docker(['inspect', name], { timeout: 10_000 });
  const gone = inspect.status !== 0;
  if (gone) {
    console.log(`[with-db] 清理完成：容器 ${name} 已销毁`);
    return true;
  }
  console.error(`[with-db] 清理失败：容器 ${name} 仍存在。rm=${detail(removed)} inspect=${detail(inspect)}`);
  return false;
}

/* ------------------------------------------------------------------ */
/* 既有库路径（DSSAAS_DB_REUSE=1）                                     */
/* ------------------------------------------------------------------ */

function startReuse() {
  const baseUrl = process.env.DSSAAS_PG_BASE_URL?.trim();
  if (!baseUrl) {
    throw Object.assign(new Error('DSSAAS_DB_REUSE=1 需要同时提供 DSSAAS_PG_BASE_URL'), { code: 2 });
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw Object.assign(new Error(`DSSAAS_PG_BASE_URL 不是合法 URL：${maskUrl(baseUrl)}`), { code: 2 });
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw Object.assign(new Error(`DSSAAS_PG_BASE_URL 协议必须是 postgresql://：${maskUrl(baseUrl)}`), { code: 2 });
  }
  const baseDatabase = databaseOf(baseUrl);
  if (!baseDatabase) {
    throw Object.assign(new Error('DSSAAS_PG_BASE_URL 必须包含库名'), { code: 2 });
  }

  const database = `dssaas_test_${hex(3)}`; // 6 位十六进制；run.ts 的隔离库命名
  const adminUrl = withDatabase(baseUrl, 'postgres');
  const create = prismaDbExecute(adminUrl, `CREATE DATABASE "${database}";`);
  if (create.status !== 0) {
    throw new Error(`创建独立库 ${database} 失败：${detail(create)}`);
  }
  const url = withDatabase(baseUrl, database);
  return {
    kind: 'reuse',
    database,
    url,
    adminUrl,
    baseUrl,
    cleanup: () => {
      const drop = prismaDbExecute(adminUrl, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE);`);
      if (drop.status === 0) {
        console.log(`[with-db] 清理完成：独立库 ${database} 已 DROP`);
        return true;
      }
      console.error(`[with-db] 清理失败：独立库 ${database} 未删除。${detail(drop)}`);
      return false;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  if (separator >= 0) {
    return { flags: argv.slice(0, separator), commandArgs: argv.slice(separator + 1) };
  }
  // 兼容 pnpm 把 --parallel 直接追加到脚本参数的情况
  const leadingFlags = [];
  let index = 0;
  while (index < argv.length && argv[index].startsWith('--')) {
    leadingFlags.push(argv[index]);
    index += 1;
  }
  return { flags: leadingFlags, commandArgs: argv.slice(index) };
}

async function main() {
  const fullArgv = process.argv.slice(2);
  const { flags, commandArgs } = parseArgs(fullArgv);
  if (commandArgs.length === 0) {
    usage();
    return 2;
  }
  const parallel = flags.includes('--parallel');

  const reuse = process.env.DSSAAS_DB_REUSE === '1';
  if (reuse && !process.env.DSSAAS_PG_BASE_URL?.trim()) {
    console.error('[with-db] DSSAAS_DB_REUSE=1 需要同时提供 DSSAAS_PG_BASE_URL。');
    return 2;
  }
  if (!reuse && !probeDocker()) return 3;

  console.log(`[with-db] 模式=${reuse ? 'reuse（既有 Postgres，独立库）' : 'docker（一次性容器）'}`);
  if (reuse) {
    console.log(`[with-db] base=${maskUrl(process.env.DSSAAS_PG_BASE_URL.trim())}`);
  }

  const startedAt = Date.now();
  let lock = null;
  let resource = null;
  let exitCode = 0;
  try {
    lock = await acquireLock({ parallel });
    resource = reuse ? startReuse() : await startContainer();

    if (resource.kind === 'reuse') {
      console.log(`[with-db] 独立库：${resource.database}`);
      console.log(`[with-db] 连接串：${maskUrl(resource.url)}`);
    } else {
      const url = `postgresql://dssaas:${resource.password}@${DB_HOST}:${resource.port}/${resource.database}?schema=public`;
      resource.url = url;
      console.log(
        `[with-db] 一次性数据库：container=${resource.name} port=${resource.port} db=${resource.database} host=${DB_HOST}`,
      );
      console.log(`[with-db] 连接串：${maskUrl(url)}`);
      await waitReady(resource.name, resource.database);
      console.log('[with-db] 数据库已就绪（pg_isready）');
    }

    const migrateResult = migrate(resource.url);
    if (migrateResult.status !== 0) {
      throw new Error(`prisma migrate deploy 失败（exit=${migrateResult.status ?? 'unknown'}）`);
    }
    console.log('[with-db] 迁移已应用');

    const commandLine = commandArgs.join(' ');
    console.log(`[with-db] 执行：${commandLine}`);
    const expectedPrefix = resource.kind === 'reuse' ? 'dssaas_test_' : resource.database;
    exitCode = await new Promise((resolve) => {
      const child = spawn(commandLine, {
        cwd: REPO_ROOT,
        env: childEnv(resource.url, expectedPrefix),
        stdio: 'inherit',
        shell: true,
        windowsHide: true,
      });
      child.on('error', (error) => {
        console.error(`[with-db] 命令启动失败：${error.message}`);
        resolve(4);
      });
      child.on('close', (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) console.error(`[with-db] 被包装命令失败（exit=${exitCode}）`);
  } catch (error) {
    console.error(`[with-db] ✖ ${error.message}`);
    exitCode = error.code === 2 ? 2 : 4;
  } finally {
    const keepFlag = process.env.DSSAAS_KEEP_DB;
    const shouldKeep = Boolean(resource) && (keepFlag === '1' || (exitCode !== 0 && keepFlag !== '0'));
    if (resource) {
      if (shouldKeep) {
        console.error(`[with-db] 保留 ${resource.kind === 'reuse' ? '独立库' : '容器'} 便于排查：`);
        console.error(`[with-db]   连接串：${resource.url}`);
        console.error(
          resource.kind === 'reuse'
            ? `[with-db]   清理：DROP DATABASE IF EXISTS "${resource.database}" WITH (FORCE);`
            : `[with-db]   清理：${DOCKER_PARTS.join(' ')} rm -f ${resource.name}`,
        );
      } else {
        const ok = resource.kind === 'reuse' ? resource.cleanup() : cleanupDocker(resource.name);
        if (!ok && exitCode === 0) exitCode = 4;
      }
    }
    if (lock) releaseLock();
    console.log(`[with-db] 总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[with-db] 运行失败：${error.stack ?? error.message}`);
    process.exit(4);
  });
