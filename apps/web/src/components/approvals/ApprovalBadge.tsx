import type { RiskLevel } from '@/lib/contracts';
import { riskIcon, riskLabel } from '@/lib/approval-view';
import styles from './approvals.module.css';

export interface ApprovalBadgeProps {
  level: RiskLevel;
  compact?: boolean;
}

/** A/B/C 三重编码：颜色（token）+ 图标（↺/⚠/⛔）+ 文字，不允许只靠颜色。 */
export function ApprovalBadge({ level, compact = false }: ApprovalBadgeProps) {
  return (
    <span
      className={`${styles.riskBadge} ${styles[`risk${level}`] ?? ''} ${compact ? styles.riskBadgeSm : ''}`}
      aria-label={`风险级别：${riskLabel(level)}`}
    >
      <span className={styles.riskGlyph} aria-hidden="true">
        {riskIcon(level)}
      </span>
      <span>{riskLabel(level)}</span>
    </span>
  );
}
