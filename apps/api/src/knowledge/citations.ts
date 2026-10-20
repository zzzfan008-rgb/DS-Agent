/**
 * 引用结构（docs/09 §10 CitationV1）与 quote 选取。
 *
 * 硬规则：quote 必须是 `kb_chunk.content` 的连续子串；服务端校验，失败即作废该引用。
 */
import type { SearchHit } from './service.js';

export interface Citation {
  doc_id: string;
  chunk_id: string;
  doc_version: number;
  quote: string;
  effective_from: string | null;
  title: string;
  source_type: string;
  section_path: string[];
  score: number;
  uri: string | null;
}

const SENTENCE_END = new Set(['。', '！', '？', '；', '!', '?', ';', '\n']);

/** 在 content 中取命中窗口（≤200 字，句边界对齐，连续子串）。 */
export function pickQuote(content: string, query: string, maxLength = 200): string {
  const chars = [...content];
  if (chars.length <= maxLength) return content;
  const candidates = [
    query.trim(),
    ...query
      .toLowerCase()
      .split(/[\s,，。；;、]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2),
  ].filter((item) => item.length > 0);

  let index = -1;
  for (const candidate of candidates) {
    const found = content.indexOf(candidate);
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) index = 0;

  let start = index;
  const floor = Math.max(0, index - 60);
  while (start > floor && !SENTENCE_END.has(chars[start - 1]!)) start -= 1;
  let end = Math.min(chars.length, start + maxLength);
  if (end - start < maxLength) start = Math.max(0, end - maxLength);
  while (end > start + 4 && end < chars.length && !SENTENCE_END.has(chars[end - 1]!)) end -= 1;
  const quote = chars.slice(start, end).join('').trim();
  return quote.length >= 4 ? quote : chars.slice(0, maxLength).join('').trim();
}

/** 构造 CitationV1；不改变 quote（调用方需保证是 content 子串）。 */
export function toCitation(hit: SearchHit): Citation {
  return {
    doc_id: hit.document_id,
    chunk_id: hit.chunk_id,
    doc_version: hit.version,
    quote: hit.quote,
    effective_from: hit.effective_at,
    title: hit.title,
    source_type: hit.source_type,
    section_path: hit.section_path,
    score: hit.score,
    uri: hit.uri,
  };
}
