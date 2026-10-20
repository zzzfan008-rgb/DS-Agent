/**
 * QA 静态规则引擎 —— docs/21《接口契约裁决》§11.3 + docs/15《测试与质量门策略》§10。
 *
 * 设计原则：
 * 1) 零依赖：只用 Node 内置模块，CI 只需 pnpm install 后即可运行；
 * 2) 只读：本脚本不修改任何业务文件；
 * 3) 可测：规则与文件遍历解耦，单元测试可用临时目录构造样本；
 * 4) 明确豁免：docs/（裁决原文本身包含废止词）、scripts/qa/（规则实现与测试样本）、
 *    packages/db/（允许 SQL/迁移，但契约字段命名规则仍会扫描 schema 与 migration）。
 *
 * 规则清单（contracts 集对应 docs/21 §11.3）：
 *   CT-01 _micro_cny 已废止（docs/21 §1）
 *   CT-02 model_route 仍用 scope_value / scope_ref 通用键（docs/21 §5）
 *   CT-03 judgment 判定值出现 revise / block（docs/21 §3）
 *   CT-05 workflow_run / listing 旧状态字段名或非法 workflow state（docs/21 §2）
 *   CT-04（边界）业务代码读 DSH .jsonl / 存储根 → 由 BD-01/02/03 承担
 *
 * boundaries 集对应 docs/15 §10：
 *   BD-01 业务代码引用 .jsonl
 *   BD-02 业务代码访问 DSH 存储根 / 凭据文件
 *   BD-03 业务代码 import DSH storage-json
 *   BD-04 除 packages/db 外 import @prisma/client
 *   BD-05 除 packages/db/tests 外出现 .sql
 *   BD-06 业务依赖出现浏览器自动化（playwright/puppeteer/selenium）
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const RULES = {
  'CT-01': {
    title: '金额字段使用 _micro_cny（docs/21 §1：一律整数分 *_cents）',
    doc: 'docs/21 §1',
  },
  'CT-02': {
    title: 'model_route 使用 scope_value / scope_ref 通用键（docs/21 §5：必须拆列为 scope_type + scope_role_id + scope_user_id）',
    doc: 'docs/21 §5',
  },
  'CT-03': {
    title: 'judgment 判定值出现 revise / block（docs/21 §3：词表为 pass|needs_revision|reject|escalate）',
    doc: 'docs/21 §3',
  },
  'CT-05': {
    title: 'workflow_run / listing 旧状态字段名或非法 workflow state（docs/21 §2）',
    doc: 'docs/21 §2',
  },
  'BD-01': {
    title: '业务代码引用 .jsonl（docs/00 §19.1、docs/15 §10 S1）',
    doc: 'docs/15 §10 S1',
  },
  'BD-02': {
    title: '业务代码访问 DSH 存储根 / 凭据文件（docs/15 §10 S2）',
    doc: 'docs/15 §10 S2',
  },
  'BD-03': {
    title: '业务代码 import DSH storage-json（docs/15 §10 S3）',
    doc: 'docs/15 §10 S3',
  },
  'BD-04': {
    title: 'packages/db 之外 import @prisma/client（docs/15 §10 S4）',
    doc: 'docs/15 §10 S4',
  },
  'BD-05': {
    title: 'packages/db 之外出现 .sql（docs/15 §10 S5）',
    doc: 'docs/15 §10 S5',
  },
  'BD-06': {
    title: '业务依赖出现浏览器自动化（docs/15 §10 S6）',
    doc: 'docs/15 §10 S6',
  },
};

export const RULE_SETS = {
  contracts: ['CT-01', 'CT-02', 'CT-03', 'CT-05', 'BD-01', 'BD-02', 'BD-03'],
  boundaries: ['BD-01', 'BD-02', 'BD-03', 'BD-04', 'BD-05', 'BD-06'],
  all: ['CT-01', 'CT-02', 'CT-03', 'CT-05', 'BD-01', 'BD-02', 'BD-03', 'BD-04', 'BD-05', 'BD-06'],
};

/** workflow_run.state 唯一词表（docs/21 §2）。 */
const WORKFLOW_STATES = new Set([
  'pending',
  'running',
  'waiting_human',
  'succeeded',
  'failed_retryable',
  'failed_permanent',
  'cancelled',
]);

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.agent-teams',
  'docs',
  'artifacts',
  'coverage',
  'dist',
  'build',
  'out',
  '.next',
  '.pnpm-store',
  '.turbo',
  '.tmp',
  'tmp',
]);
const SKIP_DIR_PREFIXES = ['.tmp-', 'tmp-', '.dsh-ops-'];
const SKIP_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);

const CONTRACT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.prisma', '.sql', '.yml', '.yaml', '.toml', '.sh', '.ps1',
]);

const BOUNDARY_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.toml', '.sh',
]);

/** 业务代码目录：docs/15 §10 的扫描范围（apps + 除 db 外的业务 packages）。 */
const BUSINESS_DIRS = [
  'apps',
  'packages/core',
  'packages/registry',
  'packages/adapters-pdd',
  'packages/adapters-1688',
  'packages/judge-rules',
  'packages/edge-proxy',
  'packages/mcp-erp',
  'packages/mcp-knowledge',
];

const TEST_PATH_RE = /(^|\/)(__tests__|tests?|fixtures|mocks)\//;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function isTestPath(rel) {
  return TEST_PATH_RE.test(rel) || TEST_FILE_RE.test(rel);
}

function extOf(rel) {
  return path.extname(rel).toLowerCase();
}

function shouldSkipDir(name) {
  return SKIP_DIRS.has(name) || SKIP_DIR_PREFIXES.some((p) => name.startsWith(p));
}

function shouldSkipFile(rel) {
  const base = path.posix.basename(rel);
  return SKIP_FILES.has(base) || base.startsWith('.dsh-ops-');
}

/**
 * 遍历目录，返回相对 root 的 POSIX 路径。
 * @param {string} root 绝对路径
 * @param {(rel:string)=>boolean} include
 */
async function walkDir(root, include, relDir = '', out = []) {
  const absDir = relDir ? path.join(root, relDir) : root;
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      await walkDir(root, include, rel, out);
    } else if (entry.isFile()) {
      if (shouldSkipFile(rel)) continue;
      if (include(rel)) out.push(rel);
    }
  }
  return out;
}

async function readText(root, rel) {
  const abs = path.join(root, rel);
  try {
    const info = await stat(abs);
    if (info.size > 2 * 1024 * 1024) return null;
    const buf = await readFile(abs);
    // 跳过二进制文件（前 4KB 出现 NUL 视为二进制）
    if (buf.subarray(0, 4096).includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

const newlineCount = (s) => (s.match(/\n/g) || []).length;

/**
 * 去掉注释但保留行号（块注释替换为等量换行）。
 * 目的：业务代码里“禁止 .jsonl”的说明性注释不应触发边界规则；
 * 而字符串字面量、import、配置键仍会被检出。
 */
export function stripComments(src, ext) {
  // 用空格覆盖注释字符但保留换行，使 stripped 与原始 src 的字符偏移完全一致；
  // 这样后续 line/column/excerpt 仍能准确指回原文件。
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, blank)
      .replace(/(^|[^:\\])\/\/[^\n]*/gm, (m, prefix) => prefix + ' '.repeat(m.length - prefix.length));
  }
  if (ext === '.sql') return src.replace(/--[^\n]*/g, blank);
  if (['.yml', '.yaml', '.toml', '.sh', '.ps1'].includes(ext)) {
    return src.replace(/(^|\s)#[^\n]*/gm, (m, prefix) => prefix + ' '.repeat(m.length - prefix.length));
  }
  return src;
}

function lineColOf(src, index) {
  const before = src.slice(0, index);
  const line = newlineCount(before) + 1;
  const lastNl = before.lastIndexOf('\n');
  return { line, column: index - lastNl };
}

function excerptOf(src, index) {
  const start = src.lastIndexOf('\n', index) + 1;
  let end = src.indexOf('\n', index);
  if (end === -1) end = src.length;
  return src.slice(start, end).trim().slice(0, 200);
}

function addViolation(list, rule, file, src, index, message) {
  const { line, column } = lineColOf(src, index);
  list.push({
    rule,
    title: RULES[rule]?.title ?? rule,
    doc: RULES[rule]?.doc ?? '',
    file,
    line,
    column,
    excerpt: excerptOf(src, index),
    message,
  });
}

/* ------------------------------------------------------------------ */
/* 结构提取：Prisma model / enum，SQL CREATE TABLE / CREATE TYPE       */
/* ------------------------------------------------------------------ */

function prismaBlocks(src) {
  const blocks = [];
  const re = /\b(model|enum)\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const bodyStart = m.index + m[0].indexOf('{') + 1;
    blocks.push({ kind: m[1], name: m[2], body: m[3], bodyStart });
  }
  return blocks;
}

function sqlBlocks(src) {
  const tables = [];
  const types = [];
  let m;
  const reTable = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+"?(\w+)"?\s*\(([\s\S]*?)\n\);/g;
  while ((m = reTable.exec(src)) !== null) {
    tables.push({ name: m[1], body: m[2], bodyStart: m.index + m[0].indexOf('(') + 1 });
  }
  const reType = /CREATE\s+TYPE\s+"?(\w+)"?\s+AS\s+ENUM\s*\(([\s\S]*?)\);/g;
  while ((m = reType.exec(src)) !== null) {
    types.push({ name: m[1], body: m[2], bodyStart: m.index + m[0].indexOf('(') + 1 });
  }
  return { tables, types };
}

/** 从 Prisma 字段行里取字段名、@map 名、默认值。 */
function parsePrismaFieldLine(line) {
  const field = line.match(/^\s*(\w+)\s+([A-Za-z_][\w.\[\]?]*)/);
  if (!field) return null;
  const mapMatch = line.match(/@map\("([^"]+)"\)/);
  const defaultMatch = line.match(/@default\("([^"]*)"\)/);
  return {
    name: field[1],
    type: field[2],
    mapped: mapMatch?.[1] ?? null,
    defaultValue: defaultMatch?.[1] ?? null,
    isRelation: /@relation\b/.test(line),
  };
}

/** 从 SQL 列定义行里取列名与 DEFAULT 值。 */
function parseSqlColumnLine(line) {
  const col = line.match(/^\s*"?(\w+)"?\s+([A-Za-z_"][\w."() ]*)/);
  if (!col) return null;
  const defaultMatch = line.match(/DEFAULT\s+'([^']*)'/i);
  return { name: col[1], type: col[2].trim(), defaultValue: defaultMatch?.[1] ?? null };
}

/* ------------------------------------------------------------------ */
/* CT 规则                                                             */
/* ------------------------------------------------------------------ */

function checkCt01(list, file, src) {
  // 注意：字段名常为 price_micro_cny，下划线属于 \w，\bmicro_cny 不会命中；
  // 这里只需要右侧词边界，避免误伤 micro_cny_extra 之类命名。
  const re = /micro_cny\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    addViolation(
      list,
      'CT-01',
      file,
      src,
      m.index,
      '金额一律整数分（字段后缀 _cents），_micro_cny 已废止；模型价格用嵌套 *_per_1k_cents / per_image_cents / per_second_cents。',
    );
  }
}

function checkCt02(list, file, src, ext) {
  // 2a) 直接出现 scope_value（任何契约相关文件）
  const re = /\bscope_value\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    addViolation(
      list,
      'CT-02',
      file,
      src,
      m.index,
      'scope_value 已废止：model_route 必须拆列为 scope_type(org|role|user) + scope_role_id + scope_user_id。',
    );
  }

  // 2b) 旧通用键 scope / scope_ref 仍在 model_route 上（换名规避同样违反 §5）
  if (ext === '.prisma') {
    for (const block of prismaBlocks(src)) {
      const isModelRoute =
        block.kind === 'model' &&
        (block.name === 'ModelRoute' || /@@map\("model_route"\)/.test(block.body));
      if (!isModelRoute) continue;
      let offset = block.bodyStart;
      for (const line of block.body.split('\n')) {
        const f = parsePrismaFieldLine(line);
        if (f && !f.isRelation) {
          const names = new Set([f.name, f.mapped].filter(Boolean));
          const hit = ['scope', 'scope_ref', 'scope_value', 'scopeRef', 'scopeValue'].find((n) => names.has(n));
          if (hit) {
            addViolation(
              list,
              'CT-02',
              file,
              src,
              offset + Math.max(0, line.indexOf(hit)),
              `model_route 出现旧通用作用域字段 ${hit}；请改为 scope_type + scope_role_id + scope_user_id，并加 CHECK 约束（docs/21 §5）。`,
            );
          }
        }
        offset += line.length + 1;
      }
    }
  }

  if (ext === '.sql') {
    const { tables } = sqlBlocks(src);
    for (const table of tables) {
      if (table.name !== 'model_route') continue;
      let offset = table.bodyStart;
      for (const line of table.body.split('\n')) {
        const col = parseSqlColumnLine(line);
        if (col && ['scope', 'scope_ref', 'scope_value', 'scopeRef', 'scopeValue'].includes(col.name)) {
          addViolation(
            list,
            'CT-02',
            file,
            src,
            offset + Math.max(0, line.indexOf(col.name)),
            `model_route 出现旧通用作用域列 ${col.name}；请改为 scope_type + scope_role_id + scope_user_id，并加 CHECK 约束（docs/21 §5）。`,
          );
        }
        offset += line.length + 1;
      }
    }
  }
}

const VERDICT_CONTEXT_RE = /\b(verdict|judgment|judged|judge_rules?|判定|裁决)\b/i;
const FORBIDDEN_VERDICT_RE = /\b(revise|block)\b/g;

function pushVerdictViolation(list, file, src, index, token) {
  addViolation(
    list,
    'CT-03',
    file,
    src,
    index,
    `judgment 判定值出现 ${token}；唯一词表为 pass | needs_revision | reject | escalate（docs/21 §3）。`,
  );
}

function checkCt03(list, file, src, ext) {
  const seen = new Set();
  const report = (index, token) => {
    const { line } = lineColOf(src, index);
    const key = `${line}:${token}`;
    if (seen.has(key)) return;
    seen.add(key);
    pushVerdictViolation(list, file, src, index, token);
  };

  // 3a) 枚举块内部（Prisma enum / SQL CREATE TYPE）：块名含 Verdict 或 Judgment
  const enumBlocks = [];
  if (ext === '.prisma') {
    for (const b of prismaBlocks(src)) {
      if (b.kind === 'enum' && /Verdict|Judgment/i.test(b.name)) enumBlocks.push(b);
    }
  } else if (ext === '.sql') {
    for (const t of sqlBlocks(src).types) {
      if (/Verdict|Judgment/i.test(t.name)) enumBlocks.push({ body: t.body, bodyStart: t.bodyStart });
    }
  }
  for (const block of enumBlocks) {
    const re = new RegExp(FORBIDDEN_VERDICT_RE.source, 'g');
    let m;
    while ((m = re.exec(block.body)) !== null) {
      const token = m[1];
      // block 只在词边界命中，blocker / blocked / rollback 不会误报
      report(block.bodyStart + m.index, token);
    }
  }

  // 3b) 代码 / 配置里 verdict 附近出现 revise / block（含对象字面量与注释外的字符串）
  const stripped = stripComments(src, ext);
  const lines = stripped.split('\n');
  const re = new RegExp(FORBIDDEN_VERDICT_RE.source, 'g');
  let lineOffset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      const from = Math.max(0, i - 2);
      const to = Math.min(lines.length - 1, i + 2);
      const context = lines.slice(from, to + 1).join('\n');
      if (VERDICT_CONTEXT_RE.test(context)) {
        report(lineOffset + m.index, m[1]);
      }
    }
    lineOffset += line.length + 1;
  }
}

function checkCt05(list, file, src, ext) {
  if (ext === '.prisma') {
    for (const block of prismaBlocks(src)) {
      if (block.kind !== 'model') continue;
      const isWorkflowRun = block.name === 'WorkflowRun' || /@@map\("workflow_run"\)/.test(block.body);
      const isListing = block.name === 'Listing' || /@@map\("listing"\)/.test(block.body);
      if (!isWorkflowRun && !isListing) continue;

      let hasState = false;
      let hasStatus = false;
      let offset = block.bodyStart;
      for (const line of block.body.split('\n')) {
        const f = parsePrismaFieldLine(line);
        if (f && !f.isRelation) {
          const names = new Set([f.name, f.mapped].filter(Boolean));
          if (isWorkflowRun) {
            if (names.has('state')) hasState = true;
            for (const old of ['status', 'phase']) {
              if (names.has(old)) {
                addViolation(
                  list,
                  'CT-05',
                  file,
                  src,
                  offset + Math.max(0, line.indexOf(old)),
                  `workflow_run 使用旧状态字段 ${old}；docs/21 §2 规定状态唯一真相是 state，子步骤用 stage。`,
                );
              }
            }
            if (f.name === 'state' && f.defaultValue !== null && !WORKFLOW_STATES.has(f.defaultValue)) {
              addViolation(
                list,
                'CT-05',
                file,
                src,
                offset + Math.max(0, line.indexOf('state')),
                `workflow_run.state 默认值 "${f.defaultValue}" 不在唯一词表内（pending|running|waiting_human|succeeded|failed_retryable|failed_permanent|cancelled）。`,
              );
            }
          } else {
            if (names.has('status')) hasStatus = true;
            for (const old of ['state', 'level']) {
              if (names.has(old)) {
                addViolation(
                  list,
                  'CT-05',
                  file,
                  src,
                  offset + Math.max(0, line.indexOf(old)),
                  `listing 使用旧字段 ${old}；docs/21 §2 规定 listing 用 status（业务态）+ platform_state（平台原始态），级别放 approval.level。`,
                );
              }
            }
          }
        }
        offset += line.length + 1;
      }
      if (isWorkflowRun && !hasState) {
        addViolation(
          list,
          'CT-05',
          file,
          src,
          block.bodyStart,
          'workflow_run 缺少 state 字段；docs/21 §2 规定 workflow_run.state 是状态机唯一真相。',
        );
      }
      if (isListing && !hasStatus) {
        addViolation(
          list,
          'CT-05',
          file,
          src,
          block.bodyStart,
          'listing 缺少 status 字段；docs/21 §2 规定 listing.status 为业务态。',
        );
      }
    }
  }

  if (ext === '.sql') {
    const { tables } = sqlBlocks(src);
    for (const table of tables) {
      const isWorkflowRun = table.name === 'workflow_run';
      const isListing = table.name === 'listing';
      if (!isWorkflowRun && !isListing) continue;
      let offset = table.bodyStart;
      for (const line of table.body.split('\n')) {
        const col = parseSqlColumnLine(line);
        if (col) {
          if (isWorkflowRun) {
            for (const old of ['status', 'phase']) {
              if (col.name === old) {
                addViolation(
                  list,
                  'CT-05',
                  file,
                  src,
                  offset + Math.max(0, line.indexOf(col.name)),
                  `workflow_run 使用旧状态列 ${old}；docs/21 §2 规定状态唯一真相是 state，子步骤用 stage。`,
                );
              }
            }
            if (col.name === 'state') {
              if (/WorkflowState/i.test(col.type)) {
                addViolation(
                  list,
                  'CT-05',
                  file,
                  src,
                  offset + Math.max(0, line.indexOf('state')),
                  'workflow_run.state 仍使用旧枚举 WorkflowState；docs/21 §2 已给出唯一词表，应改为 String + CHECK。',
                );
              }
              if (col.defaultValue !== null && !WORKFLOW_STATES.has(col.defaultValue)) {
                addViolation(
                  list,
                  'CT-05',
                  file,
                  src,
                  offset + Math.max(0, line.indexOf('state')),
                  `workflow_run.state 默认值 '${col.defaultValue}' 不在唯一词表内（pending|running|waiting_human|succeeded|failed_retryable|failed_permanent|cancelled）。`,
                );
              }
            }
          } else {
            for (const old of ['state', 'level']) {
              if (col.name === old) {
                addViolation(
                  list,
                  'CT-05',
                  file,
                  src,
                  offset + Math.max(0, line.indexOf(col.name)),
                  `listing 使用旧列 ${old}；docs/21 §2 规定 listing 用 status + platform_state，级别放 approval.level。`,
                );
              }
            }
          }
        }
        offset += line.length + 1;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* BD 规则（business 范围）                                            */
/* ------------------------------------------------------------------ */

const DSH_ROOT_RE = /\bdsh-data\b|\bDSH_HOME\b|\.credentials\.yaml|\bdsh-storage(?!-json)\b/;
const JSONL_RE = /\.jsonl\b/;
const STORAGE_JSON_IMPORT_RE = /@deepseek-ai\/dsh-storage-json/;
const PRISMA_IMPORT_RE = /(?:from\s+|require\()\s*['"]@prisma\/client['"]/;
const BROWSER_AUTOMATION_RE = /^(playwright|@playwright\/test|puppeteer|puppeteer-core|selenium|selenium-webdriver)$/;

function scanBoundaryFile(list, file, src, ext) {
  const code = stripComments(src, ext);
  for (const [rule, regex, message] of [
    ['BD-01', JSONL_RE, '业务代码禁止引用 .jsonl：业务状态只进 Postgres（docs/00 §19.1）。'],
    ['BD-02', DSH_ROOT_RE, '业务代码禁止访问 DSH 存储根 / 凭据文件（dsh-data、DSH_HOME、.credentials.yaml、dsh-storage）。'],
    ['BD-03', STORAGE_JSON_IMPORT_RE, '业务代码禁止 import DSH storage-json：业务状态只进 Postgres。'],
    ['BD-04', PRISMA_IMPORT_RE, '只有 packages/db 可以 import @prisma/client；业务读路径必须经 repository。'],
  ]) {
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
    let m;
    while ((m = re.exec(code)) !== null) {
      addViolation(list, rule, file, src, m.index, message);
    }
  }
}

function collectBusinessFiles(root) {
  return (async () => {
    const files = [];
    for (const dir of BUSINESS_DIRS) {
      const found = await walkDir(root, (rel) => BOUNDARY_EXTS.has(extOf(rel)) && !isTestPath(rel), dir);
      files.push(...found);
    }
    return [...new Set(files)].sort();
  })();
}

async function collectContractFiles(root) {
  return walkDir(
    root,
    (rel) => {
      if (rel.startsWith('scripts/qa/')) return false;
      if (rel.startsWith('docs/')) return false;
      if (!CONTRACT_EXTS.has(extOf(rel))) return false;
      if (/\.env(\.|$)/.test(path.posix.basename(rel))) return false;
      return true;
    },
    '',
  );
}

async function collectPackageManifests(root) {
  const files = [];
  for (const dir of BUSINESS_DIRS) {
    const found = await walkDir(root, (rel) => path.posix.basename(rel) === 'package.json', dir);
    files.push(...found);
  }
  return [...new Set(files)].sort();
}

async function collectAllSqlFiles(root) {
  return walkDir(root, (rel) => extOf(rel) === '.sql', '');
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {string} [options.root] 仓库根目录（默认本仓库）
 * @param {string[]} [options.ruleSets] contracts|boundaries|all 的组合，默认 all
 * @returns {Promise<{ok:boolean, scanned:object, violations:Array}>}
 */
export async function runStaticCheck(options = {}) {
  const root = path.resolve(options.root ?? REPO_ROOT);
  const sets = options.ruleSets?.length ? options.ruleSets : ['all'];
  const enabled = new Set();
  for (const set of sets) {
    for (const rule of RULE_SETS[set] ?? []) enabled.add(rule);
  }
  const has = (rule) => enabled.has(rule);

  const violations = [];
  const needContractFiles = ['CT-01', 'CT-02', 'CT-03', 'CT-05'].some(has);
  const needBusinessFiles = ['BD-01', 'BD-02', 'BD-03', 'BD-04'].some(has);

  const [contractFiles, businessFiles, allSqlFiles, manifests] = await Promise.all([
    needContractFiles ? collectContractFiles(root) : [],
    needBusinessFiles ? collectBusinessFiles(root) : [],
    has('BD-05') ? collectAllSqlFiles(root) : [],
    has('BD-06') ? collectPackageManifests(root) : [],
  ]);

  // CT：契约文件（schema/migration/代码/配置）
  if (needContractFiles) {
    for (const file of contractFiles) {
      const src = await readText(root, file);
      if (src === null) continue;
      const ext = extOf(file);
      if (has('CT-01')) checkCt01(violations, file, src);
      if (has('CT-02')) checkCt02(violations, file, src, ext);
      if (has('CT-03')) checkCt03(violations, file, src, ext);
      if (has('CT-05') && (ext === '.prisma' || ext === '.sql')) checkCt05(violations, file, src, ext);
    }
  }

  // BD-01..04：业务代码（注释已剥离）
  if (needBusinessFiles) {
    for (const file of businessFiles) {
      const src = await readText(root, file);
      if (src === null) continue;
      scanBoundaryFile(violations, file, src, extOf(file));
    }
  }

  // BD-05：packages/db 之外不得出现 .sql（tests/ 与 scripts/qa/ 豁免）
  if (has('BD-05')) {
    for (const file of allSqlFiles) {
      const allowed =
        file.startsWith('packages/db/') ||
        file.startsWith('tests/') ||
        file.startsWith('scripts/qa/');
      if (!allowed) {
        violations.push({
          rule: 'BD-05',
          title: RULES['BD-05'].title,
          doc: RULES['BD-05'].doc,
          file,
          line: 1,
          column: 1,
          excerpt: file,
          message: '只有 packages/db 包含 SQL/迁移；业务 SQL 会绕过 repository 与迁移管理（docs/15 §10 S5）。',
        });
      }
    }
  }

  // BD-06：业务依赖不得出现浏览器自动化
  if (has('BD-06')) {
    for (const file of manifests) {
      const src = await readText(root, file);
      if (src === null) continue;
      let pkg;
      try {
        pkg = JSON.parse(src);
      } catch {
        continue;
      }
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const name of Object.keys(deps)) {
        if (BROWSER_AUTOMATION_RE.test(name)) {
          const index = src.indexOf(`"${name}"`) === -1 ? 0 : src.indexOf(`"${name}"`);
          addViolation(
            violations,
            'BD-06',
            file,
            src,
            index,
            `依赖 ${name} 属浏览器自动化；方案明确不做 DOM 注入/按键模拟（docs/00 §2、docs/15 §10 S6）。`,
          );
        }
      }
    }
  }

  violations.sort((a, b) =>
    a.file === b.file ? a.line - b.line || a.rule.localeCompare(b.rule) : a.file.localeCompare(b.file),
  );

  return {
    ok: violations.length === 0,
    scanned: {
      contractFiles: contractFiles.length,
      businessFiles: businessFiles.length,
      sqlFiles: allSqlFiles.length,
      manifests: manifests.length,
    },
    ruleSets: sets,
    enabledRules: [...enabled].sort(),
    violations,
  };
}
