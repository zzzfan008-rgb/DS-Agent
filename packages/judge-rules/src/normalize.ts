/**
 * 归一化（docs/08 §5.3 N1–N6）：全角→半角、去掉零宽/emoji/插入符号、统一大小写；
 * 同时保留「归一化字符 → 原文偏移」映射，命中位置必须映射回原文。
 */
export interface NormalizedText {
  normalized: string;
  /** map[i] = normalized[i] 在原文中的字符下标。 */
  map: number[];
}

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{27BF}]/u;

function toHalfWidth(codePoint: number): number {
  if (codePoint >= 0xff01 && codePoint <= 0xff5e) return codePoint - 0xfee0;
  if (codePoint === 0x3000) return 0x20;
  return codePoint;
}

export function normalizeText(text: string): NormalizedText {
  let normalized = '';
  const map: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (ZERO_WIDTH.test(char) || EMOJI.test(char)) continue;
    const half = String.fromCodePoint(toHalfWidth(char.codePointAt(0) ?? 0));
    // N4：去掉空格、星号等「插入符号」，但保留连字符（价格区间 99-129 需要）
    if (/[ \t\r\n*·•]/.test(half)) continue;
    normalized += half.toLowerCase();
    map.push(index);
  }
  return { normalized, map };
}

export function spanToOriginal(
  map: number[],
  start: number,
  end: number,
  originalLength: number,
): [number, number] {
  if (map.length === 0 || start >= map.length) return [0, 0];
  const originalStart = map[start]!;
  const lastIndex = Math.min(end - 1, map.length - 1);
  const originalEnd = Math.min(originalLength, map[lastIndex]! + 1);
  return [originalStart, originalEnd];
}
