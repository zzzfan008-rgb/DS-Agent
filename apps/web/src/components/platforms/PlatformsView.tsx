'use client';

/**
 * 平台连接页（docs/13c）—— 视图编排。
 *
 * 五段结构：① 顶部状态条 → ② 两张平台卡（拼多多 / 1688）→ ③ 公告摘要 → ④ 未自动化接口清单 → ⑤ 同步状态。
 * ② 接真实接口 `GET /api/platform-accounts`；③④⑤ 后端无端点，一律渲染"数据源尚未接入"，
 * 不写"暂无公告"（那会被读成"平台没有新公告"），也不造假 lag_seconds。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ApiFailure } from '@/lib/api';
import type { Platform, PlatformAccountItem, TestConnectivityResult } from '@/lib/platform-types';
import { fetchPlatformAccounts } from '@/lib/platforms-client';
import { isApiFailure, redirectToLogin } from '@/lib/m3-api';
import { Chip } from '@/components/m3/M3Ui';
import { Skeleton } from '@/components/states/Skeleton';
import { ErrorState } from '@/components/states/ErrorState';
import { PlatformAccountCard } from './PlatformAccountCard';
import { PlatformAccountDrawer } from './PlatformAccountDrawer';
import {
  PLATFORM_LABEL,
  PLATFORM_SHORT,
  UnavailableBlock,
  displayName,
  formatStamp,
} from './platform-ui';
import styles from './platforms.module.css';

const PLATFORMS: Platform[] = ['pdd', '1688'];

export interface PlatformsViewProps {
  canWrite: boolean;
}

interface DrawerState {
  open: boolean;
  editing: PlatformAccountItem | null;
  defaultPlatform: Platform;
}

export function PlatformsView({ canWrite }: PlatformsViewProps) {
  const [items, setItems] = useState<PlatformAccountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [reload, setReload] = useState(0);
  const [drawer, setDrawer] = useState<DrawerState>({ open: false, editing: null, defaultPlatform: 'pdd' });
  const [flashId, setFlashId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPlatformAccounts()
      .then((data) => {
        if (!cancelled) setItems(data.items);
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
          message: '无法连接服务',
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
  }, [reload]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const refresh = useCallback(() => setReload((value) => value + 1), []);

  const byPlatform = (platform: Platform) => items.filter((item) => item.platform === platform);

  const lastTested = items
    .map((item) => item.last_tested_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;

  const openCreate = (platform: Platform) => setDrawer({ open: true, editing: null, defaultPlatform: platform });
  const openEdit = (item: PlatformAccountItem) =>
    setDrawer({ open: true, editing: item, defaultPlatform: (item.platform as Platform) ?? 'pdd' });
  const closeDrawer = () => setDrawer((previous) => ({ ...previous, open: false, editing: null }));

  const handleSaved = (mode: 'create' | 'edit') => {
    closeDrawer();
    setToast(mode === 'create' ? '平台账号已创建（连通性默认"未测试"）' : '平台账号已保存');
    refresh();
  };

  const handleArchived = (item: PlatformAccountItem) => {
    setToast(`已归档 ${PLATFORM_SHORT[item.platform] ?? item.platform} · ${displayName(item)}`);
    refresh();
  };

  const handleTested = (id: string, result: TestConnectivityResult) => {
    // 不乐观更新：只把后端这次写回的时间戳与置位的 connectivity 应用到本地视图。
    setItems((previous) =>
      previous.map((item) =>
        item.id === id
          ? {
              ...item,
              connectivity: result.connectivity,
              last_tested_at: result.tested_at,
              last_test_error: result.ok ? null : `${result.reason}: ${result.message}`,
            }
          : item,
      ),
    );
    setFlashId(null);
  };

  return (
    <div className={styles.pageStack}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>平台连接</h1>
          <p className={styles.subtitle}>
            拼多多与 1688 的账号配置、连通性与契约版本。凭据只存引用名（环境变量名 / Vault 路径），
            实值不落库、不回显；本页不发起任何真实平台请求，也不代表接口可用。
          </p>
        </div>
        <div className={styles.headActions}>
          <Chip tone={canWrite ? 'info' : 'neutral'}>{canWrite ? '可写（provider.write）' : '只读'}</Chip>
          <button type="button" className="buttonSecondary" onClick={refresh} disabled={loading}>
            刷新
          </button>
          {canWrite ? (
            <button type="button" className="buttonPrimary" onClick={() => openCreate('pdd')}>
              新建平台账号
            </button>
          ) : null}
        </div>
      </div>

      {/* ① 顶部状态条 */}
      <section className={styles.statusBar} aria-label="平台连接状态">
        <div className={styles.statusLine}>
          <span className={styles.statusItem}>
            <span className={styles.statusLabel}>已接入账号</span>
            <span className={styles.statusValue}>{loading ? '…' : items.length}</span>
            {!loading && items.length > 0 ? (
              <span className={styles.statusLabel}>
                （拼多多 {byPlatform('pdd').length} · 1688 {byPlatform('1688').length}）
              </span>
            ) : null}
          </span>
          <span className={styles.statusItem}>
            <span className={styles.statusLabel}>最近测试</span>
            <span className={styles.statusValue}>{loading ? '…' : formatStamp(lastTested)}</span>
          </span>
          <span className={styles.statusItem}>
            <span className={styles.statusLabel}>未自动化接口</span>
            <span className={styles.statusMissing}>未接入（待 M8 后续）</span>
          </span>
        </div>
        <p className={styles.verifyNotice}>
          <span aria-hidden="true">⚠</span>
          <span>
            55 个平台接口 method 尚未核验（TODO-PDD-CONTRACT-VERIFY / TODO-1688-001…012），
            「测试连接」<strong>无法发起真实请求</strong>，全部会返回 interfaces_unverified。
            这不是凭据错误，也不代表连通成功。
          </span>
        </p>
      </section>

      {/* ② 平台卡 */}
      {error ? (
        <ErrorState
          title="平台账号加载失败"
          code={error.code}
          message={error.message}
          requestId={error.requestId}
          nextAction={error.nextAction}
          onRetry={refresh}
          retryLabel="重新加载"
        />
      ) : loading ? (
        <Skeleton variant="cards" rows={2} label="加载平台账号" />
      ) : (
        <div className={styles.platformGrid}>
          {PLATFORMS.map((platform) => {
            const group = byPlatform(platform);
            return (
              <section key={platform} className={styles.platformPanel} aria-label={`${PLATFORM_LABEL[platform]} 平台账号`}>
                <div className={styles.platformHead}>
                  <span className={styles.platformName}>
                    <span
                      className={`${styles.platformDot} ${platform === 'pdd' ? styles.platformDotPdd : styles.platformDot1688}`}
                      aria-hidden="true"
                    />
                    {PLATFORM_LABEL[platform]}
                    <span className={styles.platformCount}>{group.length} 个账号</span>
                  </span>
                  {canWrite && group.length > 0 ? (
                    <button type="button" className="buttonQuiet" onClick={() => openCreate(platform)}>
                      + 接入{PLATFORM_SHORT[platform]}账号
                    </button>
                  ) : null}
                </div>
                <div className={styles.platformBody}>
                  {group.length === 0 ? (
                    <div className={styles.groupEmpty}>
                      <span>{items.length === 0 ? '尚未接入任何平台账号。' : `本平台还没有账号。`}</span>
                      <span>
                        接入后这里显示店铺、授权状态、连通性与契约版本；凭据只保存引用名（环境变量名）。
                      </span>
                      {canWrite ? (
                        <button type="button" className="buttonSecondary" onClick={() => openCreate(platform)}>
                          接入{PLATFORM_SHORT[platform]}账号
                        </button>
                      ) : (
                        <span className={styles.muted}>请联系管理员接入（需要 provider.write）。</span>
                      )}
                    </div>
                  ) : (
                    group.map((item) => (
                      <PlatformAccountCard
                        key={item.id}
                        item={item}
                        canWrite={canWrite}
                        flash={flashId === item.id}
                        onEdit={openEdit}
                        onArchived={handleArchived}
                        onTested={(result) => handleTested(item.id, result)}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* ③ 公告摘要 */}
      <section aria-label="公告摘要">
        <div className={styles.platformPanel}>
          <div className={styles.platformHead}>
            <span className={styles.platformName}>公告摘要</span>
            <Chip tone="neutral">未接入</Chip>
          </div>
          <div className={styles.platformBody}>
            <UnavailableBlock
              headline="公告订阅数据源尚未接入（platform_announcement 表尚未落地）"
              plan="公告标题 / 日期 / 影响接口 / 处理状态；抓取失败只影响本区块"
              hint={'数据接入前不显示"暂无公告"——那会被误读成"平台没有新公告"。'}
            />
          </div>
        </div>
      </section>

      {/* ④ 未自动化接口清单 */}
      <section aria-label="未自动化接口清单">
        <div className={styles.platformPanel}>
          <div className={styles.platformHead}>
            <span className={styles.platformName}>未自动化接口清单</span>
            <Chip tone="neutral">未接入</Chip>
          </div>
          <div className={styles.platformBody}>
            <UnavailableBlock
              headline="未自动化接口清单数据源尚未接入（docs/03 逐接口表仍为空缺）"
              plan="接口名 / 原因（权限 · 机房 · 未支持）/ 替代人工路径"
              hint="docs/03 回填后本区块直接消费其结果，不在前端猜测。"
            />
          </div>
        </div>
      </section>

      {/* ⑤ 同步状态 */}
      <section aria-label="同步状态">
        <div className={styles.platformPanel}>
          <div className={styles.platformHead}>
            <span className={styles.platformName}>同步状态</span>
            <Chip tone="neutral">未接入</Chip>
          </div>
          <div className={styles.platformBody}>
            <UnavailableBlock
              headline="尚未同步过：同步游标数据源未接入本页"
              plan="platform / resource / 状态 / last_success_at / lag_seconds / errors[]"
              hint={'接入平台账号后可手动触发同步（本期未开放）；空游标不渲染成"同步正常"，那会主动误导。'}
            />
          </div>
        </div>
      </section>

      <PlatformAccountDrawer
        open={drawer.open}
        editing={drawer.editing}
        defaultPlatform={drawer.defaultPlatform}
        onClose={closeDrawer}
        onSaved={(_, mode) => handleSaved(mode)}
        onRefreshAfterConflict={refresh}
      />

      {toast ? (
        <div className={styles.toast} role="status">
          <span aria-hidden="true">✓</span>
          {toast}
        </div>
      ) : null}
    </div>
  );
}
