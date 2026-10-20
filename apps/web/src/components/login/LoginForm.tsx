'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { LoginData } from '@/lib/contracts';
import { parseApiResponse } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Icon } from '@/components/common/Icon';
import styles from './login.module.css';

function safeReturnUrl(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  if (raw.startsWith('/login')) return '/';
  return raw;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

interface FormError {
  tone: 'error' | 'info';
  text: string;
}

export interface LoginFormProps {
  returnUrl: string | null;
  apiDown: boolean;
}

export function LoginForm({ returnUrl, apiDown }: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [showTotp, setShowTotp] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState<FormError | null>(null);
  const totpRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (showTotp) totpRef.current?.focus();
  }, [showTotp]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    setFormError(null);

    if (!looksLikeEmail(email)) {
      setFormError({ tone: 'error', text: '请输入有效的邮箱地址' });
      return;
    }
    if (!password) {
      setFormError({ tone: 'error', text: '请输入口令' });
      return;
    }
    if (showTotp && !/^\d{6}$/.test(totp)) {
      setFormError({ tone: 'error', text: '请输入 6 位动态验证码' });
      totpRef.current?.focus();
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password,
          ...(showTotp && totp ? { totp_code: totp } : {}),
        }),
      });
      const result = await parseApiResponse<LoginData>(response);

      if (!result.ok) {
        if (response.status === 401) {
          const totpRequired = result.detail?.totp_required === true;
          if (totpRequired && !showTotp) {
            setShowTotp(true);
            setFormError({ tone: 'info', text: '该账号启用了 TOTP，请输入 6 位动态验证码后重试。' });
          } else if (totpRequired) {
            setFormError({ tone: 'error', text: '动态验证码不正确或已过期，请重新输入。' });
            setTotp('');
          } else {
            setFormError({ tone: 'error', text: '账号或口令不正确' });
          }
        } else if (response.status === 423) {
          const lockedUntil = result.detail?.locked_until;
          setFormError({
            tone: 'error',
            text:
              typeof lockedUntil === 'string'
                ? `账号已锁定，请于 ${formatDateTime(lockedUntil)} 后重试。`
                : '账号已锁定，请稍后再试或联系管理员。',
          });
        } else if (response.status === 429) {
          const retryAfter = Number(response.headers.get('retry-after') ?? '60');
          setFormError({
            tone: 'error',
            text: `登录尝试过于频繁，请 ${Number.isFinite(retryAfter) ? retryAfter : 60} 秒后重试。`,
          });
        } else {
          setFormError({ tone: 'error', text: result.message });
        }
        return;
      }

      window.location.assign(safeReturnUrl(returnUrl));
    } catch {
      setFormError({ tone: 'error', text: '无法连接服务，请检查网络后重试。' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      className={styles.form}
      method="post"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor="login-email">
          邮箱
        </label>
        <input
          id="login-email"
          className={styles.input}
          type="email"
          autoComplete="username"
          placeholder="ops@dssaas.local"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={loading}
          required
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="login-password">
          口令
        </label>
        <div className={styles.inputWrap}>
          <input
            id="login-password"
            className={`${styles.input} ${styles.inputWithAction}`}
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder="输入口令"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={loading}
            required
          />
          <button
            type="button"
            className={styles.inputAction}
            onClick={() => setShowPassword((value) => !value)}
            aria-label={showPassword ? '隐藏口令' : '显示口令'}
            tabIndex={-1}
          >
            <Icon name={showPassword ? 'eyeOff' : 'eye'} size={16} />
          </button>
        </div>
      </div>

      {showTotp ? (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="login-totp">
            动态验证码（TOTP）
          </label>
          <input
            id="login-totp"
            ref={totpRef}
            className={`${styles.input} ${styles.totpInput}`}
            type="text"
            name="totp"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="one-time-code"
            placeholder="6 位数字"
            value={totp}
            onChange={(event) => setTotp(event.target.value.replace(/\D/g, '').slice(0, 6))}
            disabled={loading}
          />
          <p className={styles.hint}>验证码 30 秒刷新，同一验证码不可重复使用。</p>
        </div>
      ) : (
        <button
          type="button"
          className={styles.totpToggle}
          onClick={() => setShowTotp(true)}
          disabled={loading}
        >
          <Icon name="lock" size={14} />
          账号启用了 TOTP？使用动态验证码登录
        </button>
      )}

      {formError ? (
        <div
          className={`${styles.alert} ${formError.tone === 'info' ? styles.alertInfo : ''}`}
          role={formError.tone === 'error' ? 'alert' : 'status'}
        >
          <Icon name={formError.tone === 'error' ? 'alert' : 'shield'} size={16} />
          <span>{formError.text}</span>
        </div>
      ) : null}

      <button type="submit" className={styles.submit} disabled={loading || apiDown}>
        {loading ? <span className={styles.spinner} aria-hidden="true" /> : null}
        {loading ? '正在登录…' : apiDown ? '系统维护中' : '登录'}
      </button>

      <div className={styles.belowForm}>
        <span>连续 5 次失败将锁定 15 分钟；不提供"记住我"永久登录。</span>
        <span className={styles.helpRow}>
          需要帮助？<span>联系管理员（组织通讯录）</span>
        </span>
      </div>
    </form>
  );
}
