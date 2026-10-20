#!/usr/bin/env node
/**
 * 黄金集样例生成器（一次性 bootstrap；后续由人工评审新增/替换）。
 *
 * 当前不是 docs/15 §7.1 的“真实 50 SKU”，而是 **10 条结构化样例**：
 *   - 覆盖 7 个品类（T 恤/衬衫/牛仔长裤/连衣裙/羽绒服/文胸/泳衣）；
 *   - 覆盖 2XS–4XL 中的常见码段与数字码；
 *   - 每 SKU 含价格（整数分）、库存、成分、尺码表、两平台差异（1688 起批/阶梯价）。
 *
 * 运行：node tests/golden/tools/generate-samples.mjs
 * 警告：会覆盖 tests/golden 下的样例文件并重写 golden.lock.json；变更需 PR 评审。
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { datasetHash } from '../lib/dataset-hash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GENERATED_AT = '2026-10-20T06:00:00.000Z';

function measurements(overrides) {
  return { ...overrides };
}

function size(sizeCode, sizeOrder, values, recommend = {}) {
  return {
    size_code: sizeCode,
    size_order: sizeOrder,
    measurements: measurements(values),
    ...recommend,
  };
}

const COMMON = {
  brand: '示例品牌',
  season: 'all',
  year: 2026,
  fit: 'regular',
  style_tags: ['基础款', '通勤'],
  origin_country: 'CN',
  care_instructions: { washing: '机洗30℃', bleaching: '不可漂白', ironing: '中温熨烫' },
  facts: { policy: '7天无理由退换', shipping: '48小时内发货' },
  price_source: 'import',
  stock_source: 'import',
};

const SKUS = [
  {
    sku_id: 'GOLDEN-001',
    spu_code: 'SPU-A0101-001',
    name: '男装纯棉圆领短袖T恤',
    category_code: 'A0101',
    season: 'summer',
    attributes: { 领型: '圆领', 袖型: '短袖', 版型: '常规', 厚度: '适中' },
    fabric: {
      fabric_code: 'FAB-COTTON-001',
      fabric_name: '精梳棉',
      role: 'main',
      materials: [{ material: '棉', percent: 100 }],
    },
    sizes: [
      size('M', 30, { 胸围: 104, 衣长: 68, 肩宽: 44, 袖长: 22 }, { recommend_height_min: 165, recommend_height_max: 175, recommend_weight_min: 55, recommend_weight_max: 65 }),
      size('L', 40, { 胸围: 108, 衣长: 70, 肩宽: 46, 袖长: 23 }, { recommend_height_min: 170, recommend_height_max: 180, recommend_weight_min: 60, recommend_weight_max: 72 }),
      size('XL', 50, { 胸围: 112, 衣长: 72, 肩宽: 48, 袖长: 24 }, { recommend_height_min: 175, recommend_height_max: 185, recommend_weight_min: 68, recommend_weight_max: 80 }),
    ],
    price_cents: 9900,
    list_price_cents: 12900,
    sale_price_cents: 8900,
    cost_cents: 4500,
    stock_qty: 120,
    min_order_qty: 1,
    weight_g: 260,
    platforms: {
      pdd: { sale_price_cents: 8900, stock_qty: 120 },
      '1688': { min_order_qty: 2, price_tiers: [{ min_qty: 2, price_cents: 8500 }, { min_qty: 50, price_cents: 7900 }] },
    },
  },
  {
    sku_id: 'GOLDEN-002',
    spu_code: 'SPU-A0202-001',
    name: '女装翻领长袖衬衫',
    category_code: 'A0202',
    season: 'spring',
    attributes: { 领型: '翻领', 袖型: '长袖', 版型: '修身', 厚度: '适中' },
    fabric: {
      fabric_code: 'FAB-COTTON-POLY-001',
      fabric_name: '棉涤混纺',
      role: 'main',
      materials: [{ material: '棉', percent: 60 }, { material: '聚酯纤维', percent: 40 }],
    },
    sizes: [
      size('S', 20, { 胸围: 92, 衣长: 62, 肩宽: 38, 袖长: 56, 领围: 36 }, { recommend_height_min: 155, recommend_height_max: 165, recommend_weight_min: 45, recommend_weight_max: 55 }),
      size('M', 30, { 胸围: 96, 衣长: 64, 肩宽: 40, 袖长: 57, 领围: 38 }, { recommend_height_min: 160, recommend_height_max: 170, recommend_weight_min: 50, recommend_weight_max: 62 }),
      size('L', 40, { 胸围: 100, 衣长: 66, 肩宽: 42, 袖长: 58, 领围: 40 }, { recommend_height_min: 165, recommend_height_max: 175, recommend_weight_min: 58, recommend_weight_max: 70 }),
    ],
    price_cents: 15900,
    list_price_cents: 19900,
    sale_price_cents: 14900,
    cost_cents: 7200,
    stock_qty: 80,
    min_order_qty: 1,
    weight_g: 220,
    platforms: {
      pdd: { sale_price_cents: 14900, stock_qty: 80 },
      '1688': { min_order_qty: 3, price_tiers: [{ min_qty: 3, price_cents: 13500 }, { min_qty: 30, price_cents: 12500 }] },
    },
  },
  {
    sku_id: 'GOLDEN-003',
    spu_code: 'SPU-B0211-001',
    name: '女装高腰直筒牛仔长裤',
    category_code: 'B0211',
    season: 'all',
    attributes: { 腰型: '高腰', 版型: '直筒', 弹力: '微弹', 洗水: '浅蓝' },
    fabric: {
      fabric_code: 'FAB-DENIM-001',
      fabric_name: '棉弹牛仔',
      role: 'main',
      materials: [{ material: '棉', percent: 98 }, { material: '氨纶', percent: 2 }],
    },
    sizes: [
      size('26', 10, { 腰围: 66, 裤长: 98, 臀围: 90, 大腿围: 52, 脚口: 32 }, { recommend_height_min: 155, recommend_height_max: 165, recommend_weight_min: 45, recommend_weight_max: 52 }),
      size('27', 20, { 腰围: 68, 裤长: 99, 臀围: 92, 大腿围: 53, 脚口: 33 }, { recommend_height_min: 158, recommend_height_max: 168, recommend_weight_min: 48, recommend_weight_max: 56 }),
      size('28', 30, { 腰围: 71, 裤长: 100, 臀围: 95, 大腿围: 55, 脚口: 34 }, { recommend_height_min: 160, recommend_height_max: 170, recommend_weight_min: 52, recommend_weight_max: 62 }),
    ],
    price_cents: 19900,
    list_price_cents: 25900,
    sale_price_cents: 18900,
    cost_cents: 8800,
    stock_qty: 150,
    min_order_qty: 1,
    weight_g: 520,
    platforms: {
      pdd: { sale_price_cents: 18900, stock_qty: 150 },
      '1688': { min_order_qty: 2, price_tiers: [{ min_qty: 2, price_cents: 16900 }, { min_qty: 40, price_cents: 15500 }] },
    },
  },
  {
    sku_id: 'GOLDEN-004',
    spu_code: 'SPU-C0221-001',
    name: '女装法式碎花连衣裙',
    category_code: 'C0221',
    season: 'summer',
    attributes: { 领型: '方领', 袖型: '短袖', 版型: '收腰', 厚度: '轻薄' },
    fabric: {
      fabric_code: 'FAB-VISCOSE-001',
      fabric_name: '粘纤印花布',
      role: 'main',
      materials: [{ material: '粘纤', percent: 100 }],
    },
    sizes: [
      size('S', 20, { 胸围: 88, 裙长: 108, 腰围: 70, 臀围: 94 }, { recommend_height_min: 155, recommend_height_max: 165, recommend_weight_min: 45, recommend_weight_max: 54 }),
      size('M', 30, { 胸围: 92, 裙长: 110, 腰围: 74, 臀围: 98 }, { recommend_height_min: 160, recommend_height_max: 170, recommend_weight_min: 50, recommend_weight_max: 60 }),
      size('L', 40, { 胸围: 96, 裙长: 112, 腰围: 78, 臀围: 102 }, { recommend_height_min: 165, recommend_height_max: 175, recommend_weight_min: 56, recommend_weight_max: 68 }),
    ],
    price_cents: 22900,
    list_price_cents: 29900,
    sale_price_cents: 21900,
    cost_cents: 10200,
    stock_qty: 60,
    min_order_qty: 1,
    weight_g: 320,
    platforms: {
      pdd: { sale_price_cents: 21900, stock_qty: 60 },
      '1688': { min_order_qty: 2, price_tiers: [{ min_qty: 2, price_cents: 19900 }, { min_qty: 20, price_cents: 18500 }] },
    },
  },
  {
    sku_id: 'GOLDEN-005',
    spu_code: 'SPU-D0232-001',
    name: '女装短款连帽羽绒服',
    category_code: 'D0232',
    season: 'winter',
    attributes: { 领型: '连帽', 袖型: '长袖', 版型: '宽松', 填充: '90%白鸭绒' },
    fabric: {
      fabric_code: 'FAB-NYLON-001',
      fabric_name: '锦纶防风面料',
      role: 'main',
      materials: [{ material: '锦纶', percent: 100 }],
    },
    sizes: [
      size('M', 30, { 胸围: 112, 衣长: 62, 肩宽: 42, 袖长: 60, 下摆: 108 }, { recommend_height_min: 160, recommend_height_max: 170, recommend_weight_min: 50, recommend_weight_max: 62 }),
      size('L', 40, { 胸围: 116, 衣长: 64, 肩宽: 44, 袖长: 61, 下摆: 112 }, { recommend_height_min: 165, recommend_height_max: 175, recommend_weight_min: 56, recommend_weight_max: 70 }),
      size('XL', 50, { 胸围: 120, 衣长: 66, 肩宽: 46, 袖长: 62, 下摆: 116 }, { recommend_height_min: 170, recommend_height_max: 180, recommend_weight_min: 64, recommend_weight_max: 80 }),
    ],
    price_cents: 49900,
    list_price_cents: 65900,
    sale_price_cents: 46900,
    cost_cents: 23800,
    stock_qty: 45,
    min_order_qty: 1,
    weight_g: 980,
    platforms: {
      pdd: { sale_price_cents: 46900, stock_qty: 45 },
      '1688': { min_order_qty: 2, price_tiers: [{ min_qty: 2, price_cents: 43900 }, { min_qty: 20, price_cents: 40900 }] },
    },
  },
  {
    sku_id: 'GOLDEN-006',
    spu_code: 'SPU-E0201-001',
    name: '女装无钢圈薄款文胸',
    category_code: 'E0201',
    season: 'all',
    attributes: { 杯型: '3/4杯', 钢圈: '无钢圈', 版型: '背心式', 厚度: '薄款' },
    fabric: {
      fabric_code: 'FAB-NYLON-SPANDEX-001',
      fabric_name: '锦纶氨纶网布',
      role: 'main',
      materials: [{ material: '锦纶', percent: 78 }, { material: '氨纶', percent: 22 }],
    },
    sizes: [
      size('75B', 10, { 胸围: 88 }, { recommend_height_min: 155, recommend_height_max: 165, recommend_weight_min: 45, recommend_weight_max: 55 }),
      size('80B', 20, { 胸围: 92 }, { recommend_height_min: 158, recommend_height_max: 168, recommend_weight_min: 50, recommend_weight_max: 60 }),
      size('85B', 30, { 胸围: 96 }, { recommend_height_min: 160, recommend_height_max: 172, recommend_weight_min: 55, recommend_weight_max: 68 }),
    ],
    price_cents: 6900,
    list_price_cents: 9900,
    sale_price_cents: 5900,
    cost_cents: 2800,
    stock_qty: 200,
    min_order_qty: 1,
    weight_g: 90,
    platforms: {
      pdd: { sale_price_cents: 5900, stock_qty: 200 },
      '1688': { min_order_qty: 5, price_tiers: [{ min_qty: 5, price_cents: 5200 }, { min_qty: 100, price_cents: 4600 }] },
    },
  },
  {
    sku_id: 'GOLDEN-007',
    spu_code: 'SPU-G0201-001',
    name: '女装连体竞技泳衣',
    category_code: 'G0201',
    season: 'summer',
    attributes: { 领型: '圆领', 袖型: '无袖', 版型: '紧身', 用途: '训练' },
    fabric: {
      fabric_code: 'FAB-POLY-SPANDEX-001',
      fabric_name: '聚酯纤维氨纶',
      role: 'main',
      materials: [{ material: '聚酯纤维', percent: 82 }, { material: '氨纶', percent: 18 }],
    },
    sizes: [
      size('S', 20, { 胸围: 84, 衣长: 66, 腰围: 66, 臀围: 88 }, { recommend_height_min: 155, recommend_height_max: 165, recommend_weight_min: 45, recommend_weight_max: 54 }),
      size('M', 30, { 胸围: 88, 衣长: 68, 腰围: 70, 臀围: 92 }, { recommend_height_min: 160, recommend_height_max: 170, recommend_weight_min: 50, recommend_weight_max: 60 }),
      size('L', 40, { 胸围: 92, 衣长: 70, 腰围: 74, 臀围: 96 }, { recommend_height_min: 165, recommend_height_max: 175, recommend_weight_min: 56, recommend_weight_max: 68 }),
    ],
    price_cents: 25900,
    list_price_cents: 32900,
    sale_price_cents: 23900,
    cost_cents: 11200,
    stock_qty: 70,
    min_order_qty: 1,
    weight_g: 180,
    platforms: {
      pdd: { sale_price_cents: 23900, stock_qty: 70 },
      '1688': { min_order_qty: 2, price_tiers: [{ min_qty: 2, price_cents: 21900 }, { min_qty: 30, price_cents: 19900 }] },
    },
  },
  {
    sku_id: 'GOLDEN-008',
    spu_code: 'SPU-A0101-002',
    name: '男装重磅纯棉T恤（大码）',
    category_code: 'A0101',
    season: 'summer',
    attributes: { 领型: '圆领', 袖型: '短袖', 版型: '宽松', 克重: '260g' },
    fabric: {
      fabric_code: 'FAB-COTTON-SPANDEX-001',
      fabric_name: '棉氨纶',
      role: 'main',
      materials: [{ material: '棉', percent: 95 }, { material: '氨纶', percent: 5 }],
    },
    sizes: [
      size('2XL', 60, { 胸围: 120, 衣长: 76, 肩宽: 52, 袖长: 25 }, { recommend_height_min: 175, recommend_height_max: 185, recommend_weight_min: 78, recommend_weight_max: 92 }),
      size('3XL', 70, { 胸围: 126, 衣长: 78, 肩宽: 55, 袖长: 26 }, { recommend_height_min: 178, recommend_height_max: 190, recommend_weight_min: 88, recommend_weight_max: 105 }),
      size('4XL', 80, { 胸围: 132, 衣长: 80, 肩宽: 58, 袖长: 27 }, { recommend_height_min: 180, recommend_height_max: 195, recommend_weight_min: 100, recommend_weight_max: 120 }),
    ],
    price_cents: 11900,
    list_price_cents: 14900,
    sale_price_cents: 10900,
    cost_cents: 5200,
    stock_qty: 90,
    min_order_qty: 1,
    weight_g: 300,
    platforms: {
      pdd: { sale_price_cents: 10900, stock_qty: 90 },
      '1688': { min_order_qty: 3, price_tiers: [{ min_qty: 3, price_cents: 9900 }, { min_qty: 60, price_cents: 9200 }] },
    },
  },
  {
    sku_id: 'GOLDEN-009',
    spu_code: 'SPU-A0202-002',
    name: '女装缎面翻领衬衫（小码）',
    category_code: 'A0202',
    season: 'spring',
    attributes: { 领型: '翻领', 袖型: '长袖', 版型: '宽松', 面料: '缎面' },
    fabric: {
      fabric_code: 'FAB-SATIN-001',
      fabric_name: '聚酯纤维缎面',
      role: 'main',
      materials: [{ material: '聚酯纤维', percent: 100 }],
    },
    sizes: [
      size('XS', 10, { 胸围: 84, 衣长: 58, 肩宽: 36, 袖长: 54, 领围: 34 }, { recommend_height_min: 150, recommend_height_max: 160, recommend_weight_min: 40, recommend_weight_max: 48 }),
      size('S', 20, { 胸围: 88, 衣长: 60, 肩宽: 38, 袖长: 55, 领围: 36 }, { recommend_height_min: 155, recommend_height_max: 165, recommend_weight_min: 44, recommend_weight_max: 54 }),
    ],
    price_cents: 13900,
    list_price_cents: 17900,
    sale_price_cents: 12900,
    cost_cents: 6200,
    stock_qty: 55,
    min_order_qty: 1,
    weight_g: 200,
    platforms: {
      pdd: { sale_price_cents: 12900, stock_qty: 55 },
      '1688': { min_order_qty: 3, price_tiers: [{ min_qty: 3, price_cents: 11500 }, { min_qty: 30, price_cents: 10500 }] },
    },
  },
  {
    sku_id: 'GOLDEN-010',
    spu_code: 'SPU-B0211-002',
    name: '女装九分微喇牛仔裤',
    category_code: 'B0211',
    season: 'all',
    attributes: { 腰型: '中腰', 版型: '微喇', 弹力: '无弹', 洗水: '深蓝' },
    fabric: {
      fabric_code: 'FAB-DENIM-002',
      fabric_name: '全棉牛仔',
      role: 'main',
      materials: [{ material: '棉', percent: 100 }],
    },
    sizes: [
      size('29', 40, { 腰围: 74, 裤长: 96, 臀围: 98, 大腿围: 56, 脚口: 36 }, { recommend_height_min: 162, recommend_height_max: 172, recommend_weight_min: 55, recommend_weight_max: 65 }),
      size('30', 50, { 腰围: 77, 裤长: 97, 臀围: 101, 大腿围: 58, 脚口: 37 }, { recommend_height_min: 165, recommend_height_max: 175, recommend_weight_min: 60, recommend_weight_max: 72 }),
    ],
    price_cents: 21900,
    list_price_cents: 27900,
    sale_price_cents: 19900,
    cost_cents: 9600,
    stock_qty: 110,
    min_order_qty: 1,
    weight_g: 540,
    platforms: {
      pdd: { sale_price_cents: 19900, stock_qty: 110 },
      '1688': { min_order_qty: 2, price_tiers: [{ min_qty: 2, price_cents: 17900 }, { min_qty: 40, price_cents: 16500 }] },
    },
  },
];

function buildSku(def) {
  return {
    sku_id: def.sku_id,
    spu_code: def.spu_code,
    name: def.name,
    brand: COMMON.brand,
    category_code: def.category_code,
    season: def.season ?? COMMON.season,
    year: COMMON.year,
    fit: COMMON.fit,
    style_tags: COMMON.style_tags,
    attributes: def.attributes,
    fabric: def.fabric,
    origin_country: COMMON.origin_country,
    care_instructions: COMMON.care_instructions,
    sizes: def.sizes,
    price_cents: def.price_cents,
    list_price_cents: def.list_price_cents,
    sale_price_cents: def.sale_price_cents,
    cost_cents: def.cost_cents,
    stock_qty: def.stock_qty,
    min_order_qty: def.min_order_qty,
    weight_g: def.weight_g,
    price_source: COMMON.price_source,
    stock_source: COMMON.stock_source,
    facts: COMMON.facts,
    platforms: def.platforms,
  };
}

function compositionText(materials) {
  return materials.map((item) => `${item.material}${item.percent}%`).join('+');
}

function buildCopyExpected(sku, platform) {
  const platformData = sku.platforms[platform];
  const priceCents =
    platform === 'pdd'
      ? platformData.sale_price_cents ?? sku.sale_price_cents ?? sku.price_cents
      : platformData.price_tiers?.[0]?.price_cents ?? sku.price_cents;
  return {
    sku_id: sku.sku_id,
    platform,
    content_type: 'title',
    title: `${sku.name} ${sku.brand}`,
    selling_points: [
      `${compositionText(sku.fabric.materials)}`,
      `尺码 ${sku.sizes.map((item) => item.size_code).join('/')}`,
      sku.facts.shipping,
    ],
    facts: {
      price_cents: priceCents,
      stock_qty: platform === 'pdd' ? platformData.stock_qty : sku.stock_qty,
      composition_text: compositionText(sku.fabric.materials),
      size_codes: sku.sizes.map((item) => item.size_code),
      category_code: sku.category_code,
    },
    forbidden_words: [],
  };
}

function buildSizeExpected(sku, platform) {
  return {
    sku_id: sku.sku_id,
    platform,
    version_no: 1,
    unit: 'cm',
    rows: sku.sizes.map((item) => ({
      size_code: item.size_code,
      size_order: item.size_order,
      measurements: item.measurements,
      ...(item.recommend_height_min !== undefined
        ? {
            recommend_height_min: item.recommend_height_min,
            recommend_height_max: item.recommend_height_max,
            recommend_weight_min: item.recommend_weight_min,
            recommend_weight_max: item.recommend_weight_max,
          }
        : {}),
    })),
  };
}

function buildQuoteExpected(sku) {
  const data = sku.platforms['1688'];
  return {
    sku_id: sku.sku_id,
    platform: '1688',
    content_type: 'quote',
    min_order_qty: data.min_order_qty,
    price_tiers: data.price_tiers,
    stock_qty: sku.stock_qty,
  };
}

function buildNegatives(skusBySkuId) {
  const base = skusBySkuId['GOLDEN-001'];
  const compositionBad = structuredClone(base);
  compositionBad.fabric.materials = [{ material: '棉', percent: 99 }];

  const sizeMissing = structuredClone(skusBySkuId['GOLDEN-002']);
  delete sizeMissing.sizes[1].measurements['胸围'];

  const priceZero = structuredClone(skusBySkuId['GOLDEN-003']);
  priceZero.price_cents = 0;

  return [
    {
      id: 'NEG-001',
      rule: 'composition_sum',
      expected_code: 'invalid_fact',
      expected_failure: '成分合计必须为 100%',
      base_sku: base.sku_id,
      sku: compositionBad,
    },
    {
      id: 'NEG-002',
      rule: 'required_measurement',
      expected_code: 'invalid_fact',
      expected_failure: 'A0202 缺少必测部位：胸围',
      base_sku: sizeMissing.sku_id,
      sku: sizeMissing,
    },
    {
      id: 'NEG-003',
      rule: 'price_positive',
      expected_code: 'invalid_fact',
      expected_failure: '价格必须大于 0（整数分）',
      base_sku: priceZero.sku_id,
      sku: priceZero,
    },
    {
      id: 'NEG-004',
      rule: 'forbidden_claim',
      expected_code: 'platform_reject',
      expected_failure: '文案含平台禁止的绝对化用语',
      base_sku: base.sku_id,
      copy: {
        sku_id: base.sku_id,
        platform: 'pdd',
        content_type: 'title',
        title: '全网最低价 纯棉T恤',
        selling_points: ['第一品质', '绝对划算'],
        forbidden_words: ['全网最低', '第一', '绝对'],
      },
    },
  ];
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  for (const dir of ['skus', 'expected', 'negative']) {
    await rm(path.join(ROOT, dir), { recursive: true, force: true });
  }

  const skus = SKUS.map(buildSku);
  const byId = Object.fromEntries(skus.map((sku) => [sku.sku_id, sku]));

  for (const sku of skus) {
    await writeJson(path.join(ROOT, 'skus', `${sku.sku_id}.json`), sku);
    for (const platform of ['pdd', '1688']) {
      await writeJson(path.join(ROOT, 'expected', platform, sku.sku_id, 'copy.json'), buildCopyExpected(sku, platform));
      await writeJson(path.join(ROOT, 'expected', platform, sku.sku_id, 'size.json'), buildSizeExpected(sku, platform));
    }
    await writeJson(path.join(ROOT, 'expected', '1688', sku.sku_id, 'quote.json'), buildQuoteExpected(sku));
  }

  const negatives = buildNegatives(byId);
  for (const negative of negatives) {
    await writeJson(path.join(ROOT, 'negative', `${negative.id}.json`), negative);
  }

  const hash = await datasetHash(ROOT);
  const lock = {
    dataset_version: 'golden-v1-sample',
    dataset_sha256: hash,
    count_skus: skus.length,
    count_series: skus.length * 2,
    count_negative: negatives.length,
    rule_version: 'judge-rules@2026-10-20',
    prompt_version: 'copy-v1',
    model_route_snapshot: { purpose: 'copy', layers: 'L1+L2', model: 'mock' },
    generated_at: GENERATED_AT,
    note: '10 条结构化样例（非真实 50 SKU）；M8 起替换为真实脱敏数据。变更需 PR + 业务评审（docs/15 §7.3）。',
  };
  await writeJson(path.join(ROOT, 'golden.lock.json'), lock);

  console.log(`[golden] 已生成 ${skus.length} 个 SKU、${skus.length * 2} 组平台预期、${negatives.length} 条负例`);
  console.log(`[golden] dataset_sha256=${hash}`);
}

main().catch((error) => {
  console.error(`[golden] 生成失败：${error.stack ?? error.message}`);
  process.exit(1);
});
