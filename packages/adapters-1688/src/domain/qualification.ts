/**
 * 类目资质状态机 —— docs/19 §7、docs/06 §4.2.1 `product.qualification`。
 *
 * 状态与门禁（docs/19 §7）：
 * | 状态 | 判定 | 门禁 |
 * |---|---|---|
 * | `valid` | 必填齐全且全部 `valid_until ≥ as_of + 30 天` | 放行 |
 * | `expiring` | 任一资质 30 天内到期 | 放行 + 告警 |
 * | `expired` | 任一必填资质过期 | 拦截 |
 * | `missing` | 必填缺失或附件非 `approved` | 拦截 |
 * | `unknown` | 平台 `qualification_requirements` 未核验/为空 | 拦截 |
 *
 * 1688 侧特别说明：`qualification_requirements` 属于平台类目字典（`platform_category`），
 * 平台要求尚未核验（`TODO-1688-009`），因此本模块把「要求是否已知」作为显式入参，
 * 未核验时一律 `unknown` 并阻断上架草稿 —— 与 docs/02 判定规则 H1 一致。
 */

import {
  asRecord,
  blocker,
  describeValue,
  failure,
  warning,
  type ValidationIssue,
  type ValidationResult,
} from '../validation.js';

export const SAFETY_CATEGORIES = ['A', 'B', 'C'] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

export const REPORT_STATUSES = ['approved', 'pending', 'rejected'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export type QualificationStatus = 'valid' | 'expiring' | 'expired' | 'missing' | 'unknown';

export interface QualificationReport {
  type: string;
  reportNo: string;
  issuer: string;
  issuedAt: string;
  validUntil: string;
  assetIds: string[];
  status: ReportStatus;
}

export interface QualificationInput {
  safetyCategory: SafetyCategory;
  executionStandard: string;
  fiberLabel: string;
  reports: QualificationReport[];
  authorizations?: unknown[];
  registrations?: unknown[];
  checkedAt: string;
  checkedBy: string;
}

export interface QualificationEvaluation {
  status: QualificationStatus;
  issues: ValidationIssue[];
  /** 最近到期的资质日期（ISO date），无报告时为 null。 */
  nextExpiry: string | null;
  /** 距离到期的天数（负数表示已过期）。 */
  daysToExpiry: number | null;
}

export interface QualificationOptions {
  /** 判定基准日（ISO date，按 Asia/Shanghai 的业务日口径）。 */
  asOf: string;
  /** 平台类目资质要求是否已核验；false → 直接 unknown。 */
  requirementsKnown: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRING_WINDOW_DAYS = 30;

function parseDate(value: string): number | null {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

/** 评估资质；`requirementsKnown=false` 时一定是 `unknown`。 */
export function evaluateQualification(
  raw: unknown,
  options: QualificationOptions,
): QualificationEvaluation {
  const asOfMs = parseDate(options.asOf);
  if (asOfMs === null) {
    return {
      status: 'unknown',
      nextExpiry: null,
      daysToExpiry: null,
      issues: [blocker('QUALIFICATION_AS_OF', 'as_of', 'ISO date', describeValue(options.asOf), '判定基准日不合法')],
    };
  }

  if (!options.requirementsKnown) {
    return {
      status: 'unknown',
      nextExpiry: null,
      daysToExpiry: null,
      issues: [
        blocker(
          'QUALIFICATION_UNKNOWN',
          'qualification',
          '平台类目资质要求已核验',
          '未核验（TODO-1688-009）',
          '平台要求未知时商品置 qualification_unknown，禁止进入 1688 上架草稿（docs/02 H1）',
        ),
      ],
    };
  }

  const row = asRecord(raw);
  if (!row) {
    return {
      status: 'missing',
      nextExpiry: null,
      daysToExpiry: null,
      issues: [blocker('QUALIFICATION_MISSING', 'qualification', '对象', describeValue(raw), '资质对象缺失')],
    };
  }

  const issues: ValidationIssue[] = [];
  const safetyCategory = row.safetyCategory;
  if (!(SAFETY_CATEGORIES as readonly string[]).includes(String(safetyCategory))) {
    issues.push(
      blocker('QUALIFICATION_FIELD', 'qualification.safety_category', 'A|B|C', describeValue(safetyCategory), '安全类别必填（GB 18401）'),
    );
  }
  if (typeof row.executionStandard !== 'string' || row.executionStandard.trim().length === 0) {
    issues.push(blocker('QUALIFICATION_FIELD', 'qualification.execution_standard', '非空标准号', describeValue(row.executionStandard), '执行标准号必填'));
  }
  if (typeof row.fiberLabel !== 'string' || row.fiberLabel.trim().length === 0) {
    issues.push(blocker('QUALIFICATION_FIELD', 'qualification.fiber_label', '非空标准号', describeValue(row.fiberLabel), '纤维含量标识标准必填'));
  }
  if (typeof row.checkedAt !== 'string' || parseDate(row.checkedAt) === null) {
    issues.push(blocker('QUALIFICATION_FIELD', 'qualification.checked_at', 'ISO date', describeValue(row.checkedAt), '最近核验时间必填'));
  }

  const reportsRaw = row.reports;
  if (!Array.isArray(reportsRaw) || reportsRaw.length === 0) {
    issues.push(
      blocker('QUALIFICATION_MISSING', 'qualification.reports', '≥1 份质检报告', describeValue(reportsRaw), '质检报告必填（docs/19 §7）'),
    );
  } else {
    for (const [index, item] of reportsRaw.entries()) {
      const report = asRecord(item);
      const field = `qualification.reports[${index}]`;
      if (!report) {
        issues.push(blocker('QUALIFICATION_FIELD', field, '对象', describeValue(item), '质检报告必须是对象'));
        continue;
      }
      for (const key of ['type', 'reportNo', 'issuer', 'validUntil'] as const) {
        if (typeof report[key] !== 'string' || (report[key] as string).trim().length === 0) {
          issues.push(blocker('QUALIFICATION_FIELD', `${field}.${key}`, '非空字符串', describeValue(report[key]), '质检报告字段必填'));
        }
      }
      const status = String(report.status ?? '');
      if (!(REPORT_STATUSES as readonly string[]).includes(status)) {
        issues.push(blocker('QUALIFICATION_FIELD', `${field}.status`, REPORT_STATUSES.join('|'), describeValue(report.status), '报告状态必须取受控值'));
      } else if (status !== 'approved') {
        issues.push(
          blocker('QUALIFICATION_MISSING', `${field}.status`, 'approved', status, '附件未审核通过视为资质缺失（docs/19 §7 missing）'),
        );
      }
      const assetIds = report.assetIds;
      if (!Array.isArray(assetIds) || assetIds.length === 0) {
        issues.push(blocker('QUALIFICATION_FIELD', `${field}.asset_ids`, '≥1 个 asset_id', describeValue(assetIds), '报告附件只传 asset_id'));
      }
      if (Array.isArray(assetIds)) {
        for (const assetId of assetIds) {
          if (typeof assetId !== 'string' || /^https?:\/\//i.test(assetId)) {
            issues.push(
              blocker('QUALIFICATION_ASSET', `${field}.asset_ids`, 'asset_id（uuid）', describeValue(assetId), '附件禁止直传 URL，只能传 asset_id（docs/19 §7 末段）'),
            );
          }
        }
      }
    }
  }

  let nextExpiry: string | null = null;
  let daysToExpiry: number | null = null;
  if (Array.isArray(reportsRaw)) {
    for (const [index, item] of reportsRaw.entries()) {
      const report = asRecord(item);
      if (!report || typeof report.validUntil !== 'string') continue;
      const validUntilMs = parseDate(report.validUntil);
      if (validUntilMs === null) {
        issues.push(
          blocker('QUALIFICATION_FIELD', `qualification.reports[${index}].valid_until`, 'ISO date', describeValue(report.validUntil), '有效期格式不合法'),
        );
        continue;
      }
      const days = Math.floor((validUntilMs - asOfMs) / DAY_MS);
      if (daysToExpiry === null || days < daysToExpiry) {
        daysToExpiry = days;
        nextExpiry = report.validUntil;
      }
    }
  }

  if (daysToExpiry !== null) {
    if (daysToExpiry < 0) {
      issues.push(
        blocker(
          'QUALIFICATION_EXPIRED',
          'qualification.reports.valid_until',
          `≥ ${options.asOf}`,
          `${nextExpiry}（已过期 ${Math.abs(daysToExpiry)} 天）`,
          '任一必填资质过期即拦截（docs/19 L1-QUA-001）',
        ),
      );
    } else if (daysToExpiry < EXPIRING_WINDOW_DAYS) {
      issues.push(
        warning(
          'QUALIFICATION_EXPIRING',
          'qualification.reports.valid_until',
          `≥ ${EXPIRING_WINDOW_DAYS} 天有效期`,
          `${nextExpiry}（剩余 ${daysToExpiry} 天）`,
          '资质 30 天内到期：放行但需告警并提前更新（docs/19 §7 expiring）',
        ),
      );
    }
  }

  const hasBlocker = issues.some((issue) => issue.severity === 'blocker');
  let status: QualificationStatus = 'valid';
  if (hasBlocker) {
    status = issues.some((issue) => issue.code === 'QUALIFICATION_EXPIRED') ? 'expired' : 'missing';
  } else if (issues.some((issue) => issue.code === 'QUALIFICATION_EXPIRING')) {
    status = 'expiring';
  }

  if (hasBlocker && status === 'valid') status = 'missing';
  return { status, issues, nextExpiry, daysToExpiry };
}

/** 门禁：只有 `valid` / `expiring` 允许生成上架包。 */
export function qualificationAllowsPublish(status: QualificationStatus): boolean {
  return status === 'valid' || status === 'expiring';
}

/** 平台侧资质要求未核验时的统一失败结果（便于调用方直接使用）。 */
export function unknownQualification(): ValidationResult<never> {
  return failure([
    blocker('QUALIFICATION_UNKNOWN', 'qualification', '平台类目资质要求已核验', '未核验（TODO-1688-009）', '缺平台资质要求快照，禁止生成上架包'),
  ]);
}
