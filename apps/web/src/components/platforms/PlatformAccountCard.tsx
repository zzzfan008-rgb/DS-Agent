'use client';

/**
 * 单张平台账号卡（docs/13c §3.1 / §3.2 / §4.2 / §4.3）。
 *
 * 诚实性约束（不允许为了"看起来正常"而放宽）：
 * - 连通性圆点只反映后端 `connectivity`；测试中不做乐观更新。
 * - `interfaces_unverified` 走黄色 warn 结果条，卡片连通性保持"未测试"。
 * - 最近错误来自库（last_test_error），带时间戳，刷新后仍在。
 */
import { useState } from 'react';
import type { PlatformAccountItem, TestConnectivityResult } from '@/lib/platform-types';
import { archivePlatformAccount, testPlatformAccount } from '@/lib/platforms-client';
import { isApiFailure, redirectToLogin } from '@/lib/m3-api';
import type { ApiFailure } from '@/lib/api';
import { Chip, Spinner } from '@/components/m3/M3Ui';
import {
  ConnectivityDot,
  LastErrorLine,
  StatusChip,
  TestResultBar,
  describeDeployment,
  describeTestResult,
  displayName,
  formatStamp,
} from './platform-ui';
import styles from './platforms.module.css';

export interface PlatformAccountCardProps {
  item: PlatformAccountItem;
  canWrite: boolean;
  flash: boolean;
  onEdit: (item: PlatformAccountItem) => void;
  onArchived: (item: PlatformAccountItem) => void;
  onTested: (result: TestConnectivityResult) => void;
}

function failureText(failure: ApiFailure): string {
  return `${failure.status} ${failure.code}：${failure.message}${failure.requestId ? `（${failure.requestId}）` : ''}`;
}

export function PlatformAccountCard({ item, canWrite, flash, onEdit, onArchived, onTested }: PlatformAccountCardProps) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ReturnType<typeof describeTestResult> | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const deployment = describeDeployment(item.extra);

  const runTest = async () => {
    setTesting(true);
    setActionError(null);
    try {
      const outcome = await testPlatformAccount(item.id);
      // ok:false 是正常业务结果（接口未核验），这里**不**当错误处理。
      setResult(describeTestResult(outcome));
      onTested(outcome);
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) {
          redirectToLogin();
          return;
        }
        setActionError(`测试请求失败 ${failureText(caught)}`);
        return;
      }
      setActionError('测试请求失败：网络错误');
    } finally {
      setTesting(false);
    }
  };

  const archive = async () => {
    setArchiving(true);
    setActionError(null);
    try {
      await archivePlatformAccount(item.id);
      setConfirmArchive(false);
      onArchived(item);
    } catch (caught: unknown) {
      if (isApiFailure(caught)) {
        if (caught.status === 401) {
          redirectToLogin();
          return;
        }
        setActionError(`归档失败 ${failureText(caught)}`);
        return;
      }
      setActionError('归档失败：网络错误');
    } finally {
      setArchiving(false);
    }
  };

  return (
    <article className={`${styles.accountCard} ${flash ? styles.accountCardFlash : ''}`} data-account-id={item.id}>
      <header className={styles.accountChips}>
        <h3 className={styles.accountTitle}>{displayName(item)}</h3>
      </header>

      <div className={styles.accountChips}>
        <StatusChip status={item.status} />
        <Chip tone="neutral" title="乐观锁版本：编辑时通过 If-Match 提交">
          v{item.version}
        </Chip>
        <Chip
          tone={item.contract_version === 2 ? 'info' : 'warning'}
          title={item.contract_version === 2 ? '与当前系统契约一致' : '与当前系统契约（v2）不一致，请核对'}
        >
          契约 v{item.contract_version}
        </Chip>
      </div>

      <div className={styles.accountBody}>
        <div className={styles.metaRow}>
          <span className={styles.metaKey}>店铺 ID</span>
          <span className={styles.mono}>{item.shop_id ?? '—'}</span>
          <span className={styles.metaKey}>app_key</span>
          <span className={styles.mono} data-field="app_key_masked">
            {item.app_key_masked}
          </span>
        </div>

        <div className={styles.metaRow}>
          <ConnectivityDot connectivity={item.connectivity} />
          <span className={styles.muted}>最近测试 {formatStamp(item.last_tested_at)}</span>
        </div>

        <div className={styles.metaRow}>
          <span className={styles.metaKey}>部署约束</span>
          <span>
            {deployment.network_mode} · IP 白名单 {deployment.ip_whitelist} · 机房 {deployment.datacenter}
            {deployment.assumed ? <span className={styles.assumedTag}>（默认假设，docs/03 未回填）</span> : null}
            {deployment.otherKeys > 0 ? <span className={styles.muted}> · 其他键 {deployment.otherKeys}</span> : null}
          </span>
        </div>

        <div className={styles.metaRow}>
          <span className={styles.metaKey}>引用名</span>
          <span>
            <span className={styles.mono}>{item.app_secret_ref}</span>
            <span className={styles.muted}>
              {' '}
              · access_token_ref {item.access_token_ref ?? '—'} · refresh_token_ref {item.refresh_token_ref ?? '—'}
            </span>
          </span>
        </div>
      </div>

      <LastErrorLine item={item} />

      {result ? <TestResultBar model={result} onClose={() => setResult(null)} /> : null}
      {actionError ? (
        <div className={`${styles.resultBar} ${styles.resultError}`} role="alert">
          <span aria-hidden="true">✕</span>
          <div className={styles.resultBody}>
            <p className={styles.resultText}>{actionError}</p>
          </div>
        </div>
      ) : null}

      {canWrite ? (
        <>
          {confirmArchive ? (
            <div className={styles.confirmBar} role="group" aria-label="确认归档">
              <span>
                归档后该账号从列表消失，可重新接入同一店铺；审计会记录本次操作（不做物理删除）。
              </span>
              <button type="button" className="buttonSecondary" onClick={() => setConfirmArchive(false)} disabled={archiving}>
                取消
              </button>
              <button type="button" className="buttonDanger" onClick={() => void archive()} disabled={archiving}>
                {archiving ? <Spinner label="归档中" /> : '确认归档'}
              </button>
            </div>
          ) : (
            <div className={styles.actions}>
              <button type="button" className="buttonSecondary" onClick={() => void runTest()} disabled={testing}>
                {testing ? <Spinner label="测试中" /> : '测试连接'}
              </button>
              <button type="button" className="buttonQuiet" onClick={() => onEdit(item)} disabled={testing}>
                编辑
              </button>
              <button type="button" className="buttonQuiet" onClick={() => setConfirmArchive(true)} disabled={testing}>
                归档
              </button>
            </div>
          )}
        </>
      ) : (
        <p className={styles.muted}>只读：测试连接 / 编辑 / 归档需要 provider.write（管理员）。</p>
      )}
    </article>
  );
}
