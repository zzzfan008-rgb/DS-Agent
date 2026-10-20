/** M3 展示格式化：价格簿、金额输入、状态/枚举文案。 */
import { formatCents } from './format';

export interface PriceBookLike {
  text?: { input_per_1k_cents?: number; output_per_1k_cents?: number };
  image?: { per_image_cents?: number; per_megapixel_cents?: number };
  video?: { per_second_cents?: number };
  embed?: { per_1k_tokens_cents?: number };
}

export type CapabilityLike = string;
export type VerdictLike = string;

export interface PriceLine {
  label: string;
  unit: string;
  cents: number;
  yuan: string;
}

/** 价格簿 → “分/单位”主显示 + 人民币辅助。 */
export function priceLines(price: PriceBookLike | null | undefined, capability: string): PriceLine[] {
  if (!price) return [];
  const lines: PriceLine[] = [];
  const push = (label: string, unit: string, cents: number | undefined) => {
    if (typeof cents !== 'number' || !Number.isFinite(cents)) return;
    lines.push({ label, unit, cents, yuan: formatCents(cents) });
  };
  if (price.text) {
    push('输入', '千 token', price.text.input_per_1k_cents);
    push('输出', '千 token', price.text.output_per_1k_cents);
  }
  if (price.image) {
    push('按张', '张', price.image.per_image_cents);
    push('按像素', '百万像素', price.image.per_megapixel_cents);
  }
  if (price.video) push('按秒', '秒', price.video.per_second_cents);
  if (price.embed) push('嵌入', '千 token', price.embed.per_1k_tokens_cents);
  if (lines.length === 0) {
    push(`${capability}`, '次', undefined);
  }
  return lines;
}

export function priceText(price: PriceBookLike | null | undefined, capability: string): string {
  const lines = priceLines(price, capability);
  if (lines.length === 0) return '价格待补';
  return lines.map((line) => `${line.label} ${line.cents} 分/${line.unit}`).join(' · ');
}

/** 元字符串 → 整数分；拒绝浮点误差（最多两位小数）。 */
export function parseYuanToCents(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [yuanPart = '0', fenPart = ''] = value.split('.');
  const yuan = Number(yuanPart);
  if (!Number.isInteger(yuan) || yuan < 0) return null;
  const fen = Number(fenPart.padEnd(2, '0') || '0');
  if (!Number.isInteger(fen) || fen < 0 || fen > 99) return null;
  return yuan * 100 + fen;
}

export function centsToYuanInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '';
  const abs = Math.abs(Math.trunc(cents));
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function formatMeasurement(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export const VERDICT_LABEL: Record<string, string> = {
  pass: '通过',
  needs_revision: '需修改',
  reject: '驳回',
  escalate: '升级人工复核',
};

export const SEVERITY_LABEL: Record<string, string> = {
  info: '提示',
  low: '低',
  medium: '中',
  high: '高',
  blocker: '阻断',
};

export const PRODUCT_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  active: '启用',
  inactive: '停用',
  archived: '归档',
};

export const PROVIDER_STATUS_LABEL: Record<string, string> = {
  configuring: '配置中',
  active: '启用',
  degraded: '降级',
  disabled: '停用',
};

export const MODEL_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  testing: '测试中',
  published: '已发布',
  suspended: '已停用',
  archived: '已归档',
};

export const ROUTE_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  active: '生效',
  paused: '暂停',
  retired: '停用',
};

export const CAPABILITY_LABEL: Record<string, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  embedding: '嵌入',
  rerank: '重排',
};

export const PURPOSE_LABEL: Record<string, string> = {
  copy: '文案',
  judge: '判定',
  image: '图片',
  video: '视频',
  embed: '嵌入',
  rerank: '重排',
};

export const CONTENT_TYPE_LABEL: Record<string, string> = {
  title: '标题',
  selling_points: '卖点',
  detail: '详情',
  faq: 'FAQ',
  reply: '客服回复',
  quote: '报价',
};

export const TONE_OPTIONS = ['专业', '亲和', '简洁', '促销', '批发'] as const;

export const VISIBLE_REASON_LABEL: Record<string, string> = {
  provider_unavailable: '供应商未配置/不可达',
  model_not_published: '模型未发布或参数不完整',
  no_route: '没有命中当前用户/角色的 active 路由',
  role_forbidden: '你的角色无权使用该用途',
  model_purpose_mismatch: '模型能力与用途不兼容',
};

export function verdictLabel(verdict: string): string {
  return VERDICT_LABEL[verdict] ?? verdict;
}

export function severityLabel(severity: string): string {
  return SEVERITY_LABEL[severity] ?? severity;
}

export function capabilityLabel(capability: string): string {
  return CAPABILITY_LABEL[capability] ?? capability;
}

export function purposeLabel(purpose: string): string {
  return PURPOSE_LABEL[purpose] ?? purpose;
}

export function contentTypeLabel(contentType: string): string {
  return CONTENT_TYPE_LABEL[contentType] ?? contentType;
}
