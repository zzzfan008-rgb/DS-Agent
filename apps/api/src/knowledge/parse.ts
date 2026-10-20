/**
 * 文档解析（docs/09 §4）：md / txt / pdf（纯文本层）→ 统一中间态 sections。
 *
 * 约束：
 * - 不引重型依赖（不装 pdfjs/mammoth/tesseract）；PDF 仅支持文本层，扫描件/复杂 CJK 字体
 *   会得到空文本或乱码，按 `pdf_no_text_layer` 拒绝并提示 OCR（见验收记录限制）。
 * - 清洗只做结构，不改语义：去页码、统一换行/空白、保留段落边界。
 */
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

export const PARSER_VERSION = 'parser@1.0.0';

export type BlockKind = 'heading' | 'paragraph' | 'list' | 'table';

export interface ParsedBlock {
  kind: BlockKind;
  text: string;
  level?: number;
}

export interface ParsedSection {
  /** 标题层级路径（根标题为标题名）；无标题文档为 [title]。 */
  path: string[];
  blocks: ParsedBlock[];
}

export interface ParsedDocument {
  title: string;
  sections: ParsedSection[];
  /** 规范化后的全文（用于 checksum；不含标题路径重复）。 */
  text: string;
  checksum: string;
  parserVersion: string;
  mime: string;
}

export class ParseError extends Error {
  constructor(
    readonly code: 'unsupported_type' | 'empty' | 'pdf_no_text_layer' | 'pdf_encrypted' | 'pdf_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

const PAGE_NUMBER_RE = /^\s*[-—–]?\s*\d{1,4}\s*[-—–]?\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/** 归一化：CRLF→LF、去页码行、行尾空白、连续空行压缩；不改措辞。 */
export function normalizeText(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (PAGE_NUMBER_RE.test(line)) continue;
    kept.push(line.replace(/[ \t]+$/g, ''));
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把连续文本按段落/标题/列表/表格切成 blocks（仅 Markdown 结构；txt 退化为段落）。 */
function markdownSections(title: string, body: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let stack: Array<{ level: number; text: string }> = [];
  let current: ParsedSection = { path: [title], blocks: [] };
  let paragraph: string[] = [];
  let listLines: string[] = [];
  let tableLines: string[] = [];
  let inFence = false;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    current.blocks.push({ kind: 'paragraph', text: paragraph.join('\n').trim() });
    paragraph = [];
  };
  const flushList = (): void => {
    if (listLines.length === 0) return;
    current.blocks.push({ kind: 'list', text: listLines.join('\n').trim() });
    listLines = [];
  };
  const flushTable = (): void => {
    if (tableLines.length === 0) return;
    current.blocks.push({ kind: 'table', text: tableLines.join('\n').trim() });
    tableLines = [];
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const line of body.split('\n')) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      paragraph.push(line);
      continue;
    }
    if (inFence) {
      paragraph.push(line);
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      stack = stack.filter((item) => item.level < level);
      stack.push({ level, text });
      // 新 section 从该标题开始；之前的 section 收尾。
      if (current.blocks.length > 0 || current.path.length > 1) sections.push(current);
      const headingPath = stack
        .map((item) => item.text)
        .filter((text, index) => !(index === 0 && text === title));
      current = { path: [title, ...headingPath].slice(0, 6), blocks: [] };
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    if (TABLE_SEPARATOR_RE.test(line) || (line.includes('|') && line.trim().startsWith('|'))) {
      flushParagraph();
      flushList();
      tableLines.push(line);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushParagraph();
      flushTable();
      listLines.push(line);
      continue;
    }
    flushList();
    flushTable();
    paragraph.push(line);
  }
  flushAll();
  if (current.blocks.length > 0 || sections.length === 0) sections.push(current);

  return sections
    .map((section) => ({
      ...section,
      blocks: section.blocks.filter((block) => block.text.trim().length > 0),
    }))
    .filter((section) => section.blocks.length > 0);
}

function plainSections(title: string, body: string): ParsedSection[] {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map<ParsedBlock>((text) => ({ kind: 'paragraph', text }));
  return paragraphs.length === 0 ? [] : [{ path: [title], blocks: paragraphs }];
}

// ---------------------------------------------------------------------------
// PDF：文本层抽取（最小实现）
// ---------------------------------------------------------------------------

function decodePdfString(raw: string): string {
  let out = '';
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = raw[index + 1];
    if (next === undefined) break;
    index += 1;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === '(' || next === ')' || next === '\\') out += next;
    else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let count = 0; count < 2 && index + 1 < raw.length && /[0-7]/.test(raw[index + 1]!); count += 1) {
        index += 1;
        octal += raw[index]!;
      }
      out += String.fromCharCode(Number.parseInt(octal, 8));
    } else if (next === '\n') {
      // 行续接：忽略
    } else {
      out += next;
    }
  }
  return out;
}

function decodeHexString(raw: string): string {
  const clean = raw.replace(/[^0-9A-Fa-f]/g, '');
  const padded = clean.length % 2 === 0 ? clean : `${clean}0`;
  let out = '';
  for (let index = 0; index < padded.length; index += 2) {
    out += String.fromCharCode(Number.parseInt(padded.slice(index, index + 2), 16));
  }
  return out;
}

function pdfTextOperatorChunks(content: string): string[] {
  const chunks: string[] = [];
  // (literal) Tj / ' / "
  const literalRe = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")/g;
  for (const match of content.matchAll(literalRe)) chunks.push(decodePdfString(match[1]!));
  // [(a) -120 (b)] TJ
  const arrayRe = /\[((?:[^\[\]]|\\.)*)\]\s*TJ/g;
  for (const match of content.matchAll(arrayRe)) {
    let text = '';
    const pieceRe = /\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]+)>|-?\d+(?:\.\d+)?/g;
    for (const piece of match[1]!.matchAll(pieceRe)) {
      if (piece[1] !== undefined) text += decodePdfString(piece[1]);
      else if (piece[2] !== undefined) text += decodeHexString(piece[2]);
      else if (Number.parseFloat(piece[0]) < -120) text += ' ';
    }
    if (text) chunks.push(text);
  }
  return chunks;
}

/** 从 PDF 字节抽取文本层；失败抛 ParseError。 */
export function extractPdfText(buffer: Buffer): string {
  const head = buffer.subarray(0, 4096).toString('latin1');
  if (!head.includes('%PDF-')) throw new ParseError('pdf_invalid', '不是合法 PDF（缺少 %PDF- 头）');
  const whole = buffer.toString('latin1');
  if (whole.includes('/Encrypt')) {
    throw new ParseError('pdf_encrypted', 'PDF 已加密，M7 不支持加密 PDF');
  }

  const chunks: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const match of whole.matchAll(streamRe)) {
    const prefix = whole.slice(Math.max(0, (match.index ?? 0) - 500), match.index ?? 0);
    let data: Buffer;
    try {
      data = /\/FlateDecode/.test(prefix)
        ? inflateSync(Buffer.from(match[1]!, 'latin1'))
        : Buffer.from(match[1]!, 'latin1');
    } catch {
      continue;
    }
    chunks.push(...pdfTextOperatorChunks(data.toString('latin1')));
  }

  const text = normalizeText(chunks.join('\n'));
  if (text.length < 10) {
    throw new ParseError(
      'pdf_no_text_layer',
      'PDF 没有可抽取的文本层（可能是扫描件/字体无 ToUnicode），请先 OCR 后再上传',
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export interface ParseInput {
  title: string;
  fileName: string;
  mime: string | null;
  buffer: Buffer;
}

export function parseDocument(input: ParseInput): ParsedDocument {
  const lowerName = input.fileName.toLowerCase();
  const mime = (input.mime ?? '').toLowerCase();
  let format: 'md' | 'txt' | 'pdf';
  if (mime.includes('pdf') || lowerName.endsWith('.pdf')) format = 'pdf';
  else if (mime.includes('markdown') || lowerName.endsWith('.md') || lowerName.endsWith('.markdown')) format = 'md';
  else if (mime.startsWith('text/') || lowerName.endsWith('.txt')) format = 'txt';
  else {
    throw new ParseError('unsupported_type', '仅支持 md / txt / pdf（文本层）');
  }

  let body: string;
  if (format === 'pdf') body = extractPdfText(input.buffer);
  else body = normalizeText(input.buffer.toString('utf8').replace(/^\uFEFF/, ''));

  if (format === 'md') {
    body = body.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  }
  if (body.trim().length === 0) throw new ParseError('empty', '文档内容为空');

  const sections = format === 'md' ? markdownSections(input.title, body) : plainSections(input.title, body);
  if (sections.length === 0) throw new ParseError('empty', '文档解析后没有可索引内容');

  const plain = sections
    .map((section) => section.blocks.map((block) => block.text).join('\n\n'))
    .join('\n\n')
    .trim();
  return {
    title: input.title,
    sections,
    text: plain,
    checksum: createHash('sha256').update(plain, 'utf8').digest('hex'),
    parserVersion: PARSER_VERSION,
    mime: input.mime ?? (format === 'pdf' ? 'application/pdf' : format === 'md' ? 'text/markdown' : 'text/plain'),
  };
}
