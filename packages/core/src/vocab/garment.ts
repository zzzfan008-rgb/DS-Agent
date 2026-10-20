/** 服装属性词表：色卡、尺码、纤维、品类必测部位（docs/19 §1–§5）。 */

// ---------------- 色卡 ----------------

export const COLOR_FAMILIES: Record<string, string> = {
  BK: '黑',
  WH: '白/本白',
  GY: '灰',
  BE: '米/杏/驼',
  BR: '棕/咖',
  RD: '红',
  PK: '粉',
  OR: '橙',
  YL: '黄',
  GN: '绿',
  BL: '蓝',
  PR: '紫',
  GD: '金/金属',
  SV: '银',
  MC: '多色/印花',
};

export interface NormalizedColor {
  ok: boolean;
  colorId: string | null;
  reason?: string;
}

/** 把 `BK0101` / `bk-0101` 归一为 `BK-0101`；拒绝 Hex、平台 ID、拼音等。 */
export function normalizeColorId(raw: string): NormalizedColor {
  const value = raw.trim().toUpperCase();
  if (/^#[0-9A-F]{3,8}$/.test(value)) {
    return { ok: false, colorId: null, reason: '禁止用 Hex 色值充当 color_id' };
  }
  const compact = value.replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]{2}[0-9]{4}$/.test(compact)) {
    return { ok: false, colorId: null, reason: 'color_id 必须形如 BK-0101（2 位色系 + 4 位序号）' };
  }
  const family = compact.slice(0, 2);
  if (!COLOR_FAMILIES[family]) {
    return { ok: false, colorId: null, reason: `未知色系码 ${family}` };
  }
  return { ok: true, colorId: `${family}-${compact.slice(2)}` };
}

// ---------------- 尺码 ----------------

export const SIZE_CODES = [
  'XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '4XL', '5XL', 'ONE',
] as const;

export const SIZE_ALIASES: Record<string, string> = {
  '2XL': 'XXL',
  '3XL': 'XXXL',
  加大: 'XL',
  加加大: 'XXL',
  特小: 'XS',
  均码: 'ONE',
  自由码: 'ONE',
  F: 'ONE',
  FREE: 'ONE',
};

export const ALPHA_SIZE_ORDER: Record<string, number> = {
  XS: 30,
  S: 40,
  M: 50,
  L: 60,
  XL: 70,
  XXL: 80,
  XXXL: 90,
  '4XL': 95,
  '5XL': 99,
  ONE: 0,
};

export function normalizeSizeCode(raw: string): string {
  const value = raw.trim().toUpperCase();
  return SIZE_ALIASES[value] ?? value;
}

export function isValidSizeCode(value: string): boolean {
  if ((SIZE_CODES as readonly string[]).includes(value)) return true;
  return /^[0-9]{2,3}$/.test(value);
}

export function sizeOrderFor(sizeCode: string): number {
  if (sizeCode === 'ONE') return 0;
  if (ALPHA_SIZE_ORDER[sizeCode] !== undefined) return ALPHA_SIZE_ORDER[sizeCode]!;
  if (/^[0-9]{2,3}$/.test(sizeCode)) return Number(sizeCode) * 10;
  return 999;
}

// ---------------- 纤维 ----------------

export const FIBER_NAMES = [
  '棉', '聚酯纤维', '锦纶', '氨纶', '粘纤', '莫代尔纤维',
  '莱赛尔纤维', '醋酯纤维', '腈纶', '羊毛', '羊绒', '桑蚕丝',
  '亚麻', '苎麻', '真丝', '再生纤维素纤维', '铜氨纤维',
  '芳纶', '弹性纤维', '金属纤维',
] as const;

export const FIBER_ALIASES: Record<string, string> = {
  涤纶: '聚酯纤维',
  聚酯: '聚酯纤维',
  尼龙: '锦纶',
  莱卡: '氨纶',
  弹性纤维: '氨纶',
  人造棉: '粘纤',
  粘胶: '粘纤',
  天丝: '莱赛尔纤维',
  莫代尔: '莫代尔纤维',
  真丝: '桑蚕丝',
  山羊绒: '羊绒',
  精梳棉: '棉',
  有机棉: '棉',
};

export function normalizeFiberName(raw: string): string {
  const value = raw.trim();
  return FIBER_ALIASES[value] ?? value;
}

export const FABRIC_NOTES = ['主料', '辅料', '里料', '填充', '装饰'] as const;

// ---------------- 品类 ----------------

const REQUIRED_MEASUREMENTS_BY_DOMAIN: Record<string, string[]> = {
  A: ['胸围', '衣长'], // 上装
  B: ['腰围', '裤长'], // 下装
  C: ['胸围', '裙长'], // 裙装
  D: ['胸围', '衣长'], // 外套
  E: ['胸围'], // 内衣家居
  F: [], // 配饰
  G: ['胸围', '衣长'], // 泳装防护
};

export function requiredMeasurements(categoryCode: string): string[] {
  return REQUIRED_MEASUREMENTS_BY_DOMAIN[categoryCode.trim().charAt(0).toUpperCase()] ?? [];
}

export const MEASUREMENT_KEYS = [
  '衣长', '胸围', '肩宽', '袖长', '腰围', '臀围', '下摆',
  '裙长', '裤长', '脚口', '大腿围', '领围',
] as const;

export function isValidCategoryCode(code: string): boolean {
  return /^[A-Z][0-9]{4}(\.[0-9]{1,3})?$/.test(code.trim());
}
