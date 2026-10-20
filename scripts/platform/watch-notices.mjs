#!/usr/bin/env node
/**
 * 平台公告采集与变更检测（docs/01 §6.2、docs/02 §6.2）。
 *
 * 数据源：
 * - PDD：公开 JSON 接口 `https://open-api.pinduoduo.com/doc/announcement/list`
 *   （页面 https://open.pinduoduo.com/application/document/announcement 的同源数据），无需登录；
 * - 1688：暂无公开可核实入口，按 docs/02 §6 记 TODO 并跳过（需开发者账号登录）。
 *
 * 产物（默认 data/notices/，data/ 已在 .gitignore）：
 *   <platform>.json         当前快照（标题/日期/分类/链接/内容 sha256/聚合）
 *   <platform>.sha256       快照文件 sha256
 *   <platform>.delta.json   本次新增/移除（供 open-change-ticket 消费）
 *   <platform>.prev.json    上次快照（审计用）
 *
 * 退出码：
 *   0 成功（含首次 baseline、0 新增、1688 跳过）
 *   2 网络/HTTP 失败（重试 2 次后）
 *   3 解析器需更新（响应结构变化/必要字段缺失/API success=false）
 *   1 参数或本地 IO 错误
 *
 * 用法：
 *   node scripts/platform/watch-notices.mjs
 *   node scripts/platform/watch-notices.mjs --platform pdd
 *   node scripts/platform/watch-notices.mjs --fixture data/notices/pdd.fixture.json
 *   node scripts/platform/watch-notices.mjs --merge --fixture <partial.json>
 *   node scripts/platform/watch-notices.mjs --json --now 2026-10-20T08:30:00.000Z
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  NOTICES_DIR,
  dateOf,
  nowIso,
  parseArgs,
  positiveInt,
  readJsonIfExists,
  readTextIfExists,
  relToRepo,
  sha256,
  toShanghaiIso,
  writeJson,
  writeSha256,
  writeTextAtomic,
} from './lib/common.mjs';

const SCHEMA_VERSION = 'platform-notices-v1';
const DELTA_SCHEMA_VERSION = 'platform-notices-delta-v1';

const PDD_SOURCE = {
  platform: 'pdd',
  kind: 'public-json-api',
  portalBase: 'https://open.pinduoduo.com',
  listUrl: 'https://open-api.pinduoduo.com/doc/announcement/list',
  categoryUrl: 'https://open-api.pinduoduo.com/doc/announcement/category',
  requires_login: false,
  parser: 'pdd-announcement-api-v1',
  note: '公开公告接口；无需登录。请求体来自页面 JS 的固定参数（createdAt 0..far future，type=-1 全部）。',
  request_body: {
    createdAtEnd: 1963821842000,
    createdAtStart: 0,
    id: 0,
    pageIndex: 0,
    pageSize: 500,
    platform: -1,
    publishedAtEnd: 1963821842000,
    publishedAtStart: 0,
    status: -1,
    type: -1,
  },
};

const PDD_CATEGORIES_FALLBACK = {
  '-1': '所有公告',
  0: '未分类',
  1: '活动公告',
  2: '技术变更',
  3: '规则变更',
  4: '产品发布',
  5: '处罚公告',
};

const PLATFORM_1688 = {
  platform: '1688',
  requires_login: true,
  todo: '待填：1688 开放平台公告/规则中心公开 URL（docs/02 §6.2；当前未取得可核实的公开公告入口，需开发者账号登录后补解析器）',
};

class NetworkError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'NetworkError';
    this.detail = detail;
  }
}

class ParserError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ParserError';
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postJson(url, body, { timeoutMs, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json; charset=utf-8',
        origin: 'https://open.pinduoduo.com',
        referer: 'https://open.pinduoduo.com/application/document/announcement',
        'user-agent': 'dssaas-contract-drift-watcher/1.0 (+internal; no platform write)',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new NetworkError(`HTTP ${response.status} ${response.statusText}`, {
        status: response.status,
        body: text.slice(0, 300),
      });
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ParserError('响应不是合法 JSON（可能是 WAF/页面结构变化）', {
        body: text.slice(0, 300),
      });
    }
    return json;
  } catch (error) {
    if (error instanceof ParserError || error instanceof NetworkError) throw error;
    if (/** @type {Error} */ (error).name === 'AbortError') {
      throw new NetworkError(`请求超时（${timeoutMs}ms）`);
    }
    throw new NetworkError(`网络请求失败：${/** @type {Error} */ (error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function withNetworkRetry(label, operation, { retries, retryDelayMs }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof NetworkError)) throw error;
      lastError = error;
      if (attempt < retries) {
        const wait = retryDelayMs * (attempt + 1);
        console.error(`[watch] ${label} 第 ${attempt + 1} 次失败：${error.message}；${wait}ms 后重试`);
        await sleep(wait);
      }
    }
  }
  throw lastError;
}

async function fetchCategories({ timeoutMs, fetchImpl }) {
  try {
    const json = await postJson(PDD_SOURCE.categoryUrl, {}, { timeoutMs, fetchImpl });
    if (json?.success && Array.isArray(json.result)) {
      const map = { ...PDD_CATEGORIES_FALLBACK };
      for (const item of json.result) map[String(item.code)] = item.name;
      return { map, source: 'live' };
    }
    return { map: PDD_CATEGORIES_FALLBACK, source: 'fallback' };
  } catch (error) {
    console.error(`[watch] 分类接口不可用，使用内置映射（${error.message}）`);
    return { map: PDD_CATEGORIES_FALLBACK, source: 'fallback' };
  }
}

function parseApiPayload(payload, source) {
  if (!payload || typeof payload !== 'object') {
    throw new ParserError('响应不是对象');
  }
  if (payload.success !== true) {
    throw new ParserError('API 返回 success!=true（参数/权限/接口可能已变更）', {
      error_code: payload.errorCode ?? payload.error_code ?? null,
      error_msg: payload.errorMsg ?? payload.error_msg ?? null,
    });
  }
  const result = payload.result;
  if (!result || typeof result !== 'object') {
    throw new ParserError('响应缺少 result 对象');
  }
  if (!Array.isArray(result.announcementList)) {
    throw new ParserError('响应缺少 result.announcementList 数组');
  }
  if (typeof result.totalCount !== 'number') {
    throw new ParserError('响应缺少 result.totalCount 数字');
  }
  if (result.totalCount > 0 && result.announcementList.length === 0) {
    throw new ParserError('totalCount>0 但 announcementList 为空（分页参数或响应结构可能变化）');
  }
  return {
    items: result.announcementList,
    totalCount: result.totalCount,
    parser: source.parser,
  };
}

function parseFixturePayload(raw) {
  if (Array.isArray(raw)) return { items: raw, totalCount: raw.length, parser: 'fixture-array' };
  if (Array.isArray(raw?.items)) return { items: raw.items, totalCount: raw.items.length, parser: 'fixture-items' };
  if (Array.isArray(raw?.result?.announcementList)) {
    return {
      items: raw.result.announcementList,
      totalCount: raw.result.totalCount ?? raw.result.announcementList.length,
      parser: 'fixture-api-response',
    };
  }
  throw new ParserError('fixture 结构无法识别（支持 API 响应 / {items:[]} / 数组）');
}

function normalizeItems(rawItems, categoryMap, source, fetchedAt) {
  const issues = [];
  const items = [];
  for (const [index, raw] of rawItems.entries()) {
    if (!raw || typeof raw !== 'object') {
      issues.push(`第 ${index + 1} 条不是对象`);
      continue;
    }
    const noticeId = raw.id ?? raw.notice_id ?? raw.noticeId;
    const title = raw.theme ?? raw.title;
    const publishedRaw = raw.publishedAt ?? raw.published_at ?? raw.published_date;
    if (noticeId === undefined || noticeId === null || String(noticeId).trim() === '') {
      issues.push(`第 ${index + 1} 条缺少 id`);
      continue;
    }
    if (typeof title !== 'string' || title.trim() === '') {
      issues.push(`公告 ${noticeId} 缺少标题（theme/title）`);
      continue;
    }
    const publishedAt = toShanghaiIso(publishedRaw);
    if (publishedAt === null) {
      issues.push(`公告 ${noticeId} 的日期无法解析：${String(publishedRaw)}`);
      continue;
    }
    const categoryCode = Number.isFinite(Number(raw.type ?? raw.category_code)) ? Number(raw.type ?? raw.category_code) : -1;
    const category = categoryMap[String(categoryCode)] ?? raw.category ?? (categoryCode === -1 ? '未分类' : `类型 ${categoryCode}`);
    const link =
      typeof raw.link === 'string' && raw.link.trim() !== ''
        ? raw.link.trim()
        : `${source.portalBase}/application/document/announcement?id=${encodeURIComponent(String(noticeId))}`;
    const content = typeof raw.content === 'string' ? raw.content : null;
    items.push({
      notice_id: String(noticeId),
      title: title.normalize('NFC').trim(),
      published_at: publishedAt,
      published_date: dateOf(publishedAt),
      category,
      category_code: categoryCode,
      link,
      link_hash: sha256(link),
      content_sha256: content === null ? null : sha256(content),
      source: source.parser,
      first_seen_at: fetchedAt,
      last_seen_at: fetchedAt,
    });
  }
  if (issues.length > 0) {
    throw new ParserError(`公告字段结构变化（${issues.length} 条）`, { issues: issues.slice(0, 8) });
  }

  const byHash = new Map();
  for (const item of items) {
    const existing = byHash.get(item.link_hash);
    if (existing) {
      existing.last_seen_at = fetchedAt;
      if (item.content_sha256 && existing.content_sha256 !== item.content_sha256) {
        existing.content_sha256 = item.content_sha256;
      }
      continue;
    }
    byHash.set(item.link_hash, item);
  }
  return [...byHash.values()].sort((a, b) => (a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : Number(b.notice_id) - Number(a.notice_id)));
}

function aggregateByDate(items) {
  const result = {};
  for (const item of items) {
    result[item.published_date] ??= [];
    result[item.published_date].push(item.link_hash);
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => (a < b ? 1 : -1)));
}

function countByCategory(items) {
  const result = {};
  for (const item of items) result[item.category] = (result[item.category] ?? 0) + 1;
  return result;
}

function buildSnapshot({ source, fetchedAt, items, totalCount, categorySource, mode }) {
  return {
    schema_version: SCHEMA_VERSION,
    platform: source.platform,
    source: {
      kind: source.kind,
      url: source.listUrl,
      method: 'POST',
      requires_login: source.requires_login,
      parser: source.parser,
      parser_version: source.parser,
      note: source.note,
      request_body: source.request_body,
    },
    fetched_at: fetchedAt,
    last_success_at: fetchedAt,
    mode,
    total_count: totalCount,
    count: items.length,
    category_source: categorySource,
    counts: {
      total: items.length,
      by_category: countByCategory(items),
    },
    aggregated_by_date: aggregateByDate(items),
    items,
  };
}

function buildDelta({ platform, detectedAt, baseline, mode, newItems, removedItems, items }) {
  return {
    schema_version: DELTA_SCHEMA_VERSION,
    platform,
    detected_at: detectedAt,
    baseline,
    mode,
    counts: {
      new: newItems.length,
      removed: removedItems.length,
      total: items.length,
    },
    new_by_date: aggregateByDate(newItems),
    new: newItems,
    removed: removedItems.map((item) => ({
      notice_id: item.notice_id,
      title: item.title,
      published_date: item.published_date,
      link: item.link,
      link_hash: item.link_hash,
    })),
  };
}

function mergeItems(previousItems, incomingItems, fetchedAt) {
  const byHash = new Map();
  for (const item of previousItems) byHash.set(item.link_hash, { ...item });
  for (const item of incomingItems) {
    const existing = byHash.get(item.link_hash);
    if (existing) {
      byHash.set(item.link_hash, {
        ...existing,
        ...item,
        first_seen_at: existing.first_seen_at ?? item.first_seen_at,
        last_seen_at: fetchedAt,
      });
    } else {
      byHash.set(item.link_hash, item);
    }
  }
  return [...byHash.values()].sort((a, b) => (a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : Number(b.notice_id) - Number(a.notice_id)));
}

function summarize({ platform, mode, baseline, snapshot, delta, snapshotFile, shaFile, deltaFile, previousFile }) {
  return {
    ok: true,
    platform,
    mode,
    baseline,
    fetched_at: snapshot.fetched_at,
    total: snapshot.count,
    new: delta.counts.new,
    removed: delta.counts.removed,
    new_by_date: delta.new_by_date,
    snapshot: relToRepo(snapshotFile),
    sha256_file: relToRepo(shaFile),
    delta: relToRepo(deltaFile),
    previous: previousFile ? relToRepo(previousFile) : null,
    snapshot_sha256: sha256(`${JSON.stringify(snapshot, null, 2)}\n`),
    exit_code: 0,
  };
}

function printSummary(summary, newItems) {
  console.log(`[watch] platform=${summary.platform} mode=${summary.mode} baseline=${summary.baseline}`);
  console.log(`[watch] fetched=${summary.total} new=${summary.new} removed=${summary.removed}`);
  console.log(`[watch] snapshot=${summary.snapshot} sha256=${summary.snapshot_sha256}`);
  console.log(`[watch] delta=${summary.delta}`);
  const dates = Object.keys(summary.new_by_date);
  if (dates.length === 0) {
    console.log('[watch] 新增公告：无');
  } else {
    console.log('[watch] 新增公告（按发布日聚合）：');
    for (const date of dates) {
      const hashes = new Set(summary.new_by_date[date]);
      const inDate = newItems.filter((item) => hashes.has(item.link_hash));
      console.log(`  ${date} (${inDate.length})`);
      for (const item of inDate) {
        console.log(`    - [${item.category}] ${item.title} · ${item.link}`);
      }
    }
  }
}

async function watchPdd(flags) {
  const fetchedAt = flags.now ? new Date(flags.now).toISOString() : nowIso();
  const timeoutMs = positiveInt(flags['timeout-ms'], 20_000, { min: 1000, max: 120_000, name: '--timeout-ms' });
  const retries = positiveInt(flags.retries, 2, { min: 0, max: 5, name: '--retries' });
  const retryDelayMs = positiveInt(flags['retry-delay-ms'], 1000, { min: 0, max: 30_000, name: '--retry-delay-ms' });
  const mode = flags.fixture ? 'fixture' : 'fetch';

  let parser;
  if (flags.fixture) {
    const fixturePath = path.resolve(flags.fixture);
    const text = await readFile(fixturePath, 'utf8');
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new ParserError(`fixture 不是合法 JSON：${fixturePath}（${error.message}）`);
    }
    parser = parseFixturePayload(raw);
    console.log(`[watch] 使用 fixture：${fixturePath}`);
  } else {
    const body = { ...PDD_SOURCE.request_body, pageSize: positiveInt(flags['page-size'], PDD_SOURCE.request_body.pageSize, { min: 1, max: 1000, name: '--page-size' }) };
    const json = await withNetworkRetry('PDD 公告列表', () => postJson(PDD_SOURCE.listUrl, body, { timeoutMs }), {
      retries,
      retryDelayMs,
    });
    parser = parseApiPayload(json, PDD_SOURCE);
  }

  const categories = await fetchCategories({ timeoutMs, fetchImpl: fetch });
  const items = normalizeItems(parser.items, categories.map, PDD_SOURCE, fetchedAt);
  if (parser.totalCount !== items.length && mode === 'fetch') {
    console.error(`[watch] 注意：totalCount=${parser.totalCount}，实际解析=${items.length}（可能受 pageSize 限制）`);
  }

  const outputDir = path.resolve(flags['output-dir'] ?? NOTICES_DIR);
  const snapshotFile = path.join(outputDir, 'pdd.json');
  const shaFile = path.join(outputDir, 'pdd.sha256');
  const deltaFile = path.join(outputDir, 'pdd.delta.json');
  const previousFile = path.join(outputDir, 'pdd.prev.json');
  const previous = await readJsonIfExists(snapshotFile);
  const previousItems = Array.isArray(previous?.items) ? previous.items : [];
  const previousByHash = new Map(previousItems.map((item) => [item.link_hash, item]));
  const incomingByHash = new Map(items.map((item) => [item.link_hash, item]));
  const baseline = previous === null;

  const newItems = baseline ? [] : items.filter((item) => !previousByHash.has(item.link_hash));
  const removedItems = baseline || flags.merge ? [] : previousItems.filter((item) => !incomingByHash.has(item.link_hash));
  const snapshotItems = flags.merge ? mergeItems(previousItems, items, fetchedAt) : items;
  const snapshot = buildSnapshot({
    source: PDD_SOURCE,
    fetchedAt,
    items: snapshotItems,
    totalCount: flags.merge ? snapshotItems.length : parser.totalCount,
    categorySource: categories.source,
    mode,
  });
  const delta = buildDelta({
    platform: 'pdd',
    detectedAt: fetchedAt,
    baseline,
    mode,
    newItems,
    removedItems,
    items: snapshotItems,
  });

  if (!flags['dry-run']) {
    if (previous !== null) {
      const previousText = await readTextIfExists(snapshotFile);
      if (previousText !== null) await writeTextAtomic(previousFile, previousText);
    }
    await writeJson(snapshotFile, snapshot);
    const snapshotSha = sha256(`${JSON.stringify(snapshot, null, 2)}\n`);
    await writeSha256(shaFile, snapshotSha, 'pdd.json');
    await writeJson(deltaFile, delta);
  }

  const summary = summarize({ platform: 'pdd', mode, baseline, snapshot, delta, snapshotFile, shaFile, deltaFile, previousFile });
  if (!flags.json) printSummary(summary, newItems);
  return summary;
}

async function run1688(flags) {
  const summary = {
    ok: true,
    platform: '1688',
    skipped: true,
    requires_login: true,
    todo: PLATFORM_1688.todo,
    exit_code: 0,
  };
  if (flags.json) return summary;
  console.log('[watch] platform=1688 skipped=true');
  console.log(`[watch] 原因：${PLATFORM_1688.todo}`);
  return summary;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), {
    booleans: ['json', 'merge', 'dry-run', 'help', 'include-synthetic'],
  });
  if (flags.help) {
    console.log(`用法：node scripts/platform/watch-notices.mjs [options]

  --platform <pdd|1688|all>   默认 all
  --fixture <file>            用本地 fixture 代替抓取（演练/测试；支持 API 响应/{items:[]}/数组）
  --merge                     fixture/部分数据与已有快照合并（不删除旧条目）
  --output-dir <dir>          默认 data/notices
  --page-size <n>             PDD 单页条数，默认 500（当前 412 条可一次取回）
  --timeout-ms <n>            单请求超时，默认 20000
  --retries <n>               网络失败重试次数，默认 2
  --json                      输出机器可读摘要
  --dry-run                   不写快照
  --now <iso>                 固定抓取时间（测试用）

退出码：0 成功；2 网络失败（重试后）；3 解析器需更新；1 参数/IO 错误`);
    return;
  }

  const platform = String(flags.platform ?? 'all');
  if (!['pdd', '1688', 'all'].includes(platform)) throw new Error(`--platform 只能是 pdd|1688|all，实际 ${platform}`);

  const summaries = [];
  const errors = [];
  if (platform === 'pdd' || platform === 'all') {
    try {
      summaries.push(await watchPdd(flags));
    } catch (error) {
      const code = error?.name === 'ParserError' ? 3 : error?.name === 'NetworkError' ? 2 : 1;
      console.error(`[watch] PDD 失败（exit ${code}）：${error.message}`);
      if (error?.detail) console.error(`[watch] detail=${JSON.stringify(error.detail)}`);
      if (code === 3) console.error('[watch] 解析器需更新：响应结构/字段可能已变化，未写入快照；请更新 scripts/platform/watch-notices.mjs 并补 fixture 回归。');
      errors.push({ platform: 'pdd', code, message: error.message, detail: error.detail ?? null });
    }
  }
  if (platform === '1688' || (platform === 'all' && !flags.fixture)) {
    summaries.push(await run1688(flags));
  }
  if (platform === 'all' && flags.fixture) {
    console.log('[watch] --fixture 只作用于 PDD；1688 仍需登录，未运行。');
  }

  if (flags.json) {
    console.log(JSON.stringify({ ok: errors.length === 0, summaries, errors }, null, 2));
  }
  const parserError = errors.find((error) => error.code === 3);
  const networkError = errors.find((error) => error.code === 2);
  if (parserError) process.exitCode = 3;
  else if (networkError) process.exitCode = 2;
  else if (errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[watch] 失败：${error?.stack ?? error?.message ?? error}`);
  process.exitCode = error?.name === 'ParserError' ? 3 : error?.name === 'NetworkError' ? 2 : 1;
});
