import styles from './states.module.css';

export type SkeletonVariant = 'page' | 'list' | 'detail' | 'table' | 'cards';

export interface SkeletonProps {
  variant?: SkeletonVariant;
  rows?: number;
  label?: string;
}

/**
 * 统一加载态（docs/13 §2.3）：形状贴合真实内容，禁止全屏 spinner。
 * 延迟显示由调用方控制（本项目在客户端请求时自然延迟）。
 */
export function Skeleton({ variant = 'list', rows = 5, label = '加载中' }: SkeletonProps) {
  const count = Math.min(Math.max(rows, 1), 12);
  return (
    <div className={styles.skeleton} role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {variant === 'list'
        ? Array.from({ length: count }, (_, index) => (
            <div className={styles.row} key={index} aria-hidden="true">
              <div className={styles.circle} />
              <div className={styles.rowBody}>
                <div className={`${styles.line} ${styles.h16} ${styles.w40}`} />
                <div className={`${styles.line} ${styles.h12} ${styles.w80}`} />
              </div>
            </div>
          ))
        : null}
      {variant === 'detail' ? (
        <div className={styles.detailCard} aria-hidden="true">
          <div className={`${styles.line} ${styles.h16} ${styles.w40}`} />
          <div className={`${styles.block} ${styles.h120}`} />
          <div className={`${styles.line} ${styles.h12} ${styles.w60}`} />
          <div className={`${styles.line} ${styles.h12} ${styles.w80}`} />
          <div className={`${styles.block} ${styles.h220}`} />
        </div>
      ) : null}
      {variant === 'table' ? (
        <div className={styles.detailCard} aria-hidden="true">
          <div className={`${styles.line} ${styles.h16} ${styles.w25}`} />
          {Array.from({ length: count }, (_, index) => (
            <div className={`${styles.line} ${styles.h16}`} key={index} />
          ))}
        </div>
      ) : null}
      {variant === 'cards' ? (
        <div className={styles.row} aria-hidden="true" style={{ gap: 16 }}>
          {Array.from({ length: Math.min(count, 4) }, (_, index) => (
            <div className={`${styles.block} ${styles.h64}`} key={index} style={{ flex: 1 }} />
          ))}
        </div>
      ) : null}
      {variant === 'page' ? (
        <div className={styles.detailCard} aria-hidden="true">
          <div className={`${styles.line} ${styles.h16} ${styles.w25}`} />
          <div className={`${styles.line} ${styles.h12} ${styles.w60}`} />
          <div className={`${styles.block} ${styles.h120}`} />
          <div className={`${styles.block} ${styles.h220}`} />
        </div>
      ) : null}
    </div>
  );
}
