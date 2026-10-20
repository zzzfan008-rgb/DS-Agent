'use client';

import Link from 'next/link';
import type { ApprovalListItem } from '@/lib/contracts';
import { actionLabel, statusLabel } from '@/lib/approval-view';
import { formatMinutes, middleTruncate, platformLabel } from '@/lib/format';
import { ApprovalBadge } from './ApprovalBadge';
import { SlaCountdown } from './SlaCountdown';
import styles from './approvals.module.css';

export interface ApprovalQueueProps {
  items: ApprovalListItem[];
  selectedId: string | null;
  source: 'api' | 'demo';
  desktop: boolean;
  onSelect: (id: string) => void;
}

function waitedMinutes(requestedAt: string | null | undefined): number | null {
  if (!requestedAt) return null;
  const requested = new Date(requestedAt).getTime();
  if (Number.isNaN(requested)) return null;
  return Math.max(0, Math.round((Date.now() - requested) / 60_000));
}

export function ApprovalQueue({ items, selectedId, source, desktop, onSelect }: ApprovalQueueProps) {
  return (
    <ul className={styles.queueList} aria-label="审批队列">
      {items.map((item) => {
        const selected = item.id === selectedId;
        const waited = waitedMinutes(item.requested_at);
        const notes = item.risk_notes ?? [];
        return (
          <li
            key={item.id}
            id={`approval-row-${item.id}`}
            className={`${styles.row} ${item.level === 'C' ? styles.rowC : ''} ${selected ? styles.rowSelected : ''}`}
            aria-current={selected ? 'true' : undefined}
          >
            <Link
              href={`/approvals/${item.id}`}
              className={styles.rowLink}
              onClick={(event) => {
                if (desktop) {
                  event.preventDefault();
                  onSelect(item.id);
                }
              }}
            >
              <span className={styles.rowTop}>
                <ApprovalBadge level={item.level} compact />
                <span className={styles.actionName}>{actionLabel(item.action)}</span>
                {item.status !== 'pending' ? (
                  <span className={styles.statusChip}>{statusLabel(item.status)}</span>
                ) : null}
                {source === 'demo' ? <span className={styles.rowDemo}>DEMO</span> : null}
                <SlaCountdown dueAt={item.sla_due_at} status={item.status} compact />
              </span>
              <span className={styles.rowMeta}>
                <code>{item.action}</code>
                <span className={styles.dot}>·</span>
                {platformLabel(item.platform)}
                <span className={styles.dot}>·</span>
                {item.object_type} {middleTruncate(item.object_id, 8, 4)}
                <span className={styles.dot}>·</span>
                请求人 {item.requested_by ?? '—'}
                {waited !== null ? (
                  <>
                    <span className={styles.dot}>·</span>
                    已等 {formatMinutes(waited)}
                  </>
                ) : null}
              </span>
              {notes.length > 0 ? (
                <span className={styles.rowNotes}>
                  {notes.slice(0, 2).map((note) => (
                    <span className={styles.noteChip} key={note}>
                      {note}
                    </span>
                  ))}
                  {notes.length > 2 ? (
                    <span className={styles.noteMore}>+{notes.length - 2}</span>
                  ) : null}
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
