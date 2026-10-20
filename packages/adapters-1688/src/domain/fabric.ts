/**
 * 面料成分校验与文本生成 —— docs/06 §6.2、docs/19 §5。
 *
 * 与 DB 的关系：`fabric_composition.materials` 由 `fabric_materials_valid()` 在库内强制
 * 「1–8 条、整数百分比、合计 100」。本模块在写入前做同样的检查，并额外拦截**俗称** ——
 * DB 只能保证数量和合计，保证不了「涤纶」必须写成「聚酯纤维」（docs/19 §5 表）。
 *
 * 所有平台的成分展示文本都必须由 `renderMaterialsText()` 生成，禁止手写第二份
 * （docs/19 §5 末段）。
 */

import {
  asRecord,
  blocker,
  describeValue,
  failure,
  success,
  warning,
  type ValidationIssue,
  type ValidationResult,
} from '../validation.js';

/** 标准纤维名（docs/19 §5；`羊毛` 来自洗护默认组合表）。 */
export const FIBERS = [
  '棉',
  '聚酯纤维',
  '羊毛',
  '羊绒',
  '桑蚕丝',
  '亚麻',
  '锦纶',
  '氨纶',
  '粘纤',
  '莫代尔纤维',
  '莱赛尔纤维',
  '其他纤维',
] as const;

export type Fiber = (typeof FIBERS)[number];

const FIBER_SET = new Set<string>(FIBERS);

/** 俗称 → 标准名（导入层归一；落库前必须已归一）。 */
export const FIBER_ALIASES: Readonly<Record<string, string>> = {
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

/** 成分备注角色（docs/19 §5：主料/辅料/里料/填充/装饰）。 */
export const MATERIAL_NOTES = ['主料', '辅料', '里料', '填充', '装饰'] as const;
export type MaterialNote = (typeof MATERIAL_NOTES)[number];

export interface MaterialRow {
  material: string;
  percent: number;
  note?: MaterialNote;
  /** 品名编码（docs/19 §11 样例的 `fiber_code`），可选。 */
  fiberCode?: string;
}

/** 校验成分数组；不通过抛 `DomainValidationError` 由调用方决定。 */
export function validateMaterials(raw: unknown): ValidationResult<MaterialRow[]> {
  if (!Array.isArray(raw)) {
    return failure([blocker('FABRIC_TYPE', 'materials', '数组', describeValue(raw), '面料成分必须是数组')]);
  }
  if (raw.length < 1 || raw.length > 8) {
    return failure([
      blocker('FABRIC_COUNT', 'materials', '1–8 条', `${raw.length} 条`, '成分条数必须在 1–8 之间（docs/19 §5）'),
    ]);
  }

  const issues: ValidationIssue[] = [];
  const rows: MaterialRow[] = [];

  raw.forEach((item, index) => {
    const entry = asRecord(item);
    const field = `materials[${index}]`;
    if (!entry) {
      issues.push(blocker('FABRIC_TYPE', field, '对象', describeValue(item), '成分项必须是对象'));
      return;
    }
    const materialRaw = entry.material;
    const percent = entry.percent;
    const note = entry.note;

    if (typeof materialRaw !== 'string' || materialRaw.trim().length === 0) {
      issues.push(blocker('FABRIC_NAME', `${field}.material`, '标准纤维名', describeValue(materialRaw), '成分名不能为空'));
      return;
    }
    const material = materialRaw.trim();
    if (Object.hasOwn(FIBER_ALIASES, material)) {
      issues.push(
        blocker(
          'FABRIC_ALIAS',
          `${field}.material`,
          FIBER_ALIASES[material]!,
          material,
          `俗称「${material}」必须在导入层归一为「${FIBER_ALIASES[material]}」（docs/19 §5）`,
        ),
      );
      return;
    }
    if (!FIBER_SET.has(material)) {
      issues.push(
        blocker('FABRIC_NAME', `${field}.material`, FIBERS.join('|'), material, '成分名必须取自标准词表（GB/T 4146.1 口径）'),
      );
      return;
    }

    if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 1 || percent > 100) {
      issues.push(
        blocker('FABRIC_PERCENT', `${field}.percent`, '1–100 的整数', describeValue(percent), '百分比必须是整数，禁止小数/区间/「约」'),
      );
      return;
    }

    if (note !== undefined && note !== null && !(MATERIAL_NOTES as readonly string[]).includes(String(note))) {
      issues.push(
        blocker('FABRIC_NOTE', `${field}.note`, MATERIAL_NOTES.join('|'), describeValue(note), '成分角色只能取受控值'),
      );
    }

    const fiberCode = typeof entry.fiberCode === 'string' ? entry.fiberCode : undefined;
    rows.push({
      material,
      percent,
      ...(note === undefined || note === null ? {} : { note: note as MaterialNote }),
      ...(fiberCode ? { fiberCode } : {}),
    });
  });

  if (rows.length !== raw.length) return failure(issues);

  const sum = rows.reduce((acc, row) => acc + row.percent, 0);
  if (sum !== 100) {
    issues.push(
      blocker('FABRIC_SUM', 'materials', '合计 100', String(sum), `成分百分比合计为 ${sum}，必须等于 100（docs/06 §6.2 / docs/19 §5）`),
    );
  }

  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index]!.percent > rows[index - 1]!.percent) {
      issues.push(
        warning('FABRIC_ORDER', `materials[${index}].percent`, '按占比降序', `${rows[index - 1]!.percent} → ${rows[index]!.percent}`, '占比高的成分应排在前面（docs/19 §5 排序规则）'),
      );
      break;
    }
  }

  const nonMain = rows.filter((row) => row.note === undefined);
  if (nonMain.length > 0 && rows.length > 0 && rows[0]!.note === undefined) {
    issues.push(
      warning('FABRIC_NOTE', 'materials[0].note', '主料', '未标注', '首条成分通常为主料，建议显式标注 note 以对齐 fabric_composition.role'),
    );
  }

  return issues.some((issue) => issue.severity === 'blocker') ? failure(issues) : success(rows, issues);
}

/** 生成平台文本：`聚酯纤维62%、棉33%、氨纶5%`（顺序同数组）。 */
export function renderMaterialsText(rows: readonly MaterialRow[]): string {
  return rows.map((row) => `${row.material}${row.percent}%`).join('、');
}

/** 是否已归一（用于导入层与测试断言）。 */
export function normalizeFiberName(raw: string): string | null {
  const name = raw.trim();
  if (Object.hasOwn(FIBER_ALIASES, name)) return FIBER_ALIASES[name]!;
  return FIBER_SET.has(name) ? name : null;
}
