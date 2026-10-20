/**
 * t2 验收测试统一入口：
 *   1) 解析测试库：共享库自动 fork 成 run-scoped 独立库（t52，见下）；
 *   2) 重置 schema（DROP/CREATE SCHEMA public）；
 *   3) prisma migrate deploy（不用 migrate dev，遵守 t1 约束）；
 *   4) 串行执行 test/*.test.ts。
 *
 * 环境变量：TEST_DATABASE_URL（必填）。
 * 自包含运行：pnpm test:api（scripts/qa/with-db.mjs 起一次性容器或独立库）。
 * 可选守卫：DSSAAS_EXPECT_DB_PREFIX；设置后库名必须以该前缀开头，否则 exit 2。
 *
 * ── t52：为什么是「强制独立库」而不是「reset 加锁」──────────────────────────
 * 现象：两个测试进程用同一个库同时跑，一方 DROP/CREATE SCHEMA 时另一方撞
 *       `relation "roles" does not exist`。
 *
 * 根因不止 reset：测试用例共用**固定 fixture**——固定邮箱（admin.t21@test.local 等）
 * 与固定 orgId=1n。实测同一 schema 上第二个进程 create 同名用户直接 P2002。
 * 因此「只在 reset 期间持 advisory lock」不能解决问题：锁一释放，两个进程仍会在
 * 同一份数据上互相踩（P2002 / 数据串味 / 一方 DROP 掉另一方正在用的表）。
 *
 * 结论：从机制上让两次运行**不共享 schema**——共享库名一律 fork 成
 *       `dssaas_test_<pid>_<6hex>`，跑完（含失败）DROP。共享库名不再被接受为直接目标。
 *
 * 兼容：
 *   - `dssaas_test_<6hex>`（with-db reuse 建库）与 `dssaas_test_<pid>_<6hex>` 已是 run-scoped，直接用；
 *   - `dssaas_ci`（CI service，按 job 隔离）直接用；
 *   - `DSSAAS_TEST_DB_MODE=direct` 显式关闭 fork（需自行保证隔离）。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@dssaas/db';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  console.error('[test] 缺少 TEST_DATABASE_URL；拒绝回落到硬编码端口。');
  console.error('[test] 自包含运行（推荐）：pnpm test:api');
  console.error('[test] 已有测试库：TEST_DATABASE_URL=postgresql://.../dssaas_test?schema=public pnpm test:api:local');
  process.exit(2);
}

function databaseName(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** 管理连接：默认把目标库换成 `postgres`，可用 DSSAAS_PG_ADMIN_URL 覆盖。 */
function adminUrlFor(url: string): string {
  const explicit = process.env.DSSAAS_PG_ADMIN_URL;
  if (explicit) return explicit;
  return withDatabase(url, 'postgres');
}

/** 非隔离库守卫（保持 t16/t29 语义，防误连开发/生产库）。 */
const ISOLATED_DB_RE = /(^dssaas_test_[0-9a-z]{6}$)|(^dssaas_test_\d+_[0-9a-f]{6}$)|(_test$)|(^dssaas_ci$)/;

/** 已经是「按运行隔离」的库名：直接用，不再 fork。 */
const RUN_SCOPED_RE = new RegExp(
  [
    '^dssaas_test_\\d+_[0-9a-f]{6}$', // 本脚本 fork 出来的
    '^dssaas_test_[0-9a-z]{6}$', // with-db reuse 模式建的
    '^dssaas_[0-9a-f]{8}_test$', // with-db docker 模式（一次性容器）
  ].join('|'),
);
/** CI service 库：每个 job 一台干净 PG，job 内串行，视为已隔离。 */
const CI_DB_RE = /^dssaas_ci$/;

function maskUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '(invalid-url)';
  }
}

function forkDatabaseName(): string {
  return `dssaas_test_${process.pid}_${randomBytes(3).toString('hex')}`;
}

interface DatabasePlan {
  url: string;
  forked: boolean;
  adminUrl: string | null;
}

/**
 * 决定本次运行使用哪个库。
 * 共享库名 → fork 新库（t52）；run-scoped / CI 库 / direct 模式 → 原样使用。
 */
function planDatabase(): DatabasePlan {
  const name = databaseName(testDatabaseUrl!);
  if (!ISOLATED_DB_RE.test(name)) {
    console.error(`[test] 拒绝对非隔离测试库执行重置：${name || '(unknown)'}`);
    console.error('[test] 允许：dssaas_test_<6hex> / dssaas_test_<pid>_<6hex> / 以 _test 结尾 / dssaas_ci。');
    process.exit(2);
  }

  const mode = process.env.DSSAAS_TEST_DB_MODE ?? 'auto';
  if (mode === 'direct') {
    console.log(`[test] DSSAAS_TEST_DB_MODE=direct：直接使用 ${name}（隔离由调用方保证）`);
    return { url: testDatabaseUrl!, forked: false, adminUrl: null };
  }
  if (RUN_SCOPED_RE.test(name) || CI_DB_RE.test(name)) {
    console.log(`[test] 库 ${name} 已按运行隔离，直接使用`);
    return { url: testDatabaseUrl!, forked: false, adminUrl: null };
  }

  const forked = forkDatabaseName();
  console.log(
    `[test] 库 ${name} 是共享库，按 t52 规则 fork 独立库 ${forked}（跑完自动 DROP，避免并发 reset 互踢）`,
  );
  return { url: withDatabase(testDatabaseUrl!, forked), forked: true, adminUrl: adminUrlFor(testDatabaseUrl!) };
}

async function createForkedDatabase(plan: DatabasePlan): Promise<void> {
  const name = databaseName(plan.url);
  const admin = new PrismaClient({ datasources: { db: { url: plan.adminUrl! } } });
  try {
    // 先清掉本进程名下的历史残留（pid 复用/上次被 SIGKILL），再创建。
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    console.log(`[test] 已创建独立库 ${name}（admin=${maskUrl(plan.adminUrl!)}）`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[test] 无法创建独立库 ${name}：${message.split('\n')[0]}`);
    console.error(`[test] 需要连接用户具备 CREATEDB（admin=${maskUrl(plan.adminUrl!)}）。`);
    console.error('[test] 若环境不允许建库，请显式关闭 fork：DSSAAS_TEST_DB_MODE=direct');
    console.error('[test] 注意 direct 模式不再防并发：同一库同时跑两个测试进程仍会互踢。');
    throw error;
  } finally {
    await admin.$disconnect();
  }
}

/** pid 是否仍存活（signal 0）。EPERM 表示进程存在但无权操作，仍算存活。 */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 回收**已被 SIGKILL** 的前序运行遗留的独立库（t52）。
 *
 * 为什么需要：`finally` 只在正常退出或可捕获信号（SIGINT/SIGTERM）时执行。
 * 进程被 `kill -9` 或宿主机断电时库会残留；实测确认过这一点（见验收记录）。
 * 长期累积会占满磁盘，也让「库名带 pid」失去可追溯性。
 *
 * 判定规则：库名形如 `dssaas_test_<pid>_<6hex>`；取 pid 做存活检查——
 *   - pid 已不存在 → 残留，DROP；
 *   - pid 存在 → 可能是别的运行（pid 复用）或本进程，跳过。
 * 只动 fork 命名，绝不碰 `dssaas_test_<6hex>`（with-db 建的）与共享库。
 */
async function reclaimOrphanedDatabases(adminUrl: string): Promise<void> {
  if (process.env.DSSAAS_TEST_DB_RECLAIM === '0') {
    console.log('[test] DSSAAS_TEST_DB_RECLAIM=0：跳过残留库回收');
    return;
  }
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  try {
    const rows = await admin.$queryRawUnsafe<Array<{ datname: string }>>(
      "SELECT datname FROM pg_database WHERE datname ~ '^dssaas_test_[0-9]+_[0-9a-f]{6}$'",
    );
    const orphans = rows
      .map((row) => ({ name: row.datname, pid: Number(/^dssaas_test_(\d+)_/.exec(row.datname)?.[1] ?? '0') }))
      .filter((item) => item.pid > 0 && item.pid !== process.pid && !isPidAlive(item.pid));
    if (orphans.length === 0) return;
    for (const orphan of orphans) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${orphan.name}" WITH (FORCE)`);
      console.log(`[test] 回收残留库 ${orphan.name}（其 pid=${orphan.pid} 已不存在）`);
    }
  } catch (error) {
    // 尽力而为：权限不足或并发竞态都不该阻断测试本身。
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[test] 残留库回收跳过：${message.split('\n')[0]}`);
  } finally {
    await admin.$disconnect();
  }
}

async function dropForkedDatabase(plan: DatabasePlan): Promise<void> {
  if (!plan.forked || !plan.adminUrl) return;
  const name = databaseName(plan.url);
  const admin = new PrismaClient({ datasources: { db: { url: plan.adminUrl } } });
  try {
    // WITH (FORCE)（PG 13+）：先踢掉残留连接，否则刚跑完的池可能让 DROP 失败。
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    console.log(`[test] 已 DROP 独立库 ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[test] DROP 独立库 ${name} 失败：${message.split('\n')[0]}`);
    console.error(`[test] 请手动清理：DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
  } finally {
    await admin.$disconnect();
  }
}

async function resetSchema(url: string): Promise<void> {
  const name = databaseName(url);
  const expectedPrefix = process.env.DSSAAS_EXPECT_DB_PREFIX;
  if (expectedPrefix && !name.startsWith(expectedPrefix)) {
    console.error(
      `[test] 拒绝执行：库名 "${name || '(unknown)'}" 不以 DSSAAS_EXPECT_DB_PREFIX="${expectedPrefix}" 开头。`,
    );
    console.error('[test] 该守卫用于防止误连共享库；请使用 pnpm test:api 或修正 TEST_DATABASE_URL。');
    process.exit(2);
  }
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  } finally {
    await prisma.$disconnect();
  }
}

function runNode(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): number {
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd ?? appRoot,
    env: options.env ?? process.env,
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

async function main(): Promise<void> {
  const plan = planDatabase();
  const runUrl = plan.url;

  console.log(`[test] database = ${maskUrl(runUrl).replace(/:[^:@/]+@/, ':***@')}`);
  console.log(`[test] pid = ${process.pid} · started_at = ${new Date().toISOString()}`);

  if (plan.forked) {
    await reclaimOrphanedDatabases(plan.adminUrl!);
    await createForkedDatabase(plan);
  }

  // 无论成功、失败还是 Ctrl-C，都要回收独立库，避免泄漏。
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await dropForkedDatabase(plan);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void cleanup().finally(() => process.exit(130));
    });
  }

  try {
    await resetSchema(runUrl);
    console.log('[test] schema reset');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: runUrl,
      TEST_DATABASE_URL: runUrl,
    };

    const prismaCli = resolve(repoRoot, 'packages/db/node_modules/prisma/build/index.js');
    const migrateCode = runNode(
      [prismaCli, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
      { cwd: resolve(repoRoot, 'packages/db'), env },
    );
    if (migrateCode !== 0) {
      console.error('[test] migrate deploy failed');
      process.exitCode = migrateCode;
      return;
    }
    console.log('[test] migrations applied');

    const only = process.env.TEST_ONLY;
    const files = readdirSync(join(appRoot, 'test'))
      .filter((file) => file.endsWith('.test.ts'))
      .filter((file) => !only || file.includes(only))
      .sort()
      .map((file) => `test/${file}`);
    if (files.length === 0) {
      console.error('[test] no test files found');
      process.exitCode = 1;
      return;
    }

    process.exitCode = runNode(
      ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=spec', ...files],
      { cwd: appRoot, env },
    );
    console.log(`[test] finished_at = ${new Date().toISOString()} · pid = ${process.pid}`);
  } finally {
    await cleanup();
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error: unknown) => {
    console.error('[test] setup failed', error);
    process.exit(1);
  });
