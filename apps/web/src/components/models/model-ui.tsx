'use client';

import type { ReactNode } from 'react';
import { Chip } from '@/components/m3/M3Ui';
import { priceLines } from '@/lib/m3-format';
import type { ModelItem, PriceBook, ProviderItem, RouteItem } from '@/lib/m3-types';
import { MODEL_STATUS_LABEL, PROVIDER_STATUS_LABEL, ROUTE_STATUS_LABEL } from '@/lib/m3-format';
import styles from './models.module.css';
import m3 from '@/components/m3/m3.module.css';

export function PriceTag({ price, capability }: { price: PriceBook | null | undefined; capability: string }) {
  const lines = priceLines(price, capability);
  if (lines.length === 0) {
    return <span className={styles.priceMissing}>价格待补</span>;
  }
  return (
    <div className={styles.priceList}>
      {lines.map((line) => (
        <div className={styles.priceRow} key={`${line.label}-${line.unit}-${line.cents}`}>
          <span className={styles.priceLabel}>{line.label}</span>
          <span className={styles.priceCents}>
            {line.cents} 分/{line.unit}
          </span>
          <span className={styles.priceYuan}>≈ {line.yuan}</span>
        </div>
      ))}
    </div>
  );
}

export function ProviderStatus({ provider }: { provider: ProviderItem }) {
  const tone =
    provider.status === 'active'
      ? 'success'
      : provider.status === 'degraded'
        ? 'warning'
        : provider.status === 'disabled'
          ? 'danger'
          : 'neutral';
  return <Chip tone={tone}>{PROVIDER_STATUS_LABEL[provider.status] ?? provider.status}</Chip>;
}

export function Connectivity({ provider }: { provider: ProviderItem }) {
  const { ok, latency_ms, checked_at } = provider.connectivity;
  return (
    <span className={styles.connectivity} title={checked_at ? `最近检查 ${checked_at}` : '尚未测试'}>
      <span className={`${styles.connDot} ${ok ? styles.connOk : styles.connBad}`} aria-hidden="true" />
      {ok ? `ok${latency_ms !== null ? ` ${latency_ms}ms` : ''}` : 'failed'}
    </span>
  );
}

export function ModelStatus({ model }: { model: ModelItem }) {
  const tone =
    model.status === 'published'
      ? 'success'
      : model.status === 'suspended'
        ? 'warning'
        : model.status === 'archived'
          ? 'neutral'
          : 'info';
  return <Chip tone={tone}>{MODEL_STATUS_LABEL[model.status] ?? model.status}</Chip>;
}

export function RouteStatus({ route }: { route: RouteItem }) {
  const tone =
    route.status === 'active' ? 'success' : route.status === 'paused' ? 'warning' : route.status === 'retired' ? 'neutral' : 'info';
  return <Chip tone={tone}>{ROUTE_STATUS_LABEL[route.status] ?? route.status}</Chip>;
}

export function PanelCard({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <div>
          <h2 className={styles.panelTitle}>{title}</h2>
          {description ? <p className={styles.panelDesc}>{description}</p> : null}
        </div>
        {actions ? <div className={m3.inlineActions}>{actions}</div> : null}
      </div>
      <div className={styles.panelBody}>{children}</div>
    </div>
  );
}

export function ErrorLine({ message }: { message: string }) {
  return (
    <p className={styles.rowError} role="alert">
      {message}
    </p>
  );
}
