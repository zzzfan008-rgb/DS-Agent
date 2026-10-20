/**
 * 切片（docs/09 §5）：按标题层级与长度切，保留 section_path、类型、元数据。
 *
 * 参数（docs/09 §5.3 的工程近似）：
 * - 目标 450 字、硬上限 800 字、软下限 80 字；相邻重叠 15%（≤120 字，句子边界对齐）；
 * - 表格/列表按行切，不重叠；文本按句切。
 *
 * 注意：DSH 没有 embedding/vector 能力；本文件只做纯文本切片，不调模型。
 */
import { createHash } from 'node:crypto';
import type { ParsedDocument, ParsedSection } from './parse.js';

export const CHUNK_CONFIG = {
  targetChars: 450,
  hardMinChars: 80,
  hardMaxChars: 800,
  overlapRatio: 0.15,
  overlapMaxChars: 120,
  maxChunksPerDocument: 200,
  maxSectionPath: 6,
} as const;

export interface RawChunk {
  seq: number;
  content: string;
  sectionPath: string[];
  chunkType: 'text' | 'table' | 'list' | 'qa';
  contentHash: string;
  contentTokens: number;
  metadata: Record<string, unknown>;
  /** 用于 embedding 的 header + content（不落库，docs/09 §5.5）。 */
  embeddingInput: string;
}

export interface ChunkContext {
  title: string;
  versionNo: number;
  sourceType: string;
  domain: string;
  sourceRef: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  advisory: boolean;
  parserVersion: string;
}

export class ChunkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkError';
  }
}

function charLength(text: string): number {
  return [...text].length;
}

/** 中文按 1.6 字/token 粗略估算，仅用于排序与空白过滤，不作计费。 */
export function estimateTokens(text: string): number {
  const len = charLength(text);
  return Math.max(1, Math.ceil(len / 1.6));
}

function splitSentences(text: string): string[] {
  const pieces: string[] = [];
  let buffer = '';
  for (const char of text) {
    buffer += char;
    if (/[。！？；!?;\n]/.test(char)) {
      if (buffer.trim()) pieces.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim()) pieces.push(buffer.trim());
  return pieces;
}

function splitByLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hardSplit(text: string, maxChars: number): string[] {
  const chars = [...text];
  const parts: string[] = [];
  for (let index = 0; index < chars.length; index += maxChars) {
    parts.push(chars.slice(index, index + maxChars).join('').trim());
  }
  return parts.filter((part) => part.length > 0);
}

function unitsForBlocks(section: ParsedSection): { units: string[]; kind: RawChunk['chunkType'] } {
  const hasTable = section.blocks.some((block) => block.kind === 'table');
  const hasList = section.blocks.some((block) => block.kind === 'list');
  const texts = section.blocks
    .filter((block) => block.kind !== 'heading')
    .map((block) => ({ kind: block.kind, text: block.text }));
  const all = texts.map((item) => item.text).join('\n\n');
  const qa = /^\s*Q\s*[:：]/m.test(all) && /^\s*A\s*[:：]/m.test(all);
  const kind: RawChunk['chunkType'] = qa ? 'qa' : hasTable ? 'table' : hasList ? 'list' : 'text';

  const units: string[] = [];
  for (const item of texts) {
    if (item.kind === 'table' || item.kind === 'list') {
      // 表格/列表按行切，避免把一行/表头与数据拆开；行本身仍受 hardMax 约束。
      for (const line of splitByLines(item.text)) {
        for (const part of charLength(line) > CHUNK_CONFIG.hardMaxChars
          ? hardSplit(line, CHUNK_CONFIG.hardMaxChars)
          : [line]) {
          units.push(part);
        }
      }
      continue;
    }
    for (const sentence of splitSentences(item.text)) {
      for (const part of charLength(sentence) > CHUNK_CONFIG.hardMaxChars
        ? hardSplit(sentence, CHUNK_CONFIG.hardMaxChars)
        : [sentence]) {
        units.push(part);
      }
    }
  }
  return { units, kind };
}

function overlapTail(chunk: string): string {
  const max = Math.min(CHUNK_CONFIG.overlapMaxChars, Math.floor(charLength(chunk) * CHUNK_CONFIG.overlapRatio));
  if (max < 20) return '';
  const sentences = splitSentences(chunk);
  const tail: string[] = [];
  let size = 0;
  for (let index = sentences.length - 1; index >= 0 && size < max; index -= 1) {
    const sentence = sentences[index]!;
    if (size + charLength(sentence) > max && tail.length > 0) break;
    tail.unshift(sentence);
    size += charLength(sentence);
    if (size >= max * 0.6) break;
  }
  const text = tail.join('');
  return charLength(text) >= 20 ? text : '';
}

/** 把一个 section 切成 chunk 文本。 */
export function chunkSection(section: ParsedSection): Array<{ content: string; chunkType: RawChunk['chunkType'] }> {
  const { units, kind } = unitsForBlocks(section);
  if (units.length === 0) return [];
  const allowOverlap = kind === 'text' || kind === 'qa';
  const result: Array<{ content: string; chunkType: RawChunk['chunkType'] }> = [];
  let current: string[] = [];
  let currentLength = 0;
  let carry = '';

  const flush = (): void => {
    const content = current.join(kind === 'table' || kind === 'list' ? '\n' : '').trim();
    if (content.length === 0) return;
    result.push({ content, chunkType: kind });
    carry = allowOverlap ? overlapTail(content) : '';
    current = [];
    currentLength = 0;
  };

  for (const unit of units) {
    const unitLength = charLength(unit);
    const nextLength = currentLength + unitLength + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && nextLength > CHUNK_CONFIG.hardMaxChars) {
      flush();
      if (carry) {
        current.push(carry);
        currentLength = charLength(carry);
      }
    }
    current.push(unit);
    currentLength = currentLength + unitLength + (current.length > 1 ? 1 : 0);
    if (currentLength >= CHUNK_CONFIG.targetChars && nextLength >= CHUNK_CONFIG.hardMinChars) {
      flush();
    }
  }
  if (currentLength > 0) flush();
  return result;
}

/** 整篇文档切片 + 元数据（不写库）。 */
export function chunkDocument(document: ParsedDocument, context: ChunkContext): RawChunk[] {
  const chunks: RawChunk[] = [];
  const seenHashes = new Set<string>();
  let seq = 0;

  for (const section of document.sections) {
    for (const piece of chunkSection(section)) {
      const content = piece.content.trim();
      if (content.length === 0) continue;
      const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
      if (seenHashes.has(contentHash)) continue;
      seenHashes.add(contentHash);
      const sectionPath = section.path.slice(0, CHUNK_CONFIG.maxSectionPath);
      const header = `[《${context.title}》 v${context.versionNo} · ${sectionPath.join(' > ')}]`;
      chunks.push({
        seq,
        content,
        sectionPath,
        chunkType: piece.chunkType,
        contentHash,
        contentTokens: estimateTokens(content),
        metadata: {
          source_type: context.sourceType,
          domain: context.domain,
          source_ref: context.sourceRef,
          section_path: sectionPath,
          effective_from: context.effectiveFrom.toISOString(),
          effective_to: context.effectiveTo?.toISOString() ?? null,
          lang: 'zh-CN',
          parser_version: context.parserVersion,
          advisory: context.advisory,
        },
        embeddingInput: `${header}\n${content}`,
      });
      seq += 1;
      if (chunks.length > CHUNK_CONFIG.maxChunksPerDocument) {
        throw new ChunkError(
          `文档切片超过上限 ${CHUNK_CONFIG.maxChunksPerDocument}（请拆分文档后再上传）`,
        );
      }
    }
  }

  return chunks.map((chunk) => ({ ...chunk, seq: chunk.seq }));
}
