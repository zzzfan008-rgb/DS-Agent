'use client';

/**
 * 键盘快捷键偏好（队长确认 Q5：可关闭 + 持久化 localStorage）。
 *
 * 默认开启；关闭后 `?` 面板与审批列表 j/k/Enter 都不响应，
 * 但仍可从顶栏的"键盘快捷键"按钮打开面板重新开启。
 */
import { useEffect, useState } from 'react';

export const SHORTCUTS_STORAGE_KEY = 'dssaas.shortcuts.enabled';
const CHANGE_EVENT = 'dssaas:shortcuts-changed';

export function readShortcutsEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(SHORTCUTS_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function writeShortcutsEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // 隐私模式/配额满：仅本次会话生效，不阻塞 UI
  }
  window.dispatchEvent(new CustomEvent<boolean>(CHANGE_EVENT, { detail: enabled }));
}

/** 声明式读取偏好；跨组件同步（设置开关后审批页立即生效）。 */
export function useShortcutsEnabled(): boolean {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    setEnabled(readShortcutsEnabled());
    const handler = (event: Event) => {
      setEnabled((event as CustomEvent<boolean>).detail);
    };
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, []);
  return enabled;
}

/** 快捷键作用域判定：输入框、可编辑区、IME 组合输入期间一律不触发。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target.isContentEditable;
}
