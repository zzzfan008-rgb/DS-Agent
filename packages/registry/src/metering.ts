/**
 * 计量公式（docs/07 §7.3；docs/21 §1 价格结构）。
 * 全部整数分；每个计费段分别向上取整到分。
 */
import type { Capability, PriceBook, UsageActual, UsageEstimate } from './types.js';

function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

export interface PriceValidation {
  ok: boolean;
  errors: string[];
}

/** 发布/创建前的计价单结构校验：四段、整数分、非负，且本 capability 的段非空。 */
export function validatePriceBook(price: unknown, capability: Capability): PriceValidation {
  const errors: string[] = [];
  if (!price || typeof price !== 'object' || Array.isArray(price)) {
    return { ok: false, errors: ['price 必须是对象'] };
  }
  const book = price as Record<string, unknown>;
  const sections = ['text', 'image', 'video', 'embed'] as const;
  for (const section of sections) {
    const value = book[section];
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`price.${section} 必须是对象`);
      continue;
    }
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
        errors.push(`price.${section}.${key} 必须是非负整数（分）`);
      }
    }
  }

  const requiredSection: Record<Capability, keyof PriceBook | null> = {
    text: 'text',
    image: 'image',
    video: 'video',
    embedding: 'embed',
    rerank: 'text',
  };
  const required = requiredSection[capability];
  if (required) {
    const section = book[required];
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      errors.push(`capability=${capability} 必须提供 price.${required}`);
    } else {
      const keys = Object.keys(section as Record<string, unknown>);
      if (keys.length === 0) errors.push(`capability=${capability} 的 price.${required} 不能为空`);
    }
  }
  if (capability === 'image') {
    const image = (book.image ?? {}) as Record<string, unknown>;
    if (image.per_image_cents === undefined && image.per_megapixel_cents === undefined) {
      errors.push('image 计价单至少需要 per_image_cents 或 per_megapixel_cents 之一');
    }
  }
  return { ok: errors.length === 0, errors };
}

function ceilDiv(numerator: number, denominator: number): number {
  return Math.ceil(numerator / denominator);
}

/** 实际费用（分）。usage 缺省字段按 0。 */
export function computeCostCents(
  price: PriceBook,
  capability: Capability,
  usage: UsageActual,
): number {
  if (capability === 'text' || capability === 'rerank') {
    const input = nonNegativeInt(usage.inputTokens) ?? 0;
    const output = nonNegativeInt(usage.outputTokens) ?? 0;
    const inputRate = nonNegativeInt(price.text?.input_per_1k_cents) ?? 0;
    const outputRate = nonNegativeInt(price.text?.output_per_1k_cents) ?? 0;
    return ceilDiv(input * inputRate, 1000) + ceilDiv(output * outputRate, 1000);
  }
  if (capability === 'embedding') {
    const tokens = nonNegativeInt(usage.inputTokens) ?? 0;
    const rate = nonNegativeInt(price.embed?.per_1k_tokens_cents) ?? 0;
    return ceilDiv(tokens * rate, 1000);
  }
  if (capability === 'image') {
    const pixels = nonNegativeInt(usage.imagePixels);
    const perMegapixel = nonNegativeInt(price.image?.per_megapixel_cents);
    if (pixels !== null && perMegapixel !== null) {
      return ceilDiv(pixels * perMegapixel, 1_000_000);
    }
    const count = nonNegativeInt(usage.imageCount) ?? 0;
    const perImage = nonNegativeInt(price.image?.per_image_cents) ?? 0;
    return count * perImage;
  }
  if (capability === 'video') {
    const seconds = typeof usage.videoSeconds === 'number' && usage.videoSeconds >= 0
      ? usage.videoSeconds
      : 0;
    const rate = nonNegativeInt(price.video?.per_second_cents) ?? 0;
    return Math.ceil(seconds * rate);
  }
  return 0;
}

/** 调用前估价（用于配额预留与「降级不能更贵」判定）。 */
export function estimateCostCents(
  price: PriceBook,
  capability: Capability,
  estimate: UsageEstimate,
): number {
  return computeCostCents(price, capability, {
    inputTokens: estimate.tokensIn,
    outputTokens: estimate.tokensOut,
    imageCount: estimate.images,
    imagePixels: estimate.pixels,
    videoSeconds: estimate.seconds,
  });
}
