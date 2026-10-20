/**
 * 零依赖 CSV 渲染（RFC 4180 + UTF-8 BOM，便于 Excel 直接打开中文）。
 * 只渲染注册过的列，避免对象里多余字段泄漏到导入包。
 */

import type { PackageTable } from './types.js';

function escapeCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text) || /^\s|\s$/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export interface CsvOptions {
  /** Excel 兼容 BOM；默认 true。 */
  bom?: boolean;
  /** 行分隔符；默认 CRLF（RFC 4180）。 */
  newline?: string;
}

export function renderCsv(table: PackageTable, options: CsvOptions = {}): string {
  const newline = options.newline ?? '\r\n';
  const lines = [table.columns.map(escapeCell).join(',')];
  for (const row of table.rows) {
    lines.push(table.columns.map((column) => escapeCell(row[column])).join(','));
  }
  const text = `${lines.join(newline)}${newline}`;
  return options.bom === false ? text : `\uFEFF${text}`;
}
