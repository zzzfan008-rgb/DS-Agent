/**
 * 上架包导出器（CSV + XLSX + manifest）。
 *
 * 这是接口未获批时的兜底路径（ADR-0006）：
 * 导出 → 人工在商家后台导入 → **必须回填**批次号、成功/失败条数、驳回原因与包哈希。
 *
 * 产物：
 *   product.csv            商品级字段（1 行）
 *   skus.csv               每个 SKU 一行（价格含分与元两种表示）
 *   size-chart.csv         尺码表（一尺码一行，测量值展开为列）
 *   fabric.csv             面料成分（合计 100）
 *   platform-attributes.csv 平台属性映射
 *   listing.xlsx           以上 sheet + 说明
 *   manifest.json          template_profile / payload_hash / 行数 / 文件哈希 / 警告
 *   import-notes.md        人工导入与回填清单
 */

import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../util/canonical.js';
import { renderCsv } from './csv.js';
import type {
  ListingPackageFile,
  ListingPackageIssue,
  ListingPackageManifest,
  ListingPackageProfile,
  ListingPackageResult,
  ListingProductInput,
  NormalizedListingProduct,
  PackageTable,
  TableRow,
} from './types.js';
import { hasBlockingIssues, ListingPackageValidationError, validateAndNormalizeProduct } from './validation.js';
import { renderWorkbook } from './xlsx.js';

export const PDD_LISTING_PACKAGE_SCHEMA_VERSION = 'pdd-listing-package-v1' as const;
export const PDD_LISTING_PACKAGE_GENERATOR = { name: '@dssaas/adapters-pdd', version: '0.1.0' } as const;

export const PDD_LISTING_PACKAGE_PROFILE: ListingPackageProfile = {
  id: 'pdd-backend-import-unverified-v0',
  version: 'v0',
  verified: false,
  source_todo:
    '待填：拼多多商家后台批量导入模板的列名、必填列、单文件行数上限与失败回执格式（docs/01 §2.1；需开发者账号后台核验）',
  notes: [
    '本 profile 是内部规范列，不是平台官方模板；核验后必须替换列名并升 version。',
    '价格同时输出 price_cents（整数分，主数据口径）与 price_yuan（两位小数，人工核对用）。',
    '导入前必须确认后台模板与本 profile 一致；不一致时不得手工改包，应改 profile 后重导。',
  ],
};

const MEASUREMENT_COLUMNS = ['衣长', '胸围', '肩宽', '袖长', '腰围', '臀围', '下摆', '裙长', '裤长', '脚口', '大腿围', '领围'];
const PRODUCT_COLUMNS = [
  'spu_code',
  'name',
  'category_code',
  'fit',
  'description',
  'main_image',
  'gallery',
  'brand',
  'manufacturer',
  'qualification_report_no',
  'safety_class',
];
const SKU_COLUMNS = [
  'spu_code',
  'title',
  'category_code',
  'fit',
  'sku_code',
  'color_id',
  'color_name',
  'size_code',
  'size_order',
  'fabric_id',
  'price_cents',
  'price_yuan',
  'list_price_cents',
  'sale_price_cents',
  'stock_qty',
  'main_image',
  'qualification_report_no',
  'safety_class',
];
const SIZE_CHART_COLUMNS = [
  'sku_size_code',
  'size_order',
  ...MEASUREMENT_COLUMNS,
  'recommend_height_min',
  'recommend_height_max',
  'recommend_weight_min',
  'recommend_weight_max',
];
const FABRIC_COLUMNS = ['material', 'percent', 'note', 'fiber_code'];
const ATTRIBUTE_COLUMNS = ['attr_path', 'internal_value', 'platform_value_id'];
const IMPORT_CHECKLIST = [
  '在拼多多商家后台选择批量导入入口（入口 URL/路径待核验，docs/01 §2.1）',
  '确认后台模板列名与 manifest.template_profile.id 一致；不一致先改 profile 再导出，禁止手工改包',
  '导入后回填：批次号、成功条数、失败条数、平台驳回原因、包 sha256（ADR-0006 要求）',
  '失败行按平台回执修复主数据后重新生成；不重复提交同一包',
  '资质/主图缺失时不得导入（docs/01 G1：qualification_unknown 禁止进入上架草稿）',
  '本包不触达平台、不产生任何平台写操作；导入动作由人工执行并登记',
];

export interface BuildListingPackageOptions {
  outDir: string;
  /** 固定生成时间（测试/复现）；默认当前时间。 */
  generatedAt?: string;
  /** CSV 是否带 UTF-8 BOM；默认 true（Excel 打开中文不乱码）。 */
  csvBom?: boolean;
}

function formatYuan(cents: number | null): string {
  if (cents === null) return '';
  return (cents / 100).toFixed(2);
}

function cell(value: string | number | null | undefined): string | number | null {
  return value === undefined ? null : value;
}

function buildTables(product: NormalizedListingProduct): PackageTable[] {
  const productTable: PackageTable = {
    name: '商品',
    columns: PRODUCT_COLUMNS,
    rows: [
      {
        spu_code: product.spu_code,
        name: product.name,
        category_code: product.category_code,
        fit: cell(product.fit),
        description: cell(product.description),
        main_image: cell(product.media.main),
        gallery: product.media.gallery.join('|'),
        brand: cell(product.qualification.brand),
        manufacturer: cell(product.qualification.manufacturer),
        qualification_report_no: cell(product.qualification.report_no),
        safety_class: cell(product.qualification.safety_class),
      },
    ],
  };

  const skuTable: PackageTable = {
    name: 'SKU',
    columns: SKU_COLUMNS,
    rows: product.skus.map((sku): TableRow => ({
      spu_code: product.spu_code,
      title: product.name,
      category_code: product.category_code,
      fit: cell(product.fit),
      sku_code: sku.sku_code,
      color_id: sku.color_id,
      color_name: sku.color_name,
      size_code: sku.size_code,
      size_order: sku.size_order,
      fabric_id: cell(sku.fabric_id),
      price_cents: sku.price_cents,
      price_yuan: formatYuan(sku.price_cents),
      list_price_cents: cell(sku.list_price_cents),
      sale_price_cents: cell(sku.sale_price_cents),
      stock_qty: sku.stock_qty,
      main_image: cell(product.media.main),
      qualification_report_no: cell(product.qualification.report_no),
      safety_class: cell(product.qualification.safety_class),
    })),
  };

  const sizeChartTable: PackageTable = {
    name: '尺码表',
    columns: SIZE_CHART_COLUMNS,
    rows: product.size_chart.map((row): TableRow => {
      const record: TableRow = {
        sku_size_code: row.sku_size_code,
        size_order: row.size_order,
        recommend_height_min: cell(row.recommend_height_min),
        recommend_height_max: cell(row.recommend_height_max),
        recommend_weight_min: cell(row.recommend_weight_min),
        recommend_weight_max: cell(row.recommend_weight_max),
      };
      for (const key of MEASUREMENT_COLUMNS) record[key] = row.measurements[key] ?? null;
      return record;
    }),
  };

  const fabricTable: PackageTable = {
    name: '面料成分',
    columns: FABRIC_COLUMNS,
    rows: product.fabric.map((item): TableRow => ({
      material: item.material,
      percent: item.percent,
      note: cell(item.note),
      fiber_code: cell(item.fiber_code),
    })),
  };

  const attributeTable: PackageTable = {
    name: '平台属性',
    columns: ATTRIBUTE_COLUMNS,
    rows: product.attributes.map((item): TableRow => ({
      attr_path: item.attr_path,
      internal_value: item.internal_value,
      platform_value_id: cell(item.platform_value_id),
    })),
  };

  return [productTable, skuTable, sizeChartTable, fabricTable, attributeTable];
}

function notesForWorkbook(manifest: ListingPackageManifest, issues: ListingPackageIssue[]): string[] {
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  return [
    '拼多多上架包（兜底路径）',
    `template_profile: ${manifest.template_profile.id}（verified=${String(manifest.template_profile.verified)}）`,
    `generated_at: ${manifest.generated_at}`,
    `payload_hash: ${manifest.payload_hash}`,
    `data_origin: ${manifest.data_origin}`,
    `row_counts: sku=${manifest.row_counts.sku} size_chart=${manifest.row_counts.size_chart} fabric=${manifest.row_counts.fabric} attributes=${manifest.row_counts.attributes}`,
    `模板待核验：${manifest.template_profile.source_todo}`,
    '',
    '导入与回填清单：',
    ...manifest.import_checklist.map((item, index) => `${index + 1}. ${item}`),
    '',
    ...(warnings.length > 0
      ? ['警告（导入前处理）：', ...warnings.map((issue) => `- ${issue.code} @ ${issue.field}: ${issue.message}`)]
      : ['警告：无']),
  ];
}

function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function buildPddListingPackage(
  input: ListingProductInput,
  options: BuildListingPackageOptions,
): Promise<ListingPackageResult> {
  const { product, issues } = validateAndNormalizeProduct(input);
  if (hasBlockingIssues(issues)) throw new ListingPackageValidationError(issues);

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const outDir = path.resolve(options.outDir);
  await mkdir(outDir, { recursive: true });
  const outStat = await stat(outDir);
  if (!outStat.isDirectory()) throw new Error(`outDir 不是目录：${outDir}`);

  const tables = buildTables(product);
  const payloadHash = sha256(canonicalJson({ schema_version: PDD_LISTING_PACKAGE_SCHEMA_VERSION, template_profile: PDD_LISTING_PACKAGE_PROFILE.id, product }));

  const fileContents = new Map<string, Buffer | string>();
  for (const table of tables) {
    const fileNames: Record<string, string> = {
      商品: 'product.csv',
      SKU: 'skus.csv',
      尺码表: 'size-chart.csv',
      面料成分: 'fabric.csv',
      平台属性: 'platform-attributes.csv',
    };
    const fileName = fileNames[table.name];
    if (!fileName) throw new Error(`未知表名：${table.name}`);
    fileContents.set(fileName, renderCsv(table, { bom: options.csvBom ?? true }));
  }

  const manifestPreview: ListingPackageManifest = {
    schema_version: PDD_LISTING_PACKAGE_SCHEMA_VERSION,
    template_profile: PDD_LISTING_PACKAGE_PROFILE,
    generated_at: generatedAt,
    generator: PDD_LISTING_PACKAGE_GENERATOR,
    dry_run: true,
    data_origin: product.data_origin,
    payload_hash: payloadHash,
    row_counts: {
      product: product.skus.length > 0 ? 1 : 0,
      sku: product.skus.length,
      size_chart: product.size_chart.length,
      fabric: product.fabric.length,
      attributes: product.attributes.length,
    },
    files: [],
    warnings: issues.filter((issue) => issue.severity === 'warning'),
    import_checklist: [...IMPORT_CHECKLIST],
  };

  const xlsxBuffer = renderWorkbook({
    sheets: tables.map((table) => ({ name: table.name, table })),
    notes: notesForWorkbook(manifestPreview, issues),
  });
  fileContents.set('listing.xlsx', xlsxBuffer);

  const notesMarkdown = renderImportNotes(manifestPreview);
  fileContents.set('import-notes.md', notesMarkdown);

  const files: ListingPackageFile[] = [];
  for (const [name, content] of fileContents) {
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    await writeFile(path.join(outDir, name), buffer, { mode: 0o600 });
    files.push({ name, bytes: buffer.byteLength, sha256: sha256(buffer) });
  }

  const manifest: ListingPackageManifest = {
    ...manifestPreview,
    files: files.sort((a, b) => a.name.localeCompare(b.name)),
  };
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outDir, 'manifest.json'), manifestBuffer, { mode: 0o600 });

  return { out_dir: outDir, manifest, tables, issues };
}

function renderImportNotes(manifest: ListingPackageManifest): string {
  const lines = [
    '# 拼多多上架包 · 人工导入说明',
    '',
    `- template_profile：\`${manifest.template_profile.id}\`（verified=\`${String(manifest.template_profile.verified)}\`）`,
    `- generated_at：${manifest.generated_at}`,
    `- payload_hash：\`${manifest.payload_hash}\``,
    `- data_origin：${manifest.data_origin}`,
    `- dry_run：是（本包未触达平台）`,
    '',
    '## 模板状态',
    '',
    manifest.template_profile.source_todo,
    '',
    ...manifest.template_profile.notes.map((note) => `- ${note}`),
    '',
    '## 行数',
    '',
    `- 商品：${manifest.row_counts.product}`,
    `- SKU：${manifest.row_counts.sku}`,
    `- 尺码表：${manifest.row_counts.size_chart}`,
    `- 面料成分：${manifest.row_counts.fabric}`,
    `- 平台属性：${manifest.row_counts.attributes}`,
    '',
    '## 导入与回填清单',
    '',
    ...manifest.import_checklist.map((item, index) => `${index + 1}. ${item}`),
    '',
    ...(manifest.warnings.length > 0
      ? ['## 警告', '', ...manifest.warnings.map((issue) => `- \`${issue.code}\` @ \`${issue.field}\`：${issue.message}`), '']
      : []),
  ];
  return `${lines.join('\n')}\n`;
}
