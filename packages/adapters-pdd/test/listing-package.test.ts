import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildPddListingPackage, PDD_LISTING_PACKAGE_PROFILE } from '../src/listing-package/exporter.js';
import type { ListingProductInput } from '../src/listing-package/types.js';
import {
  ListingPackageValidationError,
  normalizeSizeCode,
} from '../src/listing-package/validation.js';
import { withTempDir } from './helpers.js';

const SAMPLE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/sample-product.json');

async function loadSample(): Promise<ListingProductInput> {
  return JSON.parse(await readFile(SAMPLE_PATH, 'utf8')) as ListingProductInput;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 极简 RFC4180 解析器（测试专用）。 */
function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (inQuotes) {
      if (char === '"') {
        if (clean[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // 忽略 CR，由 \n 结束行
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function listZipEntries(buffer: Buffer): string[] {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, '缺少 ZIP EOCD');
  const count = buffer.readUInt16LE(eocd + 10);
  const offset = buffer.readUInt32LE(eocd + 16);
  const names: string[] = [];
  let pointer = offset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(pointer), 0x02014b50);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    names.push(buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8'));
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function cloneSample(sample: ListingProductInput): ListingProductInput {
  return structuredClone(sample);
}

async function expectValidationError(product: ListingProductInput, code: string): Promise<void> {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => buildPddListingPackage(product, { outDir: dir, generatedAt: '2026-10-20T02:00:00.000Z' }),
      (error: unknown) => {
        assert.equal(error instanceof ListingPackageValidationError, true);
        const issues = (error as ListingPackageValidationError).issues;
        assert.ok(issues.some((issue) => issue.code === code && issue.severity === 'error'), `期望错误 ${code}，实际 ${issues.map((issue) => issue.code).join(',')}`);
        return true;
      },
    );
  });
}

test('dry-run 上架包样例：CSV/XLSX/manifest/说明齐全，行数与哈希可核对', async () => {
  const sample = await loadSample();
  await withTempDir(async (dir) => {
    const generatedAt = '2026-10-20T02:00:00.000Z';
    const result = await buildPddListingPackage(sample, { outDir: dir, generatedAt });
    assert.equal(result.manifest.schema_version, 'pdd-listing-package-v1');
    assert.equal(result.manifest.template_profile.id, PDD_LISTING_PACKAGE_PROFILE.id);
    assert.equal(result.manifest.template_profile.verified, false);
    assert.equal(result.manifest.dry_run, true);
    assert.equal(result.manifest.data_origin, 'synthetic_sample');
    assert.deepEqual(result.manifest.row_counts, { product: 1, sku: 8, size_chart: 4, fabric: 3, attributes: 3 });
    assert.equal(result.manifest.warnings.length, 0);
    assert.equal(result.manifest.payload_hash.length, 64);

    const expectedFiles = [
      'fabric.csv',
      'import-notes.md',
      'listing.xlsx',
      'manifest.json',
      'platform-attributes.csv',
      'product.csv',
      'size-chart.csv',
      'skus.csv',
    ];
    for (const name of expectedFiles) {
      const info = await stat(path.join(dir, name));
      assert.equal(info.isFile(), true, name);
      assert.ok(info.size > 0, name);
    }
    assert.deepEqual(
      result.manifest.files.map((file) => file.name),
      ['fabric.csv', 'import-notes.md', 'listing.xlsx', 'platform-attributes.csv', 'product.csv', 'size-chart.csv', 'skus.csv'],
    );
    for (const file of result.manifest.files) {
      const buffer = await readFile(path.join(dir, file.name));
      assert.equal(buffer.byteLength, file.bytes, file.name);
      assert.equal(sha256(buffer), file.sha256, file.name);
    }

    const skuCsv = await readFile(path.join(dir, 'skus.csv'), 'utf8');
    assert.equal(skuCsv.startsWith('\uFEFF'), true);
    const skuRows = parseCsv(skuCsv);
    assert.equal(skuRows.length, 9);
    assert.equal(skuRows[0]?.[0], 'spu_code');
    assert.ok(skuRows[0]?.includes('price_cents'));
    const blackM = skuRows.find((row) => row[4] === 'DS-SAMPLE-COAT-001-BK-M');
    assert.ok(blackM);
    assert.equal(blackM[5], 'BK-0101');
    assert.equal(blackM[7], 'M');
    assert.equal(blackM[10], '39900');
    assert.equal(blackM[11], '399.00');
    assert.equal(blackM[14], '120');
    const aliasRow = skuRows.find((row) => row[4] === 'DS-SAMPLE-COAT-001-KH-XXL');
    assert.ok(aliasRow);
    assert.equal(aliasRow[7], 'XXL', '2XL 必须归一为 XXL');

    const sizeCsv = parseCsv(await readFile(path.join(dir, 'size-chart.csv'), 'utf8'));
    assert.equal(sizeCsv.length, 5);
    assert.equal(sizeCsv[0]?.[0], 'sku_size_code');
    assert.ok(sizeCsv[0]?.includes('胸围'));

    const fabricCsv = parseCsv(await readFile(path.join(dir, 'fabric.csv'), 'utf8'));
    const percentSum = fabricCsv.slice(1).reduce((sum, row) => sum + Number(row[1]), 0);
    assert.equal(percentSum, 100);

    const notes = await readFile(path.join(dir, 'import-notes.md'), 'utf8');
    assert.ok(notes.includes(result.manifest.payload_hash));
    assert.ok(notes.includes('导入与回填清单'));
    assert.ok(notes.includes('批次号'));

    const xlsx = await readFile(path.join(dir, 'listing.xlsx'));
    assert.equal(xlsx.subarray(0, 4).toString('hex'), '504b0304');
    const entries = listZipEntries(xlsx);
    assert.ok(entries.includes('[Content_Types].xml'));
    assert.ok(entries.includes('xl/workbook.xml'));
    const worksheets = entries.filter((name) => name.startsWith('xl/worksheets/sheet'));
    assert.equal(worksheets.length, 6, '说明 + 商品 + SKU + 尺码表 + 面料成分 + 平台属性');
  });
});

test('同样输入 + 同样 generatedAt → payload_hash 与全部文件字节一致（可复现）', async () => {
  const sample = await loadSample();
  await withTempDir(async (first) => {
    await withTempDir(async (second) => {
      const generatedAt = '2026-10-20T02:00:00.000Z';
      const a = await buildPddListingPackage(sample, { outDir: first, generatedAt });
      const b = await buildPddListingPackage(sample, { outDir: second, generatedAt });
      assert.equal(a.manifest.payload_hash, b.manifest.payload_hash);
      assert.deepEqual(a.manifest.files, b.manifest.files);
      for (const file of a.manifest.files) {
        const left = await readFile(path.join(first, file.name));
        const right = await readFile(path.join(second, file.name));
        assert.equal(sha256(left), sha256(right), file.name);
      }
    });
  });
});

test('尺码别名归一与非法编码', () => {
  assert.equal(normalizeSizeCode('2XL'), 'XXL');
  assert.equal(normalizeSizeCode('3XL'), 'XXXL');
  assert.equal(normalizeSizeCode('加大'), 'XL');
  assert.equal(normalizeSizeCode('均码'), 'ONE');
  assert.equal(normalizeSizeCode('f'), 'ONE');
  assert.equal(normalizeSizeCode('170/88A'), null);
  assert.equal(normalizeSizeCode('6XL'), null);
  assert.equal(normalizeSizeCode('FREE'), null);
  assert.equal(normalizeSizeCode('均码加大'), null);
});

test('硬事实校验：成分合计 99 被拒', async () => {
  const sample = cloneSample(await loadSample());
  sample.fabric[0]!.percent = 60;
  await expectValidationError(sample, 'fabric_sum_invalid');
});

test('硬事实校验：非法尺码 6XL/FREE 被拒', async () => {
  const sixXl = cloneSample(await loadSample());
  sixXl.skus[0]!.size_code = '6XL';
  await expectValidationError(sixXl, 'size_code_invalid');

  const free = cloneSample(await loadSample());
  free.size_chart[0]!.sku_size_code = 'FREE';
  await expectValidationError(free, 'size_code_invalid');
});

test('硬事实校验：零价 / 促销价高于售价被拒', async () => {
  const zero = cloneSample(await loadSample());
  zero.skus[0]!.price_cents = 0;
  await expectValidationError(zero, 'invalid_price');

  const promo = cloneSample(await loadSample());
  promo.skus[0]!.sale_price_cents = 99900;
  await expectValidationError(promo, 'sale_price_above_price');
});

test('硬事实校验：重复 SKU / 缺尺码行 / 0.3cm 步进被拒', async () => {
  const duplicate = cloneSample(await loadSample());
  duplicate.skus.push(structuredClone(duplicate.skus[0]!));
  await expectValidationError(duplicate, 'duplicate_sku');

  const missing = cloneSample(await loadSample());
  missing.size_chart = missing.size_chart.filter((row) => row.sku_size_code !== 'M');
  await expectValidationError(missing, 'size_chart_missing');

  const step = cloneSample(await loadSample());
  step.size_chart[0]!.measurements['衣长'] = 70.3;
  await expectValidationError(step, 'measurement_step_invalid');

  const emptyFabric = cloneSample(await loadSample());
  emptyFabric.fabric = [];
  await expectValidationError(emptyFabric, 'fabric_missing');
});

test('警告不阻断：缺资质仍可导出，但 manifest 明确提示 qualification_unknown', async () => {
  const sample = cloneSample(await loadSample());
  sample.qualification = {};
  sample.media = {};
  await withTempDir(async (dir) => {
    const result = await buildPddListingPackage(sample, { outDir: dir, generatedAt: '2026-10-20T02:00:00.000Z' });
    const codes = result.manifest.warnings.map((issue) => issue.code);
    assert.ok(codes.includes('qualification_unknown'));
    assert.ok(codes.includes('media_main_missing'));
    assert.ok(result.manifest.import_checklist.some((item) => item.includes('资质')));
  });
});
