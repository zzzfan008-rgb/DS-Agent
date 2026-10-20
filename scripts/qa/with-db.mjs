#!/usr/bin/env node
/**
 * 一次性数据库运行器（t16）：让 API 测试在干净机器上可复现。
 *
 * 流程：
 *   1) 检查 docker 可用（binary + daemon）；
 *   2) 起一次性 pgvector/pgvector:pg16 容器（随机端口 / 随机库名 / 随机口令 / --rm）；
 *   3) 等待就绪（最多 60s）；
 *   4) prisma migrate deploy；
 *   5) 以 TEST_DATABASE_URL + DATABASE_URL 执行传入命令；
 *   6) 无论成败都 docker rm -f 并打印清理结果。
 *
 * 用法：
 *   node scripts/qa/with-db.mjs -- <command> [args...]
 *   pnpm test:api        # = with-db + pnpm --filter @dssaas/api test
 *
 * 环境变量：
 *   DSSAAS_DOCKER_BIN   docker 命令（默认 "docker"；可用 "wsl docker" 走 WSL）
 *   DSSAAS_DB_HOST      连接容器使用的主机（默认 127.0.0.1；远程 docker 引擎时可用）
 *   DSSAAS_TEST_IMAGE   镜像（默认 pgvector/pgvector:pg16）
 *
 * 退出码：
 *   0  成功且容器已销毁
 *   2  用法错误（缺少命令）
 *   3  docker 不可用（未安装 / daemon 未启动 / 无法连接）
 *   4  容器启动、等待就绪（60s 超时）、migrate 或清理失败
 *   其它  透传被包装命令的退出码
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IMAGE = process.env.DSSAAS_TEST_IMAGE || 'pgvector/pgvector:pg16';
const DOCKER_PARTS = (process.env.DSSAAS_DOCKER_BIN || 'docker').trim().split(/\s+/);
const DB_HOST = process.env.DSSAAS_DB_HOST || '127.0.0.1';
const WAIT_TIMEOUT_MS = 60_000;

function usage() {
  console.error('用法：node scripts/qa/with-db.mjs -- <command> [args...]');
  console.error('示例：node scripts/qa/with-db.mjs -- pnpm --filter @dssaas/api test');
}

function hex(bytes = 4) {
  return randomBytes(bytes).toString('hex');
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

/** 子进程环境：注入测试库 URL，并去掉嵌套 pnpm 的 npm_execpath（避免并发 install 的路径问题）。 */
function childEnv(url) {
  const env = { ...process.env, TEST_DATABASE_URL: url, DATABASE_URL: url };
  delete env.npm_execpath;
  delete env.npm_node_execpath;
  return env;
}

async function startContainer() {  let lastError = '';
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
      return { name, database, password, port };
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

function cleanup(name) {
  const removed = docker(['rm', '-f', name], { timeout: 30_000 });
  const inspect = docker(['inspect', name], { timeout: 10_000 });
  const gone = inspect.status !== 0; // inspect 失败 = 容器不存在
  if (gone) {
    console.log(`[with-db] 清理完成：容器 ${name} 已销毁`);
    return true;
  }
  console.error(`[with-db] 清理失败：容器 ${name} 仍存在。rm=${detail(removed)} inspect=${detail(inspect)}`);
  return false;
}

async function main() {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  const commandArgs = separator >= 0 ? argv.slice(separator + 1) : argv;
  if (commandArgs.length === 0) {
    usage();
    return 2;
  }

  // 1) docker 可用性：二进制与 daemon 都检查
  const probe = docker(['version', '--format', '{{.Server.Version}}'], { timeout: 15_000 });
  if (probe.error || probe.status !== 0) {
    console.error(`[with-db] Docker 不可用：${detail(probe)}`);
    console.error('[with-db] 请安装并启动 Docker Desktop / dockerd，或改用自备测试库：');
    console.error('[with-db]   TEST_DATABASE_URL=postgresql://.../dssaas_test?schema=public pnpm test:api:local');
    console.error('[with-db] CI 使用 GitHub Actions service（postgres），不需要 docker-in-docker。');
    return 3;
  }

  let container = null;
  let exitCode = 0;
  try {
    container = await startContainer();
    const url = `postgresql://dssaas:${container.password}@${DB_HOST}:${container.port}/${container.database}?schema=public`;
    console.log(
      `[with-db] 一次性数据库：container=${container.name} port=${container.port} db=${container.database} host=${DB_HOST}`,
    );
    await waitReady(container.name, container.database);
    console.log('[with-db] 数据库已就绪（pg_isready）');

    const migrate = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts/qa/prisma-cli.mjs'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      {
        cwd: REPO_ROOT,
        env: childEnv(url),
        stdio: 'inherit',
        timeout: 120_000,
      },
    );
    if (migrate.status !== 0) {
      throw new Error(`prisma migrate deploy 失败（exit=${migrate.status ?? 'unknown'}）`);
    }
    console.log('[with-db] 迁移已应用');

    const commandLine = commandArgs.join(' ');
    console.log(`[with-db] 执行：${commandLine}`);
    exitCode = await new Promise((resolve) => {
      const child = spawn(commandLine, {
        cwd: REPO_ROOT,
        env: childEnv(url),
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
    exitCode = 4;
  } finally {
    if (container) {
      const ok = cleanup(container.name);
      if (!ok && exitCode === 0) exitCode = 4;
    }
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[with-db] 运行失败：${error.stack ?? error.message}`);
    process.exit(4);
  });
