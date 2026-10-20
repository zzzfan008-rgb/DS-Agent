/**
 * 关键词检索的分词与 tsquery 构造（docs/09 §8.1）。
 *
 * Postgres 侧没有中文分词器（决策：应用侧分词，不装 zhparser/pg_jieba）：
 * - 索引：中文单字 + 相邻 bigram，英文小写词 → `to_tsvector('simple', tokens)`；
 * - 查询：同一函数切词，构造 `to_tsquery('simple', "token1" | "token2" | …)`；
 * - BM25 近似：Postgres 无 BM25，用 `ts_rank_cd`（覆盖密度）排序；真实 BM25 只在
 *   候选 ≤200 时可选（本实现不启用），见 docs/09 §8.1 与验收记录限制。
 */

const CJK_RE = /[\u4e00-\u9fff]/;
const LATIN_RE = /[a-z0-9][a-z0-9._-]{1,}/g;
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'are', 'was', 'were', 'from', 'what', 'how',
  '请问', '一下', '可以', '是否', '怎么', '什么', '这个', '那个', '我们', '你们', '以及',
]);

/** 索引/查询共用的 token 序列（去重、保序、最多 64 个）。 */
export function keywordTokens(text: string): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (token: string): void => {
    if (token.length === 0 || STOPWORDS.has(token) || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };

  for (const match of normalized.matchAll(LATIN_RE)) push(match[0]);

  const cjk: string[] = [];
  for (const char of normalized) {
    if (CJK_RE.test(char)) cjk.push(char);
  }
  for (let index = 0; index < cjk.length; index += 1) {
    push(cjk[index]!);
    if (index + 1 < cjk.length) push(`${cjk[index]}${cjk[index + 1]}`);
  }
  return tokens.slice(0, 64);
}

function quoteTsToken(token: string): string {
  return `'${token.replaceAll("'", "''")}'`;
}

/** 构造 OR 语义的 tsquery（召回优先）；无 token 返回 null。 */
export function buildTsQuery(tokens: readonly string[]): string | null {
  const valid = tokens.filter((token) => token.trim().length > 0).slice(0, 32);
  if (valid.length === 0) return null;
  return valid.map(quoteTsToken).join(' | ');
}

/** LIKE 模式（转义 % _ \）；只用于关键词降级，不做 SQL 拼接。 */
export function likePattern(text: string): string {
  return `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

/** 索引文本：tokens 空格拼接后交给 `to_tsvector('simple', …)`。 */
export function tsvectorInput(text: string): string {
  return keywordTokens(text).join(' ');
}
