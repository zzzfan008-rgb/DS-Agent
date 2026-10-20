#!/usr/bin/env node
/**
 * “迁移可重复”门禁（docs/15 §2.1 / §9.1 第 4 项；docs/00 M1 验收）。
 *
 * 语义（按 captain 口径）：对空库连续跑两次 migrate，不报错。
 *   1) 第一次 `prisma migrate deploy` 必须成功应用全部迁移；
 *   2) 第二次必须成功且输出 “No pending migrations”；
 *   3) `prisma migrate status` 必须退出 0（schema 与迁移历史一致）。
 *
 * 数据库来源（按优先级）：
 *   --url <url>  或  MIGRATE_CHECK_DATABASE_URL   → 直接使用（CI 用 service postgres 的空库）
 *   DATABASE_URL（环境变量或 packages/db/.env）  → 派生 <db>_migrate_check，自动建库/删库
 *
 * 安全护栏：
 *   - 默认只允许 localhost/127.0.0.1/::1，远程库需 --allow-remote；
 *   - 显式 --url 的库名必须含 check/test/ci，否则需 --allow-any-db；
 *   - 自动建库只操作以 _migrate_check 结尾的派生库，绝不碰 DATABASE_URL 原库。
 *
 * 用法：
 *   node scripts/qa/check-migrations.mjs
 *   node scripts/qa/check-migrations.mjs --url postgresql://user:pass@localhost:5432/dssaas_ci?schema=public
 *   node scripts/qa/check-migrations.mjs --keep        # 保留派生库，便于人工排查
 */

import { spawn } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DB_DIR = path.join(REPO_ROOT, 'packages/db');
const SCHEMA_REL = 'prisma/schema.prisma';
const MIGRATIONS_DIR = path.join(DB_DIR, 'prisma/migrations');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const SAFE_DB_RE = /(check|test|ci)/i;

function usage() {
  console.log(`迁移可重复门禁

用法：node scripts/qa/check-migrations.mjs [选项]

选项：
  --url <url>        使用指定数据库（应已存在且为空；CI 用）
  --keep             保留自动创建的 <db>_migrate_check 库
  --allow-remote     允许非 localhost 数据库（显式声明）
  --allow-any-db     允许库名不含 check/test/ci（危险，仅本地调试）
  --json             输出 JSON 摘要
  -h, --help         显示本帮助

环境变量：
  MIGRATE_CHECK_DATABASE_URL   等价于 --url
  DATABASE_URL                 无显式 URL 时用于派生临时库
`);
}

function parseArgs(argv) {
  const opts = { keep: false, allowRemote: false, allowAnyDb: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue; // pnpm/npm 把 -- 原样传给脚本
    if (arg === '--url') {
      opts.url = argv[i + 1];
      if (!opts.url) throw new Error('--url 缺少参数');
      i += 1;
    } else if (arg === '--keep') opts.keep = true;
    else if (arg === '--allow-remote') opts.allowRemote = true;
    else if (arg === '--allow-any-db') opts.allowAnyDb = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return opts;
}

function parseDotEnv(text) {
  const env = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

async function loadDbEnv() {
  try {
    const text = await readFile(path.join(DB_DIR, '.env'), 'utf8');
    return parseDotEnv(text);
  } catch {
    return {};
  }
}

function parseDbUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`无法解析数据库 URL：${rawUrl.replace(/:[^:@/]+@/, ':***@')}`);
  }
  const db = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!db) throw new Error('数据库 URL 缺少库名');
  return {
    url,
    db,
    host: url.hostname,
    displayUrl: rawUrl.replace(/:[^:@/]+@/, ':***@'),
  };
}

function withDatabase(rawUrl, dbName) {
  const url = new URL(rawUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function assertSafe(parsed, opts, { explicit }) {
  if (!LOCAL_HOSTS.has(parsed.host) && !opts.allowRemote) {
    throw new Error(
      `拒绝在非 localhost 数据库上执行（host=${parsed.host}）。如确认是隔离环境，请显式加 --allow-remote。`,
    );
  }
  if (explicit && !SAFE_DB_RE.test(parsed.db) && !opts.allowAnyDb) {
    throw new Error(
      `库名 "${parsed.db}" 不含 check/test/ci，疑似业务库。请使用独立空库，或显式加 --allow-any-db。`,
    );
  }
}

async function resolvePrismaEntry() {
  const candidates = [
    path.join(DB_DIR, 'node_modules/prisma/build/index.js'),
    path.join(REPO_ROOT, 'node_modules/prisma/build/index.js'),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return { command: process.execPath, prefix: [candidate] };
    } catch {
      /* try next */
    }
  }
  return { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', prefix: ['exec', 'prisma'] };
}

function run(command, args, { cwd, env, stdin, label }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}`, label }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, label }));
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

function tail(text, lines = 12) {
  const all = text.trim().split('\n');
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

async function countMigrationDirs() {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).length;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return 0;
  }

  const dbEnv = await loadDbEnv();
  const explicitUrl = opts.url ?? process.env.MIGRATE_CHECK_DATABASE_URL;
  const baseUrl = explicitUrl ?? process.env.DATABASE_URL ?? dbEnv.DATABASE_URL;

  if (!baseUrl) {
    throw new Error('没有数据库 URL：请设置 MIGRATE_CHECK_DATABASE_URL / DATABASE_URL，或传 --url。');
  }

  const prisma = await resolvePrismaEntry();
  const steps = [];
  let scratchDb = null;
  let scratchConfig = null;

  const runPrisma = async (args, { stdin, env } = {}) =>
    run(prisma.command, [...prisma.prefix, ...args], {
      cwd: DB_DIR,
      env,
      stdin,
      label: `prisma ${args.slice(0, 2).join(' ')}`,
    });

  try {
    let targetUrl;
    let mode;
    if (explicitUrl) {
      const parsed = parseDbUrl(explicitUrl);
      assertSafe(parsed, opts, { explicit: true });
      targetUrl = explicitUrl;
      mode = 'explicit';
      console.log(`[migrate-check] 目标库（显式）：${parsed.displayUrl}`);
    } else {
      const parsed = parseDbUrl(baseUrl);
      assertSafe(parsed, opts, { explicit: false });
      scratchDb = `${parsed.db}_migrate_check`;
      scratchConfig = { adminUrl: withDatabase(baseUrl, 'postgres'), url: withDatabase(baseUrl, scratchDb), db: scratchDb };
      targetUrl = scratchConfig.url;
      mode = 'scratch';
      console.log(`[migrate-check] 派生临时库：${scratchDb}（源库 ${parsed.db} 不会被改动）`);

      const dropSql = `DROP DATABASE IF EXISTS "${scratchDb}" WITH (FORCE);`;
      const createSql = `CREATE DATABASE "${scratchDb}";`;
      const drop = await runPrisma(['db', 'execute', '--url', scratchConfig.adminUrl, '--stdin'], { stdin: dropSql });
      if (drop.code !== 0) {
        throw new Error(
          `无法清理临时库 ${scratchDb}（需要 CREATEDB 权限）。\n${tail(drop.stderr || drop.stdout)}`,
        );
      }
      const create = await runPrisma(['db', 'execute', '--url', scratchConfig.adminUrl, '--stdin'], { stdin: createSql });
      if (create.code !== 0) {
        throw new Error(
          `无法创建临时库 ${scratchDb}（需要 CREATEDB 权限）。可改用 --url 指向已有空库。\n${tail(create.stderr || create.stdout)}`,
        );
      }
      steps.push({ name: `创建空库 ${scratchDb}`, status: 'passed' });
    }

    const env = { DATABASE_URL: targetUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' };
    const deployArgs = ['migrate', 'deploy', '--schema', SCHEMA_REL];

    // 第一次：空库 → 全部迁移
    const first = await runPrisma(deployArgs, { env });
    if (first.code !== 0) {
      throw new Error(`第一次 migrate deploy 失败（空库无法应用迁移）。\n${tail(first.stderr || first.stdout)}`);
    }
    steps.push({ name: '第一次 migrate deploy（空库）', status: 'passed' });

    // 第二次：必须幂等成功
    const second = await runPrisma(deployArgs, { env });
    const secondText = `${second.stdout}\n${second.stderr}`;
    if (second.code !== 0) {
      throw new Error(`第二次 migrate deploy 失败（迁移不可重复）。\n${tail(second.stderr || second.stdout)}`);
    }
    if (!/No pending migrations|already been applied|Database schema is up to date/i.test(secondText)) {
      throw new Error(
        `第二次 migrate deploy 未返回“无待应用迁移”，无法证明可重复。输出：\n${tail(secondText)}`,
      );
    }
    steps.push({ name: '第二次 migrate deploy（无待应用迁移）', status: 'passed' });

    // 迁移历史与 schema 一致性
    const status = await runPrisma(['migrate', 'status', '--schema', SCHEMA_REL], { env });
    if (status.code !== 0) {
      throw new Error(`migrate status 失败（迁移历史与 schema 不一致）。\n${tail(status.stderr || status.stdout)}`);
    }
    steps.push({ name: 'migrate status（schema 与迁移历史一致）', status: 'passed' });

    const count = await countMigrationDirs();
    const summary = {
      ok: true,
      mode,
      database: parseDbUrl(targetUrl).displayUrl,
      migrations: count,
      steps,
    };
    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log('');
      for (const step of steps) console.log(`  ✔ ${step.name}`);
      console.log('');
      console.log(`✔ 迁移可重复：${count} 个迁移在空库上连续执行两次均通过。`);
    }
    return 0;
  } finally {
    if (scratchConfig && !opts.keep) {
      const drop = await runPrisma(['db', 'execute', '--url', scratchConfig.adminUrl, '--stdin'], {
        stdin: `DROP DATABASE IF EXISTS "${scratchConfig.db}" WITH (FORCE);`,
      });
      if (drop.code !== 0) {
        console.error(`[migrate-check] 临时库 ${scratchConfig.db} 清理失败，请手工删除：${tail(drop.stderr || drop.stdout)}`);
      } else {
        console.log(`[migrate-check] 已清理临时库 ${scratchConfig.db}`);
      }
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[migrate-check] ✖ ${error.message}`);
    process.exit(1);
  });
