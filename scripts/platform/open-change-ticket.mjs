#!/usr/bin/env node
/**
 * 公告增量 → 变更工单（docs/01 §6.3、docs/02 §6.2）。
 *
 * 输入：data/notices/<platform>.delta.json（由 watch-notices.mjs 生成）
 * 输出：docs/变更工单/YYYY-MM-DD-<platform>-<slug>.md + docs/变更工单/index.json
 *
 * 幂等：按公告链接哈希 `link_hash` 去重；已存在则跳过（不覆盖、不改内容）。
 * 分级：标题命中 P0 关键词 → P0；否则按分类/路由（P1/P2）。
 * 责任人与截止：默认「平台接入负责人」、T+3（可由 --due-days 调整）。
 *
 * 退出码：0 成功（含全部重复跳过）；2 无可用 delta；1 参数/IO 错误。
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  INTERFACE_TEST_MAP_FILE,
  NOTICES_DIR,
  TICKETS_DIR,
  addDaysIso,
  nowIso,
  parseArgs,
  positiveInt,
  readJsonIfExists,
  readTextIfExists,
  relToRepo,
  writeJson,
} from './lib/common.mjs';
import { readTicket, writeTicket } from './lib/frontmatter.mjs';
import { resolveImpact } from './lib/impact.mjs';

const INDEX_SCHEMA_VERSION = 'drift-ticket-index-v1';
const OWNER = '平台接入负责人';
const TICKET_PREFIX = 'drift';

function safeSlug(title, fallback) {
  const cleaned = String(title ?? '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (cleaned || fallback).slice(0, 40);
}

function isSynthetic(title) {
  return /【测试】|synthetic|fixture/i.test(String(title ?? ''));
}

async function loadDeltaFiles(flags) {
  if (flags.delta) {
    const file = path.resolve(flags.delta);
    const delta = await readJsonIfExists(file);
    if (!delta) return { files: [], errors: [`delta 不存在：${file}`] };
    return { files: [{ file, delta }], errors: [] };
  }
  const platform = String(flags.platform ?? 'all');
  const outputDir = path.resolve(flags['notices-dir'] ?? NOTICES_DIR);
  const platforms = platform === 'all' ? ['pdd', '1688'] : [platform];
  const files = [];
  for (const name of platforms) {
    const file = path.join(outputDir, `${name}.delta.json`);
    const delta = await readJsonIfExists(file);
    if (delta) files.push({ file, delta });
  }
  return { files, errors: files.length === 0 ? [`未找到 delta（${outputDir}/<platform>.delta.json）；请先运行 watch-notices.mjs`] : [] };
}

async function loadExistingIndex(ticketDir) {
  const indexFile = path.join(ticketDir, 'index.json');
  const index = (await readJsonIfExists(indexFile)) ?? {
    schema_version: INDEX_SCHEMA_VERSION,
    updated_at: null,
    tickets: [],
  };
  if (!Array.isArray(index.tickets)) index.tickets = [];
  const byLinkHash = new Map(index.tickets.filter((item) => item?.link_hash).map((item) => [item.link_hash, item]));

  // 双保险：即使 index 丢失，也从已有工单 frontmatter 恢复幂等键。
  let files = [];
  try {
    files = (await readdir(ticketDir)).filter((name) => name.endsWith('.md')).sort();
  } catch {
    files = [];
  }
  for (const name of files) {
    const file = path.join(ticketDir, name);
    const ticket = await readTicket(file);
    const linkHash = ticket?.data?.link_hash;
    if (typeof linkHash === 'string' && !byLinkHash.has(linkHash)) {
      byLinkHash.set(linkHash, { ...ticket.data, file: relToRepo(file) });
    }
  }
  return { indexFile, index, byLinkHash };
}

function renderTicketBody({ notice, impact, ticketId, createdAt, dueAt }) {
  const docLines =
    impact.doc_refs.length > 0
      ? impact.doc_refs.map((ref) => `- \`${ref}\``).join('\n')
      : '- 未匹配到具体文档条目，需人工确认（docs/01 或 docs/02 §2）';
  const interfaceLines =
    impact.interfaces.length > 0 ? impact.interfaces.map((key) => `- \`${key}\``).join('\n') : '- （无）';
  const testLines = impact.tests.length > 0 ? impact.tests.map((test) => `- \`${test}\``).join('\n') : '- （无）';

  return `# 变更工单 · ${notice.title}

> 由 \`scripts/platform/open-change-ticket.mjs\` 根据 \`watch-notices\` 的公告增量自动生成。
> 本工单只读公告数据，未调用任何平台写接口；回归命令只跑本地 adapter 测试。

## 公告

| 项 | 内容 |
|---|---|
| 标题 | ${notice.title} |
| 发布时间 | ${notice.published_at}（上海时间 ${notice.published_date}） |
| 分类 | ${notice.category}（type=${notice.category_code}） |
| 链接 | ${notice.link} |
| link_hash | \`${notice.link_hash}\` |
| notice_id | \`${notice.notice_id}\` |
| 检测时间 | ${createdAt} |
| 工单编号 | \`${ticketId}\` |
| 数据来源 | ${notice.source}（synthetic=${isSynthetic(notice.title)}） |

## 影响面

平台：**${impact.platform}**（${impact.package}）

接口条目：

${interfaceLines}

文档引用：

${docLines}

命中路由：${impact.matched_routes.length > 0 ? impact.matched_routes.join('、') : '无（使用默认映射）'}
${impact.fallback ? '\n> ⚠️ mapping_fallback=true：标题未命中关键词路由，工单使用平台默认接口与默认测试；请人工确认影响面。' : ''}

## 需回归的 adapter 测试

- 包：\`${impact.package}\`
- 命令：\`${impact.test_command}\`
- 测试文件：

${testLines}

## 责任人 / 截止

- 责任人：${OWNER}
- 创建时间：${createdAt}
- 截止时间：${dueAt}（默认 T+3；P0 按 docs/01 §6.3 应在 24h 内 hotfix）

## 处置清单

- [ ] 打开公告原文，确认是否 breaking（无法判断时按 P0，docs/01 §6.3 G9）
- [ ] 对照影响面逐条检查 adapter 字段/枚举/错误码（未核验接口先看注册表 TODO）
- [ ] 运行回归：\`node scripts/platform/run-adapter-regression.mjs --ticket <本文件>\`
- [ ] 回归失败 → 工单自动置 \`blocked\`，冻结对应自动写并转人工/导入包
- [ ] 更新 docs/01 或 docs/02 对应行、补脱敏 fixture、记录 release_id
- [ ] 关闭工单并登记 closed_at

## 回归结果

（尚未运行；运行 \`run-adapter-regression.mjs\` 后自动追加）
`;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), { booleans: ['json', 'dry-run', 'help'] });
  if (flags.help) {
    console.log(`用法：node scripts/platform/open-change-ticket.mjs [options]

  --platform <pdd|1688|all>   默认 all
  --delta <file>              直接指定 delta 文件（默认 data/notices/<platform>.delta.json）
  --notices-dir <dir>         默认 data/notices
  --ticket-dir <dir>          默认 docs/变更工单
  --due-days <n>              截止 T+N 天，默认 3
  --now <iso>                 固定创建时间（测试用）
  --json                      输出机器可读摘要
  --dry-run                   只打印将创建的工单，不写文件

退出码：0 成功；2 无可用 delta；1 参数/IO 错误`);
    return;
  }

  const now = flags.now ? new Date(flags.now).toISOString() : nowIso();
  const dueDays = positiveInt(flags['due-days'], 3, { min: 1, max: 30, name: '--due-days' });
  const ticketDir = path.resolve(flags['ticket-dir'] ?? TICKETS_DIR);
  const { files, errors } = await loadDeltaFiles(flags);
  if (errors.length > 0) {
    for (const error of errors) console.error(`[ticket] ${error}`);
    process.exitCode = 2;
    return;
  }
  if (!(await readJsonIfExists(INTERFACE_TEST_MAP_FILE))) {
    throw new Error(`接口测试映射缺失：${INTERFACE_TEST_MAP_FILE}`);
  }

  const { indexFile, index, byLinkHash } = await loadExistingIndex(ticketDir);
  const created = [];
  const skipped = [];
  const failed = [];

  for (const { file, delta } of files) {
    const platform = delta.platform;
    if (!platform) {
      failed.push({ file: relToRepo(file), error: 'delta 缺少 platform' });
      continue;
    }
    const newItems = Array.isArray(delta.new) ? delta.new : [];
    console.log(
      `[ticket] delta=${relToRepo(file)} platform=${platform} baseline=${Boolean(delta.baseline)} new=${newItems.length}`,
    );
    for (const notice of newItems) {
      if (!notice?.link_hash || !notice?.title) {
        failed.push({ file: relToRepo(file), error: '公告缺少 link_hash/title' });
        continue;
      }
      const existing = byLinkHash.get(notice.link_hash);
      if (existing) {
        skipped.push({ platform, title: notice.title, link_hash: notice.link_hash, existing: existing.file ?? null });
        console.log(`[ticket] SKIP duplicate ${notice.link_hash.slice(0, 12)}… ${notice.title}`);
        continue;
      }
      const impact = await resolveImpact({
        platform,
        title: notice.title,
        categoryCode: notice.category_code,
        category: notice.category,
      });
      const date = notice.published_date || now.slice(0, 10);
      const slug = safeSlug(notice.title, String(notice.notice_id ?? 'notice'));
      const baseName = `${date}-${platform}-${slug}`;
      let fileName = `${baseName}.md`;
      let counter = 1;
      while ((await readTextIfExists(path.join(ticketDir, fileName))) !== null && counter < 20) {
        counter += 1;
        fileName = `${baseName}-${notice.notice_id}${counter > 2 ? `-${counter}` : ''}.md`;
      }
      const target = path.join(ticketDir, fileName);
      const ticketId = `${TICKET_PREFIX}-${date.replaceAll('-', '')}-${platform}-${String(notice.notice_id).replace(/[^\w.-]/g, '_')}`;
      const dueAt = addDaysIso(now, dueDays);
      const data = {
        ticket_id: ticketId,
        platform,
        notice_id: String(notice.notice_id),
        link_hash: notice.link_hash,
        title: notice.title,
        published_at: notice.published_at,
        published_date: notice.published_date,
        category: notice.category,
        category_code: notice.category_code,
        severity: impact.severity,
        status: 'open',
        synthetic: isSynthetic(notice.title),
        owner: OWNER,
        created_at: now,
        due_at: dueAt,
        affected_interfaces: impact.interfaces,
        affected_doc_refs: impact.doc_refs,
        regression_packages: [impact.package],
        regression_commands: [impact.test_command],
        regression_tests: impact.tests,
        matched_routes: impact.matched_routes,
        mapping_fallback: impact.fallback,
      };
      const body = renderTicketBody({ notice, impact, ticketId, createdAt: now, dueAt });
      if (!flags['dry-run']) {
        await writeTicket(target, data, body);
        byLinkHash.set(notice.link_hash, { ...data, file: relToRepo(target) });
        index.tickets.push({
          ticket_id: ticketId,
          platform,
          notice_id: String(notice.notice_id),
          link_hash: notice.link_hash,
          title: notice.title,
          severity: impact.severity,
          status: 'open',
          synthetic: data.synthetic,
          file: relToRepo(target),
          created_at: now,
          due_at: dueAt,
        });
      }
      created.push({ ticket_id: ticketId, file: relToRepo(target), severity: impact.severity, synthetic: data.synthetic, interfaces: impact.interfaces });
      console.log(`[ticket] CREATE ${relToRepo(target)} severity=${impact.severity} interfaces=${impact.interfaces.length} synthetic=${data.synthetic}`);
    }
  }

  if (!flags['dry-run']) {
    index.updated_at = now;
    await writeJson(indexFile, index);
  }

  const summary = {
    ok: failed.length === 0,
    dry_run: Boolean(flags['dry-run']),
    created,
    skipped,
    failed,
    index: relToRepo(indexFile),
    counts: { created: created.length, skipped: skipped.length, failed: failed.length },
  };
  if (flags.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`[ticket] 完成：created=${created.length} skipped=${skipped.length} failed=${failed.length}`);
    console.log(`[ticket] index=${relToRepo(indexFile)}`);
  }
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[ticket] 失败：${error?.stack ?? error?.message ?? error}`);
  process.exitCode = 1;
});
