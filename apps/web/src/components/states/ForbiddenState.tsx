import { Icon } from '@/components/common/Icon';
import styles from './states.module.css';

export interface ForbiddenStateProps {
  /** 需要什么权限（人类可读，如"审计权限（audit.read）"）；不要在这里推断角色。 */
  requiredPermission?: string;
  title?: string;
  description?: string;
  applyPath?: string;
}

/**
 * 无权限态（docs/13 V8）：统一文案"无权访问或不存在"，不泄露对象是否存在、不渲染业务数据。
 * 路由级 403、越权直达 URL 均复用。
 */
export function ForbiddenState({
  requiredPermission,
  title = '无权访问或不存在',
  description,
  applyPath = '如需访问，请联系管理员开通对应权限（申请路径：设置 → 账号与角色）。',
}: ForbiddenStateProps) {
  return (
    <div className={styles.forbidden} role="alert">
      <div className={styles.forbiddenHead}>
        <Icon name="shield" size={20} />
        <span>{title}</span>
      </div>
      <p className={styles.forbiddenText}>
        {description ??
          (requiredPermission
            ? `当前账号缺少「${requiredPermission}」权限，页面不展示任何业务数据。`
            : '当前账号无权访问该页面，页面不展示任何业务数据。')}
      </p>
      <p className={styles.applyPath}>{applyPath}</p>
    </div>
  );
}
