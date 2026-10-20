/**
 * 校验问题结构 —— 对齐 docs/19 §10 的 `{code, field, expected, actual, hint}`。
 *
 * 为什么自己定义而不引 zod / ajv：
 * - 本包只做 1688 侧的**领域校验**，不依赖 HTTP 框架；引入校验库会把「形状」与
 *   「业务规则」混在一起，而 docs/06 §6.4 的阶梯价规则（单调性、区间连续）JSON
 *   Schema 表达不了，必然要写手写校验；
 * - 错误结构必须与 docs/19 §10 一致（`SCHEMA-xxx` / `BIZ-xxx` / `PLAT-xxx`），
 *   才能被 apps/api 的写入门原样透出给前端；
 * - 零依赖便于本包被 worker / api / 脚本同时引用。
 *
 * 约定：`severity='blocker'` 表示禁止生成上架包；`warning` 只提示不阻断。
 */

export type Severity = 'blocker' | 'warning';

export interface ValidationIssue {
  /** 错误码，见各领域模块与 docs/19 §10 的映射（本包用 `BIZ-*` / `PLAT-*` 命名）。 */
  code: string;
  /** 字段路径（内部字段名，非平台字段名）。 */
  field: string;
  /** 期望值的人类可读描述。 */
  expected: string;
  /** 实际值的人类可读描述。 */
  actual: string;
  /** 修复提示（可直接展示给运营）。 */
  hint: string;
  severity: Severity;
}

export interface ValidationResult<T> {
  ok: boolean;
  value: T | null;
  issues: ValidationIssue[];
}

/** 构造阻断级问题。 */
export function blocker(
  code: string,
  field: string,
  expected: string,
  actual: string,
  hint: string,
): ValidationIssue {
  return { code, field, expected, actual, hint, severity: 'blocker' };
}

/** 构造提示级问题。 */
export function warning(
  code: string,
  field: string,
  expected: string,
  actual: string,
  hint: string,
): ValidationIssue {
  return { code, field, expected, actual, hint, severity: 'warning' };
}

/** 安全地把任意值转成短字符串（不抛错、不输出对象内容以外的隐私）。 */
export function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `array(${value.length})`;
  return `object(${Object.keys(value as Record<string, unknown>).slice(0, 6).join(',')})`;
}

export function success<T>(value: T, issues: ValidationIssue[] = []): ValidationResult<T> {
  return { ok: !issues.some((item) => item.severity === 'blocker'), value, issues };
}

export function failure<T>(issues: ValidationIssue[]): ValidationResult<T> {
  const list = issues.length > 0 ? issues : [
    blocker('INTERNAL-EMPTY', '-', '至少一条问题', '0 条', '校验器返回失败但未给出问题，属实现缺陷'),
  ];
  return { ok: false, value: null, issues: list };
}

export function hasBlocker(issues: readonly ValidationIssue[]): boolean {
  return issues.some((item) => item.severity === 'blocker');
}

/** 单行格式化，便于日志与验收文档粘贴。 */
export function formatIssue(issue: ValidationIssue): string {
  return `[${issue.severity}] ${issue.code} @${issue.field} expected=${issue.expected} actual=${issue.actual} — ${issue.hint}`;
}

/** 按 code 去重（同一 SKU 的同类问题只报第一条，避免刷屏）。 */
export function dedupeIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  const result: ValidationIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}|${issue.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(issue);
  }
  return result;
}

/** 非负整数判定（金额分、数量都用它，避免浮点）。 */
export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** 把 `unknown` 记录收敛为可索引对象。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
