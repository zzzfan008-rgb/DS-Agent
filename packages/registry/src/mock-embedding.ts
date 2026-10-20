/**
 * 确定性 mock embedding（M7 测试/离线用；不是语义模型）。
 *
 * 用途：`provider.extra.mock=true` 的 embedding provider 在无外部密钥时产出 1024 维向量，
 * 使知识库入库/检索链路可端到端跑通与测试。**生产必须换成真实 embedding 模型**
 * （docs/09 §6；维度锁 1024）。
 *
 * 设计：
 * - 概念词典把同义词映射到同一 concept token（风衣/外套/夹克 → C:outerwear；退货/退换/退款 → C:return），
 *   让"同义改写能召回"在 mock 下可验证；
 * - 中文 bigram + 英文词 + 概念词，经 sha256 投影到固定维度并带符号累加；
 * - 结果 L2 归一化；同一文本永远同向量，不同文本语义相近时共享概念维度。
 *
 * 这不是 BM25/向量模型质量的替代品；只用于 M7 管线与降级路径的可重复验证。
 */
import { createHash } from 'node:crypto';

/** 概念词典：key 是内部概念 token，value 是同义/近义表述。 */
export const MOCK_CONCEPT_LEXICON: Readonly<Record<string, readonly string[]>> = {
  'C:outerwear': ['风衣', '外套', '夹克', '大衣', '冲锋衣'],
  'C:return': ['退货', '退换', '退款', '售后', '七天无理由', '退货退款'],
  'C:size': ['尺码', '尺寸', '大小', '码数', '选码', '偏大', '偏小'],
  'C:care': ['洗护', '清洗', '洗涤', '保养', '水洗', '干洗'],
  'C:fabric': ['面料', '材质', '布料', '成分', '克重'],
  'C:price': ['价格', '报价', '批发价', '阶梯价', '起批', '起订量'],
  'C:policy': ['政策', '规则', '条款', '平台规则', '退换政策'],
  'C:shipping': ['发货', '物流', '快递', '运费', '拦截', '拒收'],
  'C:quality': ['质量', '瑕疵', '破损', '做工', '起球', '色差'],
};

const CJK_RE = /[\u4e00-\u9fff]/;
const LATIN_RE = /[a-z0-9][a-z0-9._-]{1,}/g;

function conceptTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const [concept, aliases] of Object.entries(MOCK_CONCEPT_LEXICON)) {
    if (aliases.some((alias) => text.includes(alias))) {
      // 概念权重用重复 token 表达（hash 投影后同维累加）。
      tokens.push(concept, concept, concept, concept, concept, concept);
    }
  }
  return tokens;
}

/** 从文本提取索引/查询 token；中文 bigram（单字保底），英文小写词。 */
export function tokenizeForMockEmbedding(text: string): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const tokens: string[] = [...conceptTokens(normalized)];

  for (const match of normalized.matchAll(LATIN_RE)) {
    tokens.push(`w:${match[0]}`);
  }

  const cjk = [...normalized].filter((char) => CJK_RE.test(char));
  for (let index = 0; index < cjk.length; index += 1) {
    tokens.push(`z:${cjk[index]}`);
    if (index + 1 < cjk.length) tokens.push(`b:${cjk[index]}${cjk[index + 1]}`);
  }
  return tokens;
}

function tokenBucket(token: string, dim: number): { index: number; sign: number } {
  const digest = createHash('sha256').update(token, 'utf8').digest();
  const index = digest.readUInt32BE(0) % dim;
  const sign = (digest[4]! & 1) === 0 ? 1 : -1;
  return { index, sign };
}

/** 单个文本 → L2 归一化的 1024 维向量（确定性）。 */
export function mockEmbedding(text: string, dim = 1024): number[] {
  if (!Number.isInteger(dim) || dim < 8) throw new Error(`invalid embedding dim: ${dim}`);
  const vector = new Array<number>(dim).fill(0);
  for (const token of tokenizeForMockEmbedding(text)) {
    const { index, sign } = tokenBucket(token, dim);
    vector[index]! += sign;
  }
  let norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) {
    vector[0] = 1;
    norm = 1;
  }
  return vector.map((value) => value / norm);
}

export function mockEmbeddings(texts: readonly string[], dim = 1024): number[][] {
  return texts.map((text) => mockEmbedding(text, dim));
}
