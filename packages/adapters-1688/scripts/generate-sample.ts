/**
 * 生成 1688 上架包样例与合成契约 fixture。
 *
 * 产物（全部可提交到 Git）：
 * - `docs/samples/1688-listing-package.sample.json` —— 内部规范化上架包（含阻断项）
 * - `docs/samples/1688-listing-package.sample.csv` —— 内部规范列 CSV（UTF-8 BOM）
 * - `docs/samples/1688-attribute-mappings.sample.csv` —— `platform_attribute_mapping` 草稿行
 * - `packages/adapters-1688/test/fixtures/1688/contract.probe/…json` —— 合成 fixture
 *
 * 用法：`pnpm --filter @dssaas/adapters-1688 sample`
 * 固定 `generatedAt` 以保证可复现（同输入同哈希）。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildListingPackage,
  renderListingPackageCsv,
  renderListingPackageJson,
} from '../src/listing/exporter.js';
import { describeListingPackage } from '../src/listing/package.js';
import { renderMappingCsv } from '../src/mapping/attributes.js';
import { registrySummary } from '../src/client/registry.js';
import { openTodos } from '../src/todo.js';
import { createFixture, assertFixtureHonesty, fixturePath, saveFixture } from '../src/testing/fixtures.js';
import type { HttpRequest, HttpResponse } from '../src/client/types.js';
import { sampleListingInput } from '../test/sample-data.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const SAMPLES_DIR = path.join(REPO_ROOT, 'docs', 'samples');
const FIXTURE_ROOT = path.join(HERE, '..', 'test', 'fixtures');

/** 固定时间，保证哈希可复现。 */
const GENERATED_AT = '2026-10-20T14:00:00.000Z';
const AS_OF = '2026-10-20';

async function main(): Promise<void> {
  await mkdir(SAMPLES_DIR, { recursive: true });

  const draft = buildListingPackage(sampleListingInput, { generatedAt: GENERATED_AT, asOf: AS_OF });

  const jsonFile = path.join(SAMPLES_DIR, '1688-listing-package.sample.json');
  const csvFile = path.join(SAMPLES_DIR, '1688-listing-package.sample.csv');
  const mappingFile = path.join(SAMPLES_DIR, '1688-attribute-mappings.sample.csv');

  await writeFile(jsonFile, renderListingPackageJson(draft), 'utf8');
  await writeFile(csvFile, renderListingPackageCsv(draft), 'utf8');
  await writeFile(mappingFile, renderMappingCsv(draft.attributes), 'utf8');

  // ---- 合成契约 fixture（明确标注 synthetic / verified=false）----
  const request: HttpRequest = {
    method: 'POST',
    url: 'https://example.invalid/router/rest?app_key=demo-app-key&sign=demo-signature&timestamp=1700000000',
    headers: {
      'content-type': 'application/json',
      'x-app-key': 'demo-app-key',
      'access-token': 'demo-token',
    },
    body: JSON.stringify({ method: 'test.echo', page: 1, note: '合成样例，非平台真实报文' }),
  };
  const response: HttpResponse = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, echo: 'synthetic' }),
  };
  const fixture = createFixture(request, response, {
    platform: '1688',
    operation: 'contract.probe',
    recordedAt: '2026-10-20T02:00:00.000Z',
    docVersion: null,
    recorder: 'scripts/generate-sample.ts',
    verified: false,
    synthetic: true,
    note: '形状样例：仅验证录制/回放与脱敏机制，不代表 1688 真实报文（TODO-1688-001/012）',
  });
  const fixtureFile = await saveFixture(FIXTURE_ROOT, fixture);

  const honesty = assertFixtureHonesty(fixture);
  const summary = registrySummary();
  const blockers = draft.checks.blockers;
  const warnings = draft.checks.warnings;

  console.log('1688 上架包样例已生成（固定 generatedAt，可复现）');
  console.log(`- ${path.relative(REPO_ROOT, jsonFile)}`);
  console.log(`- ${path.relative(REPO_ROOT, csvFile)}`);
  console.log(`- ${path.relative(REPO_ROOT, mappingFile)}`);
  console.log(`- ${path.relative(REPO_ROOT, fixtureFile)}（= fixturePath: ${path.relative(REPO_ROOT, fixturePath(FIXTURE_ROOT, fixture))}）`);
  console.log('');
  console.log(`packageHash = ${draft.packageHash}`);
  console.log(`summary     = ${describeListingPackage(draft)}`);
  console.log(`blockers    = ${blockers.length}：${blockers.map((issue) => issue.code).join(', ')}`);
  console.log(`warnings    = ${warnings.length}：${warnings.map((issue) => issue.code).join(', ')}`);
  console.log(`mappingRows = ${draft.attributes.length}（status=draft: ${draft.attributes.filter((row) => row.status === 'draft').length}）`);
  console.log(`fixture     = synthetic=${fixture.meta.synthetic} verified=${fixture.meta.verified} honestyIssues=${honesty.length}`);
  console.log(
    `registry    = ${summary.total} 个操作（api=${summary.byChannel.api} / import=${summary.byChannel.import} / manual=${summary.byChannel.manual}），` +
      `只读=${summary.byRisk.readonly} A=${summary.byRisk.A} B=${summary.byRisk.B} C=${summary.byRisk.C}，未关闭 TODO=${summary.openTodoCount}`,
  );
  console.log(`openTodos   = ${openTodos().map((item) => item.id).join(', ')}`);
  console.log('');
  console.log(`publishable = ${draft.meta.publishable}（契约未核验时必须为 false）`);
  if (draft.meta.publishable) {
    throw new Error('契约未核验却生成了可发布包：门禁失效');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
