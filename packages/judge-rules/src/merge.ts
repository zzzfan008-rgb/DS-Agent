/** L1 + L2 合并规则（docs/08 §11.3）。 */
import type { L1Result, L2Output, MergedVerdict, Severity } from './types.js';
import { maxSeverity } from './types.js';
import { l1HighestSeverity } from './l1.js';

function l1Reason(result: L1Result): string {
  return result.hits
    .filter((hit) => hit.severity === 'blocker' || hit.severity === 'high')
    .map((hit) => `${hit.rule_id} 命中“${hit.matched}”`)
    .join('；');
}

function l1Repair(result: L1Result): string {
  return [...new Set(result.hits.map((hit) => hit.suggestion))].join('；');
}

export function mergeJudgments(
  l1: L1Result,
  l2: L2Output | null,
  options: { noEvidence?: boolean } = {},
): MergedVerdict {
  if (l1.errors.length > 0) {
    return {
      verdict: 'escalate',
      severity: 'high',
      reason: `L1 规则执行异常：${l1.errors.map((error) => error.rule_id).join(',')}`,
      repair_hint: '转 L3 人工复核',
      evidence_refs: [],
      short_circuit: 'NO_EVIDENCE',
    };
  }

  if (l1.blocked) {
    return {
      verdict: 'reject',
      severity: 'blocker',
      reason: l1Reason(l1) || 'L1 blocker 命中',
      repair_hint: l1Repair(l1) || '修改内容后重判',
      evidence_refs: [],
      short_circuit: 'L1_BLOCKER',
    };
  }

  const l1Severity = l1HighestSeverity(l1);
  if (!l2) {
    if (options.noEvidence) {
      return {
        verdict: 'escalate',
        severity: maxSeverity(l1Severity, 'high'),
        reason: '无可用证据，升级 L3 人工',
        repair_hint: '补充知识库政策/依据后再判',
        evidence_refs: [],
        short_circuit: 'NO_EVIDENCE',
      };
    }
    const verdict =
      l1Severity === 'blocker'
        ? 'reject'
        : l1Severity === 'high' || l1Severity === 'medium'
          ? 'needs_revision'
          : 'pass';
    return {
      verdict,
      severity: l1Severity,
      reason: verdict === 'pass' ? 'L1 未命中阻断项' : l1Reason(l1) || 'L1 命中需修订项',
      repair_hint: verdict === 'pass' ? '' : l1Repair(l1) || '按命中项修改',
      evidence_refs: [],
      short_circuit: options.noEvidence ? 'NO_EVIDENCE' : 'L2_SKIPPED',
    };
  }

  if (l2.verdict === 'escalate') {
    return {
      verdict: 'escalate',
      severity: maxSeverity(l1Severity, 'high'),
      reason: l2.reason,
      repair_hint: l2.repair_hint,
      evidence_refs: l2.evidence_refs,
    };
  }

  let verdict = l2.verdict;
  if ((l1Severity === 'high' || l1Severity === 'medium') && l2.verdict === 'pass') {
    verdict = 'needs_revision';
  }
  const severity = maxSeverity(l1Severity, l2.severity) as Severity;
  const reasonParts = [l2.reason, l1Severity !== 'info' && l1Severity !== 'low' ? l1Reason(l1) : '']
    .filter((part) => part.length > 0);
  const repairParts = [l2.repair_hint, l1Severity !== 'info' && l1Severity !== 'low' ? l1Repair(l1) : '']
    .filter((part) => part.length > 0);
  return {
    verdict,
    severity,
    reason: (reasonParts.join('；') || '判定完成').slice(0, 2000),
    repair_hint: (repairParts.join('；') || '').slice(0, 1000),
    evidence_refs: l2.evidence_refs,
  };
}
