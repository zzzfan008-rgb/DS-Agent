import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/common/Icon';
import styles from './states.module.css';

export interface EmptyStateProps {
  title: string;
  description?: string;
  kind?: 'no-data' | 'filtered';
  icon?: IconName;
  primaryAction?: ReactNode;
  secondaryLink?: ReactNode;
}

/**
 * 统一空态（docs/13 §2.3）：必须说明"为什么空"，空数据与筛选空分开。
 */
export function EmptyState({
  title,
  description,
  kind = 'no-data',
  icon = 'inbox',
  primaryAction,
  secondaryLink,
}: EmptyStateProps) {
  return (
    <div className={styles.empty} data-kind={kind}>
      <div className={styles.emptyIcon}>
        <Icon name={kind === 'filtered' ? 'filter' : icon} size={20} />
      </div>
      <p className={styles.emptyTitle}>{title}</p>
      {description ? <p className={styles.emptyDesc}>{description}</p> : null}
      {primaryAction || secondaryLink ? (
        <div className={styles.actions}>
          {primaryAction}
          {secondaryLink ? <span className={styles.link}>{secondaryLink}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
