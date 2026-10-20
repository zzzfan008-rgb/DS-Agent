'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { ApprovalDetailView } from '@/lib/contracts';
import { failureFromUnknown, type ApiFailure } from '@/lib/api';
import {
  isApiFailure,
  loadApprovalDetail,
  type ApprovalsSource,
} from '@/lib/approvals-client';
import { normalizeApprovalDetail } from '@/lib/approval-view';
import { Icon } from '@/components/common/Icon';
import { EmptyState } from '@/components/states/EmptyState';
import { ErrorState } from '@/components/states/ErrorState';
import { Skeleton } from '@/components/states/Skeleton';
import { ApprovalDetail } from './ApprovalDetail';
import { DemoDataBanner } from './DemoDataBanner';
import styles from './approvals.module.css';

export interface ApprovalDetailRouteProps {
  id: string;
}

/** 窄屏独立详情页（<1024 从列表导航进入）；桌面直接打开也复用。 */
export function ApprovalDetailRoute({ id }: ApprovalDetailRouteProps) {
  const [state, setState] = useState<'loading' | 'error' | 'notfound' | 'ready'>('loading');
  const [error, setError] = useState<ApiFailure | null>(null);
  const [source, setSource] = useState<ApprovalsSource>('api');
  const [detail, setDetail] = useState<ApprovalDetailView | null>(null);
  const [nonce, setNonce] = useState(0);

  const goLogin = useCallback(() => {
    const here = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/login?return_url=${encodeURIComponent(here)}`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setError(null);
    loadApprovalDetail(id)
      .then((load) => {
        if (cancelled) return;
        setDetail(normalizeApprovalDetail(load.detail));
        setSource(load.source);
        setState('ready');
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (isApiFailure(caught)) {
          if (caught.status === 401) {
            goLogin();
            return;
          }
          setError(caught);
          setState(caught.code === 'not_found' || caught.status === 404 ? 'notfound' : 'error');
          return;
        }
        setError(failureFromUnknown(caught));
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [id, nonce, goLogin]);

  return (
    <div className={styles.detailRoute}>
      <div className={styles.backRow}>
        <Link href="/approvals" className={styles.backLink}>
          <Icon name="arrowLeft" size={16} />
          返回审批列表
        </Link>
        {source === 'demo' ? <span className="badge badgeDemo">DEMO</span> : null}
      </div>

      {state === 'loading' ? <Skeleton variant="detail" /> : null}

      {state === 'error' ? (
        <ErrorState
          title="审批详情加载失败"
          code={error?.code}
          message={error?.message}
          requestId={error?.requestId}
          nextAction={error?.nextAction}
          onRetry={() => setNonce((value) => value + 1)}
        />
      ) : null}

      {state === 'notfound' ? (
        <EmptyState
          title="审批不存在或已处理"
          description="该审批可能已被他人处理或链接已过期。"
          primaryAction={
            <Link href="/approvals" className="buttonSecondary">
              返回审批列表
            </Link>
          }
        />
      ) : null}

      {state === 'ready' && detail ? (
        <>
          {source === 'demo' ? <DemoDataBanner /> : null}
          <ApprovalDetail detail={detail} demo={source === 'demo'} />
        </>
      ) : null}
    </div>
  );
}
