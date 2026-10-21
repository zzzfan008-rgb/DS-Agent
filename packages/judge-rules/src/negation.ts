/**
 * 否定语境判定（docs/08 §5.3/§5.4；t42 质量对照发现）。
 *
 * 问题：L1 原先用裸字符串匹配禁限词，会把**正确的拒绝话术**判成违规：
 *   - 「不能承诺当天发货」含禁词「当天发货」→ 误报
 *   - 「不能直接按『七天无理由』答复」含禁词「七天无理由」→ 误报
 * 见 docs/42-F1质量对照.md §三「两处禁词命中的复核」。
 *
 * 本模块给出一个**保守**的否定作用域判定：命中词所在分句内、命中词之前出现
 * 否定标记时，该命中降级为 info（保留记录与原文 span，便于误杀申诉与审计），
 * 不计入 blocker。
 *
 * 「保守」体现在四条约束——目的是**不能因此漏掉真正的承诺**：
 *   1) 作用域不跨标点/转折词：`不保证当天发货，但一般当天发` 只降级前一处；
 *      转折后的分句仍是隐含承诺，必须继续命中。
 *   2) 双重否定视为肯定：`不能不承诺当天发货` 不降级。
 *   3) 非否定用法不算标记：`不仅/不但/不少/不过/不得不…` 不是否定。
 *   4) 只看命中词之前，且窗口上限 10 字：不做全文推断，避免把别处的否定
 *      套到本条命中上。
 *
 * 已知局限（记录在 docs/42，不在此处静默兜底）：
 *   - 只判前缀作用域：后缀式标记（`当天发货需确认`）不降级，仍按原严重度命中；
 *   - 反讽/反问（`难道不能当天发货？`）无法用规则区分，交 L2/人工；
 *   - 降级命中仍进入 L1 结果（severity=info、negated=true），L2 提示词可继续语义复核。
 */

/** 否定标记：同一位置取最长匹配（「不能承诺」优先于「不能」）。 */
export const NEGATION_MARKERS = [
  '不能承诺',
  '不能保证',
  '无法保证',
  '暂不支持',
  '不承诺',
  '不支持',
  '不保证',
  '需确认',
  '待确认',
  '不能',
  '无法',
  '不可',
  '不会',
  '不得',
  '禁止',
  '不',
] as const;

/** 含「不」但不是否定的词；命中这些前缀时不视为否定标记。 */
const NON_NEGATION_PREFIXES = [
  '不仅', '不但', '不只', '不光', '不单', '不少', '不错', '不断', '不管',
  '不论', '不过', '不久', '不足', '不同', '不合', '不然', '不料', '不免',
  '不由', '不失', '不愧', '不规则', '不锈钢',
];

/** 必须整体跳过的组合（「不得不」= 必须，是肯定语气）。 */
const SKIP_PHRASES = ['不得不'];

/**
 * 转折/分句边界：否定作用域到此为止。
 * 归一化会把全角标点转半角（N1），因此半角与全角都要列；`。` `、` 不在转换范围内。
 */
const CLAUSE_BOUNDARIES = new Set([
  ',', '.', '!', '?', ';', ':', '\n',
  '，', '。', '！', '？', '；', '：', '、',
  '但', '却', '而',
]);

/** 默认前视窗口：命中词前 N 个字符。 */
export const DEFAULT_NEGATION_WINDOW = 10;

export interface NegationResult {
  negated: boolean;
  /** 命中的否定标记原文（如「不能承诺」）；negated=false 时为空。 */
  marker?: string;
  /** 标记在归一化文本中的起点。 */
  marker_index?: number;
  /** 作用域内否定标记个数：奇数=否定，偶数=双重否定（视为肯定）。 */
  marker_count: number;
}

function isNonNegation(normalized: string, index: number): boolean {
  return NON_NEGATION_PREFIXES.some((prefix) => normalized.startsWith(prefix, index));
}

/** 从命中词回扫到分句边界（或窗口下界），返回分句内命中词之前的起点。 */
function clauseStartBefore(normalized: string, hitStart: number, window: number): number {
  const lowerBound = Math.max(0, hitStart - window);
  for (let index = hitStart - 1; index >= lowerBound; index -= 1) {
    if (CLAUSE_BOUNDARIES.has(normalized[index]!)) return index + 1;
  }
  return lowerBound;
}

/**
 * 在 [start, hitStart) 内正向收集否定标记（左起最长匹配、不重叠）。
 * 正向扫描是关键：反向扫描会把「不能」和它的首字「不」重复计成两个标记。
 */
function collectMarkers(
  normalized: string,
  start: number,
  hitStart: number,
): Array<{ marker: string; index: number }> {
  const markers: Array<{ marker: string; index: number }> = [];
  let cursor = start;
  while (cursor < hitStart) {
    const skip = SKIP_PHRASES.find((phrase) => normalized.startsWith(phrase, cursor));
    if (skip) {
      cursor += skip.length;
      continue;
    }
    let matched: string | null = null;
    for (const marker of NEGATION_MARKERS) {
      if (!normalized.startsWith(marker, cursor)) continue;
      if (cursor + marker.length > hitStart) continue; // 标记不能压到命中词上
      if (marker.startsWith('不') && isNonNegation(normalized, cursor)) continue;
      matched = marker;
      break; // NEGATION_MARKERS 按长度倒序，首个命中即最长
    }
    if (matched) {
      markers.push({ marker: matched, index: cursor });
      cursor += matched.length;
      continue;
    }
    cursor += 1;
  }
  return markers;
}

/**
 * 判定 normalized[hitStart, …) 处的命中是否处于否定语境。
 *
 * 奇数个标记 → 否定（降级）；偶数个 → 双重否定（视为肯定，不降级）；
 * 无标记 → 不降级。
 *
 * @param normalized 归一化文本（与 L1 命中使用的同一份）
 * @param hitStart   命中词在归一化文本中的起点
 * @param window     前视窗口字符数
 */
export function detectNegation(
  normalized: string,
  hitStart: number,
  window: number = DEFAULT_NEGATION_WINDOW,
): NegationResult {
  if (hitStart <= 0) return { negated: false, marker_count: 0 };
  const start = clauseStartBefore(normalized, hitStart, window);
  const markers = collectMarkers(normalized, start, hitStart);
  if (markers.length === 0) return { negated: false, marker_count: 0 };
  const negated = markers.length % 2 === 1;
  // 取离命中词最近的标记作为解释依据
  const nearest = markers[markers.length - 1]!;
  return {
    negated,
    marker: negated ? nearest.marker : undefined,
    marker_index: negated ? nearest.index : undefined,
    marker_count: markers.length,
  };
}
