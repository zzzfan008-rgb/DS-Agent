#!/usr/bin/env node
/**
 * Prisma CLI 包装器 —— 固定 cwd 到 packages/db，直接调用本地 prisma，不经过嵌套 pnpm。
 *
 * 用法：
 *   node scripts/qa/prisma-cli.mjs validate --schema prisma/schema.prisma
 *   node scripts/qa/prisma-cli.mjs migrate deploy --schema prisma/schema.prisma
 */

import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DB_DIR = path.join(REPO_ROOT, 'packages/db');

async function main() {
  const candidates = [
    path.join(DB_DIR, 'node_modules/prisma/build/index.js'),
    path.join(REPO_ROOT, 'node_modules/prisma/build/index.js'),
  ];
  let entry = null;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      entry = candidate;
      break;
    } catch {
      /* next */
    }
  }
  if (!entry) {
    console.error('[prisma-cli] 找不到 prisma CLI，请先在仓库根执行 pnpm install。');
    return 1;
  }

  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('[prisma-cli] 缺少 prisma 子命令。');
    return 2;
  }

  const env = { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' };
  delete env.npm_execpath;
  delete env.npm_node_execpath;

  const child = spawn(process.execPath, [entry, ...args], {
    cwd: DB_DIR,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  return await new Promise((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[prisma-cli] 运行失败：${error.stack ?? error.message}`);
    process.exit(2);
  });
