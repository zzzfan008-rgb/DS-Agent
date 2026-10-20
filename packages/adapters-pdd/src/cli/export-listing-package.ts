#!/usr/bin/env node
/**
 * 生成一份上架包样例（dry-run 兜底路径）。
 *
 * 用法（在包目录或仓库根均可）：
 *   pnpm --filter @dssaas/adapters-pdd sample:listing
 *   tsx src/cli/export-listing-package.ts --out artifacts/pdd-listing-package-sample
 *
 * 行为：
 * - 读取 .env（若存在）+ 环境变量；缺 PDD 凭据/域名 → dry-run（这是默认状态）；
 * - 读取 examples/sample-product.json（或 --product 指定）；
 * - 校验硬事实 → 写 CSV/XLSX/manifest/import-notes；
 * - 打印不含凭据的 JSON 摘要。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describePddConfig, loadPddConfig, loadPddEnvFiles } from '../config.js';
import { PddError } from '../errors.js';
import {
  buildPddListingPackage,
  PDD_LISTING_PACKAGE_PROFILE,
} from '../listing-package/exporter.js';
import type { ListingProductInput } from '../listing-package/types.js';
import { ListingPackageValidationError } from '../listing-package/validation.js';
import { PACKAGE_ROOT, REPO_ROOT } from '../util/ids.js';

interface CliArgs {
  outDir: string;
  productPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  let outDir = path.join(REPO_ROOT, 'artifacts/pdd-listing-package-sample');
  let productPath = path.join(PACKAGE_ROOT, 'examples/sample-product.json');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out 需要目录参数');
      outDir = path.resolve(value);
      index += 1;
    } else if (arg === '--product') {
      const value = argv[index + 1];
      if (!value) throw new Error('--product 需要 JSON 文件路径');
      productPath = path.resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法：tsx src/cli/export-listing-package.ts [--out <dir>] [--product <sample-product.json>]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return { outDir, productPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadPddEnvFiles([path.join(REPO_ROOT, '.env'), '.env']);
  const config = loadPddConfig();
  const raw = await readFile(args.productPath, 'utf8');
  const product = JSON.parse(raw) as ListingProductInput;
  const result = await buildPddListingPackage(product, { outDir: args.outDir });
  const summary = {
    mode: config.mode,
    dry_run_reason: config.dryRunReason,
    config: describePddConfig(config),
    out_dir: result.out_dir,
    template_profile: PDD_LISTING_PACKAGE_PROFILE.id,
    template_profile_verified: PDD_LISTING_PACKAGE_PROFILE.verified,
    payload_hash: result.manifest.payload_hash,
    row_counts: result.manifest.row_counts,
    files: result.manifest.files.map((file) => `${file.name} (${file.bytes} bytes, sha256=${file.sha256.slice(0, 12)}…)`),
    warnings: result.manifest.warnings.map((issue) => `${issue.code} @ ${issue.field}: ${issue.message}`),
    import_checklist: result.manifest.import_checklist,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error: unknown) => {
  if (error instanceof ListingPackageValidationError) {
    console.error(JSON.stringify({ ok: false, error: 'validation_failed', issues: error.issues }, null, 2));
    process.exit(1);
  }
  if (error instanceof PddError) {
    console.error(JSON.stringify({ ok: false, error: error.toJSON() }, null, 2));
    process.exit(2);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(2);
});
