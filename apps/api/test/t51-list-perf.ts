/**
 * t51 F1 修复验证 —— 手工基准脚本（CI 不跑，不匹配 `*.test.ts`）。
 *
 * 目的：在同一口径下对比 t51 前后 `listProducts()` 的 p95（1,000 / 10,000 两档），
 * 证明"分页下推"确实把线性增长削平。
 *
 * 运行：
 *   DATABASE_URL=... npx tsx test/t51-list-perf.ts
 *
 * **防腐提示**：改动 `src/services/products.ts` 的 `listProducts` / `aggregateProductRows`
 * 后必须手动重跑本脚本，否则文档里的 p95 会变成过时数字。
 */
import { PrismaClient } from '@dssaas/db';
import { listProducts } from '../src/services/products.js';

const PREFIX = 'T51PERF';
const RUNS = 30;

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index]!.toFixed(1));
}

async function seed(prisma: PrismaClient, target: number): Promise<number> {
  const existing = await prisma.product.count({ where: { spuCode: { startsWith: PREFIX } } });
  if (existing >= target) return existing;
  const data = Array.from({ length: target - existing }, (_, index) => ({
    orgId: 1n,
    spuCode: `${PREFIX}-${String(existing + index).padStart(6, '0')}`,
    name: `perf ${existing + index}`,
    categoryCode: 'A0101',
  }));
  for (let offset = 0; offset < data.length; offset += 1000) {
    await prisma.product.createMany({ data: data.slice(offset, offset + 1000) });
  }
  return prisma.product.count({ where: { spuCode: { startsWith: PREFIX } } });
}

async function measure(prisma: PrismaClient, label: string, missingFields: boolean): Promise<void> {
  const deps = { prisma, audit: { record: async () => undefined } as never };
  // 预热（排除首查询的 prepared statement 开销）
  for (let i = 0; i < 3; i += 1) {
    await listProducts(deps, { limit: 20, q: PREFIX, ...(missingFields ? { missing_fields: true } : {}) });
  }
  const latencies: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const started = performance.now();
    await listProducts(deps, { limit: 20, q: PREFIX, ...(missingFields ? { missing_fields: true } : {}) });
    latencies.push(performance.now() - started);
  }
  console.log(
    `${label.padEnd(34)} p50=${percentile(latencies, 50)}ms  p95=${percentile(latencies, 95)}ms  ` +
      `max=${percentile(latencies, 100)}ms  (n=${RUNS})`,
  );
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const total = await prisma.product.count({ where: { orgId: 1n, archivedAt: null } });
    console.log(`[t51] 起点：org 全表 ${total} 条商品`);

    const rows1k = await seed(prisma, 1000);
    console.log(`\n--- 1,000 条（实际 ${rows1k}） ---`);
    await measure(prisma, 'missing_fields=true（列表筛选）', true);
    await measure(prisma, 'missing_fields=false（默认列表）', false);

    const rows10k = await seed(prisma, 10000);
    console.log(`\n--- 10,000 条（实际 ${rows10k}） ---`);
    await measure(prisma, 'missing_fields=true（列表筛选）', true);
    await measure(prisma, 'missing_fields=false（默认列表）', false);

    console.log('\n[t51] 清理基准数据…');
    await prisma.product.deleteMany({ where: { spuCode: { startsWith: PREFIX } } });
    console.log('[t51] done');
  } finally {
    await prisma.$disconnect();
  }
}

void main();
