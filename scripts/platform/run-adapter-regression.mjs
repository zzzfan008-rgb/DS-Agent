#!/usr/bin/env node
/**
 * adapter 回归钩子（docs/01 §6.4、docs/02 §6.2 第 3 段）。
 *
 * 读取变更工单 frontmatter 里的 regression_commands / regression_packages，
 * 顺序执行（默认 `pnpm --filter <adapter> test`），输出真实通过/失败摘要；
 * - 全部通过：工单 status=regression_passed，追加回归结果；
 * - 任一失败：工单 status=blocked，追加失败命令与输出尾部。
 *
 * 退出码：0 全部通过/无待回归；1 至少一个工单失败；2 输入/工单结构错误。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  REPO_ROOT,
  TICKETS_DIR,
  nowIso,
  parseArgs,
  positiveInt,
  readJsonIfExists,
  relToRepo,
  writeJson,
} from './lib/common.mjs';
import { readTicket, writeTicket } from './lib/frontmatter.mjs';

function tailLines(text, count = 40) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line, index, all) => line.trim() !== '' || index < all.length - 1);
  return lines.slice(-count).join('\n');
}

function commandsFor(ticketData) {
  const commands = Array.isArray(ticketData.regression_commands) ? [...ticketData.regression_commands] : [];
  if (commands.length === 0) {
    const packages = Array.isArray(ticketData.regression_packages) ? ticketData.regression_packages : [];
    for (const pkg of packages) commands.push(`pnpm --filter ${pkg} test`);
  }
  return commands.map((command) => String(command)).filter((command) => command.trim() !== '');
}

/**
 * 解析可用的 pnpm 可执行文件。
 *
 * 背景：本机 PATH 中可能同时存在 DSH 运行时的 pnpm shim（其内部 link 可能已被清理）
 * 与全局 npm/pnpm；`shell:true` 会优先命中前者并报 MODULE_NOT_FOUND。
 * 这里显式探测 `-v` 可用的候选，避免把环境问题误判为 adapter 回归失败。
 */
function resolvePnpmCommand(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(path.resolve(explicitPath));
  if (process.env.PNPM_EXEC_PATH) candidates.push(process.env.PNPM_EXEC_PATH);
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'pnpm.cmd'));
    candidates.push(path.join(process.env.APPDATA, 'npm', 'pnpm.exe'));
  }
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm'] : ['pnpm']) {
      candidates.push(path.join(dir, name));
    }
  }
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate) || !existsSync(candidate)) continue;
    seen.add(candidate);
    const probe = spawnSync(`"${candidate}" -v`, {
      shell: true,
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function withPnpm(command, pnpmPath) {
  if (!pnpmPath) return command;
  return command.replace(/^pnpm(?:\.cmd|\.exe)?(?=\s|$)/, `"${pnpmPath}"`);
}

async function discoverTickets(flags) {
  const ticketDir = path.resolve(flags['ticket-dir'] ?? TICKETS_DIR);
  if (flags.ticket) return [path.resolve(flags.ticket)];

  const index = await readJsonIfExists(path.join(ticketDir, 'index.json'));
  const includeSynthetic = Boolean(flags['include-synthetic']);
  if (index && Array.isArray(index.tickets)) {
    return index.tickets
      .filter((entry) => ['open', 'blocked'].includes(entry.status))
      .filter((entry) => includeSynthetic || entry.synthetic !== true)
      .filter((entry) => !flags.platform || entry.platform === flags.platform)
      .map((entry) => path.resolve(REPO_ROOT, entry.file))
      .filter((file) => file.endsWith('.md'));
  }

  // index 缺失时扫目录，避免“index 丢了就永远不回归”。
  const { readdir } = await import('node:fs/promises');
  let files = [];
  try {
    files = (await readdir(ticketDir)).filter((name) => name.endsWith('.md')).sort();
  } catch {
    files = [];
  }
  const result = [];
  for (const name of files) {
    const file = path.join(ticketDir, name);
    const ticket = await readTicket(file);
    if (!ticket?.data?.status) continue;
    if (!['open', 'blocked'].includes(ticket.data.status)) continue;
    if (!includeSynthetic && ticket.data.synthetic === true) continue;
    if (flags.platform && ticket.data.platform !== flags.platform) continue;
    result.push(file);
  }
  return result;
}

function runCommand(command, { timeoutMs, json }) {
  const startedAt = Date.now();
  const result = spawnSync(command, {
    cwd: REPO_ROOT,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, npm_execpath: undefined, npm_node_execpath: undefined },
  });
  const durationMs = Date.now() - startedAt;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (!json) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    console.log(`[regression] $ ${command} → exit=${result.status ?? 'null'} ${durationMs}ms`);
  }
  return {
    command,
    exitCode: result.status ?? (result.error ? -1 : 1),
    durationMs,
    signal: result.signal ?? null,
    error: result.error ? String(result.error.message) : null,
    tail: tailLines(`${stdout}\n${stderr}`),
  };
}

async function updateTicket(file, ticket, { success, results, now }) {
  const data = {
    ...ticket.data,
    status: success ? 'regression_passed' : 'blocked',
    last_regression_at: now,
    last_regression_result: success ? 'passed' : 'failed',
  };
  const lines = [
    `- 运行时间：${now}`,
    `- 结果：**${success ? '通过' : '失败'}**`,
    ...results.map(
      (result) =>
        `- 命令 \`${result.command}\` → exit=${result.exitCode}（${result.durationMs}ms）${result.error ? `；error=${result.error}` : ''}`,
    ),
  ];
  if (!success) {
    const failed = results.find((result) => result.exitCode !== 0);
    lines.push('', '失败输出（尾部）：', '', '```text', failed?.tail ?? '(无输出)', '```');
  }
  const body = `${ticket.body.replace(/\n+$/, '')}\n\n## 回归结果 · ${now}\n\n${lines.join('\n')}\n`;
  await writeTicket(file, data, body);
}

async function updateIndex(ticketDir, ticketId, status, now) {
  const file = path.join(ticketDir, 'index.json');
  const index = await readJsonIfExists(file);
  if (!index || !Array.isArray(index.tickets)) return;
  const entry = index.tickets.find((item) => item.ticket_id === ticketId);
  if (!entry) return;
  entry.status = status;
  entry.last_regression_at = now;
  index.updated_at = now;
  await writeJson(file, index);
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), { booleans: ['json', 'dry-run', 'help', 'include-synthetic'] });
  if (flags.help) {
    console.log(`用法：node scripts/platform/run-adapter-regression.mjs [options]

  --ticket <file>            指定工单（默认扫描 docs/变更工单/index.json 的 open/blocked 工单）
  --ticket-dir <dir>         默认 docs/变更工单
  --platform <pdd|1688>      过滤平台
  --command <cmd>            覆盖工单内的回归命令（演练/排查；只运行这一条）
  --pnpm <path>              显式指定可用的 pnpm（默认自动探测 APPDATA/npm 与 PATH）
  --include-synthetic        扫描时包含 synthetic 演练工单（默认跳过）
  --timeout-ms <n>           单条命令超时，默认 600000
  --json                     输出机器可读摘要（不回显子进程输出）
  --dry-run                  只打印将执行的命令

退出码：0 通过/无工单；1 至少一个工单回归失败；2 输入/工单结构错误`);
    return;
  }

  const now = flags.now ? new Date(flags.now).toISOString() : nowIso();
  const timeoutMs = positiveInt(flags['timeout-ms'], 600_000, { min: 1000, max: 3_600_000, name: '--timeout-ms' });
  const json = Boolean(flags.json);
  const ticketDir = path.resolve(flags['ticket-dir'] ?? TICKETS_DIR);
  const pnpmPath = resolvePnpmCommand(flags.pnpm);
  if (!pnpmPath) {
    console.error('[regression] 未找到可用的 pnpm（--pnpm 可显式指定）；命令可能因环境问题失败');
  } else if (!json) {
    console.log(`[regression] pnpm=${pnpmPath}`);
  }
  const files = await discoverTickets(flags);
  if (files.length === 0) {
    if (json) console.log(JSON.stringify({ ok: true, tickets: [], message: '无待回归工单' }, null, 2));
    else console.log('[regression] 无待回归工单（index 中无 open/blocked，或全部为 synthetic）');
    return;
  }

  const summary = { ok: true, tickets: [], errors: [] };
  for (const file of files) {
    const ticket = await readTicket(file);
    if (!ticket) {
      summary.ok = false;
      summary.errors.push({ file: relToRepo(file), error: '工单不存在' });
      continue;
    }
    if (!ticket.hasFrontmatter) {
      summary.ok = false;
      summary.errors.push({ file: relToRepo(file), error: '工单缺少 frontmatter' });
      continue;
    }
    const commands = (flags.command ? [String(flags.command)] : commandsFor(ticket.data)).map((command) =>
      withPnpm(command, pnpmPath),
    );
    if (commands.length === 0) {
      summary.ok = false;
      summary.errors.push({ file: relToRepo(file), error: '工单未声明 regression_commands / regression_packages' });
      continue;
    }
    console.log(`[regression] ticket=${relToRepo(file)} ticket_id=${ticket.data.ticket_id ?? '(none)'}`);
    for (const command of commands) console.log(`[regression]   $ ${command}`);
    if (flags['dry-run']) {
      summary.tickets.push({ file: relToRepo(file), ticket_id: ticket.data.ticket_id ?? null, dry_run: true, commands });
      continue;
    }

    const results = [];
    for (const command of commands) results.push(runCommand(command, { timeoutMs, json }));
    const success = results.every((result) => result.exitCode === 0);
    await updateTicket(file, ticket, { success, results, now });
    await updateIndex(ticketDir, String(ticket.data.ticket_id ?? ''), success ? 'regression_passed' : 'blocked', now);
    if (!success) summary.ok = false;
    summary.tickets.push({
      file: relToRepo(file),
      ticket_id: ticket.data.ticket_id ?? null,
      status: success ? 'regression_passed' : 'blocked',
      results,
    });
    console.log(`[regression] ${success ? 'PASS' : 'FAIL'} ${relToRepo(file)} → status=${success ? 'regression_passed' : 'blocked'}`);
  }

  if (json) console.log(JSON.stringify(summary, null, 2));
  else {
    const passed = summary.tickets.filter((ticket) => ticket.status === 'regression_passed').length;
    const blocked = summary.tickets.filter((ticket) => ticket.status === 'blocked').length;
    console.log(`[regression] 完成：passed=${passed} blocked=${blocked} errors=${summary.errors.length}`);
  }
  if (summary.errors.length > 0) process.exitCode = 2;
  else if (!summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[regression] 失败：${error?.stack ?? error?.message ?? error}`);
  process.exitCode = 2;
});
