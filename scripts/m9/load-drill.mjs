#!/usr/bin/env node
/**
 * M9 压测脚本（t44）：写路径 / 读路径 / 审批+写门 / 媒体 / SSE。
 *
 * 运行（独立测试库，with-db 负责建库/迁移/清理）：
 *   DSSAAS_DB_REUSE=1 DSSAAS_PG_BASE_URL="$DSSAAS_PG_BASE_URL" \
 *     node scripts/qa/with-db.mjs -- node apps/api/node_modules/tsx/dist/cli.mjs scripts/m9/load-drill.mjs
 *
 * 说明：
 * - 只读/写独立测试库；不触碰业务代码与 schema；
 * - API 与压测器在同一 Node 进程，内存数字是“进程级”近似值，文档会注明；
 * - 所有场景都记录 P50/P95/P99、吞吐、错误率、DB 连接数、内存前后值。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '../../packages/db/src/index.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { loadConfig } from '../../apps/api/src/config.ts';
import { hashPassword } from '../../apps/api/src/lib/password.ts';
import { publishTargetPayload } from '../../apps/api/src/write-gate/gate.ts';
import { MediaPipeline } from '../../apps/worker/src/media/pipeline.ts';
import { PrismaMediaRepository } from '../../apps/worker/src/media/prisma-repository.ts';
import { MockMediaProvider } from '../../apps/worker/src/media/provider.ts';
import { FsStorage } from '../../apps/worker/src/media/storage.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(REPO_ROOT, 'artifacts/m9');
const OUT_FILE = path.join(OUT_DIR, 'load-report.json');
const MEDIA_ROOT = path.join(OUT_DIR, 'media');
const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const ADMIN_EMAIL = 'm9.admin@test.local';
const OPERATOR_EMAIL = 'm9.operator@test.local';
const ADMIN_PASSWORD = 'M9AdminPassword!2026';
const OPERATOR_PASSWORD = 'M9OperatorPassword!2026';
const READ_CONCURRENCY = 50;
const READ_DURATION_MS = 60_000;
const WRITE_CONCURRENCY = 10;
const WRITE_TOTAL_PRODUCTS = 200;
const APPROVAL_COUNT = 100;
const PUBLISH_CONCURRENCY = 5;
const MEDIA_JOBS = 50;
const SSE_CONNECTIONS = 20;
const SSE_DURATION_MS = 120_000;

if (!DB_URL) {
  console.error('[M9] 缺少 TEST_DATABASE_URL/DATABASE_URL');
  process.exit(2);
}
const dbName = new URL(DB_URL).pathname.replace(/^\//, '');
if (!/(^dssaas_test_[0-9a-z]{6}$)|(_test$)|(^dssaas_ci$)/.test(dbName)) {
  console.error(`[M9] 拒绝在非隔离库上压测：${dbName}`);
  process.exit(2);
}

const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
const metricsPrisma = new PrismaClient({
  datasources: { db: { url: `${DB_URL}${DB_URL.includes('?') ? '&' : '?'}connection_limit=2` } },
});
const auth = { admin: null, operator: null };
let apiBase = '';
let app = null;
let adminId = '';
let operatorId = '';
let providerId = '';
let modelId = '';
const report = {
  run_id: randomUUID(),
  started_at: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    cpu_count: os.cpus().length,
    total_mem_mb: Math.round(os.totalmem() / 1024 / 1024),
    database: maskUrl(DB_URL),
    mode: 'API + load generator same Node process（内存为进程级近似）',
    concurrency: {
      write: WRITE_CONCURRENCY,
      read: READ_CONCURRENCY,
      read_duration_ms: READ_DURATION_MS,
      publish: PUBLISH_CONCURRENCY,
      media_workers: 2,
      sse_connections: SSE_CONNECTIONS,
      sse_duration_ms: SSE_DURATION_MS,
    },
  },
  scenarios: {},
  bottleneck: null,
  notes: [],
};

function maskUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '(invalid)';
  }
}

function mem() {
  const value = process.memoryUsage();
  return {
    rss_mb: Number((value.rss / 1024 / 1024).toFixed(1)),
    heap_used_mb: Number((value.heapUsed / 1024 / 1024).toFixed(1)),
    external_mb: Number((value.external / 1024 / 1024).toFixed(1)),
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(1));
}

function summarize(latencies, errors, durationMs) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const count = latencies.length;
  return {
    requests: count,
    errors,
    error_rate: count + errors === 0 ? 0 : Number((errors / (count + errors)).toFixed(4)),
    throughput_rps: durationMs <= 0 ? 0 : Number((count / (durationMs / 1000)).toFixed(2)),
    latency_ms: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(1)) : 0,
    },
    duration_ms: Math.round(durationMs),
  };
}

async function api(method, urlPath, { role = 'operator', body, timeoutMs = 15_000 } = {}) {
  const session = role ? auth[role] : null;
  const headers = { accept: 'application/json' };
  if (session) {
    headers.cookie = session.cookie;
    headers['x-csrf-token'] = session.csrf;
  }
  if (method !== 'GET') headers['idempotency-key'] = randomUUID();
  const started = performance.now();
  const response = await fetch(`${apiBase}${urlPath}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const elapsed = performance.now() - started;
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const error = json?.error ?? {};
    throw new Error(`HTTP ${response.status} ${error.code ?? ''} ${error.message ?? ''}`.trim());
  }
  return { status: response.status, body: json, elapsed };
}

async function login(email, password) {
  const response = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`登录失败：${response.status} ${JSON.stringify(json)}`);
  const setCookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean);
  const cookie = setCookies
    .map((value) => value.split(';')[0])
    .filter((value) => value.startsWith('dssaas_sid=') || value.startsWith('dssaas_csrf='))
    .join('; ');
  return { cookie, csrf: json.data.csrf_token };
}

async function ensureUser(email, password, roleCode, displayName) {
  const role = await prisma.role.findFirstOrThrow({ where: { code: roleCode, archivedAt: null } });
  const existing = await prisma.user.findFirst({ where: { email, archivedAt: null } });
  if (existing) return existing.id;
  const user = await prisma.user.create({
    data: {
      orgId: 1n,
      email,
      displayName,
      passwordHash: await hashPassword(password),
      status: 'active',
      totpEnabled: false,
    },
  });
  await prisma.membership.create({ data: { orgId: 1n, userId: user.id, roleId: role.id, status: 'active' } });
  return user.id;
}

async function sampleConnections() {
  try {
    const rows = await metricsPrisma.$queryRawUnsafe(
      'select count(*)::int as count from pg_stat_activity where datname = current_database()',
    );
    return Number(rows[0]?.count ?? 0);
  } catch {
    return null;
  }
}

class ConnectionSampler {
  constructor(intervalMs = 250) {
    this.intervalMs = intervalMs;
    this.samples = [];
    this.timer = null;
    this.running = false;
  }
  start() {
    this.running = true;
    this.samples = [];
    this.timer = setInterval(() => {
      if (!this.running) return;
      void sampleConnections().then((value) => {
        if (value !== null) this.samples.push(value);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }
  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    const last = await sampleConnections();
    if (last !== null) this.samples.push(last);
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      samples: this.samples.length,
      max: sorted.length ? sorted[sorted.length - 1] : null,
      p95: sorted.length ? percentile(sorted, 95) : null,
      last,
    };
  }
}

async function seedBaseProducts() {
  const data = [];
  for (let index = 0; index < 1000; index += 1) {
    data.push({
      orgId: 1n,
      spuCode: `LOAD-BASE-${String(index).padStart(4, '0')}`,
      name: `压测基础商品 ${index}`,
      categoryCode: 'A0101',
      createdBy: operatorId,
    });
  }
  for (let offset = 0; offset < data.length; offset += 200) {
    await prisma.product.createMany({ data: data.slice(offset, offset + 200) });
  }
}

function importCsv(batchIndex) {
  const header =
    'spu_code,name,category_code,color_id,size_code,price_cents,stock_qty,fabric_materials,measurements,effective_from,size_system';
  const lines = [header];
  for (let index = 0; index < WRITE_TOTAL_PRODUCTS / WRITE_CONCURRENCY; index += 1) {
    const spu = `LOAD-WRITE-${batchIndex}-${String(index).padStart(3, '0')}`;
    lines.push(
      [
        spu,
        `压测写入商品 ${batchIndex}-${index}`,
        'A0101',
        'BK-0101',
        'M',
        '9900',
        '10',
        JSON.stringify([{ material: '棉', percent: 100 }]),
        JSON.stringify({ 胸围: 100, 衣长: 70 }),
        '2026-10-01',
        'alpha',
      ]
        .map((value) => {
          const text = String(value);
          return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
        })
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

async function scenarioWrite() {
  const before = mem();
  const sampler = new ConnectionSampler();
  sampler.start();
  const latencies = [];
  const errors = [];
  const started = Date.now();
  await Promise.all(
    Array.from({ length: WRITE_CONCURRENCY }, async (_, batch) => {
      try {
        const result = await api('POST', '/api/products/import', {
          role: 'operator',
          body: { csv: importCsv(batch), platform_scope: 'both' },
          timeoutMs: 120_000,
        });
        latencies.push(result.elapsed);
      } catch (error) {
        errors.push(String(error));
      }
    }),
  );
  const connections = await sampler.stop();
  const after = mem();
  report.scenarios.write = {
    name: '写路径：POST /products 导入 200 条 CSV（并发 10）',
    ...summarize(latencies, errors.length, Date.now() - started),
    errors_sample: errors.slice(0, 5),
    db_connections: connections,
    memory: { before, after, rss_delta_mb: Number((after.rss_mb - before.rss_mb).toFixed(1)) },
  };
}

async function scenarioRead() {
  const before = mem();
  const sampler = new ConnectionSampler();
  sampler.start();
  const latencies = [];
  let errors = 0;
  let requests = 0;
  const errorSamples = [];
  const deadline = Date.now() + READ_DURATION_MS;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: READ_CONCURRENCY }, async () => {
      while (Date.now() < deadline) {
        try {
          const result = await api('GET', '/api/products?limit=20', { role: 'operator', timeoutMs: 20_000 });
          latencies.push(result.elapsed);
          requests += 1;
        } catch (error) {
          errors += 1;
          if (errorSamples.length < 5) errorSamples.push(String(error));
        }
      }
    }),
  );
  const connections = await sampler.stop();
  const after = mem();
  report.scenarios.read = {
    name: '读路径：GET /products（1000 条数据）并发 50、持续 60s',
    ...summarize(latencies, errors, Date.now() - started),
    requests,
    errors_sample: errorSamples,
    db_connections: connections,
    memory: { before, after, rss_delta_mb: Number((after.rss_mb - before.rss_mb).toFixed(1)) },
  };
}

async function scenarioApprovalGate() {
  const products = await prisma.product.findMany({
    where: { spuCode: { startsWith: 'LOAD-BASE-' } },
    select: { id: true },
    take: APPROVAL_COUNT,
    orderBy: { spuCode: 'asc' },
  });
  const listings = products.map((product) => ({
    orgId: 1n,
    platform: 'pdd',
    productId: product.id,
    status: 'draft',
    createdBy: operatorId,
  }));
  await prisma.listing.createMany({ data: listings });
  const listingRows = await prisma.listing.findMany({
    where: { productId: { in: products.map((product) => product.id) }, platform: 'pdd' },
    select: { id: true, productId: true },
    orderBy: { createdAt: 'asc' },
  });
  const listingByProduct = new Map(listingRows.map((row) => [row.productId, row.id]));
  const before = mem();
  const createSampler = new ConnectionSampler();
  createSampler.start();
  const createStarted = Date.now();
  const createLatencies = [];
  const createErrors = [];
  const approvals = await pMapConcurrent(
    products,
    10,
    async (product, index) => {
      const target = publishTargetPayload({ product_id: product.id, platform: 'pdd', sku_ids: [], media_plan: {} });
      try {
        const result = await api('POST', '/api/approvals', {
          role: 'operator',
          body: {
            subject_type: 'listing',
            subject_id: listingByProduct.get(product.id),
            action: 'publish',
            platform: 'pdd',
            target_payload: target,
            risk_meta: { impact_scope: { sku_ids: [] } },
            context: { listingStatus: 'draft', firstPublish: true, notOnline: true },
          },
        });
        createLatencies.push(result.elapsed);
        return { id: result.body.data.id, product_id: product.id, index };
      } catch (error) {
        createErrors.push(String(error));
        return null;
      }
    },
  );
  const createConnections = await createSampler.stop();
  const createDuration = Date.now() - createStarted;

  const validApprovals = approvals.filter(Boolean);
  const decideStarted = Date.now();
  const decideLatencies = [];
  const decideErrors = [];
  const decideSampler = new ConnectionSampler();
  decideSampler.start();
  await pMapConcurrent(validApprovals, 10, async (approval) => {
    try {
      const result = await api('POST', `/api/approvals/${approval.id}/decide`, {
        role: 'admin',
        body: { decision: 'approve' },
      });
      decideLatencies.push(result.elapsed);
    } catch (error) {
      decideErrors.push(String(error));
    }
  });
  const decideConnections = await decideSampler.stop();
  const decideDuration = Date.now() - decideStarted;

  const publishStarted = Date.now();
  const publishLatencies = [];
  const publishErrors = [];
  const publishSampler = new ConnectionSampler();
  publishSampler.start();
  await pMapConcurrent(validApprovals, PUBLISH_CONCURRENCY, async (approval) => {
    try {
      const result = await api('POST', '/api/listings/publish', {
        role: 'operator',
        body: {
          product_id: approval.product_id,
          platform: 'pdd',
          sku_ids: [],
          approval_id: approval.id,
          mode: 'dry_run',
        },
        timeoutMs: 30_000,
      });
      publishLatencies.push(result.elapsed);
    } catch (error) {
      publishErrors.push(String(error));
    }
  });
  const publishConnections = await publishSampler.stop();
  const publishDuration = Date.now() - publishStarted;
  const after = mem();
  report.scenarios.approval_gate = {
    name: '审批+写门：100 条审批 → 决策 → dry-run 发布（并发 5）',
    approvals_created: validApprovals.length,
    approval_create: {
      ...summarize(createLatencies, createErrors.length, createDuration),
      errors_sample: createErrors.slice(0, 5),
      db_connections: createConnections,
    },
    approval_decide: {
      ...summarize(decideLatencies, decideErrors.length, decideDuration),
      errors_sample: decideErrors.slice(0, 5),
      db_connections: decideConnections,
    },
    publish: {
      ...summarize(publishLatencies, publishErrors.length, publishDuration),
      errors_sample: publishErrors.slice(0, 5),
      db_connections: publishConnections,
    },
    memory: { before, after, rss_delta_mb: Number((after.rss_mb - before.rss_mb).toFixed(1)) },
  };
}

async function pMapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

async function scenarioMedia() {
  const before = mem();
  const jobs = [];
  for (let index = 0; index < MEDIA_JOBS; index += 1) {
    jobs.push({
      orgId: 1n,
      purpose: 'image',
      providerId,
      modelId,
      params: { kind: 'scene', source: 'ai_generated', prompt: `M9 压测图 ${index}`, count: 1 },
      status: 'queued',
      idempotencyKey: `m9-media-${randomUUID()}`,
      subjectType: 'other',
      createdBy: operatorId,
    });
  }
  await prisma.mediaJob.createMany({ data: jobs });
  const createdJobs = await prisma.mediaJob.findMany({
    where: { idempotencyKey: { startsWith: 'm9-media-' } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  const jobIds = createdJobs.map((job) => job.id);
  const storage = await FsStorage.create(MEDIA_ROOT);
  const repo = new PrismaMediaRepository(prisma);
  const provider = new MockMediaProvider({ pendingPolls: 0, costCents: 4 });
  const pipelines = [
    new MediaPipeline({ repo, storage, provider, random: () => 0.5 }),
    new MediaPipeline({ repo, storage, provider, random: () => 0.5 }),
  ];
  const sampler = new ConnectionSampler();
  sampler.start();
  const started = Date.now();
  const workerResults = await Promise.all(
    pipelines.map(async (pipeline, workerIndex) => {
      const end = Date.now() + 90_000;
      let processed = 0;
      while (Date.now() < end) {
        const results = await pipeline.runDue(10);
        processed += results.length;
        if (results.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
        const remaining = await prisma.mediaJob.count({
          where: { id: { in: jobIds }, status: { in: ['queued', 'submitted', 'polling', 'retrieved'] } },
        });
        if (remaining === 0) break;
      }
      return { worker: workerIndex + 1, processed };
    }),
  );
  const connections = await sampler.stop();
  const after = mem();
  const terminal = await prisma.mediaJob.findMany({
    where: { id: { in: jobIds } },
    select: { id: true, status: true, costCents: true },
  });
  const assets = await prisma.mediaAsset.findMany({ where: { mediaJobId: { in: jobIds } }, select: { mediaJobId: true } });
  const ledgers = await prisma.costLedger.findMany({
    where: { kind: 'media', refType: 'media_job', refId: { in: jobIds } },
    select: { refId: true, amountCents: true },
  });
  const assetCount = new Map();
  for (const asset of assets) assetCount.set(asset.mediaJobId, (assetCount.get(asset.mediaJobId) ?? 0) + 1);
  const ledgerCount = new Map();
  for (const ledger of ledgers) ledgerCount.set(ledger.refId, (ledgerCount.get(ledger.refId) ?? 0) + 1);
  report.scenarios.media = {
    name: '媒体：50 个任务、2 个 worker 并发消费',
    duration_ms: Date.now() - started,
    jobs: jobIds.length,
    terminal: {
      succeeded: terminal.filter((job) => job.status === 'succeeded').length,
      failed: terminal.filter((job) => job.status === 'failed').length,
      other: terminal.filter((job) => !['succeeded', 'failed'].includes(job.status)).length,
    },
    assets: {
      total: assets.length,
      jobs_with_exactly_one: [...assetCount.values()].filter((count) => count === 1).length,
      duplicate_jobs: [...assetCount.entries()].filter(([, count]) => count > 1).length,
    },
    ledgers: {
      total: ledgers.length,
      total_cents: ledgers.reduce((sum, ledger) => sum + ledger.amountCents, 0),
      jobs_with_exactly_one: [...ledgerCount.values()].filter((count) => count === 1).length,
      duplicate_jobs: [...ledgerCount.entries()].filter(([, count]) => count > 1).length,
    },
    workers: workerResults,
    db_connections: connections,
    memory: { before, after, rss_delta_mb: Number((after.rss_mb - before.rss_mb).toFixed(1)) },
  };
}

async function scenarioSse() {
  const before = mem();
  const sampler = new ConnectionSampler();
  sampler.start();
  const started = Date.now();
  let failures = 0;
  let heartbeats = 0;
  let snapshots = 0;
  const connectLatencies = [];
  const workers = Array.from({ length: SSE_CONNECTIONS }, async () => {
    const controller = new AbortController();
    const connectStarted = performance.now();
    try {
      const response = await fetch(`${apiBase}/api/events/stream`, {
        headers: { cookie: auth.admin.cookie, accept: 'text/event-stream' },
        signal: controller.signal,
      });
      connectLatencies.push(performance.now() - connectStarted);
      if (!response.ok || !response.body) {
        failures += 1;
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const deadline = Date.now() + SSE_DURATION_MS;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const result = await Promise.race([
          reader.read(),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), Math.min(remaining, 5_000))),
        ]);
        if (result.timeout) continue;
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        heartbeats += (buffer.match(/: hb /g) ?? []).length;
        snapshots += (buffer.match(/event: unread\.snapshot/g) ?? []).length;
        // 只统计新增片段，避免重复计数
        buffer = buffer.slice(-64);
      }
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    } catch (error) {
      if (Date.now() - connectStarted < SSE_DURATION_MS) failures += 1;
    }
  });
  await Promise.all(workers);
  const connections = await sampler.stop();
  const after = mem();
  report.scenarios.sse = {
    name: 'SSE：20 个并发连接，持续 120s，心跳/内存',
    connections: SSE_CONNECTIONS,
    failures,
    heartbeats,
    snapshots,
    connect_latency_ms: {
      p50: percentile([...connectLatencies].sort((a, b) => a - b), 50),
      p95: percentile([...connectLatencies].sort((a, b) => a - b), 95),
      max: connectLatencies.length ? Number(Math.max(...connectLatencies).toFixed(1)) : null,
    },
    duration_ms: Date.now() - started,
    db_connections: connections,
    memory: { before, after, rss_delta_mb: Number((after.rss_mb - before.rss_mb).toFixed(1)) },
  };
}

function chooseBottleneck() {
  const candidates = [];
  for (const [key, scenario] of Object.entries(report.scenarios)) {
    if (!scenario || typeof scenario !== 'object') continue;
    if (scenario.errors > 0) candidates.push({ key, reason: `errors=${scenario.errors}`, score: 1000 + scenario.errors });
    if (scenario.latency_ms?.p99 >= 1000) {
      candidates.push({ key, reason: `p99=${scenario.latency_ms.p99}ms`, score: scenario.latency_ms.p99 });
    }
    const maxConn = scenario.db_connections?.max ?? 0;
    if (maxConn >= 10) candidates.push({ key, reason: `db_connections.max=${maxConn}`, score: maxConn });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    COOKIE_SECURE: 'false',
    CSRF_REQUIRE_ORIGIN: 'false',
    AUTH_LOGIN_RATE_MAX: '1000',
    LOG_LEVEL: 'silent',
  });
  app = await buildApp(config, { prisma, disconnectOnClose: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apiBase = `http://127.0.0.1:${app.server.address().port}`;

  adminId = await ensureUser(ADMIN_EMAIL, ADMIN_PASSWORD, 'admin', 'M9 管理员');
  operatorId = await ensureUser(OPERATOR_EMAIL, OPERATOR_PASSWORD, 'operator', 'M9 运营');
  const suffix = randomUUID().slice(0, 8);
  const provider = await prisma.provider.create({
    data: {
      orgId: 1n,
      name: `m9_provider_${suffix}`,
      kind: 'image',
      credentialRef: 'm9_cred',
      status: 'active',
      extra: { mock: true },
    },
  });
  const model = await prisma.model.create({
    data: {
      orgId: 1n,
      providerId: provider.id,
      name: `m9.model.${suffix}`,
      externalModelId: 'm9-mock-image',
      displayName: 'M9 Mock 图片模型',
      capability: 'image',
      purposeSupport: ['image'],
      paramsSchema: { type: 'object', properties: {}, additionalProperties: true },
      price: { image: { per_image_cents: 4 } },
      status: 'published',
      publishedAt: new Date(),
    },
  });
  providerId = provider.id;
  modelId = model.id;

  auth.admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  auth.operator = await login(OPERATOR_EMAIL, OPERATOR_PASSWORD);

  // 预热（不纳入指标）
  for (let index = 0; index < 5; index += 1) await api('GET', '/api/products?limit=5', { role: 'operator' });

  await seedBaseProducts();
  await scenarioWrite();
  await scenarioRead();
  await scenarioApprovalGate();
  await scenarioMedia();
  await scenarioSse();

  report.finished_at = new Date().toISOString();
  report.bottleneck = chooseBottleneck();
  if (report.scenarios.read?.latency_ms?.p99 >= 1000) {
    report.notes.push(
      '读路径在 50 并发下 p99 超过 1s；listProducts 当前会一次性取回全部匹配商品，再做内存聚合，limit 不参与 DB 查询，建议作为首个优化点。',
    );
  }
  if ((report.scenarios.read?.db_connections?.max ?? 0) >= 10) {
    report.notes.push('读路径期间 pg_stat_activity 达到连接池上限（默认 10），后续请求只能在池内排队。');
  }
  report.notes.push('本机为单 Node 进程 + 本地/WSL Postgres；数量只代表本机配置，上生产必须按同规格重测。');
  await writeFile(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ status: 'done', report: path.relative(REPO_ROOT, OUT_FILE), bottleneck: report.bottleneck }, null, 2));
}

try {
  await main();
  process.exit(0);
} catch (error) {
  report.error = { message: error?.message ?? String(error), stack: error?.stack };
  report.finished_at = new Date().toISOString();
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(error);
  process.exit(1);
} finally {
  try {
    await app?.close();
  } catch {
    /* ignore */
  }
  try {
    await metricsPrisma.$disconnect();
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
}
