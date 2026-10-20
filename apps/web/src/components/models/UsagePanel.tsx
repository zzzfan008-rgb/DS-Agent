'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ApiFailure } from '@/lib/api';
import { fetchUsage } from '@/lib/models-client';
import { isApiFailure, redirectToLogin } from '@/lib/m3-api';
import type { UsageData } from '@/lib/m3-types';
import { formatCents } from '@/lib/format';
import { InlineAlert, Spinner } from '@/components/m3/M3Ui';
import { PanelCard } from './model-ui';
import styles from './models.module.css';
import m3 from '@/components/m3/m3.module.css';

function isoDate(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function UsagePanel() {
  const [fromDate, setFromDate] = useState(isoDate(-6));
  const [toDate, setToDate] = useState(isoDate(0));
  const [groupBy, setGroupBy] = useState<'model' | 'purpose' | 'day'>('model');
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const from = new Date(`${fromDate}T00:00:00`).toISOString();
    const to = new Date(`${toDate}T23:59:59.999`).toISOString();
    setLoading(true);
    setError(null);
    fetchUsage(from, to, groupBy)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (isApiFailure(caught)) {
          if (caught.status === 401) {
            redirectToLogin();
            return;
          }
          setError(`${caught.code}: ${caught.message}`);
          return;
        }
        setError('用量加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fromDate, toDate, groupBy, reload]);

  const maxCost = useMemo(
    () => Math.max(1, ...(data?.items.map((item) => item.cost_cents) ?? [0])),
    [data],
  );

  return (
    <PanelCard
      title="用量与成本"
      description="数据源 model_call_log；按模型/用途/天聚合。金额为整数分，条形按费用占比。"
      actions={
        <div className={m3.inlineActions}>
          <input
            className={m3.input}
            type="date"
            aria-label="开始日期"
            value={fromDate}
            onChange={(event) => setFromDate(event.target.value)}
            style={{ width: 150 }}
          />
          <span className={m3.muted}>~</span>
          <input
            className={m3.input}
            type="date"
            aria-label="结束日期"
            value={toDate}
            onChange={(event) => setToDate(event.target.value)}
            style={{ width: 150 }}
          />
          <div className={m3.segmented} role="group" aria-label="分组维度">
            {[
              ['model', '模型'],
              ['purpose', '用途'],
              ['day', '天'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={groupBy === value ? m3.segmentActive : undefined}
                aria-pressed={groupBy === value}
                onClick={() => setGroupBy(value as typeof groupBy)}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" className="buttonSecondary" onClick={() => setReload((value) => value + 1)}>
            刷新
          </button>
        </div>
      }
    >
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {loading ? <Spinner label="加载用量" /> : null}
      {data && data.items.length === 0 ? (
        <p className={m3.muted}>该区间没有模型调用记录。</p>
      ) : null}
      {data && data.items.length > 0 ? (
        <>
          <div className={m3.tableWrap}>
            <table className={m3.table}>
              <caption>模型用量与成本</caption>
              <thead>
                <tr>
                  <th scope="col">key</th>
                  <th scope="col" className={m3.num}>
                    调用
                  </th>
                  <th scope="col" className={m3.num}>
                    输入 token
                  </th>
                  <th scope="col" className={m3.num}>
                    输出 token
                  </th>
                  <th scope="col" className={m3.num}>
                    图片
                  </th>
                  <th scope="col" className={m3.num}>
                    视频秒
                  </th>
                  <th scope="col" className={m3.num}>
                    费用
                  </th>
                  <th scope="col">占比</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.key}>
                    <th scope="row" className={m3.mono}>
                      {item.key}
                    </th>
                    <td className={m3.num}>{item.calls}</td>
                    <td className={m3.num}>{item.input_tokens.toLocaleString('zh-CN')}</td>
                    <td className={m3.num}>{item.output_tokens.toLocaleString('zh-CN')}</td>
                    <td className={m3.num}>{item.images}</td>
                    <td className={m3.num}>{item.video_seconds}</td>
                    <td className={m3.num}>{formatCents(item.cost_cents)}</td>
                    <td>
                      <div className={m3.progressTrack}>
                        <div
                          className={m3.progressBar}
                          style={{ width: `${Math.max(2, Math.round((item.cost_cents / maxCost) * 100))}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.totalLine}>
            合计 <strong>{formatCents(data.total_cents)}</strong> · 区间 {data.from.slice(0, 10)} ~ {data.to.slice(0, 10)}
          </p>
        </>
      ) : null}
    </PanelCard>
  );
}
