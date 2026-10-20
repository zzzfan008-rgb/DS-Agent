import type { IconName } from '@/components/common/Icon';
import { PERMISSIONS, can } from './permissions';

/**
 * 全局导航（docs/13 §2.1）：固定 4 组、12 页；登录页独立无壳层。
 * 可见性由 `GET /me.permissions[]` 决定；`permission` 缺省表示登录即可见。
 */
export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  permission?: string;
  description: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: '工作台',
    items: [
      {
        href: '/',
        label: '首页',
        icon: 'home',
        permission: PERMISSIONS.dashboardRead,
        description: '待办、告警与今日动态',
      },
      {
        href: '/service',
        label: '客服工作台',
        icon: 'service',
        permission: PERMISSIONS.conversationRead,
        description: '会话、AI 草稿与发送',
      },
      {
        href: '/inquiry',
        label: '询盘工作台',
        icon: 'inquiry',
        permission: PERMISSIONS.inquiryRead,
        description: '1688 询盘、报价与起批',
      },
      {
        href: '/approvals',
        label: '审批中心',
        icon: 'approval',
        permission: PERMISSIONS.approvalRead,
        description: 'A/B/C 审批队列与 SLA',
      },
    ],
  },
  {
    title: '商品与内容',
    items: [
      {
        href: '/products',
        label: '商品库',
        icon: 'product',
        permission: PERMISSIONS.productRead,
        description: 'SPU/SKU、尺码表、成分、平台属性',
      },
      {
        href: '/copy',
        label: '文案工作台',
        icon: 'copy',
        permission: PERMISSIONS.contentRead,
        description: '生成 → 判断 → 审批 → 发布',
      },
      {
        href: '/media',
        label: '素材库',
        icon: 'media',
        permission: PERMISSIONS.mediaRead,
        description: '实拍、AI 场景图、尺码表图与成本',
      },
    ],
  },
  {
    title: '平台与模型',
    items: [
      {
        href: '/platforms',
        label: '平台连接',
        icon: 'platform',
        description: '拼多多 / 1688 授权、公告与同步',
      },
      {
        href: '/models',
        label: '模型与供应商',
        icon: 'model',
        description: 'Provider / Model / Route 与前台可用模型',
      },
      {
        href: '/kb',
        label: '知识库',
        icon: 'kb',
        permission: PERMISSIONS.kbRead,
        description: '政策、尺码、话术文档与检索测试',
      },
    ],
  },
  {
    title: '治理',
    items: [
      {
        href: '/ops',
        label: '运营看板',
        icon: 'ops',
        permission: PERMISSIONS.dashboardRead,
        description: '经营/成本/质量看板，审计与设置',
      },
    ],
  },
];

export function visibleNavGroups(permissions: readonly string[]): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => can(permissions, item.permission)),
  })).filter((group) => group.items.length > 0);
}

export function allVisibleNavItems(permissions: readonly string[]): NavItem[] {
  return visibleNavGroups(permissions).flatMap((group) => group.items);
}

/** 页面标题与分组：顶栏、面包屑、无权限态共用。 */
export interface PageMeta {
  prefix: string;
  title: string;
  group: string;
  permission?: string;
}

export const PAGE_META: PageMeta[] = [
  { prefix: '/products', title: '商品库', group: '商品与内容', permission: PERMISSIONS.productRead },
  { prefix: '/copy', title: '文案工作台', group: '商品与内容', permission: PERMISSIONS.contentRead },
  { prefix: '/media', title: '素材库', group: '商品与内容', permission: PERMISSIONS.mediaRead },
  { prefix: '/service', title: '客服工作台', group: '工作台', permission: PERMISSIONS.conversationRead },
  { prefix: '/inquiry', title: '询盘工作台', group: '工作台', permission: PERMISSIONS.inquiryRead },
  { prefix: '/approvals', title: '审批中心', group: '工作台', permission: PERMISSIONS.approvalRead },
  { prefix: '/platforms', title: '平台连接', group: '平台与模型' },
  { prefix: '/models', title: '模型与供应商', group: '平台与模型' },
  { prefix: '/kb', title: '知识库', group: '平台与模型', permission: PERMISSIONS.kbRead },
  { prefix: '/ops', title: '运营看板', group: '治理', permission: PERMISSIONS.dashboardRead },
  { prefix: '/', title: '首页', group: '工作台', permission: PERMISSIONS.dashboardRead },
];

export function pageMetaFor(pathname: string): PageMeta {
  const normalized = pathname.split('?')[0] ?? '/';
  let best: PageMeta | null = null;
  for (const meta of PAGE_META) {
    if (meta.prefix === '/') continue;
    if (normalized === meta.prefix || normalized.startsWith(`${meta.prefix}/`)) {
      if (!best || meta.prefix.length > best.prefix.length) best = meta;
    }
  }
  return best ?? PAGE_META[PAGE_META.length - 1]!;
}

/** 当前页是否激活（用于导航高亮）。 */
export function isNavActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
