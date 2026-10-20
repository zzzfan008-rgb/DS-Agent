/**
 * 最小 XLSX（OOXML）生成器：多工作表 + 表头加粗 + 列宽。
 *
 * 不依赖 exceljs / SheetJS：上架包是低频导出，格式只需要"Excel 能打开、多 sheet、
 * 中文不乱码、数字保持数字"。真正的平台模板（列名/校验）仍待 docs/01 §2.1 核验。
 */

import type { PackageTable, TableRow } from './types.js';
import { createZip, type ZipEntry } from './zip.js';

export interface WorkbookSheet {
  name: string;
  table: PackageTable;
  /** 覆盖默认列宽（字符数）。 */
  columnWidths?: number[];
}

export interface WorkbookOptions {
  sheets: WorkbookSheet[];
  /** `说明` sheet 的文本行（每行一个单元格）。 */
  notes?: string[];
  title?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnLetter(index: number): string {
  let value = index;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function cellXml(reference: string, value: string | number | null, styleIndex?: number): string {
  const style = styleIndex === undefined ? '' : ` s="${styleIndex}"`;
  if (value === null || value === '') return `<c r="${reference}"${style}/>`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}"${style}><v>${value}</v></c>`;
  }
  const text = escapeXml(String(value));
  const preserve = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${reference}"${style} t="inlineStr"><is><t${preserve}>${text}</t></is></c>`;
}

function sheetXml(table: PackageTable, columnWidths?: number[]): string {
  const rowCount = table.rows.length + 1;
  const columnCount = table.columns.length;
  const cols =
    columnCount > 0
      ? `<cols>${Array.from({ length: columnCount }, (_, index) => {
          const width = columnWidths?.[index] ?? 18;
          return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
        }).join('')}</cols>`
      : '';
  const rows: string[] = [];
  const headerCells = table.columns.map((column, index) => cellXml(`${columnLetter(index + 1)}1`, column, 1)).join('');
  rows.push(`<row r="1">${headerCells}</row>`);
  table.rows.forEach((row: TableRow, rowIndex) => {
    const excelRow = rowIndex + 2;
    const cells = table.columns
      .map((column, columnIndex) => cellXml(`${columnLetter(columnIndex + 1)}${excelRow}`, row[column] ?? null))
      .join('');
    rows.push(`<row r="${excelRow}">${cells}</row>`);
  });
  void rowCount;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows.join('')}</sheetData></worksheet>`;
}

function notesSheetXml(notes: string[]): string {
  const rows = notes.map((line, index) => {
    const excelRow = index + 1;
    return `<row r="${excelRow}"><c r="A${excelRow}" t="inlineStr"><is><t>${escapeXml(line)}</t></is></c></row>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="110" customWidth="1"/></cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

const CONTENT_TYPES_HEADER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`;
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${MAIN_NS}">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sanitizeSheetName(name: string, fallback: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, '_').trim().slice(0, 31);
  return cleaned === '' ? fallback : cleaned;
}

export function renderWorkbook(options: WorkbookOptions): Buffer {
  const notes = options.notes ?? [];
  const sheets: WorkbookSheet[] = [];
  if (notes.length > 0) {
    sheets.push({
      name: '说明',
      table: { name: '说明', columns: ['说明'], rows: notes.map((line) => ({ 说明: line })) },
    });
  }
  sheets.push(...options.sheets);

  const usedNames = new Set<string>();
  const normalizedSheets = sheets.map((sheet, index) => {
    let name = sanitizeSheetName(sheet.name, `Sheet${index + 1}`);
    let suffix = 1;
    while (usedNames.has(name)) {
      suffix += 1;
      name = `${sanitizeSheetName(sheet.name, `Sheet${index + 1}`).slice(0, 28)}_${suffix}`;
    }
    usedNames.add(name);
    return { ...sheet, name };
  });

  const contentTypes = [
    `${CONTENT_TYPES_HEADER}<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${normalizedSheets
      .map(
        (_, index) =>
          `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('')}</Types>`,
  ].join('');

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${DOC_REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${MAIN_NS}" xmlns:r="${DOC_REL_NS}"><sheets>${normalizedSheets
    .map((sheet, index) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('')}</sheets></workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS_NS}">${normalizedSheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="${DOC_REL_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join('')}<Relationship Id="rId${normalizedSheets.length + 1}" Type="${DOC_REL_NS}/styles" Target="styles.xml"/></Relationships>`;

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
  ];
  normalizedSheets.forEach((sheet, index) => {
    const xml = sheet.table.columns.length === 1 && sheet.table.columns[0] === '说明' && notes.length > 0
      ? notesSheetXml(notes)
      : sheetXml(sheet.table, sheet.columnWidths);
    entries.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: Buffer.from(xml, 'utf8') });
  });

  return createZip(entries);
}
