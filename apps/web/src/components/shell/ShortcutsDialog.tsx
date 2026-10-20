'use client';

import { useEffect, useRef, useState } from 'react';
import { isEditableTarget, readShortcutsEnabled, writeShortcutsEnabled } from '@/lib/shortcuts';
import { Icon } from '@/components/common/Icon';
import styles from './shell.module.css';

type Section = {
  title: string;
  rows: Array<{ label: string; keys: string[]; pending?: boolean }>;
};

const SECTIONS: Section[] = [
  {
    title: '全局',
    rows: [
      { label: '打开 / 关闭快捷键面板', keys: ['?'] },
      { label: '关闭弹层 / 取消输入', keys: ['Esc'] },
    ],
  },
  {
    title: '审批中心（M1 已启用）',
    rows: [
      { label: '下一条 / 上一条', keys: ['j', 'k'] },
      { label: '打开选中项详情', keys: ['Enter'] },
    ],
  },
  {
    title: '后续里程碑',
    rows: [
      { label: '命令面板', keys: ['⌘', 'K'], pending: true },
      { label: '页面跳转', keys: ['g', 'h'], pending: true },
      { label: '批准 / 驳回（A/B 级）', keys: ['⇧', 'A'], pending: true },
    ],
  },
];

/** `?` 快捷键面板；偏好写入 localStorage（队长确认 Q5：可关闭）。 */
export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setEnabled(readShortcutsEnabled());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || isEditableTarget(event.target)) return;
      if (event.key === 'Escape' && open) {
        setOpen(false);
        return;
      }
      if (event.key === '?' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (!readShortcutsEnabled()) return;
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('dssaas:open-shortcuts', onOpen as EventListener);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('dssaas:open-shortcuts', onOpen as EventListener);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    writeShortcutsEnabled(next);
  };

  if (!open) return null;

  return (
    <div
      className={styles.dialogOverlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
      >
        <div className={styles.dialogHead}>
          <div>
            <h2 className={styles.dialogTitle} id="shortcuts-title">
              键盘快捷键
            </h2>
            <p className={styles.dialogSub}>
              输入框内与中文输入法组合输入期间不会触发单键快捷键。
            </p>
          </div>
          <button
            type="button"
            className="buttonQuiet"
            onClick={() => setOpen(false)}
            ref={closeRef}
            aria-label="关闭快捷键面板"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className={styles.dialogBody}>
          <div className={styles.switchRow}>
            <div>
              <p className={styles.switchLabel}>启用键盘快捷键</p>
              <p className={styles.switchHint}>
                偏好保存在本机（localStorage）；关闭后仍可通过顶栏键盘按钮打开本面板。
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="启用键盘快捷键"
              className={`${styles.switch} ${enabled ? styles.switchOn : ''}`}
              onClick={toggle}
            >
              <span className={styles.switchKnob} />
            </button>
          </div>

          {SECTIONS.map((section) => (
            <section className={styles.shortcutSection} key={section.title}>
              <h4>{section.title}</h4>
              {section.rows.map((row) => (
                <div className={styles.shortcutRow} key={row.label}>
                  <span>
                    {row.label}
                    {row.pending ? '（未启用）' : ''}
                  </span>
                  <span className={styles.shortcutKeys}>
                    {row.keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}

          <p className={styles.pendingNote}>
            M1 只启用面板与审批列表 <kbd>j</kbd>/<kbd>k</kbd>/<kbd>Enter</kbd>；
            <kbd>g</kbd> 跳转、命令面板与审批决策快捷键随 M4 接入。
          </p>
        </div>
      </div>
    </div>
  );
}
