'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { ApiFailure } from '@/lib/api';
import { fetchProductList } from '@/lib/products-client';
import { isApiFailure, redirectToLogin } from '@/lib/m3-api';
import { PRODUCT_STATUS_LABEL } from '@/lib/m3-format';
import { Chip, PendingAggregate } from '@/components/m3/M3Ui';
import { PageHeader } from '@/components/common/PageHeader';
import { Icon } from '@/components/common/Icon';
import { EmptyState } from '@/components/states/EmptyState';
import { ErrorState } from '@/components/states/ErrorState';
import { Skeleton } from '@/components/states/Skeleton';
import type { ProductListItem, ProductStatus } from '@/lib/m3-types';
import styles from './products.module.css';
import m3 from '@/components/m3/m3.module.css';

type StatusFilter = ProductStatus | '';

export interface ProductsViewProps {
  canWrite: boolean;
  canImport: boolean;
}

function PlatformCell({ item, platform }: { item: ProductListItem; platform: 'pdd' | '1688' }) {
  const state = item.platform_states?.[platform];
  if (!state) {
    return <PendingAggregate label="待聚合" />;
  }
  const status = state.status ?? state.platform_state ?? 'unknown';
  return (
    <Chip
      tone={status === 'published' ? 'success' : status === 'rejected' ? 'danger' : status === 'publishing' ? 'info' : 'neutral'}
      title={state.platform_state ? `platform_state: ${state.platform_state}` : undefined}
    >
      {status}
    </Chip>
  );
}

function MissingFieldsCell({ item }: { item: ProductListItem }) {
  if (!Array.isArray(item.missing_fields)) return <PendingAggregate label="待聚合" />;
  if (item.missing_fields.length === 0) return <span className={m3.muted}>—</span>;
  return (
    <span className={styles.missingRow}>
      {item.missing_fields.slice(0, 2).map((field) => (
        <Chip key={field} tone="warning" title={field}>
          {field}
        </Chip>
      ))}
      {item.missing_fields.length > 2 ? (
        <span className={m3.muted}>+{item.missing_fields.length - 2}</span>
      ) : null}
    </span>
  );
}

export function ProductsView({ canWrite, canImport }: ProductsViewProps) {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [debounced, setDebounced] = useState({ q: '', category: '', status: '' as StatusFilter });
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<string | null>>([]);
  const [items, setItems] = useState<ProductListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced({ q, category, status });
      setCursor(null);
      setHistory([]);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [q, category, status]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchProductList({
      q: debounced.q,
      category_code: debounced.category,
      status: debounced.status,
      cursor,
      limit: 20,
    })
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setNextCursor(result.nextCursor);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (isApiFailure(caught)) {
          if (caught.status === 401) {
            redirectToLogin();
            return;
          }
          setError(caught);
          return;
        }
        setError({
          ok: false,
          status: 0,
          code: 'network_error',
          message: '无法连接商品接口',
          requestId: null,
          nextAction: 'retry_later',
          retryable: true,
          detail: null,
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, cursor, refreshToken]);

  const filtered = useMemo(
    () => Boolean(q || category || status),
    [q, category, status],
  );

  const goNext = () => {
    if (!nextCursor) return;
    setHistory((previous) => [...previous, cursor]);
    setCursor(nextCursor);
  };

  const goPrev = () => {
    if (history.length === 0) return;
    const previous = history[history.length - 1] ?? null;
    setHistory((stack) => stack.slice(0, -1));
    setCursor(previous);
  };

  const clearFilters = () => {
    setQ('');
    setCategory('');
    setStatus('');
  };

  return (
    <div className={m3.pageStack}>
      <PageHeader
        title="商品库"
        description="SPU/SKU 主数据、尺码表、面料成分与平台属性。列表平台态/缺失字段由后端聚合（t28），未就绪时显示“待聚合”，不展示推断值。"
        badges={<span className="badge badgeM1">M3</span>}
        actions={
          <>
            {canImport ? (
              <Link className="buttonSecondary" href="/products/import">
                <Icon name="database" size={15} />
                导入 CSV
              </Link>
            ) : null}
            {canWrite ? (
              <Link className="buttonPrimary" href="/products/new">
                <Icon name="product" size={15} />
                新建商品
              </Link>
            ) : null}
          </>
        }
      />

      <div className={m3.card}>
        <div className={m3.cardBody}>
          <div className={m3.toolbar}>
            <div className={m3.toolbarGroup}>
              <Icon name="search" size={15} />
              <input
                className={`${m3.searchInput}`}
                type="search"
                aria-label="搜索 SPU 或商品名称"
                placeholder="搜索 SPU / 名称"
                value={q}
                onChange={(event) => setQ(event.target.value)}
              />
            </div>
            <div className={m3.toolbarGroup}>
              <span className={m3.muted}>类目</span>
              <input
                className={`${m3.input} ${styles.categoryInput}`}
                aria-label="类目编码"
                placeholder="如 A0101"
                value={category}
                onChange={(event) => setCategory(event.target.value.toUpperCase())}
              />
            </div>
            <div className={m3.toolbarGroup}>
              <span className={m3.muted}>状态</span>
              <select
                className={m3.select}
                aria-label="商品状态"
                value={status}
                onChange={(event) => setStatus(event.target.value as StatusFilter)}
              >
                <option value="">全部</option>
                {Object.entries(PRODUCT_STATUS_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="buttonQuiet"
              onClick={clearFilters}
              disabled={!filtered}
            >
              清除筛选
            </button>
            <button
              type="button"
              className={`buttonSecondary ${m3.right}`}
              onClick={() => setRefreshToken((value) => value + 1)}
            >
              <Icon name="refresh" size={15} />
              刷新
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <ErrorState
          title="商品列表加载失败"
          code={error.code}
          message={error.message}
          requestId={error.requestId}
          nextAction={error.nextAction}
          onRetry={() => setRefreshToken((value) => value + 1)}
        />
      ) : loading ? (
        <Skeleton variant="table" rows={8} label="商品列表加载中" />
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState
            kind="filtered"
            title="无匹配结果"
            description="当前筛选条件下没有商品；清除筛选可恢复完整列表。"
            primaryAction={
              <button type="button" className="buttonSecondary" onClick={clearFilters}>
                清除筛选
              </button>
            }
          />
        ) : (
          <EmptyState
            title="还没有商品"
            description="通过 CSV 导入现有商品，或手工创建一个商品。尺码表必须在创建时一并提供（后端强制）。"
            icon="product"
            primaryAction={
              canImport ? (
                <Link className="buttonPrimary" href="/products/import">
                  导入 CSV
                </Link>
              ) : undefined
            }
            secondaryLink={canWrite ? <Link href="/products/new">新建商品</Link> : undefined}
          />
        )
      ) : (
        <>
          <div className={styles.tableCard}>
            <div className={m3.tableWrap}>
              <table className={m3.table}>
                <caption>商品列表</caption>
                <thead>
                  <tr>
                    <th scope="col">SPU</th>
                    <th scope="col">名称</th>
                    <th scope="col">类目</th>
                    <th scope="col">SKU / 色</th>
                    <th scope="col">尺码版本</th>
                    <th scope="col">PDD</th>
                    <th scope="col">1688</th>
                    <th scope="col">缺失字段</th>
                    <th scope="col">更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">
                        <Link className={styles.spuLink} href={`/products/${item.id}`}>
                          {item.spu_code}
                        </Link>
                      </th>
                      <td>
                        <Link className={styles.nameLink} href={`/products/${item.id}`}>
                          {item.name}
                        </Link>
                      </td>
                      <td className={m3.mono}>{item.category_code}</td>
                      <td>
                        {item.sku_count} / {item.color_count}
                      </td>
                      <td>{item.size_chart_version > 0 ? `v${item.size_chart_version}` : '—'}</td>
                      <td>
                        <PlatformCell item={item} platform="pdd" />
                      </td>
                      <td>
                        <PlatformCell item={item} platform="1688" />
                      </td>
                      <td>
                        <MissingFieldsCell item={item} />
                      </td>
                      <td className={m3.muted}>{item.updated_at ? item.updated_at.slice(0, 16).replace('T', ' ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className={styles.pager}>
            <button
              type="button"
              className="buttonSecondary"
              onClick={goPrev}
              disabled={history.length === 0 || loading}
            >
              上一页
            </button>
            <span className={m3.muted}>本页 {items.length} 条</span>
            <button
              type="button"
              className="buttonSecondary"
              onClick={goNext}
              disabled={!nextCursor || loading}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </div>
  );
}
