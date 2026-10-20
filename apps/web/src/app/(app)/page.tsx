import Link from 'next/link';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/common/PageHeader';
import { Icon, type IconName } from '@/components/common/Icon';
import { EmptyState } from '@/components/states/EmptyState';
import { guardPage } from '@/lib/page-guard';
import { PERMISSIONS } from '@/lib/permissions';
import styles from './dashboard.module.css';

export const metadata: Metadata = { title: '首页' };
export const dynamic = 'force-dynamic';

interface TodoCard {
  label: string;
  hint: string;
  href: string;
  icon: IconName;
}

const TODO_CARDS: TodoCard[] = [
  {
    label: '审批积压',
    hint: 'pending_count / oldest_wait_minutes · GET /dashboard/overview',
    href: '/approvals',
    icon: 'approval',
  },
  {
    label: '驳回待修',
    hint: 'rejected_listings · 平台驳回后待修复项',
    href: '/products',
    icon: 'product',
  },
  {
    label: '死信任务',
    hint: 'failed_runs · 重放需理由与六条校验',
    href: '/ops',
    icon: 'activity',
  },
  {
    label: '失败 run',
    hint: 'workflow_run.state = failed_* · 可重试/永久',
    href: '/ops',
    icon: 'database',
  },
];

const QUICK_LINKS: Array<{ href: string; label: string; description: string; icon: IconName }> = [
  { href: '/approvals', label: '打开审批中心', description: '查看 A/B/C 队列与 SLA', icon: 'approval' },
  { href: '/products', label: '进入商品库', description: 'SPU/SKU、尺码表与成分', icon: 'product' },
  { href: '/service', label: '进入客服工作台', description: '会话、草稿与秒级提醒（M5）', icon: 'service' },
  { href: '/platforms', label: '检查平台连接', description: '拼多多 / 1688 授权与同步', icon: 'platform' },
];

export default async function DashboardPage() {
  const guard = await guardPage(PERMISSIONS.dashboardRead, '看板读取（dashboard.read）');
  if (!guard.ok) return guard.node;

  return (
    <div className={styles.page}>
      <PageHeader
        title="首页"
        description="待办、告警与今日动态。M1 只搭壳层与空态：所有数值为“—”，表示数据源未接入，不是 0。"
        badges={<span className="badge badgeM1">M1 骨架</span>}
        meta={<span>当前账号：{guard.me.name}</span>}
      />

      <div className={styles.todoGrid}>
        {TODO_CARDS.map((card) => (
          <Link className={styles.todoCard} href={card.href} key={card.label}>
            <span className={styles.todoIcon}>
              <Icon name={card.icon} size={18} />
            </span>
            <span className={styles.todoBody}>
              <span className={styles.todoLabel}>{card.label}</span>
              <span className={styles.todoValue}>—</span>
              <span className={styles.todoHint}>{card.hint}</span>
            </span>
            <span className={styles.todoArrow} aria-hidden="true">
              <Icon name="external" size={15} />
            </span>
          </Link>
        ))}
      </div>

      <div className={styles.panelGrid}>
        <section className={styles.panel} aria-labelledby="alerts-title">
          <div className={styles.panelHead}>
            <h2 className={styles.panelTitle} id="alerts-title">
              告警
            </h2>
            <span className="badge">M4 接入告警流</span>
          </div>
          <div className={styles.panelBody}>
            <EmptyState
              title="今天没有告警"
              description="平台不可用、配额耗尽、SSE 中断与 kill switch 会在这里出现；M1 尚未接入数据源。"
              icon="bell"
            />
          </div>
        </section>

        <section className={styles.panel} aria-labelledby="today-title">
          <div className={styles.panelHead}>
            <h2 className={styles.panelTitle} id="today-title">
              今日动态
            </h2>
            <span className="badge">M4 接入</span>
          </div>
          <div className={styles.panelBody}>
            <EmptyState
              title="今天还没有动作"
              description="上架数、回复数、媒体任务与成本将在这里汇总；先从一个具体页面开始。"
              icon="activity"
            />
          </div>
        </section>

        <section className={styles.panel} aria-labelledby="tickets-title">
          <div className={styles.panelHead}>
            <h2 className={styles.panelTitle} id="tickets-title">
              不可逆登记
            </h2>
            <span className="badge">M4 接入</span>
          </div>
          <div className={styles.panelBody}>
            <EmptyState
              title="没有进行中的不可逆事件"
              description="正向空态：发生 C 级写入或止损时，这里显示补偿工单、责任人与 SLA。"
              icon="shield"
            />
          </div>
        </section>

        <section className={styles.panel} aria-labelledby="quick-title">
          <div className={styles.panelHead}>
            <h2 className={styles.panelTitle} id="quick-title">
              快捷入口
            </h2>
            <span className="badge">M1 可用</span>
          </div>
          <ul className={styles.quickList}>
            {QUICK_LINKS.map((link) => (
              <li key={link.href}>
                <Link className={styles.quickItem} href={link.href}>
                  <Icon name={link.icon} size={17} />
                  <span className={styles.quickText}>
                    <span className={styles.quickLabel}>{link.label}</span>
                    <span className={styles.quickDesc}>{link.description}</span>
                  </span>
                  <Icon name="arrowRight" size={15} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <p className={styles.footnote}>
        M1 骨架：<code>GET /dashboard/overview</code>、<code>GET /kill-switches</code>、
        <code>GET /compensating-tickets</code> 尚未实现，因此卡片显示“—”。审批中心已可用（只读 + 演示数据兜底）。
      </p>
    </div>
  );
}
