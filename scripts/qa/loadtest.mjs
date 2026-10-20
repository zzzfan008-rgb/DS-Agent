/**
 * M9 压测：读路径与写路径的并发基线。
 *
 * 目的不是刷吞吐数字，而是**找到第一个瓶颈**并留下证据。
 * 用法：
 *   DATABASE_URL=... TEST_DATABASE_URL=... node scripts/qa/loadtest.mjs
 */
import { buildApp } from '../../apps/api/src/app.ts';
import { loadConfig } from '../../apps/api/src/config.ts';

const DURATION_MS = Number(process.env.LOAD_DURATION_MS ?? 20000);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50);

function pct(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(name, latencies, errors, startedAt) {
  const elapsed = Date.now() - startedAt;
  const ok = latencies.length;
  const total = ok + errors;
  return {
    name,
    duration_ms: elapsed,
    total,
    ok,
    errors,
    error_rate: total === 0 ? 0 : Number((errors / total).toFixed(4)),
    throughput_rps: Number((total / (elapsed / 1000)).toFixed(2)),
    p50_ms: pct(latencies, 50),
    p95_ms: pct(latencies, 95),
    p99_ms: pct(latencies, 99),
    max_ms: latencies.length ? Math.max(...latencies) : 0,
  };
}

async function runPool(workers, durationMs) {
  const latencies = [];
  const errors = [];
  const deadline = Date.now() + durationMs;

  async function loop() {
    while (Date.now() < deadline) {
      const t0 = performance.now();
      try {
        const res = await workers();
        if (res.statusCode >= 500) errors.push(res.statusCode);
        else latencies.push(Math.round(performance.now() - t0));
      } catch (err) {
        errors.push(err?.code ?? 'exception');
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, loop));
  return { latencies, errors };
}

const app = await buildApp(loadConfig());
await app.ready();

// 预热：避免首个请求的模块/连接初始化污染 P99
await app.inject({ method: 'GET', url: '/api/health' });

const results = [];

// 1) 健康检查（基线：确认框架本身不慢）
{
  const startedAt = Date.now();
  const { latencies, errors } = await runPool(
    () => app.inject({ method: 'GET', url: '/api/health' }),
    Math.min(DURATION_MS, 5000),
  );
  results.push(summarize('GET /api/health', latencies, errors.length, startedAt));
}

// 2) 未认证读（鉴权路径开销）
{
  const startedAt = Date.now();
  const { latencies, errors } = await runPool(
    () => app.inject({ method: 'GET', url: '/api/products' }),
    Math.min(DURATION_MS, 8000),
  );
  results.push(summarize('GET /api/products (401)', latencies, errors.length, startedAt));
}

// 3) 指标端点
{
  const startedAt = Date.now();
  const { latencies, errors } = await runPool(
    () => app.inject({ method: 'GET', url: '/api/metrics' }),
    Math.min(DURATION_MS, 5000),
  );
  results.push(summarize('GET /api/metrics', latencies, errors.length, startedAt));
}

// 4) 连接池压力：并发打 health 直到连接耗尽（若配置上限低会先出现 5xx/超时）
{
  const startedAt = Date.now();
  const { latencies, errors } = await runPool(
    () => app.inject({ method: 'GET', url: '/api/health' }),
    DURATION_MS,
  );
  results.push(summarize(`GET /api/health (${DURATION_MS}ms 持续)`, latencies, errors.length, startedAt));
}

const mem = process.memoryUsage();
const report = {
  generated_at: new Date().toISOString(),
  concurrency: CONCURRENCY,
  node: process.version,
  platform: process.platform,
  rss_mb: Math.round(mem.rss / 1024 / 1024),
  heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
  results,
};

console.log(JSON.stringify(report, null, 2));
await app.close();
