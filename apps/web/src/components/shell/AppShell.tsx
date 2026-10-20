'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import type { Me } from '@/lib/contracts';
import { visibleNavGroups } from '@/lib/nav';
import { SidebarNav } from './SidebarNav';
import { TopBar } from './TopBar';
import { MobileNav } from './MobileNav';
import { ShortcutsDialog } from './ShortcutsDialog';
import styles from './shell.module.css';

export interface AppShellProps {
  me: Me;
  children: ReactNode;
}

/** 全局壳层：深色侧栏 + 顶栏 + 主内容 + 移动端导航 + 快捷键面板。 */
export function AppShell({ me, children }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const groups = visibleNavGroups(me.permissions);

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main">
        跳到主内容
      </a>
      <SidebarNav groups={groups} pathname={pathname} me={me} />
      <div className={styles.body}>
        <TopBar pathname={pathname} me={me} />
        <main id="main" className={styles.main}>
          {children}
        </main>
        <footer className={styles.footer}>
          <span>DSSAAS · 服装电商双平台运营台（M1 骨架）</span>
          <span>契约 v2 · 所有写操作必须经审批与审计</span>
        </footer>
      </div>
      <MobileNav groups={groups} pathname={pathname} />
      <ShortcutsDialog />
    </div>
  );
}
