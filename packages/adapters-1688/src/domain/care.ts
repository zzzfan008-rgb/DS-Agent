/**
 * 洗护说明校验 —— docs/19 §6、docs/06 §4.2.1 `product.care_instructions`。
 *
 * 规则（docs/19 §6 末段）：
 * ① 码表外代码拒绝；② 默认组合只是录入模板，`source` 不得为模型；
 * ③ 「不可水洗」不得同时带水温；④ 五槽位齐全才允许发布；⑤ 洗护图/文字/知识库同版本。
 *
 * 文字由码表生成（`text` 字段），不接受手写第二份口径 —— 客服话术与详情页都引用这里。
 */

import {
  asRecord,
  blocker,
  describeValue,
  failure,
  success,
  type ValidationIssue,
  type ValidationResult,
} from '../validation.js';

export const CARE_SLOTS = ['wash', 'bleach', 'dry', 'iron', 'dryClean'] as const;
export type CareSlot = (typeof CARE_SLOTS)[number];

/** 槽位 → 代码 → 中文口径（docs/19 §6 表）。 */
export const CARE_CODEBOOK: Readonly<Record<CareSlot, Readonly<Record<string, string>>>> = {
  wash: {
    W30: '30℃ 常规机洗',
    W40: '40℃ 常规机洗',
    W60: '60℃ 常规机洗',
    WHAND: '手洗 ≤40℃',
    WNONE: '不可水洗',
  },
  bleach: {
    BOXY: '仅氧漂',
    BCL: '仅氯漂',
    BNONE: '不可漂白',
  },
  dry: {
    DHANG: '悬挂晾干',
    DFLAT: '平摊晾干',
    DSHADE: '阴干',
    DTUMBLE_LOW: '翻转干燥低温',
    DTUMBLE_NONE: '不可翻转干燥',
  },
  iron: {
    I110: '熨斗底板最高 110℃',
    I150: '熨斗底板最高 150℃',
    I200: '熨斗底板最高 200℃',
    INONE: '不可熨烫',
  },
  dryClean: {
    DCP: '常规干洗',
    DCF: '缓和干洗',
    DCNONE: '不可干洗',
  },
};

/** 允许的来源（`ck_source_kind` 白名单，且**不含** model）。 */
export const CARE_SOURCES = ['import', 'erp', 'manual', 'platform_sync', 'supplier'] as const;
export type CareSource = (typeof CARE_SOURCES)[number];

export interface CareSlotValue {
  code: string;
  /** 由码表生成的展示文本。 */
  text: string;
  /** 仅水洗码有温度。 */
  tempC: number | null;
}

export interface CareInstructions {
  wash: CareSlotValue;
  bleach: CareSlotValue;
  dry: CareSlotValue;
  iron: CareSlotValue;
  dryClean: CareSlotValue;
  note: string | null;
  source: CareSource;
}

const TEMP_BY_CODE: Readonly<Record<string, number>> = { W30: 30, W40: 40, W60: 60 };

/** 校验五槽位洗护；不通过抛给调用方决定。 */
export function validateCare(raw: unknown): ValidationResult<CareInstructions> {
  const row = asRecord(raw);
  if (!row) {
    return failure([blocker('CARE_TYPE', 'care_instructions', '对象', describeValue(raw), '洗护说明必须是对象')]);
  }
  const issues: ValidationIssue[] = [];
  const slots: Partial<Record<CareSlot, CareSlotValue>> = {};

  for (const slot of CARE_SLOTS) {
    const value = row[slot];
    const field = `care_instructions.${slot}`;
    if (value === undefined || value === null) {
      issues.push(blocker('CARE_SLOT', field, `${CARE_SLOTS.join('/')} 五槽位齐全`, '缺失', '洗护五槽位缺失视为未录入，禁止发布（docs/19 §6）'));
      continue;
    }
    const entry = typeof value === 'string' ? { code: value } : asRecord(value);
    if (!entry || typeof entry.code !== 'string') {
      issues.push(blocker('CARE_TYPE', field, '对象 {code, temp_c?}', describeValue(value), '槽位值必须是 {code} 结构'));
      continue;
    }
    const code = entry.code.trim().toUpperCase();
    const book = CARE_CODEBOOK[slot];
    if (!Object.hasOwn(book, code)) {
      issues.push(
        blocker('CARE_CODE', field, Object.keys(book).join('|'), code, '洗护代码不在码表内（docs/19 §6）'),
      );
      continue;
    }
    const tempCandidate = entry.tempC ?? entry.temp_c;
    const tempC = Object.hasOwn(TEMP_BY_CODE, code) ? TEMP_BY_CODE[code]! : null;
    if (tempCandidate !== undefined && tempCandidate !== null) {
      if (slot !== 'wash') {
        issues.push(blocker('CARE_TEMP', `${field}.temp_c`, '仅水洗槽位可带温度', describeValue(tempCandidate), '只有水洗码允许温度'));
        continue;
      }
      if (code === 'WNONE') {
        issues.push(
          blocker('CARE_TEMP', `${field}.temp_c`, 'null（不可水洗无温度）', describeValue(tempCandidate), '「不可水洗」不得同时带水温（docs/19 §6 规则 ③）'),
        );
        continue;
      }
      if (Number(tempCandidate) !== tempC) {
        issues.push(
          blocker('CARE_TEMP', `${field}.temp_c`, tempC === null ? 'null' : String(tempC), describeValue(tempCandidate), '温度必须与代码一致，由码表决定'),
        );
        continue;
      }
    }
    slots[slot] = { code, text: book[code]!, tempC };
  }

  const sourceRaw = row.source;
  const source = typeof sourceRaw === 'string' ? sourceRaw.trim() : '';
  if (!(CARE_SOURCES as readonly string[]).includes(source)) {
    issues.push(
      blocker(
        'CARE_SOURCE',
        'care_instructions.source',
        CARE_SOURCES.join('|'),
        describeValue(sourceRaw),
        '来源必须在 ck_source_kind 白名单内；模型不得成为洗护事实来源',
      ),
    );
  }

  const noteRaw = row.note;
  if (noteRaw !== undefined && noteRaw !== null && (typeof noteRaw !== 'string' || noteRaw.length > 200)) {
    issues.push(blocker('CARE_NOTE', 'care_instructions.note', '≤200 字字符串或 null', describeValue(noteRaw), '注记长度受限'));
  }

  if (issues.some((issue) => issue.severity === 'blocker') || Object.keys(slots).length !== CARE_SLOTS.length) {
    return failure(issues);
  }

  return success({
    wash: slots.wash!,
    bleach: slots.bleach!,
    dry: slots.dry!,
    iron: slots.iron!,
    dryClean: slots.dryClean!,
    note: typeof noteRaw === 'string' ? noteRaw : null,
    source: source as CareSource,
  });
}

/** 洗护图标/文字的扁平化输出（详情页与客服话术共用）。 */
export function careTextLines(care: CareInstructions): string[] {
  const ordered = CARE_SLOTS.map((slot) => care[slot]);
  return ordered.map((slot) => slot.text);
}
