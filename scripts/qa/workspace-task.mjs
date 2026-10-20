#!/usr/bin/env node
/**
 * 工作区任务运行器 —— 替代 `pnpm -r --if-present <task>`。
 *
 * 为什么不用嵌套 pnpm：
 *   pnpm 脚本内部再调用 pnpm 时会继承 npm_execpath；在多 agent / 并发 install 的
 *   机器上该路径可能被临时清理，导致 MODULE_NOT_FOUND。本脚本直接按
 *   pnpm-workspace.yaml 枚举包，用 shell 执行各包的 script，行为等价且可诊断。
 *
 * 用法：node scripts/qa/workspace-task.mjs <task>
 */

import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function workspacePatterns() {
  const yaml = await readFile(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const patterns = [];
  let inPackages = false;
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.replace(/#.*$/, '');
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const match = line.match(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/);
    if (match) {
      patterns.push(match[1]);
      continue;
    }
    if (/^\S/.test(line)) inPackages = false;
  }
  return patterns;
}

async function expandPatterns(patterns) {
  const dirs = new Set();
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      let entries = [];
      try {
        entries = await readdir(path.join(REPO_ROOT, base), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) dirs.add(path.posix.join(base, entry.name));
      }
    } else if (!pattern.includes('*')) {
      dirs.add(pattern);
    }
  }
  return [...dirs].sort();
}

async function readPackage(relDir) {
  try {
    const text = await readFile(path.join(REPO_ROOT, relDir, 'package.json'), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runScript(relDir, script) {
  return new Promise((resolve) => {
    const absDir = path.join(REPO_ROOT, relDir);
    const env = { ...process.env };
    delete env.npm_execpath;
    delete env.npm_node_execpath;
    const binPaths = [path.join(absDir, 'node_modules/.bin'), path.join(REPO_ROOT, 'node_modules/.bin')];
    env.PATH = [...binPaths, env.PATH ?? ''].join(path.delimiter);

    const child = spawn(script, {
      cwd: absDir,
      env,
      shell: true,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', (error) => resolve({ code: -1, error: error.message }));
    child.on('close', (code) => resolve({ code: code ?? -1 }));
  });
}

async function main() {
  const task = process.argv[2];
  if (!task || !/^[a-z][\w:-]*$/i.test(task)) {
    console.error('用法：node scripts/qa/workspace-task.mjs <task>');
    return 2;
  }

  const dirs = await expandPatterns(await workspacePatterns());
  const targets = [];
  for (const dir of dirs) {
    const pkg = await readPackage(dir);
    const script = pkg?.scripts?.[task];
    if (script) targets.push({ dir, name: pkg.name ?? dir, script });
  }

  if (targets.length === 0) {
    console.log(`[workspace-task] 没有包定义 "${task}" 脚本，跳过（0 个包）。`);
    return 0;
  }

  console.log(`[workspace-task] ${task}：${targets.length} 个包`);
  const results = [];
  for (const target of targets) {
    console.log(`\n--- ${target.name} (${target.dir}) ---`);
    const result = await runScript(target.dir, target.script);
    results.push({ ...target, ...result });
    if (result.code !== 0) {
      console.error(`✖ ${target.name} 的 ${task} 失败（exit=${result.code}）`);
      break;
    }
    console.log(`✔ ${target.name} 的 ${task} 通过`);
  }

  const failed = results.filter((r) => r.code !== 0);
  console.log('');
  for (const r of results) console.log(`${r.code === 0 ? '✔' : '✖'} ${r.name}  ${task}`);
  if (failed.length > 0) return 1;
  console.log(`[workspace-task] 全部 ${targets.length} 个包通过。`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[workspace-task] 运行失败：${error.stack ?? error.message}`);
    process.exit(2);
  });
