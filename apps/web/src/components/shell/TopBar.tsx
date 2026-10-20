'use client';

import { useState } from 'react';
import { pageMetaFor, visibleNavGroups, type NavGroup } from '@/lib/nav';
import type { Me } from '@/lib/contracts';
import { roleLabel } from '@/lib/format';
import { Icon } from '@/components/common/Icon';
import { RealtimeLamp } from './RealtimeLamp';
import { UserMenu } from './UserMenu';
import styles from './shell.module.css';

export interface TopBarProps {
  pathname: string;
  me: Me;
}

/** 顶栏：页面标题来自路由表；全局搜索 M1 为 disabled 占位，不假装可搜。 */
export function TopBar({ pathname, me }: TopBarProps) {
  const meta = pageMetaFor(pathname);
  return (
    <header className={styles.topbar}>
      <div className={styles.titleBlock}>
        <span className={styles.titleGroup}>{meta.group}</span>
        <h1 className={styles.title}>{meta.title}</h1>
      </div>

      <div className={styles.search}>
        <span className={styles.searchIcon} aria-hidden="true">
          <Icon name="search" size={15} />
        </span>
        <input
          className={styles.searchInput}
          type="search"
          placeholder="搜索商品 / 会话 / 审批（M4 接入）"
          aria-label="全局搜索（M4 接入）"
          disabled
          title="全局搜索与命令面板将在 M4 接入"
        />
      </div>

      <div className={styles.topActions}>
        <RealtimeLamp />
        <span className={styles.roleBadge} title="角色用于展示；页面可见性来自 permissions[]">
          {roleLabel(me.role)}
        </span>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="键盘快捷键设置"
          title="键盘快捷键（?）"
          onClick={() => window.dispatchEvent(new CustomEvent('dssaas:open-shortcuts'))}
        >
          <Icon name="keyboard" size={17} />
        </button>
        <UserMenu name={me.name} role={me.role} />
      </div>
    </header>
  );
}

/** 供 AppShell 复用的导航分组计算（避免重复过滤）。 */
export function useVisibleGroups(me: Me): NavGroup[] {
  return visibleNavGroups(me.permissions);
}
