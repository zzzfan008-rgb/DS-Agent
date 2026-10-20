/**
 * CSV 生成（RFC 4180 转义 + UTF-8 BOM）。
 *
 * 为什么自己写：上架包与映射表都要导出 CSV，Excel 打开中文需要 BOM；引入 CSV 库
 * 为一个几十行的函数增加依赖不值得。注意：**这不是 1688 的导入模板**，模板列名未核验
 * （`TODO-1688-010`），导出器会在包内显式标注 `templateVerified=false`。
 */

/** 单元格转义：含逗号/引号/换行时用双引号包裹，内部引号翻倍。 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** 生成 CSV 文本；`bom=true` 时加 UTF-8 BOM（Excel 中文识别）。 */
export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[], options: { bom?: boolean } = {}): string {
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) {
    if (row.length !== headers.length) {
      throw new Error(`CSV 行列数不一致：期望 ${headers.length} 列，收到 ${row.length} 列`);
    }
    lines.push(row.map(escapeCsvCell).join(','));
  }
  const text = `${lines.join('\r\n')}\r\n`;
  return options.bom === false ? text : `\uFEFF${text}`;
}
