'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { ApiFailure } from '@/lib/api';
import { fetchProduct } from '@/lib/products-client';
import { isApiFailure, redirectToLogin } from '@/lib/m3-api';
import { PRODUCT_STATUS_LABEL } from '@/lib/m3-format';
import { formatCents, formatDate, platformLabel } from '@/lib/format';
import { colorFamily, MEASUREMENT_COLUMNS } from '@/lib/garment-ui';
import type { ProductDetail, SizeChartRow } from '@/lib/m3-types';
import { Chip, SectionCard } from '@/components/m3/M3Ui';
import { Icon } from '@/components/common/Icon';
import { EmptyState } from '@/components/states/EmptyState';
import { ErrorState } from '@/components/states/ErrorState';
import { Skeleton } from '@/components/states/Skeleton';
import styles from './products.module.css';
import m3 from '@/components/m3/m3.module.css';

type TabId = 'overview' | 'size-chart' | 'fabric' | 'attributes' | 'media';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: '概览与 SKU' },
  { id: 'size-chart', label: '尺码表' },
  { id: 'fabric', label: '面料成分' },
  { id: 'attributes', label: '平台属性' },
  { id: 'media', label: '素材摘要' },
];

function measurementColumns(rows: SizeChartRow[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row.measurements ?? {})) keys.add(key);
  }
  const ordered = MEASUREMENT_COLUMNS.filter((column) => keys.has(column));
  const extras = [...keys].filter((key) => !(MEASUREMENT_COLUMNS as readonly string[]).includes(key)).sort();
  return [...ordered, ...extras];
}

export interface ProductDetailViewProps {
  productId: string;
}

export function ProductDetailView({ productId }: ProductDetailViewProps) {
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<TabId>('overview');
  const [version, setVersion] = useState<number | null>(null);
  const [platformTab, setPlatformTab] = useState<string>('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotFound(false);
    fetchProduct(productId)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        const versions = [...new Set(data.size_chart.map((row) => row.version_no))].sort((a, b) => b - a);
        setVersion(versions[0] ?? null);
        const platforms = [...new Set(data.attributes.map((attr) => attr.platform))];
        setPlatformTab(platforms[0] ?? '');
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (isApiFailure(caught)) {
          if (caught.status === 401) {
            redirectToLogin();
            return;
          }
          if (caught.status === 404) {
            setNotFound(true);
            return;
          }
          setError(caught);
          return;
        }
        setError({
          ok: false,
          status: 0,
          code: 'network_error',
          message: '无法连接商品详情接口',
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
  }, [productId, reload]);

  const versions = useMemo(() => {
    if (!detail) return [];
    return [...new Set(detail.size_chart.map((row) => row.version_no))].sort((a, b) => b - a);
  }, [detail]);
  const activeVersion = versions[0] ?? null;
  const currentRows = useMemo(
    () => (detail ? detail.size_chart.filter((row) => row.version_no === version) : []),
    [detail, version],
  );
  const columns = useMemo(() => measurementColumns(currentRows), [currentRows]);
  const platforms = useMemo(
    () => (detail ? [...new Set(detail.attributes.map((attr) => attr.platform))] : []),
    [detail],
  );
  const platformAttrs = useMemo(
    () => (detail ? detail.attributes.filter((attr) => attr.platform === platformTab) : []),
    [detail, platformTab],
  );
  const fabricGroups = useMemo(() => {
    if (!detail) return [];
    const groups = new Map<string, { label: string; items: typeof detail.fabric }>();
    for (const material of detail.fabric) {
      const key = material.note?.trim() || '未标注';
      const group = groups.get(key) ?? { label: key, items: [] };
      group.items.push(material);
      groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({
      ...group,
      total: group.items.reduce((sum, material) => sum + material.percent, 0),
    }));
  }, [detail]);

  if (loading) return <Skeleton variant="page" label="商品详情加载中" />;

  if (notFound) {
    return (
      <EmptyState
        title="商品不存在或已归档"
        description="链接可能已过期，或商品已被归档。"
        primaryAction={
          <Link className="buttonSecondary" href="/products">
            返回商品库
          </Link>
        }
      />
    );
  }

  if (error || !detail) {
    return (
      <ErrorState
        title="商品详情加载失败"
        code={error?.code}
        message={error?.message}
        requestId={error?.requestId}
        nextAction={error?.nextAction}
        onRetry={() => setReload((value) => value + 1)}
      />
    );
  }

  const { product } = detail;

  return (
    <div className={m3.pageStack}>
      <div className={styles.backRow}>
        <Link className={styles.backLink} href="/products">
          <Icon name="arrowLeft" size={15} />
          返回商品库
        </Link>
        <Link className="buttonSecondary" href={`/copy?product=${encodeURIComponent(product.id)}`}>
          <Icon name="copy" size={15} />
          去文案工作台
        </Link>
      </div>

      <div className={styles.detailHeader}>
        <div>
          <div className={styles.detailTitleRow}>
            <h1 className={styles.detailTitle}>{product.name}</h1>
            <Chip tone={product.status === 'active' ? 'success' : product.status === 'draft' ? 'warning' : 'neutral'}>
              {PRODUCT_STATUS_LABEL[product.status] ?? product.status}
            </Chip>
            <Chip tone="info">fact v{product.fact_version}</Chip>
          </div>
          <p className={styles.detailMeta}>
            <span className={m3.mono}>{product.spu_code}</span>
            <span>·</span>
            类目 <span className={m3.mono}>{product.category_code}</span>
            <span>·</span>
            fit {product.fit ?? '—'}
            <span>·</span>
            {detail.skus.length} SKU · {new Set(detail.skus.map((sku) => sku.color_id)).size} 色
          </p>
        </div>
      </div>

      <div className={styles.tabBar} role="tablist" aria-label="商品详情页签">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`${styles.tab} ${tab === item.id ? styles.tabActive : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'overview' ? (
        <>
          <SectionCard title="基本信息">
            <dl className={m3.infoGrid}>
              <div className={m3.infoItem}>
                <dt>SPU</dt>
                <dd className={m3.mono}>{product.spu_code}</dd>
              </div>
              <div className={m3.infoItem}>
                <dt>名称</dt>
                <dd>{product.name}</dd>
              </div>
              <div className={m3.infoItem}>
                <dt>类目</dt>
                <dd className={m3.mono}>{product.category_code}</dd>
              </div>
              <div className={m3.infoItem}>
                <dt>fit</dt>
                <dd>{product.fit ?? '—'}</dd>
              </div>
              <div className={m3.infoItem}>
                <dt>状态</dt>
                <dd>{PRODUCT_STATUS_LABEL[product.status] ?? product.status}</dd>
              </div>
              <div className={m3.infoItem}>
                <dt>描述</dt>
                <dd>{product.description ?? '—'}</dd>
              </div>
            </dl>
          </SectionCard>

          <SectionCard
            title={`SKU（${detail.skus.length}）`}
            description="色卡色块为色系示意，实物颜色以素材为准；价格来自主数据（整数分）。"
          >
            {detail.skus.length === 0 ? (
              <EmptyState title="没有 SKU" description="该商品当前没有有效 SKU。" />
            ) : (
              <div className={m3.tableWrap}>
                <table className={m3.table}>
                  <caption>SKU 列表</caption>
                  <thead>
                    <tr>
                      <th scope="col">色卡</th>
                      <th scope="col">尺码</th>
                      <th scope="col">SKU 编码</th>
                      <th scope="col">面料编码</th>
                      <th scope="col" className={m3.num}>
                        售价
                      </th>
                      <th scope="col" className={m3.num}>
                        划线价
                      </th>
                      <th scope="col" className={m3.num}>
                        促销价
                      </th>
                      <th scope="col" className={m3.num}>
                        库存
                      </th>
                      <th scope="col" className={m3.num}>
                        起批
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.skus.map((sku) => {
                      const color = colorFamily(sku.color_id);
                      return (
                        <tr key={sku.id}>
                          <th scope="row">
                            <span className={styles.colorCell} title="色系示意，实物以素材为准">
                              <span className={styles.swatch} style={{ background: color.swatch }} />
                              <span className={styles.colorMeta}>
                                <span>{sku.color_name}</span>
                                <span className={styles.colorCode}>
                                  {sku.color_id} · {color.label}
                                </span>
                              </span>
                            </span>
                          </th>
                          <td>{sku.size_code}</td>
                          <td className={m3.mono}>{sku.sku_code}</td>
                          <td className={m3.mono}>{sku.fabric_code ?? '—'}</td>
                          <td className={m3.num}>{formatCents(sku.price_cents)}</td>
                          <td className={m3.num}>{formatCents(sku.list_price_cents)}</td>
                          <td className={m3.num}>{formatCents(sku.sale_price_cents)}</td>
                          <td className={m3.num}>{sku.stock}</td>
                          <td className={m3.num}>{sku.min_order_qty}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </>
      ) : null}

      {tab === 'size-chart' ? (
        <SectionCard
          title="尺码表"
          description="一个商品同时只有一个生效版本；版本内每个尺码一行（多码多行）。"
          extra={
            versions.length > 0 ? (
              <div className={styles.versionTabs} role="group" aria-label="尺码表版本">
                {versions.map((versionNo) => (
                  <button
                    key={versionNo}
                    type="button"
                    className={`${styles.versionTab} ${version === versionNo ? styles.versionActive : ''}`}
                    aria-pressed={version === versionNo}
                    onClick={() => setVersion(versionNo)}
                  >
                    v{versionNo}
                    {versionNo === activeVersion ? ' · 生效中（推断）' : ' · 历史'}
                  </button>
                ))}
              </div>
            ) : null
          }
        >
          {currentRows.length === 0 ? (
            <EmptyState
              title="没有尺码表"
              description="该商品没有返回尺码表数据；创建 SKU 前后端要求尺码表已生效。"
            />
          ) : (
            <>
              <div className={styles.inferenceNote}>
                <Icon name="alert" size={14} />
                服务端未返回 status，按最高版本推断“生效中”；历史版本仅用于查看，不代表平台当前读取的版本。
              </div>
              <div className={styles.sizeTableWrap} style={{ marginTop: 10 }}>
                <table className={styles.sizeTable}>
                  <caption>尺码表 v{version ?? '—'}</caption>
                  <thead>
                    <tr>
                      <th scope="col">尺码</th>
                      {columns.map((column) => (
                        <th key={column} scope="col">
                          {column}（cm）
                        </th>
                      ))}
                      <th scope="col">建议身高</th>
                      <th scope="col">建议体重</th>
                      <th scope="col">生效日期</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentRows.map((row) => (
                      <tr key={`${row.version_no}-${row.sku_size_code}`}>
                        <th scope="row">{row.sku_size_code}</th>
                        {columns.map((column) => (
                          <td key={column}>{row.measurements[column] ?? '—'}</td>
                        ))}
                        <td>
                          {row.recommend_height_min ?? '—'}–{row.recommend_height_max ?? '—'}
                        </td>
                        <td>
                          {row.recommend_weight_min ?? '—'}–{row.recommend_weight_max ?? '—'}
                        </td>
                        <td>{formatDate(row.effective_from)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </SectionCard>
      ) : null}

      {tab === 'fabric' ? (
        <SectionCard
          title="面料成分"
          description="后端已按材质扁平返回，role/note 可能混用（G6）；这里按 note 分组展示，合计非 100 标红。"
        >
          {fabricGroups.length === 0 ? (
            <EmptyState title="没有成分数据" description="该商品没有返回 effective 面料成分。" />
          ) : (
            fabricGroups.map((group) => (
              <div className={styles.fabricGroup} key={group.label}>
                <div className={styles.fabricHead}>
                  <span className={styles.fabricTitle}>{group.label}</span>
                  <Chip tone={group.total === 100 ? 'success' : 'danger'}>合计 {group.total}%</Chip>
                </div>
                <div className={styles.fabricRows}>
                  {group.items.map((material, index) => (
                    <div className={styles.fabricRow} key={`${group.label}-${material.material}-${index}`}>
                      <span className={styles.fabricName}>{material.material}</span>
                      <span className={styles.fabricBar}>
                        <span
                          className={`${styles.fabricBarInner} ${group.total === 100 ? '' : styles.fabricBarWarn}`}
                          style={{ width: `${Math.min(100, Math.max(0, material.percent))}%` }}
                        />
                      </span>
                      <span className={styles.fabricPercent}>{material.percent}%</span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </SectionCard>
      ) : null}

      {tab === 'attributes' ? (
        <SectionCard
          title={`平台属性映射（${detail.attributes.length}）`}
          description="只展示后端已返回的映射字段；attr_type / 平台值名称 / 未映射清单当前未返回（G8）。"
          extra={
            platforms.length > 0 ? (
              <div className={m3.segmented} role="group" aria-label="平台属性平台">
                {platforms.map((platform) => (
                  <button
                    key={platform}
                    type="button"
                    className={platform === platformTab ? m3.segmentActive : undefined}
                    aria-pressed={platform === platformTab}
                    onClick={() => setPlatformTab(platform)}
                  >
                    {platformLabel(platform)}
                  </button>
                ))}
              </div>
            ) : null
          }
        >
          {platformAttrs.length === 0 ? (
            <EmptyState
              title="未配置平台属性映射"
              description="该商品（或该平台）没有返回属性映射记录。"
            />
          ) : (
            <div className={m3.tableWrap}>
              <table className={m3.table}>
                <caption>平台属性映射</caption>
                <thead>
                  <tr>
                    <th scope="col">平台</th>
                    <th scope="col">属性路径</th>
                    <th scope="col">内部值</th>
                    <th scope="col">平台值 ID</th>
                    <th scope="col">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {platformAttrs.map((attr, index) => (
                    <tr key={`${attr.platform}-${attr.attr_path}-${index}`}>
                      <td>{platformLabel(attr.platform)}</td>
                      <td className={m3.mono}>{attr.attr_path}</td>
                      <td>{attr.internal_value}</td>
                      <td className={m3.mono}>{attr.platform_value_id ?? '—'}</td>
                      <td>
                        <Chip tone={attr.status === 'verified' ? 'success' : attr.status === 'stale' ? 'warning' : 'neutral'}>
                          {attr.status}
                        </Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      ) : null}

      {tab === 'media' ? (
        <SectionCard title="素材摘要">
          <div className={styles.mediaPlaceholder}>
            <Icon name="media" size={22} />
            <p>
              素材统计将在 M6 接入；当前后端 `media_summary.counts` 为空对象。
              这里不显示 0，避免把“未接入”误认为“没有素材”。
            </p>
            <Link className="buttonSecondary" href="/media">
              去素材库
            </Link>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
