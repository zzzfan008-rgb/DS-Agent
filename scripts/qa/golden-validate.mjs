#!/usr/bin/env node
/**
 * 黄金集自校验器（t15）—— 校验 `data/golden/` 种子数据自身是否合法、自洽。
 *
 * 校验项：
 *   1) products.csv：列数/表头/行数/唯一 spu_code/类目分组（上衣/裤装/连衣裙/外套各 ≥3）；
 *   2) fabric_json 与 fabrics.jsonl：JSON 可解析、材料百分比为整数、合计 100、两处一致；
 *   3) size_chart_json 与 size-charts.jsonl：SizeChartV1 结构、码集覆盖 SKU、码序递增、
 *      品类的必测部位齐全、单位 cm、版本号一致；
 *   4) qualification_json：非空且含 textile_safety.standard / grade；
 *   5) expected/<spu>.json：每商品一条，规则 ID/严重度合法，facts 与主数据一致；
 *   6) expected/negative/*.json：≥3 条，变异确实违反对应规则，error_code 在 docs/12 §4 词表内。
 *
 * 用法：
 *   node scripts/qa/golden-validate.mjs            # 校验 data/golden
 *   node scripts/qa/golden-validate.mjs --json     # 机器可读
 *   node scripts/qa/golden-validate.mjs --root <dir>  # 校验副本（篡改验证用）
 *
 * 退出码：0 通过；1 校验失败；2 运行错误。
 * 注意：本校验器**尚未**接入 pnpm check:contracts / CI（按 t15 要求等统一编排，见 data/golden/README.md）。
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDocErrorCodes } from '../../tests/contract/lib/doc-codes.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/golden');

const REQUIRED_COLUMNS = [
  'spu_code',
  'title',
  'category_code',
  'fabric_json',
  'size_chart_json',
  'qualification_json',
  'platform_pdd_category',
  'platform_1688_category',
  'price_cents',
  'stock_qty',
];

const CATEGORY_GROUPS = {
  上衣: ['A0101', 'A0202'],
  裤装: ['B0211'],
  连衣裙: ['C0221'],
  外套: ['D0232'],
};

const REQUIRED_MEASUREMENTS = {
  A0101: ['胸围', '衣长'],
  A0202: ['胸围', '衣长'],
  B0211: ['腰围', '裤长'],
  C0221: ['胸围', '裙长'],
  D0232: ['胸围', '衣长'],
};

const SIZE_CODE_RE = /^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|4XL|5XL|[0-9]{2,3}|ONE)$/;
const L1_RULE_RE = /^(L1-[A-Z]{3,4}-\d{3}|PLAT-QUA-\d{3})$/;
const SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'blocker']);

const errors = [];

function err(file, message) {
  errors.push(`${file}: ${message}`);
}

function isInt(value) {
  return Number.isInteger(value);
}

/** RFC4180 CSV 解析（支持引号内逗号/换行/双引号转义）。 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
      if (ch === '\r') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((item) => !(item.length === 1 && item[0] === ''));
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    err(path.relative(DEFAULT_ROOT, file), `JSON 解析失败（${error.message}）`);
    return null;
  }
}

async function readJsonLines(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    err(path.basename(file), `读取失败（${error.message}）`);
    return [];
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const rows = [];
  lines.forEach((line, index) => {
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      err(`${path.basename(file)}:${index + 1}`, `JSON 解析失败（${error.message}）`);
    }
  });
  return rows;
}

function canonicalMaterials(materials) {
  return [...materials]
    .map((item) => `${item.material}:${item.percent}`)
    .sort()
    .join('|');
}

function compositionText(materials) {
  return materials.map((item) => `${item.material}${item.percent}%`).join('+');
}

function validateQualification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const safety = value.textile_safety;
  return Boolean(
    safety &&
      typeof safety === 'object' &&
      typeof safety.standard === 'string' &&
      safety.standard.length > 0 &&
      typeof safety.grade === 'string' &&
      safety.grade.length > 0,
  );
}

function validateSizeChart(chart, product, file) {
  if (!chart || typeof chart !== 'object') return;
  if (chart.spu_code !== product.spu_code) err(file, 'spu_code 与商品不一致');
  if (chart.version_no !== 1) err(file, 'version_no 应为 1');
  if (chart.unit !== 'cm') err(file, 'unit 必须为 cm');
  if (!['alpha', 'numeric', 'height_weight', 'one_size'].includes(chart.size_system)) {
    err(file, `size_system 非法：${chart.size_system}`);
  }
  if (!Array.isArray(chart.sizes) || chart.sizes.length === 0) {
    err(file, 'sizes 必须是非空数组');
    return;
  }

  const codes = new Set();
  let lastOrder = -Infinity;
  for (const row of chart.sizes) {
    if (!SIZE_CODE_RE.test(row.sku_size_code ?? '')) err(file, `sku_size_code 非法：${row.sku_size_code}`);
    if (codes.has(row.sku_size_code)) err(file, `sku_size_code 重复：${row.sku_size_code}`);
    codes.add(row.sku_size_code);
    if (!isInt(row.size_order) || row.size_order <= lastOrder) {
      err(file, `size_order 必须严格递增（${row.sku_size_code}）`);
    }
    lastOrder = row.size_order;
    if (!row.measurements || typeof row.measurements !== 'object' || Array.isArray(row.measurements)) {
      err(file, `${row.sku_size_code} measurements 必须是对象`);
      continue;
    }
    for (const key of REQUIRED_MEASUREMENTS[product.category_code] ?? []) {
      const value = row.measurements[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        err(file, `${row.sku_size_code} 缺少必测部位或数值非法：${key}`);
      }
    }
    for (const key of ['recommend_height_min', 'recommend_height_max', 'recommend_weight_min', 'recommend_weight_max']) {
      if (row[key] !== undefined && !isInt(row[key])) err(file, `${row.sku_size_code} ${key} 必须为整数`);
    }
    if (
      row.recommend_height_min !== undefined &&
      row.recommend_height_max !== undefined &&
      row.recommend_height_min >= row.recommend_height_max
    ) {
      err(file, `${row.sku_size_code} 身高区间 min 必须 < max`);
    }
    if (
      row.recommend_weight_min !== undefined &&
      row.recommend_weight_max !== undefined &&
      row.recommend_weight_min >= row.recommend_weight_max
    ) {
      err(file, `${row.sku_size_code} 体重区间 min 必须 < max`);
    }
  }

  for (const code of product.sku_size_codes) {
    if (!codes.has(code)) err(file, `尺码表未覆盖 SKU 码：${code}`);
  }
  for (const code of codes) {
    if (!product.sku_size_codes.includes(code)) err(file, `尺码表存在未声明的码：${code}`);
  }

  const numeric = [...codes].every((code) => /^\d+$/.test(code));
  if (numeric && chart.size_system !== 'numeric') err(file, '数字码应使用 size_system=numeric');
  if (!numeric && chart.size_system === 'numeric') err(file, '字母码不应使用 size_system=numeric');
}

function validateExpected(expected, product, file) {
  if (expected.spu_code !== product.spu_code) err(file, 'spu_code 与商品不一致');
  if (!Array.isArray(expected.expected_l1)) {
    err(file, 'expected_l1 必须是数组');
    return;
  }
  for (const hit of expected.expected_l1) {
    if (!L1_RULE_RE.test(hit.rule_id ?? '')) err(file, `rule_id 非法：${hit.rule_id}`);
    if (!SEVERITIES.has(hit.severity)) err(file, `severity 非法：${hit.severity}`);
    for (const key of ['field', 'matched']) {
      if (typeof hit[key] !== 'string' || hit[key].length === 0) err(file, `L1 命中缺少 ${key}`);
    }
  }
  if (expected.expected_l1.length === 0) {
    if (expected.expected_verdict !== 'pass') err(file, '无 L1 命中时 expected_verdict 应为 pass');
  } else if (!['needs_revision', 'reject', 'escalate'].includes(expected.expected_verdict)) {
    err(file, `有 L1 命中时 verdict 非法：${expected.expected_verdict}`);
  }

  const facts = expected.facts ?? {};
  if (facts.price_cents !== product.price_cents) err(file, 'facts.price_cents 与商品不一致');
  if (facts.stock_qty !== product.stock_qty) err(file, 'facts.stock_qty 与商品不一致');
  if (facts.category_code !== product.category_code) err(file, 'facts.category_code 与商品不一致');
  if (facts.composition_text !== compositionText(product.fabric.materials)) {
    err(file, 'facts.composition_text 与成分不一致');
  }
  if (JSON.stringify(facts.size_codes) !== JSON.stringify(product.sku_size_codes)) {
    err(file, 'facts.size_codes 与尺码表码集不一致');
  }
}

function validateNegative(negative, file, docCodes, chartsBySpu) {
  const { case_id: caseId, base_spu: baseSpu, rule, expected, data } = negative;
  if (!caseId) err(file, '缺少 case_id');
  if (!baseSpu) err(file, '缺少 base_spu');
  if (!rule) err(file, '缺少 rule');
  if (!expected || typeof expected !== 'object') {
    err(file, '缺少 expected');
    return;
  }
  if (!docCodes.has(expected.error_code)) err(file, `error_code ${expected.error_code} 不在 docs/12 §4`);
  for (const hit of expected.l1 ?? []) {
    if (!L1_RULE_RE.test(hit.rule_id ?? '')) err(file, `rule_id 非法：${hit.rule_id}`);
  }
  if (!data || typeof data !== 'object') {
    err(file, '缺少 mutated data');
    return;
  }

  switch (rule) {
    case 'composition_sum_99': {
      const sum = (data.fabric?.materials ?? []).reduce((total, item) => total + item.percent, 0);
      if (sum === 100) err(file, '变异未生效：成分合计仍为 100');
      break;
    }
    case 'missing_qualification': {
      const value = data.qualification;
      if (!validateQualification(value)) {
        // 期望就是缺失，正常
      } else {
        err(file, '变异未生效：资质仍非空');
      }
      break;
    }
    case 'required_measurement_missing': {
      const required = REQUIRED_MEASUREMENTS[data.category_code] ?? [];
      const missing = (data.chart ?? []).some((row) =>
        required.some((key) => row.measurements?.[key] === undefined),
      );
      if (!missing) err(file, '变异未生效：未发现缺失必测部位');
      break;
    }
    case 'size_code_not_covered': {
      const chart = chartsBySpu.get(baseSpu);
      const codes = new Set((data.chart ?? []).map((row) => row.sku_size_code));
      const uncovered = (data.skuSizes ?? []).filter((code) => !codes.has(code));
      if (uncovered.length === 0) err(file, '变异未生效：尺码表仍覆盖所有 SKU');
      if (chart) {
        // 交叉检查：基准商品尺码表在原始数据中存在
        if (!chart.sizes?.length) err(file, '基准商品的尺码表为空');
      }
      break;
    }
    default:
      err(file, `未知 rule：${rule}`);
  }
}

export async function validateGolden(root = DEFAULT_ROOT) {
  errors.length = 0;
  const csvFile = path.join(root, 'products.csv');
  let csvText;
  try {
    csvText = await readFile(csvFile, 'utf8');
  } catch (error) {
    return { ok: false, errors: [`products.csv: 读取失败（${error.message}）`], counts: {} };
  }

  const rows = parseCsv(csvText);
  if (rows.length < 2) return { ok: false, errors: ['products.csv: 至少需要表头 + 12 行数据'], counts: {} };
  const header = rows[0];
  if (JSON.stringify(header) !== JSON.stringify(REQUIRED_COLUMNS)) {
    err('products.csv', `表头不一致，期望：${REQUIRED_COLUMNS.join(',')}`);
  }
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].length !== header.length) {
      err(`products.csv:${i + 1}`, `列数 ${rows[i].length} 与表头 ${header.length} 不一致`);
    }
  }

  const products = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.length !== header.length) continue;
    const record = Object.fromEntries(header.map((key, index) => [key, row[index]]));
    const file = `products.csv:${i + 1} (${record.spu_code})`;

    let fabric;
    let sizeRef;
    let qualification;
    try {
      fabric = JSON.parse(record.fabric_json);
    } catch (error) {
      err(file, `fabric_json 解析失败（${error.message}）`);
    }
    try {
      sizeRef = JSON.parse(record.size_chart_json);
    } catch (error) {
      err(file, `size_chart_json 解析失败（${error.message}）`);
    }
    try {
      qualification = JSON.parse(record.qualification_json);
    } catch (error) {
      err(file, `qualification_json 解析失败（${error.message}）`);
    }

    if (!record.spu_code) err(file, 'spu_code 为空');
    if (!record.title) err(file, 'title 为空');
    if (!CATEGORY_GROUPS[Object.keys(CATEGORY_GROUPS).find((group) => (CATEGORY_GROUPS[group] ?? []).includes(record.category_code))]) {
      err(file, `category_code 不在黄金集覆盖范围：${record.category_code}`);
    }
    if (!record.platform_pdd_category) err(file, 'platform_pdd_category 为空');
    if (!record.platform_1688_category) err(file, 'platform_1688_category 为空');
    if (!/^\d+$/.test(record.price_cents) || Number(record.price_cents) <= 0) err(file, 'price_cents 必须是正整数分');
    if (!/^\d+$/.test(record.stock_qty) || Number(record.stock_qty) < 0) err(file, 'stock_qty 必须是非负整数');

    if (fabric) {
      if (!fabric.fabric_code) err(file, 'fabric.fabric_code 为空');
      if (!Array.isArray(fabric.materials) || fabric.materials.length === 0) {
        err(file, 'fabric.materials 不能为空');
      } else {
        let sum = 0;
        for (const item of fabric.materials) {
          if (typeof item.material !== 'string' || item.material.length === 0) err(file, '材料名称为空');
          if (!isInt(item.percent)) err(file, `材料百分比必须是整数：${item.material}`);
          else sum += item.percent;
        }
        if (sum !== 100) err(file, `成分合计 ${sum}% ≠ 100%`);
      }
    }
    if (!validateQualification(qualification)) {
      err(file, 'qualification 缺失或缺少 textile_safety.standard / grade');
    }
    if (!sizeRef || !Array.isArray(sizeRef.sku_size_codes) || sizeRef.sku_size_codes.length === 0) {
      err(file, 'size_chart_json.sku_size_codes 必须是非空数组');
    } else if (new Set(sizeRef.sku_size_codes).size !== sizeRef.sku_size_codes.length) {
      err(file, 'size_chart_json.sku_size_codes 有重复');
    }

    products.push({
      spu_code: record.spu_code,
      title: record.title,
      category_code: record.category_code,
      fabric,
      sku_size_codes: sizeRef?.sku_size_codes ?? [],
      qualification,
      price_cents: Number(record.price_cents),
      stock_qty: Number(record.stock_qty),
      rowNumber: i + 1,
    });
  }

  const spuCodes = products.map((product) => product.spu_code);
  if (new Set(spuCodes).size !== spuCodes.length) err('products.csv', 'spu_code 有重复');
  if (products.length < 12) err('products.csv', `商品数 ${products.length} < 12`);

  for (const [group, codes] of Object.entries(CATEGORY_GROUPS)) {
    const count = products.filter((product) => codes.includes(product.category_code)).length;
    if (count < 3) err('products.csv', `${group} 商品数 ${count} < 3`);
  }

  const fabrics = await readJsonLines(path.join(root, 'fabrics.jsonl'));
  const fabricsBySpu = new Map();
  for (const row of fabrics) {
    if (!row.spu_code) {
      err('fabrics.jsonl', '存在缺少 spu_code 的行');
      continue;
    }
    if (fabricsBySpu.has(row.spu_code)) err('fabrics.jsonl', `spu_code 重复：${row.spu_code}`);
    fabricsBySpu.set(row.spu_code, row);
  }
  for (const product of products) {
    const fabric = fabricsBySpu.get(product.spu_code);
    if (!fabric) {
      err('fabrics.jsonl', `缺少商品 ${product.spu_code} 的成分行`);
      continue;
    }
    if (!product.fabric) continue;
    const sum = (fabric.materials ?? []).reduce((total, item) => total + item.percent, 0);
    if (sum !== 100) err(`fabrics.jsonl (${product.spu_code})`, `成分合计 ${sum}% ≠ 100%`);
    if (canonicalMaterials(fabric.materials ?? []) !== canonicalMaterials(product.fabric.materials ?? [])) {
      err(`fabrics.jsonl (${product.spu_code})`, '与 products.csv fabric_json 不一致');
    }
  }

  const charts = await readJsonLines(path.join(root, 'size-charts.jsonl'));
  const chartsBySpu = new Map();
  for (const chart of charts) {
    if (!chart.spu_code) {
      err('size-charts.jsonl', '存在缺少 spu_code 的行');
      continue;
    }
    if (chartsBySpu.has(chart.spu_code)) err('size-charts.jsonl', `spu_code 重复：${chart.spu_code}`);
    chartsBySpu.set(chart.spu_code, chart);
  }
  for (const product of products) {
    const chart = chartsBySpu.get(product.spu_code);
    if (!chart) {
      err('size-charts.jsonl', `缺少商品 ${product.spu_code} 的尺码表`);
      continue;
    }
    validateSizeChart(chart, product, `size-charts.jsonl (${product.spu_code})`);
  }
  if (charts.length !== products.length) {
    err('size-charts.jsonl', `尺码表数量 ${charts.length} 与商品数 ${products.length} 不一致`);
  }

  const expectedDir = path.join(root, 'expected');
  let expectedFiles = [];
  try {
    expectedFiles = (await readdir(expectedDir)).filter((name) => name.endsWith('.json') && !name.startsWith('negative'));
  } catch {
    err('expected/', '目录不存在');
  }
  for (const product of products) {
    const expected = await readJson(path.join(expectedDir, `${product.spu_code}.json`));
    if (!expected) continue;
    validateExpected(expected, product, `expected/${product.spu_code}.json`);
  }
  if (expectedFiles.length !== products.length) {
    err('expected/', `期望结论数量 ${expectedFiles.length} 与商品数 ${products.length} 不一致`);
  }

  const docCodes = await loadDocErrorCodes();
  const negativeDir = path.join(expectedDir, 'negative');
  let negativeFiles = [];
  try {
    negativeFiles = (await readdir(negativeDir)).filter((name) => name.endsWith('.json'));
  } catch {
    err('expected/negative/', '目录不存在');
  }
  if (negativeFiles.length < 3) err('expected/negative/', `负例数量 ${negativeFiles.length} < 3`);
  for (const name of negativeFiles) {
    const negative = await readJson(path.join(negativeDir, name));
    if (negative) validateNegative(negative, `expected/negative/${name}`, docCodes, chartsBySpu);
  }

  const counts = {
    products: products.length,
    groups: Object.fromEntries(
      Object.entries(CATEGORY_GROUPS).map(([group, codes]) => [
        group,
        products.filter((product) => codes.includes(product.category_code)).length,
      ]),
    ),
    sizeCharts: charts.length,
    fabrics: fabrics.length,
    expected: expectedFiles.length,
    negatives: negativeFiles.length,
  };

  return { ok: errors.length === 0, errors, counts };
}

async function main() {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes('--json');
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex >= 0 ? argv[rootIndex + 1] : DEFAULT_ROOT;
  const result = await validateGolden(root);

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(
      `✔ 黄金集校验通过：${result.counts.products} 商品（上衣 ${result.counts.groups.上衣} / 裤装 ${result.counts.groups.裤装} / 连衣裙 ${result.counts.groups.连衣裙} / 外套 ${result.counts.groups.外套}）+ ${result.counts.sizeCharts} 尺码表 + ${result.counts.fabrics} 成分 + ${result.counts.expected} 期望 + ${result.counts.negatives} 负例`,
    );
  } else {
    console.error(`✖ 黄金集校验失败：${result.errors.length} 个问题`);
    for (const message of result.errors) console.error(`  - ${message}`);
  }
  return result.ok ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[golden-validate] 运行失败：${error.stack ?? error.message}`);
      process.exit(2);
    });
}
