import type { FactChipView } from '@/lib/contracts';
import styles from './approvals.module.css';

export interface FactSourceChipsProps {
  facts: FactChipView[];
}

/**
 * 事实来源 chips（docs/13 D2）：必须可展开查看来源，不能是纯装饰标签。
 * 原生 <details> 保证键盘/读屏可用，失败状态由父级兜底。
 */
export function FactSourceChips({ facts }: FactSourceChipsProps) {
  if (facts.length === 0) {
    return <p className={styles.mutedText}>未返回事实来源快照（C 级不可提交，见 docs/13 §5.2）。</p>;
  }
  return (
    <div className={styles.factRow}>
      {facts.map((fact) => (
        <details className={styles.fact} key={fact.key}>
          <summary className={styles.factSummary}>
            {fact.label}
            <span className={styles.factHint} aria-hidden="true">
              查看
            </span>
          </summary>
          <div className={styles.factBody}>{fact.detail}</div>
        </details>
      ))}
    </div>
  );
}
