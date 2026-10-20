import styles from './approvals.module.css';

export interface DemoDataBannerProps {
  variant?: 'top' | 'inline';
}

/** DEMO 标识：只在 API 404（审批端点未实现）时出现，明确数据不参与任何写操作。 */
export function DemoDataBanner({ variant = 'top' }: DemoDataBannerProps) {
  return (
    <div
      className={`${styles.demoBanner} ${variant === 'inline' ? styles.demoBannerInline : ''}`}
      role="status"
    >
      <span className="badge badgeDemo">DEMO</span>
      <span>
        演示数据：审批 API（<code>GET /api/approvals</code>）尚未实现，返回 404 时使用内置样本；
        数据不参与任何审批或写操作。网络错误 / 5xx 不会回退为演示数据。
      </span>
    </div>
  );
}
