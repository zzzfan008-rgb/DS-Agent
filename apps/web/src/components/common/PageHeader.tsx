import type { ReactNode } from 'react';
import styles from './common.module.css';

export interface PageHeaderProps {
  title: string;
  description?: string;
  badges?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}

/** 页面标题区：标题 + 徽标 + 一句话职责 + 主操作（每页唯一主操作区）。 */
export function PageHeader({ title, description, badges, actions, meta }: PageHeaderProps) {
  return (
    <div className={styles.header}>
      <div className={styles.headerMain}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{title}</h1>
          {badges ? <div className={styles.badges}>{badges}</div> : null}
        </div>
        {description ? <p className={styles.description}>{description}</p> : null}
        {meta ? <div className={styles.meta}>{meta}</div> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
