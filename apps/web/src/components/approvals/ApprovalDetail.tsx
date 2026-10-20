import type { ApprovalDetailView } from '@/lib/contracts';
import { formatDateTime, middleTruncate, platformLabel } from '@/lib/format';
import { statusLabel } from '@/lib/approval-view';
import { Icon } from '@/components/common/Icon';
import { ApprovalBadge } from './ApprovalBadge';
import { DecisionBar } from './DecisionBar';
import { DiffTable } from './DiffTable';
import { FactSourceChips } from './FactSourceChips';
import { SlaCountdown } from './SlaCountdown';
import styles from './approvals.module.css';

export interface ApprovalDetailProps {
  detail: ApprovalDetailView;
  demo: boolean;
}

const C_IRREVERSIBLE_TEXT =
  '提交后不可撤回；平台侧可能触发重新审核、搜索降权或活动中掉线，系统不提供回滚。';
const B_IRREVERSIBLE_TEXT =
  '提交后不可整体回滚；平台写入可能产生不可逆影响，必要时需建立补偿工单止损。';

/** 审批详情：事实来源 → 影响面 → diff → 风险 → 双人 → 审计 → 历史 → 决策（只读）。 */
export function ApprovalDetail({ detail, demo }: ApprovalDetailProps) {
  const critical = detail.level === 'C';
  const riskBanner = critical
    ? C_IRREVERSIBLE_TEXT
    : detail.level === 'B'
      ? B_IRREVERSIBLE_TEXT
      : null;

  return (
    <article className={styles.detail} aria-labelledby={`approval-title-${detail.id}`}>
      <header className={styles.detailHeader}>
        <div className={styles.detailTitleRow}>
          <ApprovalBadge level={detail.level} />
          <h2 className={styles.detailTitle} id={`approval-title-${detail.id}`}>
            {detail.action_label}
          </h2>
          {detail.status !== 'pending' ? (
            <span className={styles.statusChip}>{statusLabel(detail.status)}</span>
          ) : null}
          {demo ? <span className="badge badgeDemo">DEMO</span> : null}
        </div>
        <p className={styles.detailMeta}>
          <code>{detail.action}</code>
          <span className={styles.dot}>·</span>
          {platformLabel(detail.platform)}
          <span className={styles.dot}>·</span>
          {detail.object_type} {middleTruncate(detail.object_id, 12, 6)}
        </p>
        <p className={styles.detailMeta}>
          请求人 {detail.requested_by ?? '—'} · {formatDateTime(detail.requested_at)}
          {detail.batch_id ? (
            <>
              <span className={styles.dot}>·</span>
              批次 {middleTruncate(detail.batch_id, 8, 4)}
            </>
          ) : null}
        </p>
        <div className={styles.detailSlaRow}>
          <SlaCountdown dueAt={detail.sla_due_at} status={detail.status} />
          {detail.expires_at ? (
            <span className={styles.expires}>
              审批有效期：{formatDateTime(detail.expires_at)}
            </span>
          ) : null}
        </div>
      </header>

      {riskBanner ? (
        <section
          className={`${styles.riskBanner} ${critical ? styles.riskBannerC : styles.riskBannerB}`}
          aria-label={critical ? 'C 级不可逆警告' : 'B 级不可撤回警告'}
        >
          <div className={styles.riskBannerHead}>
            <Icon name="alert" size={17} />
            <strong>{critical ? '不可逆操作（C 级）' : '不可撤回操作（B 级）'}</strong>
          </div>
          <p>{riskBanner}</p>
          {detail.window_hint ? (
            <p className={styles.windowHint}>建议执行窗口：{detail.window_hint}</p>
          ) : null}
          {!critical && !detail.window_hint ? (
            <p className={styles.windowHint}>建议在低峰期执行，并在执行后 30 分钟内对账。</p>
          ) : null}
        </section>
      ) : null}

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>影响面</h3>
        {detail.impact_scope.length > 0 ? (
          <dl className={styles.impactGrid}>
            {detail.impact_scope.map((item) => (
              <div className={styles.impactItem} key={item.key}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className={styles.mutedText}>未返回影响面数据（M4 前后端补齐 risk_meta.impact_scope）。</p>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>平台现值 vs 变更</h3>
        <DiffTable rows={detail.diff} />
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>事实来源</h3>
        <FactSourceChips facts={detail.facts} />
      </section>

      {detail.risk_notes.length > 0 ? (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>风险提示</h3>
          <ul className={styles.noteList}>
            {detail.risk_notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {critical ? (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>双人信息</h3>
          <div className={styles.dualGrid}>
            <div>
              <span className={styles.dualLabel}>审批人</span>
              <strong>{detail.approver ?? '待指定'}</strong>
            </div>
            <div>
              <span className={styles.dualLabel}>执行人</span>
              <strong>{detail.executor ?? '待指定'}</strong>
            </div>
            <div className={styles.dualNote}>审批人 ≠ 执行人；缺少任一方时不可执行（docs/11 §6.4）。</div>
          </div>
        </section>
      ) : null}

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>审计关联</h3>
        <dl className={styles.auditGrid}>
          <div>
            <dt>request_id</dt>
            <dd>
              <code>{detail.request_id ?? '—'}</code>
            </dd>
          </div>
          <div>
            <dt>target_hash</dt>
            <dd>
              <code>{detail.target_hash ?? '—'}</code>
            </dd>
          </div>
          <div>
            <dt>历史同类操作</dt>
            <dd>{detail.history.length} 条</dd>
          </div>
        </dl>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>历史</h3>
        {detail.history.length > 0 ? (
          <ol className={styles.timeline}>
            {detail.history.map((item, index) => (
              <li key={`${item.at}-${index}`}>
                <span className={styles.timelineDot} aria-hidden="true" />
                <span className={styles.timelineAt}>{formatDateTime(item.at)}</span>
                <span className={styles.timelineActor}>{item.actor}</span>
                <span className={styles.timelineAction}>{item.action}</span>
                {item.comment ? <span className={styles.timelineComment}>{item.comment}</span> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.mutedText}>暂无历史记录。</p>
        )}
      </section>

      <DecisionBar level={detail.level} allowedDecisions={detail.allowed_decisions} />
    </article>
  );
}
