#!/usr/bin/env node
/**
 * QA 静态门禁 CLI。
 *
 * 用法：
 *   node scripts/qa/static-check.mjs                 # 全量（contracts + boundaries）
 *   node scripts/qa/static-check.mjs --contracts     # 只跑 docs/21 §11.3 契约检查
 *   node scripts/qa/static-check.mjs --boundaries    # 只跑 docs/15 §10 边界检查
 *   node scripts/qa/static-check.mjs --json          # 机器可读输出（CI 归档用）
 *   node scripts/qa/static-check.mjs --root <dir>    # 指定仓库根（测试/复用）
 *
 * 退出码：0 通过；1 有违规；2 参数或运行错误。
 */

import path from 'node:path';
import { runStaticCheck, REPO_ROOT, RULES } from './lib/static-rules.mjs';

function usage() {
  console.log(`QA 静态门禁（docs/21 §11.3 + docs/15 §10）

用法：node scripts/qa/static-check.mjs [选项]

选项：
  --contracts        只检查接口契约（docs/21 §11.3）
  --boundaries       只检查存储/依赖边界（docs/15 §10）
  --all              两者都查（默认）
  --root <dir>       指定仓库根目录（默认 ${REPO_ROOT}）
  --json             输出 JSON（适合 CI artifact）
  --quiet            只输出违规与结论
  -h, --help         显示本帮助

规则：
${Object.entries(RULES)
  .map(([id, r]) => `  ${id}  ${r.title}`)
  .join('\n')}
`);
}

function parseArgs(argv) {
  const opts = { sets: [], json: false, quiet: false, root: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue; // pnpm/npm 把 -- 原样传给脚本
    if (arg === '--contracts') opts.sets.push('contracts');
    else if (arg === '--boundaries') opts.sets.push('boundaries');
    else if (arg === '--all') opts.sets.push('all');
    else if (arg === '--json') opts.json = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--root') {
      const value = argv[i + 1];
      if (!value) throw new Error('--root 缺少参数');
      opts.root = path.resolve(value);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (opts.sets.length === 0) opts.sets = ['all'];
  if (opts.sets.includes('all')) opts.sets = ['all'];
  return opts;
}

function formatHuman(result, { quiet }) {
  const lines = [];
  if (!quiet) {
    lines.push('QA 静态门禁 · docs/21 §11.3 + docs/15 §10');
    lines.push(
      `扫描范围：contracts ${result.scanned.contractFiles} 文件 · business ${result.scanned.businessFiles} 文件 · sql ${result.scanned.sqlFiles} 文件 · package.json ${result.scanned.manifests} 个`,
    );
    lines.push(`启用规则：${result.enabledRules.join(' ')}`);
    lines.push('');
  }

  if (result.violations.length === 0) {
    lines.push('✔ 通过：0 处违规');
    return lines.join('\n');
  }

  const byRule = new Map();
  for (const v of result.violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v);
  }
  for (const [rule, items] of [...byRule.entries()].sort()) {
    lines.push(`✖ [${rule}] ${items[0].title}  （${items.length} 处，依据 ${items[0].doc}）`);
    for (const v of items) {
      lines.push(`    ${v.file}:${v.line}:${v.column}`);
      lines.push(`      ${v.message}`);
      if (v.excerpt) lines.push(`      > ${v.excerpt}`);
    }
    lines.push('');
  }
  lines.push(`结论：${result.violations.length} 处违规，CI 必须失败。`);
  lines.push('修复口径见 docs/21-接口契约裁决.md 与 docs/15-测试与质量门策略.md §10。');
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return 0;
  }

  const result = await runStaticCheck({ root: opts.root, ruleSets: opts.sets });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatHuman(result, opts));
  }
  return result.ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[static-check] 运行失败：${error.stack ?? error.message}`);
    process.exit(2);
  });
