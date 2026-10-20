'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { isNavActive, type NavGroup } from '@/lib/nav';
import { Icon } from '@/components/common/Icon';
import styles from './shell.module.css';

const PREFERRED = ['/', '/approvals', '/products'];

export interface MobileNavProps {
  groups: NavGroup[];
  pathname: string;
}

/** <768 底部 4 tab + "更多" 抽屉（docs/13 §8.1）。 */
export function MobileNav({ groups, pathname }: MobileNavProps) {
  const [open, setOpen] = useState(false);
  const flat = groups.flatMap((group) => group.items);
  const primary = PREFERRED.map((href) => flat.find((item) => item.href === href)).filter(
    (item): item is NonNullable<typeof item> => Boolean(item),
  );
  for (const item of flat) {
    if (primary.length >= 3) break;
    if (!primary.some((entry) => entry.href === item.href)) primary.push(item);
  }
  const tabs = primary.slice(0, 3);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      {open ? (
        <>
          <div className={styles.drawerOverlay} onClick={() => setOpen(false)} aria-hidden="true" />
          <div className={styles.drawer} role="dialog" aria-modal="true" aria-label="全部导航">
            <div className={styles.drawerHead}>
              <span>全部导航</span>
              <button
                type="button"
                className="buttonQuiet"
                onClick={() => setOpen(false)}
                aria-label="关闭导航"
              >
                <Icon name="close" size={18} />
              </button>
            </div>
            {groups.map((group) => (
              <div className={styles.drawerGroup} key={group.title}>
                <p className={styles.drawerGroupTitle}>{group.title}</p>
                {group.items.map((item) => {
                  const active = isNavActive(item.href, pathname);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`${styles.drawerItem} ${active ? styles.drawerItemActive : ''}`}
                      onClick={() => setOpen(false)}
                    >
                      <Icon name={item.icon} size={18} />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      ) : null}

      <nav className={styles.mobileNav} aria-label="移动端导航">
        {tabs.map((item) => {
          const active = isNavActive(item.href, pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.bottomItem} ${active ? styles.bottomItemActive : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              <Icon name={item.icon} size={20} />
              <span>{item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          className={styles.bottomItem}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <Icon name="more" size={20} />
          <span>更多</span>
        </button>
      </nav>
    </>
  );
}
