/**
 * t2 验收测试统一入口：
 *   1) 测试库守卫（库名必须以 _test 结尾）；
 *   2) 重置 schema（DROP/CREATE SCHEMA public）；
 *   3) prisma migrate deploy（不用 migrate dev，遵守 t1 约束）；
 *   4) 串行执行 test/*.test.ts。
 *
 * 环境变量：TEST_DATABASE_URL（必填；库名必须以 _test 结尾）。
 * 自包含运行：pnpm test:api（scripts/qa/with-db.mjs 起一次性 pgvector 容器）。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

async function resetSchema(): Promise<void> {
  const name = databaseName(testDatabaseUrl!);
  if (!/_test$/.test(name)) {
    throw new Error(`拒绝对非测试库执行重置：${name || '(unknown)'}（库名必须以 _test 结尾）`);
  }
  const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl! } } });
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
  console.log(`[test] database = ${testDatabaseUrl!.replace(/:[^:@/]+@/, ':***@')}`);
  await resetSchema();
  console.log('[test] schema reset');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl!,
    TEST_DATABASE_URL: testDatabaseUrl!,
  };

  const prismaCli = resolve(repoRoot, 'packages/db/node_modules/prisma/build/index.js');
  const migrateCode = runNode(
    [prismaCli, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
    { cwd: resolve(repoRoot, 'packages/db'), env },
  );
  if (migrateCode !== 0) {
    console.error('[test] migrate deploy failed');
    process.exit(migrateCode);
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
    process.exit(1);
  }

  const testCode = runNode(
    ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=spec', ...files],
    { cwd: appRoot, env },
  );
  process.exit(testCode);
}

main().catch((error: unknown) => {
  console.error('[test] setup failed', error);
  process.exit(1);
});
