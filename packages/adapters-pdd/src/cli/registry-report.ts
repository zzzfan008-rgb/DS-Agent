#!/usr/bin/env node
/**
 * 接口注册表报告：打印统计与「未自动化接口清单」。
 *
 * 用法：
 *   pnpm --filter @dssaas/adapters-pdd registry:report
 *   tsx src/cli/registry-report.ts --json
 */

import { describePddConfig, loadPddConfig, type PddConfigSummary } from '../config.js';
import { pddRegistry } from '../registry/index.js';
import { PDD_SOURCE_DOC } from '../registry/types.js';
import { SIGNATURE_TODO } from '../http/signer.js';

function main(): void {
  const json = process.argv.includes('--json');
  const stats = pddRegistry.stats();
  const rows = pddRegistry.unverifiedReport();
  let configSummary: PddConfigSummary | Record<string, unknown>;
  try {
    configSummary = describePddConfig(loadPddConfig());
  } catch (error) {
    configSummary = { config_error: error instanceof Error ? error.message : String(error) };
  }

  const report = {
    source_doc: PDD_SOURCE_DOC,
    signature_todo: SIGNATURE_TODO,
    config: configSummary,
    stats,
    unverified: rows,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('拼多多接口注册表（M1）');
  console.log(`来源：${PDD_SOURCE_DOC.path} ${PDD_SOURCE_DOC.version}`);
  console.log(`模式：${String(configSummary.mode)}（${String(configSummary.dry_run_reason ?? 'live')}）`);
  console.log(
    `统计：total=${stats.total} verified=${stats.verified} unverified=${stats.unverified} write=${stats.write} read=${stats.read}`,
  );
  console.log(
    `分节：${Object.entries(stats.by_section)
      .map(([section, count]) => `${section}=${count}`)
      .join(' ')}`,
  );
  console.log('');
  console.log('未自动化接口清单（全部未核验；method 留空，禁止编造）：');
  for (const row of rows) {
    console.log(`- [§${row.section}] ${row.key} · ${row.title} · fallback=${row.fallback} · ${row.doc_ref}`);
    console.log(`  ${row.todo}`);
  }
  console.log('');
  console.log(`签名：${SIGNATURE_TODO}`);
}

main();
