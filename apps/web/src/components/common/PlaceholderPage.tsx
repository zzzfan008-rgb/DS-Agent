import type { ReactNode } from 'react';
import Link from 'next/link';
import { EmptyState } from '@/components/states/EmptyState';
import { PageHeader } from './PageHeader';
import styles from './common.module.css';

export interface PlannedBlock {
  title: string;
  detail: string;
}

export interface PlaceholderBodyProps {
  blocks: PlannedBlock[];
  emptyTitle: string;
  emptyDescription: string;
  note?: string;
}

export interface PlaceholderPageProps extends PlaceholderBodyProps {
  title: string;
  description: string;
  milestone: string;
  badges?: ReactNode;
  actions?: ReactNode;
}

/** 占位页正文：规划区块 + 正向空态 + 说明；不渲染任何假数据。 */
export function PlaceholderBody({ blocks, emptyTitle, emptyDescription, note }: PlaceholderBodyProps) {
  return (
    <>
      <div className={styles.blockGrid}>
        {blocks.map((block, index) => (
          <section className={styles.blockCard} key={block.title}>
            <span className={styles.blockIndex} aria-hidden="true">
              {index + 1}
            </span>
            <h2 className={styles.blockTitle}>{block.title}</h2>
            <p className={styles.blockDetail}>{block.detail}</p>
          </section>
        ))}
      </div>

      <section className={styles.placeholderCard} aria-label="M1 占位">
        <div className={styles.placeholderBody}>
          <EmptyState
            title={emptyTitle}
            description={emptyDescription}
            icon="inbox"
            secondaryLink={<span>设计说明：工作区 docs/13 §3（M1 不提供在线文档）</span>}
          />
        </div>
      </section>

      {note ? <p className={styles.note}>{note}</p> : null}
    </>
  );
}

/** M1 统一占位模板（队长确认 Q3）。 */
export function PlaceholderPage({
  title,
  description,
  milestone,
  blocks,
  emptyTitle,
  emptyDescription,
  note,
  badges,
  actions,
}: PlaceholderPageProps) {
  return (
    <div className={styles.page}>
      <PageHeader
        title={title}
        description={description}
        badges={
          <>
            <span className="badge badgeM1">M1 骨架</span>
            <span className="badge">计划接入 {milestone}</span>
            {badges}
          </>
        }
        actions={actions}
      />
      <PlaceholderBody
        blocks={blocks}
        emptyTitle={emptyTitle}
        emptyDescription={emptyDescription}
        note={note}
      />
    </div>
  );
}

export interface TabItem {
  href: string;
  label: string;
  active: boolean;
}

export interface TabNavProps {
  items: TabItem[];
  label?: string;
}

/** 页内 tab（模型管理前台/后台、运营看板 dashboard/audit/settings）。 */
export function TabNav({ items, label = '页面视图' }: TabNavProps) {
  return (
    <nav className={styles.tabs} aria-label={label}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={`${styles.tab} ${item.active ? styles.tabActive : ''}`}
          aria-current={item.active ? 'page' : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
