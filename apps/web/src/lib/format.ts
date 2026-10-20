/** 展示格式化（不做任何业务计算；金额一律整数分转字符串）。 */

const DATE_TIME = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DATE_ONLY = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const yuan = Math.floor(abs / 100);
  const fen = String(abs % 100).padStart(2, '0');
  return `${sign}¥${yuan.toLocaleString('zh-CN')}.${fen}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return DATE_TIME.format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return DATE_ONLY.format(date);
}

/** 剩余时间：用于 SLA/审批有效期；负数表示已超时。 */
export function formatRemaining(ms: number): string {
  const overdue = ms < 0;
  const total = Math.abs(ms);
  const minutes = Math.floor(total / 60_000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  let value: string;
  if (days > 0) value = `${days}天${hours}小时`;
  else if (hours > 0) value = `${hours}小时${mins}分`;
  else value = `${mins}分`;
  return overdue ? `已超时 ${value}` : `剩余 ${value}`;
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))} 分钟`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return mins === 0 ? `${hours} 小时` : `${hours} 小时 ${mins} 分`;
}

export function platformLabel(platform: string | null | undefined): string {
  if (platform === 'pdd') return '拼多多';
  if (platform === '1688') return '1688';
  return platform ?? '—';
}

export function roleLabel(role: string): string {
  if (role === 'admin') return '管理员';
  if (role === 'operator') return '运营';
  if (role === 'viewer') return '只读';
  return role;
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '·';
  const first = Array.from(trimmed)[0] ?? '·';
  return first.toUpperCase();
}

export function middleTruncate(value: string, head = 8, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 0);
  } catch {
    return '—';
  }
}
