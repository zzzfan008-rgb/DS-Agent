/**
 * 事实组装与证据加载（docs/06 §6.5、docs/08 §6/§7）。
 *
 * - 事实只能来自主数据：价格/库存/成分/尺码/交期由 product/product_sku/
 *   fabric_composition/size_chart 组装；政策引用只接受 kb_document 的证据；
 * - facts_hash 由 core.computeFactsHash 统一计算，判断前先比对当前主数据；
 * - L2 证据只从 kb_chunk 有效切片加载，且按角色 ACL 过滤。
 */
import type { PrismaClient } from '@dssaas/db';
import {
  computeFactsHash,
  createFactEnvelope,
  fabricText,
  type FactEnvelope,
  type FactItem,
} from '@dssaas/core';
import type { EvidenceRef, JudgeFacts } from '@dssaas/judge-rules';

function item(
  key: string,
  value: string | number | boolean,
  unit: string,
  source: FactItem['source'],
  sourceTable: string,
  sourceId: string,
  sourceVersion: number,
): FactItem {
  return {
    key,
    value,
    unit,
    source,
    source_table: sourceTable,
    source_id: sourceId,
    source_version: sourceVersion,
  };
}

export async function buildProductFacts(
  prisma: PrismaClient,
  productId: string,
): Promise<FactEnvelope> {
  const product = await prisma.product.findFirst({
    where: { id: productId, archivedAt: null },
    select: { id: true, orgId: true },
  });
  if (!product) throw new Error('product not found');
  const skus = await prisma.productSku.findMany({
    where: { productId, archivedAt: null, status: 'active' },
    orderBy: { priceCents: 'asc' },
  });
  if (skus.length === 0) throw new Error('product has no active sku');

  const items: FactItem[] = [];
  const cheapest = skus[0]!;
  items.push(
    item('price', cheapest.priceCents, 'cent', 'import', 'product_sku', cheapest.id, cheapest.version),
  );
  if (cheapest.salePriceCents !== null) {
    items.push(
      item('promo_price', cheapest.salePriceCents, 'cent', 'import', 'product_sku', cheapest.id, cheapest.version),
    );
  }
  items.push(
    item(
      'stock',
      skus.reduce((sum, sku) => sum + sku.stockQty, 0),
      'piece',
      'import',
      'product_sku',
      cheapest.id,
      cheapest.version,
    ),
  );
  const leadTimes = skus
    .map((sku) => sku.leadTimeDays)
    .filter((value): value is number => typeof value === 'number');
  if (leadTimes.length > 0) {
    items.push(
      item('lead_time', Math.min(...leadTimes), 'day', 'import', 'product_sku', cheapest.id, cheapest.version),
    );
  }

  const fabric = await prisma.fabricComposition.findFirst({
    where: { productId, archivedAt: null, status: 'effective' },
    orderBy: { versionNo: 'desc' },
  });
  if (fabric) {
    const materials = fabric.materials as Array<{ material: string; percent: number; note?: string }>;
    items.push(
      item(
        'composition',
        fabricText(materials),
        'text',
        'import',
        'fabric_composition',
        fabric.id,
        fabric.versionNo,
      ),
    );
    items.push(
      item('care', '按洗护说明', 'text', 'manual', 'product', productId, 1),
    );
  }

  const latestVersion = await prisma.sizeChart.aggregate({
    where: { productId, archivedAt: null },
    _max: { versionNo: true },
  });
  const sizeRows = latestVersion._max.versionNo
    ? await prisma.sizeChart.findMany({
        where: { productId, archivedAt: null, versionNo: latestVersion._max.versionNo },
        orderBy: { sizeOrder: 'asc' },
      })
    : [];
  if (sizeRows.length > 0) {
    const first = sizeRows[0]!;
    items.push(
      item(
        'size',
        sizeRows.map((row) => row.skuSizeCode).join(','),
        'text',
        'import',
        'size_chart',
        first.id,
        first.versionNo,
      ),
    );
  }

  return createFactEnvelope(items);
}

export async function verifyFactsAgainstMaster(
  prisma: PrismaClient,
  productId: string,
  envelope: FactEnvelope,
): Promise<{ ok: boolean; expectedHash: string }> {
  const current = await buildProductFacts(prisma, productId);
  return { ok: current.facts_hash === envelope.facts_hash, expectedHash: current.facts_hash };
}

function parseComposition(value: string): Array<{ material: string; percent: number }> {
  const out: Array<{ material: string; percent: number }> = [];
  for (const token of value.split('、')) {
    const match = token.match(/^(.+?)(\d{1,3})%$/);
    if (match) out.push({ material: match[1]!, percent: Number(match[2]) });
  }
  return out;
}

export async function buildJudgeFacts(
  prisma: PrismaClient,
  productId: string | null,
  envelope: FactEnvelope,
): Promise<JudgeFacts> {
  const facts: JudgeFacts = {};
  for (const entry of envelope.items) {
    if (entry.key === 'price' && typeof entry.value === 'number') facts.price_cents = entry.value;
    if (entry.key === 'promo_price' && typeof entry.value === 'number') {
      facts.promo_price_cents = entry.value;
    }
    if (entry.key === 'stock' && typeof entry.value === 'number') facts.stock = entry.value;
    if (entry.key === 'composition' && typeof entry.value === 'string') {
      facts.composition = parseComposition(entry.value);
    }
    if (entry.key === 'lead_time' && typeof entry.value === 'number') {
      facts.lead_time_days = entry.value;
    }
    if (entry.source === 'kb' && entry.source_table === 'kb_document') {
      facts.policy_refs = [...(facts.policy_refs ?? []), entry.source_id];
    }
  }
  if (productId) {
    const latestVersion = await prisma.sizeChart.aggregate({
      where: { productId, archivedAt: null },
      _max: { versionNo: true },
    });
    const rows = latestVersion._max.versionNo
      ? await prisma.sizeChart.findMany({
          where: { productId, archivedAt: null, versionNo: latestVersion._max.versionNo },
          orderBy: { sizeOrder: 'asc' },
        })
      : [];
    if (rows.length > 0) {
      facts.size_codes = rows.map((row) => row.skuSizeCode);
      facts.size_ranges = rows.map((row) => ({
        size_code: row.skuSizeCode,
        ...(row.recommendHeightMin === null ? {} : { height_min: row.recommendHeightMin }),
        ...(row.recommendHeightMax === null ? {} : { height_max: row.recommendHeightMax }),
        ...(row.recommendWeightMin === null ? {} : { weight_min: row.recommendWeightMin }),
        ...(row.recommendWeightMax === null ? {} : { weight_max: row.recommendWeightMax }),
      }));
      facts.measurements = rows[0]!.measurements as Record<string, number>;
    }
    const skus = await prisma.productSku.findMany({
      where: { productId, archivedAt: null, status: 'active' },
      select: { sizeCode: true },
    });
    facts.sku_size_codes = skus.map((sku) => sku.sizeCode);
    const prices = skus.length
      ? await prisma.productSku.aggregate({
          where: { productId, archivedAt: null, status: 'active' },
          _min: { priceCents: true },
        })
      : null;
    if (prices?._min.priceCents) facts.min_price_cents = prices._min.priceCents;
  }
  return facts;
}

export async function loadEvidence(
  prisma: PrismaClient,
  envelope: FactEnvelope,
  roleCode: string,
  now: Date = new Date(),
): Promise<EvidenceRef[]> {
  const docIds = envelope.items
    .filter((entry) => entry.source === 'kb' && entry.source_table === 'kb_document')
    .map((entry) => entry.source_id);
  if (docIds.length === 0) return [];

  const documents = await prisma.kbDocument.findMany({
    where: {
      id: { in: docIds },
      orgId: 1n,
      status: 'active',
      archivedAt: null,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    select: { id: true, versionNo: true, effectiveFrom: true },
  });
  if (documents.length === 0) return [];
  const docMap = new Map(documents.map((doc) => [doc.id, doc]));

  const chunks = await prisma.kbChunk.findMany({
    where: {
      documentId: { in: [...docMap.keys()] },
      status: 'active',
      archivedAt: null,
      aclRoles: { has: roleCode },
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: [{ documentId: 'asc' }, { seq: 'asc' }],
    take: 8,
  });

  const evidence: EvidenceRef[] = [];
  for (const chunk of chunks) {
    const doc = docMap.get(chunk.documentId);
    if (!doc) continue;
    evidence.push({
      doc_id: doc.id,
      chunk_id: chunk.id,
      doc_version: doc.versionNo,
      quote: chunk.content.slice(0, 200),
      effective_from: doc.effectiveFrom.toISOString(),
    });
  }
  return evidence;
}

export function recomputeHash(envelope: FactEnvelope): string {
  return computeFactsHash({
    facts_version: envelope.facts_version,
    captured_at: envelope.captured_at,
    items: envelope.items,
  });
}
