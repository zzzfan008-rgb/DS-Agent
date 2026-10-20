import type { RiskLevel } from '@/lib/contracts';
import { Icon } from '@/components/common/Icon';
import styles from './approvals.module.css';

export interface DecisionBarProps {
  level: RiskLevel;
  allowedDecisions: string[];
}

const DECISION_LABELS: Record<string, string> = {
  approve: '批准并执行',
  approve_with_edit: '修改后批准',
  reject: '驳回',
  schedule: '预约执行',
};

/**
 * M1 只读决策区（队长确认 Q2）：
 * - C 级不渲染任何决策按钮（V3），只留不可逆声明；
 * - A/B 渲染 disabled + "决策将在 M4 接入"；
 * - 永远不发写请求。
 */
export function DecisionBar({ level, allowedDecisions }: DecisionBarProps) {
  if (level === 'C') {
    return (
      <div className={styles.decisionBar} role="note">
        <div className={styles.decisionNote}>
          <Icon name="lock" size={15} />
          <span>
            C 级不可逆：M1 只读。M4 执行需滚动阅读 → 勾选知晓 → 一次性 confirm-token → 双人确认。
          </span>
        </div>
      </div>
    );
  }

  const decisions = allowedDecisions.length > 0 ? allowedDecisions : ['approve', 'reject'];
  return (
    <div className={styles.decisionBar} role="note">
      <div className={styles.decisionNote}>
        <Icon name="lock" size={15} />
        <span>只读模式：决策将在 M4 接入；M1 不发送任何写请求。</span>
      </div>
      <div className={styles.decisionActions}>
        {decisions
          .filter((decision) => DECISION_LABELS[decision])
          .map((decision) => (
            <button
              key={decision}
              type="button"
              className={decision === 'reject' ? 'buttonSecondary' : 'buttonPrimary'}
              disabled
              title="决策将在 M4 接入"
            >
              {DECISION_LABELS[decision]}
            </button>
          ))}
      </div>
    </div>
  );
}
