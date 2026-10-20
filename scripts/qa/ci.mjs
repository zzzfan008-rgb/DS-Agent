#!/usr/bin/env node
/**
 * 本地 / CI 统一门禁编排（docs/15 §9.1 PR 必过项）。
 *
 *   pnpm ci                    # 全量：lint → typecheck → test → prisma validate → 迁移可重复
 *   pnpm ci --skip-migrations  # 无本地数据库时跳过迁移项（CI 不应跳过）
 *
 * 顺序执行、fail fast：前一关红则后续不启动（docs/15 §1）。
 * 直接用 node 执行脚本，避免嵌套 pnpm 在并发 install 环境下的路径问题。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NODE = process.execPath;

const STEPS = [
  {
    id: 'lint',
    name: '静态门禁（docs/21 §11.3 + docs/15 §10）',
    commands: [[NODE, ['scripts/qa/static-check.mjs']]],
  },
  {
    id: 'typecheck',
    name: '类型检查（tsc -p）',
    commands: [[NODE, ['scripts/qa/workspace-task.mjs', 'typecheck']]],
  },
  {
    id: 'test',
    name: '单测（QA 规则 + 各包）',
    commands: [
      [NODE, ['--test', 'scripts/qa/__tests__/*.test.mjs']],
      [NODE, ['scripts/qa/workspace-task.mjs', 'test']],
    ],
  },
  {
    id: 'test:contract',
    name: '契约回放（fixture / Schema / 错误映射）',
    commands: [[NODE, ['--test', 'tests/contract/replay.test.mjs']]],
  },
  {
    id: 'test:fault',
    name: '故障注入（矩阵四维断言）',
    commands: [[NODE, ['--test', 'tests/fault/fault-injection.test.mjs']]],
  },
  {
    id: 'test:golden',
    name: '黄金集（结构 / 硬事实 / 版本锁）',
    commands: [
      [NODE, ['--test', 'tests/golden/golden.test.mjs']],
      [NODE, ['scripts/qa/golden-check.mjs']],
    ],
  },
  {
    id: 'db:validate',
    name: 'Prisma schema 校验',
    commands: [[NODE, ['scripts/qa/prisma-cli.mjs', 'validate', '--schema', 'prisma/schema.prisma']]],
  },
  {
    id: 'check:migrations',
    name: '迁移可重复（空库两次 migrate）',
    commands: [[NODE, ['scripts/qa/check-migrations.mjs']]],
  },
];

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, npm_execpath: undefined, npm_node_execpath: undefined },
    });
    child.on('error', (error) => resolve({ code: -1, error: error.message }));
    child.on('close', (code) => resolve({ code: code ?? -1 }));
  });
}

async function main() {
  const argv = process.argv.slice(2).filter((arg) => arg !== '--');
  const skipMigrations = argv.includes('--skip-migrations');
  const steps = skipMigrations ? STEPS.filter((s) => s.id !== 'check:migrations') : STEPS;

  const results = [];
  for (const step of steps) {
    console.log(`\n=== ${step.name} ===`);
    const startedAt = Date.now();
    let code = 0;
    for (const [command, args] of step.commands) {
      const result = await run(command, args);
      code = result.code;
      if (result.error) console.error(`[ci] ${result.error}`);
      if (code !== 0) break;
    }
    const ms = Date.now() - startedAt;
    results.push({ ...step, code, ms });
    if (code !== 0) {
      console.error(`\n✖ ${step.name} 失败（exit=${code}）。后续门禁不再启动（fail fast）。`);
      break;
    }
    console.log(`✔ ${step.name} 通过（${(ms / 1000).toFixed(1)}s）`);
  }

  console.log('\n=== 门禁汇总 ===');
  for (const result of results) {
    console.log(`${result.code === 0 ? '✔' : '✖'} ${result.name}  ${(result.ms / 1000).toFixed(1)}s`);
  }
  if (skipMigrations) console.log('- 迁移可重复  已跳过（--skip-migrations）');

  const failed = results.filter((r) => r.code !== 0);
  if (failed.length > 0) {
    console.error(`\n结论：${failed.length} 项失败，CI 必须失败。`);
    return 1;
  }
  console.log('\n结论：全部门禁通过。');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[ci] 运行失败：${error.stack ?? error.message}`);
    process.exit(2);
  });
