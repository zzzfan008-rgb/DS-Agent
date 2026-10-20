'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ApprovalDetailView, ApprovalListItem } from '@/lib/contracts';
import { failureFromUnknown, type ApiFailure } from '@/lib/api';
import { isApiFailure, loadApprovalDetail, loadApprovals, type ApprovalsSource } from '@/lib/approvals-client';
import { normalizeApprovalDetail } from '@/lib/approval-view';
import { formatMinutes } from '@/lib/format';
import { useMediaQuery } from '@/lib/use-media-query';
import { isEditableTarget, useShortcutsEnabled } from '@/lib/shortcuts';
import { PageHeader } from '@/components/common/PageHeader';
import { Icon } from '@/components/common/Icon';
import { AsyncSection } from '@/components/states/AsyncSection';
import { EmptyState } from '@/components/states/EmptyState';
import { ErrorState } from '@/components/states/ErrorState';
import { Skeleton } from '@/components/states/Skeleton';
import { ApprovalDetail } from './ApprovalDetail';
import { ApprovalQueue } from './ApprovalQueue';
import { DemoDataBanner } from './DemoDataBanner';
import styles from './approvals.module.css';

const FILTER_KEY = 'dssaas.approvals.filters';
const SCROLL_KEY = 'dssaas.approvals.scroll';

type LevelFilter = 'all' | 'A' | 'B' | 'C';
type PlatformFilter = 'all' | 'pdd' | '1688';
type StatusFilter = 'pending' | 'all' | 'approved' | 'rejected';

interface Filters {
  level: LevelFilter;
  platform: PlatformFilter;
  status: StatusFilter;
  overdueOnly: boolean;
  mineOnly: boolean;
  q: string;
}

const DEFAULT_FILTERS: Filters = {
  level: 'all',
  platform: 'all',
  status: 'pending',
  overdueOnly: false,
  mineOnly: false,
  q: '',
};

const LEVEL_RANK: Record<string, number> = { C: 0, B: 1, A: 2 };

function dueTime(item: ApprovalListItem): number {
  if (!item.sla_due_at) return Number.POSITIVE_INFINITY;
  const time = new Date(item.sla_due_at).getTime();
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

function isFiltered(filters: Filters): boolean {
  return (
    filters.level !== DEFAULT_FILTERS.level ||
    filters.platform !== DEFAULT_FILTERS.platform ||
    filters.status !== DEFAULT_FILTERS.status ||
    filters.overdueOnly ||
    filters.mineOnly ||
    filters.q.trim() !== ''
  );
}

export interface ApprovalsViewProps {
  currentUserName: string;
}

/**
 * 审批中心（M1 只读）：真实 API 优先，404 回退演示数据；其余错误一律错误态。
 * 桌面为队列 + 详情并排；<1024 队列全宽，行点击进入独立详情页。
 */
export function ApprovalsView({ currentUserName }: ApprovalsViewProps) {
  const router = useRouter();
  const desktop = useMediaQuery('(min-width: 1024px)');
  const shortcutsEnabled = useShortcutsEnabled();

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [restored, setRestored] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [items, setItems] = useState<ApprovalListItem[]>([]);
  const [source, setSource] = useState<ApprovalsSource>('api');
  const [metaData, setMetaData] = useState<{
    pending_count?: number;
    oldest_wait_minutes?: number;
    overdue_count?: number;
  }>({});
  const [listState, setListState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [listError, setListError] = useState<ApiFailure | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApprovalDetailView | null>(null);
  const [detailSource, setDetailSource] = useState<ApprovalsSource>('api');
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'error' | 'notfound' | 'ready'>('idle');
  const [detailError, setDetailError] = useState<ApiFailure | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);

  const goLogin = useCallback(() => {
    const here = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/login?return_url=${encodeURIComponent(here)}`);
  }, []);

  const handleFailure = useCallback(
    (error: unknown, setter: (failure: ApiFailure) => void) => {
      if (isApiFailure(error)) {
        if (error.status === 401) {
          goLogin();
          return;
        }
        setter(error);
        return;
      }
      setter(failureFromUnknown(error));
    },
    [goLogin],
  );

  /* 恢复筛选与滚动位置（窄屏详情返回时保留上下文）。 */
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(FILTER_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Filters>;
        setFilters({ ...DEFAULT_FILTERS, ...parsed });
      }
    } catch {
      // 忽略损坏的本地偏好
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      window.sessionStorage.setItem(FILTER_KEY, JSON.stringify(filters));
    } catch {
      // 隐私模式下不阻塞
    }
  }, [filters, restored]);

  /* 列表加载。 */
  useEffect(() => {
    let cancelled = false;
    setListState('loading');
    setListError(null);
    loadApprovals()
      .then((load) => {
        if (cancelled) return;
        setSource(load.source);
        setItems(load.data.items);
        setMetaData({
          pending_count: load.data.meta?.pending_count,
          oldest_wait_minutes: load.data.meta?.oldest_wait_minutes,
          overdue_count: load.data.meta?.overdue_count,
        });
        setListState('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        handleFailure(error, (failure) => {
          setListError(failure);
          setListState('error');
        });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken, handleFailure]);

  /* 滚动位置恢复/保存。 */
  useEffect(() => {
    if (listState !== 'ready') return;
    try {
      const saved = window.sessionStorage.getItem(SCROLL_KEY);
      if (saved) {
        window.scrollTo(0, Number(saved) || 0);
        window.sessionStorage.removeItem(SCROLL_KEY);
      }
    } catch {
      // ignore
    }
  }, [listState]);

  useEffect(() => {
    return () => {
      try {
        window.sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
      } catch {
        // ignore
      }
    };
  }, []);

  const visibleItems = useMemo(() => {
    const query = filters.q.trim().toLowerCase();
    return items
      .filter((item) => {
        if (filters.level !== 'all' && item.level !== filters.level) return false;
        if (filters.platform !== 'all' && item.platform !== filters.platform) return false;
        if (filters.status !== 'all' && item.status !== filters.status) return false;
        if (filters.overdueOnly && !item.overdue) return false;
        if (filters.mineOnly && item.assignee !== currentUserName) return false;
        if (query) {
          const haystack = [
            item.id,
            item.action,
            item.object_id,
            item.requested_by ?? '',
            ...(item.risk_notes ?? []),
          ]
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const level = (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9);
        if (level !== 0) return level;
        return dueTime(a) - dueTime(b);
      });
  }, [items, filters, currentUserName]);

  const pendingCount =
    metaData.pending_count ?? items.filter((item) => item.status === 'pending').length;
  const overdueCount =
    metaData.overdue_count ??
    items.filter((item) => item.status === 'pending' && item.overdue).length;
  const oldestWait =
    metaData.oldest_wait_minutes ??
    items.reduce((max, item) => {
      if (item.status !== 'pending' || !item.requested_at) return max;
      const requested = new Date(item.requested_at).getTime();
      if (Number.isNaN(requested)) return max;
      return Math.max(max, Math.round((Date.now() - requested) / 60_000));
    }, 0);

  /* 选中项跟随筛选结果（仅桌面需要右栏详情）。 */
  useEffect(() => {
    if (!desktop || listState !== 'ready') {
      if (!desktop) setSelectedId(null);
      return;
    }
    setSelectedId((previous) => {
      if (previous && visibleItems.some((item) => item.id === previous)) return previous;
      return visibleItems[0]?.id ?? null;
    });
  }, [desktop, listState, visibleItems]);

  /* 详情加载（桌面右栏）。 */
  useEffect(() => {
    if (!desktop || !selectedId) {
      setDetail(null);
      setDetailState('idle');
      return;
    }
    let cancelled = false;
    setDetailState('loading');
    setDetailError(null);
    loadApprovalDetail(selectedId)
      .then((load) => {
        if (cancelled) return;
        setDetail(normalizeApprovalDetail(load.detail));
        setDetailSource(load.source);
        setDetailState('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        handleFailure(error, (failure) => {
          setDetailError(failure);
          setDetailState(failure.code === 'not_found' || failure.status === 404 ? 'notfound' : 'error');
        });
      });
    return () => {
      cancelled = true;
    };
  }, [desktop, selectedId, detailNonce, handleFailure]);

  /* 键盘 j/k/Enter（可关闭；输入框内不触发）。 */
  useEffect(() => {
    if (!shortcutsEnabled || listState !== 'ready' || visibleItems.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      if (event.key !== 'j' && event.key !== 'k' && event.key !== 'Enter') return;
      const currentIndex = Math.max(
        0,
        visibleItems.findIndex((item) => item.id === selectedId),
      );
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault();
        const nextIndex =
          event.key === 'j'
            ? Math.min(visibleItems.length - 1, currentIndex + 1)
            : Math.max(0, currentIndex - 1);
        const next = visibleItems[nextIndex];
        if (next) {
          setSelectedId(next.id);
          document
            .getElementById(`approval-row-${next.id}`)
            ?.scrollIntoView({ block: 'nearest' });
        }
        return;
      }
      if (event.key === 'Enter' && selectedId) {
        event.preventDefault();
        router.push(`/approvals/${selectedId}`);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcutsEnabled, listState, visibleItems, selectedId, router]);

  const updateFilters = <Key extends keyof Filters>(key: Key, value: Filters[Key]) => {
    setFilters((previous) => ({ ...previous, [key]: value }));
  };

  const clearFilters = () => setFilters(DEFAULT_FILTERS);

  return (
    <div className={styles.page}>
      <PageHeader
        title="审批中心"
        description="A/B/C 三级审批队列与 SLA。M1 只读：不提供批准、驳回、批量或预约执行；决策将在 M4 接入。"
        badges={
          <>
            <span className="badge badgeM1">M1 只读</span>
            {source === 'demo' ? <span className="badge badgeDemo">DEMO</span> : null}
          </>
        }
        actions={
          <button
            type="button"
            className="buttonSecondary"
            onClick={() => setRefreshToken((value) => value + 1)}
          >
            <Icon name="refresh" size={15} />
            刷新
          </button>
        }
      />

      <div className={styles.stats} aria-label="审批概览">
        <div className={styles.stat}>
          <span className={styles.statValue}>{listState === 'ready' ? pendingCount : '—'}</span>
          <span className={styles.statLabel}>待处理</span>
        </div>
        <span className={styles.statDivider} aria-hidden="true" />
        <div className={styles.stat}>
          <span className={styles.statValue}>
            {listState === 'ready' ? formatMinutes(oldestWait) : '—'}
          </span>
          <span className={styles.statLabel}>最老等待</span>
        </div>
        <span className={styles.statDivider} aria-hidden="true" />
        <div className={styles.stat}>
          <span
            className={`${styles.statValue} ${listState === 'ready' && overdueCount > 0 ? styles.statDanger : ''}`}
          >
            {listState === 'ready' ? overdueCount : '—'}
          </span>
          <span className={styles.statLabel}>已超时</span>
        </div>
        <span className={styles.statDivider} aria-hidden="true" />
        <div className={styles.stat}>
          <span className={styles.statValue}>0</span>
          <span className={styles.statLabel}>今日未审批写（M1 无写入口）</span>
        </div>
      </div>

      {source === 'demo' ? <DemoDataBanner /> : null}

      <div className={styles.filters}>
        <div className={styles.filterGroup} role="group" aria-label="按风险级别筛选">
          <span className={styles.filterLabel}>级别</span>
          <div className={styles.segmented}>
            {(
              [
                ['all', '全部'],
                ['A', 'A 可逆'],
                ['B', 'B 不可撤回'],
                ['C', 'C 不可逆'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={filters.level === value ? styles.segmentActive : undefined}
                aria-pressed={filters.level === value}
                onClick={() => updateFilters('level', value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <label className={styles.selectGroup}>
          <span className={styles.filterLabel}>平台</span>
          <select
            value={filters.platform}
            onChange={(event) =>
              updateFilters('platform', event.target.value as PlatformFilter)
            }
          >
            <option value="all">全部</option>
            <option value="pdd">拼多多</option>
            <option value="1688">1688</option>
          </select>
        </label>

        <label className={styles.selectGroup}>
          <span className={styles.filterLabel}>状态</span>
          <select
            value={filters.status}
            onChange={(event) => updateFilters('status', event.target.value as StatusFilter)}
          >
            <option value="pending">待处理</option>
            <option value="approved">已批准</option>
            <option value="rejected">已驳回</option>
            <option value="all">全部</option>
          </select>
        </label>

        <label className={styles.check}>
          <input
            type="checkbox"
            checked={filters.overdueOnly}
            onChange={(event) => updateFilters('overdueOnly', event.target.checked)}
          />
          仅超时
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={filters.mineOnly}
            onChange={(event) => updateFilters('mineOnly', event.target.checked)}
          />
          只看我的
        </label>

        <div className={styles.searchGroup}>
          <div className={styles.search}>
            <Icon name="search" size={15} />
            <input
              type="search"
              value={filters.q}
              placeholder="搜索动作 / 对象 / 申请人"
              aria-label="搜索审批"
              onChange={(event) => updateFilters('q', event.target.value)}
            />
          </div>
          <button
            type="button"
            className="buttonQuiet"
            onClick={clearFilters}
            disabled={!isFiltered(filters)}
          >
            清除筛选
          </button>
        </div>
      </div>

      {listState === 'error' ? (
        <ErrorState
          title="审批队列加载失败"
          code={listError?.code}
          message={listError?.message}
          requestId={listError?.requestId}
          nextAction={listError?.nextAction}
          onRetry={() => setRefreshToken((value) => value + 1)}
        />
      ) : (
        <div className={`${styles.layout} ${!desktop ? styles.layoutSingle : ''}`}>
          <section className={styles.queuePanel} aria-label="审批队列">
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>队列</h2>
              <span className={styles.panelCount}>{visibleItems.length} 项</span>
              {desktop && shortcutsEnabled ? (
                <span className={styles.keyHint}>
                  <kbd>j</kbd>
                  <kbd>k</kbd> 移动 · <kbd>Enter</kbd> 打开
                </span>
              ) : null}
            </div>

            {listState === 'loading' ? <Skeleton rows={6} /> : null}

            {listState === 'ready' && items.length === 0 ? (
              <EmptyState
                title="队列已清空"
                description="当前没有待处理审批；新的审批创建后会通过 SSE 角标提醒（M4 接入）。"
                icon="check"
              />
            ) : null}

            {listState === 'ready' && items.length > 0 && visibleItems.length === 0 ? (
              <EmptyState
                kind="filtered"
                title="无匹配结果"
                description="当前筛选条件下没有审批项；清除筛选可恢复完整队列。"
                primaryAction={
                  <button type="button" className="buttonSecondary" onClick={clearFilters}>
                    清除筛选
                  </button>
                }
              />
            ) : null}

            {listState === 'ready' && visibleItems.length > 0 ? (
              <ApprovalQueue
                items={visibleItems}
                selectedId={selectedId}
                source={source}
                desktop={desktop}
                onSelect={setSelectedId}
              />
            ) : null}
          </section>

          {desktop ? (
            <section className={styles.detailPanel} aria-label="审批详情">
              <AsyncSection
                state={
                  detailState === 'loading'
                    ? 'loading'
                    : detailState === 'error'
                      ? 'error'
                      : detailState === 'notfound' || detailState === 'idle'
                        ? 'empty'
                        : 'ready'
                }
                error={detailError}
                skeletonVariant="detail"
                onRetry={() => setDetailNonce((value) => value + 1)}
                empty={
                  detailState === 'notfound' ? (
                    <EmptyState
                      title="审批不存在或已处理"
                      description="该审批可能已被他人处理或链接已过期。刷新队列后重试。"
                      primaryAction={
                        <button
                          type="button"
                          className="buttonSecondary"
                          onClick={() => setRefreshToken((value) => value + 1)}
                        >
                          刷新队列
                        </button>
                      }
                    />
                  ) : (
                    <EmptyState
                      title="从左侧选择一个审批项"
                      description="M1 只读：可查看风险评估、diff、事实来源与历史，不提供决策。"
                      icon="list"
                    />
                  )
                }
              >
                {detail && detailState === 'ready' ? (
                  <>
                    {detailSource === 'demo' && source !== 'demo' ? (
                      <DemoDataBanner variant="inline" />
                    ) : null}
                    <ApprovalDetail detail={detail} demo={detailSource === 'demo'} />
                  </>
                ) : null}
              </AsyncSection>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
