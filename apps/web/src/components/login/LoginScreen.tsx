import type { HealthCheck } from '@/lib/contracts';
import { Icon } from '@/components/common/Icon';
import { LoginForm } from './LoginForm';
import styles from './login.module.css';

export interface LoginScreenProps {
  health: HealthCheck | null;
  returnUrl: string | null;
  version: string;
}

function healthInfo(health: HealthCheck | null) {
  if (!health) {
    return {
      tone: styles.healthUnknown,
      text: '系统状态未知',
      detail: '无法连接 /api/health；登录可能不可用',
      apiDown: true,
    };
  }
  if (health.status === 'ok') {
    return { tone: styles.healthOk, text: '系统正常', detail: 'API 与数据库连接正常', apiDown: false };
  }
  if (health.status === 'degraded') {
    return {
      tone: styles.healthWarn,
      text: '部分能力降级',
      detail: '部分依赖不健康，登录仍可用；失败时联系管理员',
      apiDown: false,
    };
  }
  return {
    tone: styles.healthDown,
    text: '系统维护中',
    detail: '健康检查为 down，登录暂时不可用',
    apiDown: true,
  };
}

/** 登录页：左侧品牌叙事 + 右侧登录卡；<960 隐藏左栏。 */
export function LoginScreen({ health, returnUrl, version }: LoginScreenProps) {
  const info = healthInfo(health);

  return (
    <div className={styles.page}>
      <aside className={styles.brandSide} aria-label="系统介绍">
        <div className={styles.gridPattern} aria-hidden="true" />
        <div className={styles.brandInner}>
          <div className={styles.brandTop}>
            <span className={styles.brandMark} aria-hidden="true">
              D
            </span>
            <span className={styles.brandName}>DSSAAS · 服装电商双平台运营台</span>
          </div>

          <div className={styles.hero}>
            <p className={styles.heroKicker}>拼多多 + 1688 · 一个入口</p>
            <h1 className={styles.heroTitle}>
              一个人也能管好
              <br />
              双平台的日常运营
            </h1>
            <p className={styles.heroLead}>
              文案、上架、客服、素材、对账，全部走同一套审批与审计。
              系统只生成与执行，放行权永远在人手上。
            </p>
            <ul className={styles.promises}>
              <li>
                <Icon name="check" size={16} />
                写操作 100% 经审批与审计，可追溯到事实来源
              </li>
              <li>
                <Icon name="check" size={16} />
                价格、成分、尺码、政策只来自主数据，模型不得编造
              </li>
              <li>
                <Icon name="check" size={16} />
                A / B / C 三级风险，不可逆操作必须二次确认
              </li>
            </ul>
          </div>

          <div className={styles.brandFooter}>
            <span>内部系统 · 单租户部署</span>
            <span>版本 {version} · 契约 v2</span>
          </div>
        </div>
      </aside>

      <main className={styles.formSide}>
        <div className={styles.mobileBrand}>
          <span className={styles.brandMark} aria-hidden="true">
            D
          </span>
          <span className={styles.brandName}>DSSAAS · 服装电商双平台运营台</span>
        </div>

        <section className={styles.card} aria-labelledby="login-title">
          <div className={styles.cardHead}>
            <div>
              <h2 className={styles.cardTitle} id="login-title">
                登录
              </h2>
              <p className={styles.cardSub}>使用工作账号登录，进入对应角色的工作台</p>
            </div>
            <span className="badge badgeM1">M1 骨架</span>
          </div>

          {health?.status === 'down' || health === null ? (
            <div className={`${styles.alert} ${styles.alertInfo}`} role="status">
              <Icon name="alert" size={16} />
              <span>
                {health === null
                  ? '无法连接服务：健康检查失败，登录暂不可用。'
                  : '系统维护中：健康检查为 down，登录暂不可用。'}
              </span>
            </div>
          ) : null}

          <LoginForm returnUrl={returnUrl} apiDown={info.apiDown} />

          <div className={styles.healthRow}>
            <span className={`${styles.healthDot} ${info.tone}`} aria-hidden="true" />
            <span className={styles.healthText}>{info.text}</span>
            <span className={styles.healthDetail} title={info.detail}>
              {info.detail}
            </span>
          </div>
        </section>

        <p className={styles.footnote}>
          仅限授权人员使用；登录、失败、锁定均写入审计日志。系统不提供"记住我"永久登录。
        </p>
      </main>
    </div>
  );
}
