'use client';

import Link from 'next/link';
import type { Me } from '@/lib/contracts';
import { isNavActive, type NavGroup } from '@/lib/nav';
import { roleLabel } from '@/lib/format';
import { Icon } from '@/components/common/Icon';
import styles from './shell.module.css';

export interface SidebarNavProps {
  groups: NavGroup[];
  pathname: string;
  me: Me;
}

/** 深色侧栏：固定 4 组、12 页；只渲染 `/me.permissions[]` 允许的入口。 */
export function SidebarNav({ groups, pathname, me }: SidebarNavProps) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true">
          D
        </span>
        <span className={styles.brandText}>
          <span className={styles.brandName}>DSSAAS</span>
          <span className={styles.brandMeta}>服装电商双平台运营台</span>
        </span>
      </div>

      <nav className={styles.nav} aria-label="主导航">
        {groups.map((group) => (
          <div className={styles.group} key={group.title}>
            <p className={styles.groupTitle}>{group.title}</p>
            {group.items.map((item) => {
              const active = isNavActive(item.href, pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`${styles.navLink} ${active ? styles.navActive : ''}`}
                  aria-current={active ? 'page' : undefined}
                  title={`${item.label} · ${item.description}`}
                >
                  <span className={styles.navIcon}>
                    <Icon name={item.icon} size={17} />
                  </span>
                  <span className={styles.navLabel}>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className={styles.sidebarFooter}>
        <span>
          当前账号：<strong>{me.name}</strong>
        </span>
        <span>
          {roleLabel(me.role)} · 契约 v2 · M1 骨架
        </span>
      </div>
    </aside>
  );
}
