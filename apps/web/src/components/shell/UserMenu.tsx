'use client';

import { useEffect, useRef, useState } from 'react';
import { initials, roleLabel } from '@/lib/format';
import { Icon } from '@/components/common/Icon';
import styles from './shell.module.css';

export interface UserMenuProps {
  name: string;
  role: string;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split('; ')) {
    if (part.startsWith(prefix)) return decodeURIComponent(part.slice(prefix.length));
  }
  return null;
}

/** 用户菜单 + 登出（真实调用 POST /api/auth/logout，携带 CSRF 双提交头）。 */
export function UserMenu({ name, role }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const logout = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const csrf = readCookie('dssaas_csrf') ?? '';
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-csrf-token': csrf, accept: 'application/json' },
      });
    } catch {
      // 登出失败也回到登录页：会话是否已删由服务端审计记录，前端不阻塞。
    } finally {
      window.location.assign('/login');
    }
  };

  return (
    <div className={styles.menuWrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.menuButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`用户菜单：${name}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {initials(name)}
        </span>
        <span className={styles.menuName}>{name}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open ? (
        <div className={styles.menuPop} role="menu" aria-label="用户菜单">
          <div className={styles.menuHead}>
            <p className={styles.menuHeadName}>{name}</p>
            <p className={styles.menuHeadMeta}>{roleLabel(role)} · 会话空闲 8 小时</p>
          </div>
          <button
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${styles.menuItemDanger}`}
            onClick={() => void logout()}
            disabled={busy}
          >
            <Icon name="logout" size={16} />
            {busy ? '正在退出…' : '退出登录'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
