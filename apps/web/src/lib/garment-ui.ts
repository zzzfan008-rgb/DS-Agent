/** 与后端一致的客户端提示词表/归一（只做展示与前置提示，最终以后端校验为准）。 */

export const MEASUREMENT_COLUMNS = [
  '衣长',
  '胸围',
  '肩宽',
  '袖长',
  '腰围',
  '臀围',
  '下摆',
  '裙长',
  '裤长',
  '脚口',
  '大腿围',
  '领围',
] as const;

export const FIBERS = [
  '棉',
  '聚酯纤维',
  '锦纶',
  '氨纶',
  '粘纤',
  '莫代尔纤维',
  '莱赛尔纤维',
  '醋酯纤维',
  '腈纶',
  '羊毛',
  '羊绒',
  '桑蚕丝',
  '亚麻',
  '苎麻',
  '真丝',
  '再生纤维素纤维',
  '铜氨纤维',
  '芳纶',
  '弹性纤维',
  '金属纤维',
] as const;

/** 15 色系：色块仅作“色系示意”，不代表实物颜色。 */
export const COLOR_FAMILIES: Record<string, { label: string; swatch: string }> = {
  BK: { label: '黑', swatch: '#1f2937' },
  WH: { label: '白/本白', swatch: '#f8fafc' },
  GY: { label: '灰', swatch: '#94a3b8' },
  BE: { label: '米/杏/驼', swatch: '#d6c2a1' },
  BR: { label: '棕/咖', swatch: '#8b5e3c' },
  RD: { label: '红', swatch: '#dc2626' },
  PK: { label: '粉', swatch: '#f9a8d4' },
  OR: { label: '橙', swatch: '#f97316' },
  YL: { label: '黄', swatch: '#eab308' },
  GN: { label: '绿', swatch: '#16a34a' },
  BL: { label: '蓝', swatch: '#2563eb' },
  PR: { label: '紫', swatch: '#7c3aed' },
  GD: { label: '金/金属', swatch: '#b45309' },
  SV: { label: '银', swatch: '#cbd5e1' },
  MC: { label: '多色/印花', swatch: 'linear-gradient(135deg,#f87171,#facc15,#4ade80,#60a5fa)' },
};

const COLOR_RE = /^([A-Z]{2})-?(\d{4})$/;
const SIZE_RE = /^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|4XL|5XL|[0-9]{2,3}|ONE)$/;
const SIZE_ALIASES: Record<string, string> = {
  '2XL': 'XXL',
  '3XL': 'XXXL',
  均码: 'ONE',
  FREE: 'ONE',
  FREE_SIZE: 'ONE',
};

export function normalizeColorId(raw: string): { ok: true; colorId: string } | { ok: false; reason: string } {
  const value = raw.trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(value)) return { ok: false, reason: '禁止用 Hex 色值充当 color_id' };
  const match = value.match(COLOR_RE);
  if (!match) return { ok: false, reason: 'color_id 形如 BK-0101（2 位色系 + 4 位序号）' };
  const family = match[1]!;
  if (!COLOR_FAMILIES[family]) return { ok: false, reason: `未知色系码 ${family}` };
  return { ok: true, colorId: `${family}-${match[2]}` };
}

export function normalizeSizeCode(raw: string): { ok: true; sizeCode: string } | { ok: false; reason: string } {
  const value = raw.trim().toUpperCase().replace(/\s+/g, '');
  const mapped = SIZE_ALIASES[value] ?? value;
  if (!SIZE_RE.test(mapped)) return { ok: false, reason: `尺码 ${raw} 不在词表内（如 2XL→XXL）` };
  return { ok: true, sizeCode: mapped };
}

export function colorFamily(colorId: string): { code: string; label: string; swatch: string } {
  const family = colorId.slice(0, 2).toUpperCase();
  const entry = COLOR_FAMILIES[family];
  return {
    code: family,
    label: entry?.label ?? '未知色系',
    swatch: entry?.swatch ?? '#e2e8f0',
  };
}

export function isHalfStep(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 250 && Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;
}

export function isKnownFiber(value: string): boolean {
  return (FIBERS as readonly string[]).includes(value);
}

export function defaultEffectiveFrom(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
