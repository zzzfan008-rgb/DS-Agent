#!/usr/bin/env node
/**
 * 黄金集校验（docs/15 §7）。
 *
 * 校验内容：
 *   1) 数据集版本锁：golden.lock.json 的 dataset_sha256 与文件集合一致；
 *   2) SKU 输入硬规则：整数分、成分合计 100、尺码必测部位、推荐区间成对且递增；
 *   3) 平台预期硬事实：价格/库存/成分/尺码/1688 阶梯价与 SKU 输入逐字一致；
 *   4) 负例：expected_code 在 docs/12 §4 词表内，且变异确实违反对应规则。
 *
 * 用法：node scripts/qa/golden-check.mjs [--json] [--report <path>]
 * 退出码：0 通过；1 校验失败；2 运行错误。
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { datasetHash } from '../../tests/golden/lib/dataset-hash.mjs';
import { loadDocErrorCodes } from '../../tests/contract/lib/doc-codes.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/golden');
let ROOT = DEFAULT_ROOT;
const REQUIRED_MEASUREMENTS = {
  A0101: ['胸围', '衣长'],
  A0202: ['胸围', '衣长'],
  B0211: ['腰围', '裤长'],
  C0221: ['胸围', '裙长'],
  D0232: ['胸围', '衣长'],
  E0201: ['胸围'],
  G0201: ['胸围', '衣长'],
};

const errors = [];
const missing = (file, field) => errors.push(`${file}: 缺少 ${field}`);

function isInt(value) {
  return Number.isInteger(value);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    errors.push(`${path.relative(ROOT, file)}: JSON 解析失败（${error.message}）`);
    return null;
  }
}

async function listFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(abs)));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(abs);
  }
  return files.sort();
}

function compositionText(materials = []) {
  return materials.map((item) => `${item.material}${item.percent}%`).join('+');
}

function pddPrice(sku) {
  return sku.platforms?.pdd?.sale_price_cents ?? sku.sale_price_cents ?? sku.price_cents;
}

function platform1688Price(sku) {
  return sku.platforms?.['1688']?.price_tiers?.[0]?.price_cents ?? sku.price_cents;
}

function validateSkuStructure(file, sku) {
  const rel = path.relative(ROOT, file);
  for (const field of ['sku_id', 'spu_code', 'name', 'category_code', 'fabric', 'sizes', 'platforms']) {
    if (sku[field] === undefined) missing(rel, field);
  }
  if (!REQUIRED_MEASUREMENTS[sku.category_code]) {
    errors.push(`${rel}: category_code ${sku.category_code} 不在 docs/19 §3.2 样例类目内`);
  }
  if (!isInt(sku.price_cents) || sku.price_cents <= 0) errors.push(`${rel}: price_cents 必须是正整数分`);
  if (sku.list_price_cents !== undefined && (!isInt(sku.list_price_cents) || sku.list_price_cents < sku.price_cents)) {
    errors.push(`${rel}: list_price_cents 必须是整数分且不小于 price_cents`);
  }
  if (sku.sale_price_cents !== undefined && (!isInt(sku.sale_price_cents) || sku.sale_price_cents > sku.price_cents)) {
    errors.push(`${rel}: sale_price_cents 必须是整数分且不大于 price_cents`);
  }
  if (!isInt(sku.stock_qty) || sku.stock_qty < 0) errors.push(`${rel}: stock_qty 必须是非负整数`);
  if (!Array.isArray(sku.sizes) || sku.sizes.length < 2) errors.push(`${rel}: sizes 至少 2 行`);
  if (!Array.isArray(sku.fabric?.materials) || sku.fabric.materials.length === 0) {
    errors.push(`${rel}: fabric.materials 不能为空`);
  } else {
    const sum = sku.fabric.materials.reduce((total, item) => total + item.percent, 0);
    if (sum !== 100) errors.push(`${rel}: 成分合计 ${sum}% ≠ 100%`);
  }

  let previousOrder = -Infinity;
  for (const size of sku.sizes ?? []) {
    if (!size.size_code) missing(rel, 'size_code');
    if (!isInt(size.size_order)) errors.push(`${rel}: size ${size.size_code} 的 size_order 必须是整数`);
    if (size.size_order <= previousOrder) errors.push(`${rel}: size_order 必须严格递增（${size.size_code}）`);
    previousOrder = size.size_order;
    for (const key of REQUIRED_MEASUREMENTS[sku.category_code] ?? []) {
      if (size.measurements?.[key] === undefined) errors.push(`${rel}: ${size.size_code} 缺少必测部位 ${key}`);
    }
    const ranges = [
      size.recommend_height_min,
      size.recommend_height_max,
      size.recommend_weight_min,
      size.recommend_weight_max,
    ];
    if (ranges.some((value) => value !== undefined)) {
      if (ranges.some((value) => value === undefined)) errors.push(`${rel}: ${size.size_code} 推荐区间必须成对出现`);
      else if (size.recommend_height_min >= size.recommend_height_max) {
        errors.push(`${rel}: ${size.size_code} 身高区间 min < max 不成立`);
      } else if (size.recommend_weight_min >= size.recommend_weight_max) {
        errors.push(`${rel}: ${size.size_code} 体重区间 min < max 不成立`);
      }
    }
  }

  const pdd = sku.platforms?.pdd;
  if (!pdd) errors.push(`${rel}: 缺少 platforms.pdd`);
  else if (!isInt(pdd.sale_price_cents) || pdd.sale_price_cents <= 0) errors.push(`${rel}: pdd 价格必须是正整数分`);
  const ali = sku.platforms?.['1688'];
  if (!ali) errors.push(`${rel}: 缺少 platforms.1688`);
  else {
    if (!isInt(ali.min_order_qty) || ali.min_order_qty < 1) errors.push(`${rel}: 1688 起批量必须是正整数`);
    if (!Array.isArray(ali.price_tiers) || ali.price_tiers.length === 0) errors.push(`${rel}: 1688 缺少阶梯价`);
    else {
      let lastMin = 0;
      for (const tier of ali.price_tiers) {
        if (!isInt(tier.min_qty) || tier.min_qty <= lastMin) errors.push(`${rel}: 1688 阶梯价 min_qty 必须递增`);
        if (!isInt(tier.price_cents) || tier.price_cents <= 0) errors.push(`${rel}: 1688 阶梯价必须是正整数分`);
        lastMin = tier.min_qty;
      }
    }
  }
}

async function validateExpected(sku) {
  const dirs = ['pdd', '1688'];
  for (const platform of dirs) {
    const copyFile = path.join(ROOT, 'expected', platform, sku.sku_id, 'copy.json');
    const copy = await readJson(copyFile);
    if (!copy) continue;
    const rel = path.relative(ROOT, copyFile);
    if (copy.sku_id !== sku.sku_id) errors.push(`${rel}: sku_id 不一致`);
    const expectedPrice = platform === 'pdd' ? pddPrice(sku) : platform1688Price(sku);
    const expectedStock = platform === 'pdd' ? sku.platforms.pdd.stock_qty : sku.stock_qty;
    const expectedFacts = {
      price_cents: expectedPrice,
      stock_qty: expectedStock,
      composition_text: compositionText(sku.fabric.materials),
      size_codes: sku.sizes.map((item) => item.size_code),
      category_code: sku.category_code,
    };
    for (const [key, value] of Object.entries(expectedFacts)) {
      const actual = copy.facts?.[key];
      if (JSON.stringify(actual) !== JSON.stringify(value)) {
        errors.push(`${rel}: facts.${key} 与主数据不一致（expected=${JSON.stringify(value)} actual=${JSON.stringify(actual)}）`);
      }
    }

    const sizeFile = path.join(ROOT, 'expected', platform, sku.sku_id, 'size.json');
    const sizeExpected = await readJson(sizeFile);
    if (!sizeExpected) continue;
    const sizeRel = path.relative(ROOT, sizeFile);
    const expectedRows = sku.sizes.map((item) => ({
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
    }));
    if (JSON.stringify(sizeExpected.rows) !== JSON.stringify(expectedRows)) {
      errors.push(`${sizeRel}: 尺码行与主数据不一致（图文同版本要求）`);
    }
  }

  const quoteFile = path.join(ROOT, 'expected', '1688', sku.sku_id, 'quote.json');
  const quote = await readJson(quoteFile);
  if (quote) {
    const rel = path.relative(ROOT, quoteFile);
    if (quote.min_order_qty !== sku.platforms['1688'].min_order_qty) errors.push(`${rel}: 起批量不一致`);
    if (JSON.stringify(quote.price_tiers) !== JSON.stringify(sku.platforms['1688'].price_tiers)) {
      errors.push(`${rel}: 1688 阶梯价不一致`);
    }
    if (quote.stock_qty !== sku.stock_qty) errors.push(`${rel}: 库存不一致`);
  }
}

async function validateNegative(negative, docCodes) {
  const rel = `negative/${negative.id}`;
  if (!docCodes.has(negative.expected_code)) {
    errors.push(`${rel}: expected_code ${negative.expected_code} 不在 docs/12 §4`);
  }
  const sku = negative.sku;
  switch (negative.rule) {
    case 'composition_sum': {
      const sum = sku.fabric.materials.reduce((total, item) => total + item.percent, 0);
      if (sum === 100) errors.push(`${rel}: 负例成分合计不应为 100`);
      break;
    }
    case 'required_measurement': {
      const required = REQUIRED_MEASUREMENTS[sku.category_code] ?? [];
      const violated = sku.sizes.some((size) => required.some((key) => size.measurements?.[key] === undefined));
      if (!violated) errors.push(`${rel}: 负例未缺少必测部位`);
      break;
    }
    case 'price_positive': {
      if (sku.price_cents > 0) errors.push(`${rel}: 负例价格应 ≤ 0`);
      break;
    }
    case 'forbidden_claim': {
      const copy = negative.copy;
      const text = [copy.title, ...(copy.selling_points ?? [])].join(' ');
      if (!(copy.forbidden_words ?? []).some((word) => text.includes(word))) {
        errors.push(`${rel}: 负例未包含禁止词`);
      }
      break;
    }
    default:
      errors.push(`${rel}: 未知 rule ${negative.rule}`);
  }
}

export async function validateGolden(root = DEFAULT_ROOT) {
  ROOT = path.resolve(root);
  errors.length = 0;

  const lockFile = path.join(ROOT, 'golden.lock.json');
  const lock = await readJson(lockFile);
  if (!lock) {
    errors.push('缺少 golden.lock.json');
    return { ok: false, dataset_version: null, dataset_sha256: null, skus: 0, expected_files: 0, negatives: 0, errors };
  }

  const skuFiles = await listFiles(path.join(ROOT, 'skus'));
  const skus = [];
  for (const file of skuFiles) {
    const sku = await readJson(file);
    if (!sku) continue;
    skus.push(sku);
    validateSkuStructure(file, sku);
  }

  const actualHash = await datasetHash(ROOT);
  if (actualHash !== lock.dataset_sha256) {
    errors.push(`golden.lock.json: dataset_sha256 不匹配（lock=${lock.dataset_sha256} actual=${actualHash}）；数据集变更必须走 PR 评审并更新基线`);
  }
  if (skus.length < 10) errors.push(`SKU 数量 ${skus.length} < 10（起步要求）`);
  if (lock.count_skus !== skus.length) errors.push(`lock.count_skus=${lock.count_skus} 与实际 ${skus.length} 不一致`);

  for (const sku of skus) {
    await validateExpected(sku);
  }

  const docCodes = await loadDocErrorCodes();
  const negativeFiles = await listFiles(path.join(ROOT, 'negative'));
  if (negativeFiles.length < 3) errors.push(`负例数量 ${negativeFiles.length} < 3`);
  for (const file of negativeFiles) {
    const negative = await readJson(file);
    if (negative) await validateNegative(negative, docCodes);
  }
  if (lock.count_negative !== negativeFiles.length) {
    errors.push(`lock.count_negative=${lock.count_negative} 与实际 ${negativeFiles.length} 不一致`);
  }

  const summary = {
    ok: errors.length === 0,
    dataset_version: lock.dataset_version,
    dataset_sha256: actualHash,
    skus: skus.length,
    expected_files: (await listFiles(path.join(ROOT, 'expected'))).length,
    negatives: negativeFiles.length,
    errors,
  };

  return summary;
}

async function main() {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes('--json');
  const reportIndex = argv.indexOf('--report');
  const reportPath = reportIndex >= 0 ? argv[reportIndex + 1] : null;
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex >= 0 ? argv[rootIndex + 1] : DEFAULT_ROOT;

  const summary = await validateGolden(root);

  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(path.resolve(reportPath), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }

  if (jsonOut) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (summary.ok) {
    console.log(`✔ 黄金集校验通过：${summary.skus} SKU / ${summary.expected_files} 个预期文件 / ${summary.negatives} 条负例`);
    console.log(`  dataset_version=${summary.dataset_version} sha256=${String(summary.dataset_sha256).slice(0, 16)}…`);
  } else {
    console.error(`✖ 黄金集校验失败：${summary.errors.length} 个问题`);
    for (const error of summary.errors) console.error(`  - ${error}`);
  }
  return summary.ok ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[golden] 运行失败：${error.stack ?? error.message}`);
      process.exit(2);
    });
}
