/**
 * 业务日与时间窗 —— 对账/日报统一按 `Asia/Shanghai` 业务日。
 *
 * 为什么不用 UTC 日：驳回数、上架数、消息量的"今天"是运营视角的北京时间；
 * 若按 UTC 切，18:00 之后的数据会算到"明天"，日报与运营看到的平台后台不一致。
 *
 * 上海无夏令时（恒定 UTC+8），因此直接用固定偏移，不引入时区库。
 */

export const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` 校验（只做格式与真实日期校验）。 */
export function isDayString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/** 业务日 → UTC 起点（含）。非法输入抛错，避免静默算错统计窗。 */
export function dayStartUtc(day: string): Date {
  if (!isDayString(day)) throw new TypeError(`非法业务日：${String(day)}（要求 YYYY-MM-DD）`);
  return new Date(Date.parse(`${day}T00:00:00Z`) - SHANGHAI_OFFSET_MS);
}

/** 业务日 → 次日 UTC 起点（不含）。 */
export function dayEndUtc(day: string): Date {
  return new Date(dayStartUtc(day).getTime() + DAY_MS);
}

/** 业务日 + N 天（用于"最近 N 天"与幂等键同日比较）。 */
export function addDays(day: string, days: number): string {
  return new Date(dayStartUtc(day).getTime() + days * DAY_MS + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** 某时刻所属的上海业务日。 */
export function businessDayOf(at: Date): string {
  return new Date(at.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** 今日（上海）。 */
export function todayBusinessDay(now: Date = new Date()): string {
  return businessDayOf(now);
}

/** 两个业务日相差天数（`to - from`）。 */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayStartUtc(to).getTime() - dayStartUtc(from).getTime()) / DAY_MS);
}
