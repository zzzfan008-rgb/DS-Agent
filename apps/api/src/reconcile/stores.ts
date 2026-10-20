/**
 * 差异存储 —— `drift_log` 缺失期的降级实现 + 建表后的正式实现。
 *
 * 背景（已上报队长，t37 补表）：
 * - docs/18 §4、docs/20 §7 要求"对账漂移写 `drift_log`"，但 docs/06 未定义、t1 迁移未建；
 * - 任务约束"不改 schema"，因此默认 `RECONCILE_STORE=auto`：
 *   探测到 `drift_log` → 用 Postgres；探测不到 → 落文件（`artifacts/reconcile/<day>/<platform>.json`）；
 * - 两种实现共享同一幂等语义：唯一键 `(org_id, day, platform, drift_key)`，
 *   重复对账只更新 `last_detected_at / seen_count / 当前值`，**不新增行**。
 *
 * 建议 DDL（未执行，见 docs/验收记录-M8-对账日报.md §4）：
 * ```sql
 * CREATE TABLE drift_log (
 *   id uuid PRIMARY KEY,
 *   org_id bigint NOT NULL DEFAULT 1,
 *   platform text NOT NULL CHECK (platform IN ('pdd','1688')),
 *   day date NOT NULL,
 *   drift_key text NOT NULL CHECK (char_length(drift_key) = 35),
 *   kind text NOT NULL,
 *   severity text NOT NULL CHECK (severity IN ('low','medium','high')),
 *   subject jsonb NOT NULL DEFAULT '{}',
 *   local_value jsonb,
 *   platform_value jsonb,
 *   detail text NOT NULL,
 *   suggestion jsonb NOT NULL DEFAULT '{}',
 *   status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed','ignored')),
 *   first_detected_at timestamptz NOT NULL,
 *   last_detected_at timestamptz NOT NULL,
 *   seen_count integer NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
 *   detected_at timestamptz NOT NULL,
 *   created_at timestamptz NOT NULL DEFAULT now(),
 *   updated_at timestamptz NOT NULL DEFAULT now(),
 *   UNIQUE (org_id, day, platform, drift_key)
 * );
 * CREATE INDEX ix_drift_day_platform ON drift_log (day, platform, kind);
 * ```
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@dssaas/db';
import { uuidv7 } from '../lib/ids.js';
import { DRIFT_KINDS, type DetectedDrift, type DriftKind, type DriftRecord, type Platform } from './types.js';

export class DriftStoreUnavailableError extends Error {
  readonly ddl: string;

  constructor(message: string, ddl: string) {
    super(message);
    this.name = 'DriftStoreUnavailableError';
    this.ddl = ddl;
  }
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface DriftStore {
  readonly name: 'memory' | 'file' | 'postgres';
  /** 幂等写入：同 key 更新，不新增行。 */
  upsert(platform: Platform, day: string, drifts: readonly DetectedDrift[]): Promise<UpsertResult>;
  list(day: string, platform?: Platform): Promise<DriftRecord[]>;
  count(day: string, platform?: Platform, kind?: DriftKind): Promise<number>;
  countByKind(day: string, platform?: Platform): Promise<Record<string, number>>;
  /** 存储可用性（file 恒 true；postgres 探测表是否存在）。 */
  probe(): Promise<{ ok: boolean; reason: string | null }>;
}

export const PROPOSED_DRIFT_LOG_DDL = `CREATE TABLE drift_log (
  id uuid PRIMARY KEY,
  org_id bigint NOT NULL DEFAULT 1,
  platform text NOT NULL CHECK (platform IN ('pdd','1688')),
  day date NOT NULL,
  drift_key text NOT NULL CHECK (char_length(drift_key) = 35),
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low','medium','high')),
  subject jsonb NOT NULL DEFAULT '{}',
  local_value jsonb,
  platform_value jsonb,
  detail text NOT NULL,
  suggestion jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','fixed','ignored')),
  first_detected_at timestamptz NOT NULL,
  last_detected_at timestamptz NOT NULL,
  seen_count integer NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  detected_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, day, platform, drift_key)
);
CREATE INDEX ix_drift_day_platform ON drift_log (day, platform, kind);`;

function mergeSeen(
  existing: DriftRecord | undefined,
  incoming: DetectedDrift,
): { record: DriftRecord; state: 'inserted' | 'updated' | 'unchanged' } {
  if (!existing) {
    return {
      state: 'inserted',
      record: {
        ...incoming,
        first_detected_at: incoming.detected_at,
        last_detected_at: incoming.detected_at,
        seen_count: 1,
      },
    };
  }
  const identical =
    existing.last_detected_at === incoming.detected_at &&
    JSON.stringify(existing.local) === JSON.stringify(incoming.local) &&
    JSON.stringify(existing.platform_value) === JSON.stringify(incoming.platform_value) &&
    existing.detail === incoming.detail &&
    existing.severity === incoming.severity;
  return {
    // 同一天重复对账会更新 last_detected_at / seen_count，因此默认计为 updated；
    // 只有"同一时刻同一内容"的重放才算 unchanged。
    state: identical ? 'unchanged' : 'updated',
    record: {
      ...existing,
      ...incoming,
      // 首次发现时间与已见次数必须保留，否则"同一天重复对账"会看起来像新差异。
      first_detected_at: existing.first_detected_at,
      last_detected_at: incoming.detected_at,
      seen_count: existing.seen_count + 1,
    },
  };
}

function tally(states: readonly ('inserted' | 'updated' | 'unchanged')[]): UpsertResult {
  return {
    inserted: states.filter((state) => state === 'inserted').length,
    updated: states.filter((state) => state === 'updated').length,
    unchanged: states.filter((state) => state === 'unchanged').length,
  };
}

/** 内存实现（单测/短生命周期）。 */
export class MemoryDriftStore implements DriftStore {
  readonly name = 'memory' as const;
  private readonly rows = new Map<string, DriftRecord>();

  private static rowKey(platform: Platform, day: string, driftKey: string): string {
    return `${day}|${platform}|${driftKey}`;
  }

  async upsert(platform: Platform, day: string, drifts: readonly DetectedDrift[]): Promise<UpsertResult> {
    const states: Array<'inserted' | 'updated' | 'unchanged'> = [];
    for (const drift of drifts) {
      const key = MemoryDriftStore.rowKey(platform, day, drift.drift_key);
      const merged = mergeSeen(this.rows.get(key), drift);
      this.rows.set(key, merged.record);
      states.push(merged.state);
    }
    return tally(states);
  }

  async list(day: string, platform?: Platform): Promise<DriftRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.day === day && (platform === undefined || row.platform === platform))
      .sort((a, b) => a.drift_key.localeCompare(b.drift_key));
  }

  async count(day: string, platform?: Platform, kind?: DriftKind): Promise<number> {
    return (await this.list(day, platform)).filter((row) => (kind ? row.kind === kind : true)).length;
  }

  async countByKind(day: string, platform?: Platform): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const row of await this.list(day, platform)) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    return counts;
  }

  async probe(): Promise<{ ok: boolean; reason: string | null }> {
    return { ok: true, reason: null };
  }
}

interface FilePayload {
  day: string;
  platform: Platform;
  generated_at: string;
  items: DriftRecord[];
}

/** 文件实现：`<dir>/<day>/<platform>.json`，原子写（tmp + rename）。 */
export class FileDriftStore implements DriftStore {
  readonly name = 'file' as const;

  constructor(private readonly directory: string) {}

  private fileOf(platform: Platform, day: string): string {
    return path.join(this.directory, day, `${platform}.json`);
  }

  private async read(platform: Platform, day: string): Promise<FilePayload> {
    try {
      const raw = await readFile(this.fileOf(platform, day), 'utf8');
      const parsed = JSON.parse(raw) as FilePayload;
      if (!Array.isArray(parsed.items)) return { day, platform, generated_at: new Date(0).toISOString(), items: [] };
      return parsed;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { day, platform, generated_at: new Date(0).toISOString(), items: [] };
      throw error;
    }
  }

  private async write(payload: FilePayload): Promise<void> {
    const file = this.fileOf(payload.platform, payload.day);
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(temp, file);
  }

  async upsert(platform: Platform, day: string, drifts: readonly DetectedDrift[]): Promise<UpsertResult> {
    const payload = await this.read(platform, day);
    const byKey = new Map(payload.items.map((item) => [item.drift_key, item]));
    const states: Array<'inserted' | 'updated' | 'unchanged'> = [];
    for (const drift of drifts) {
      const merged = mergeSeen(byKey.get(drift.drift_key), drift);
      byKey.set(drift.drift_key, merged.record);
      states.push(merged.state);
    }
    payload.items = [...byKey.values()].sort((a, b) => a.drift_key.localeCompare(b.drift_key));
    payload.generated_at = new Date().toISOString();
    await this.write(payload);
    return tally(states);
  }

  async list(day: string, platform?: Platform): Promise<DriftRecord[]> {
    const platforms: Platform[] = platform ? [platform] : ['pdd', '1688'];
    const rows: DriftRecord[] = [];
    for (const candidate of platforms) {
      const payload = await this.read(candidate, day);
      rows.push(...payload.items);
    }
    return rows.sort((a, b) => a.drift_key.localeCompare(b.drift_key));
  }

  async count(day: string, platform?: Platform, kind?: DriftKind): Promise<number> {
    return (await this.list(day, platform)).filter((row) => (kind ? row.kind === kind : true)).length;
  }

  async countByKind(day: string, platform?: Platform): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const row of await this.list(day, platform)) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    return counts;
  }

  async probe(): Promise<{ ok: boolean; reason: string | null }> {
    try {
      await mkdir(this.directory, { recursive: true });
      return { ok: true, reason: null };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 供验收脚本/测试查看落盘目录。 */
  directoryPath(): string {
    return this.directory;
  }
}

/**
 * Postgres 实现 —— 适配 t37 落地的 `drift_log` 实际列：
 * `id, org_id, platform, day, drift_key, kind, severity, detail(jsonb), detected_at, fixed_at, ...`。
 *
 * 为什么把 `subject/local/platform_value/suggestion/status/first_detected_at/last_detected_at/seen_count`
 * 放进 `detail` jsonb：t37 的 `detail` 是唯一承载"差异内容"的 jsonb 列（schema 不改），
 * 而幂等判据（首次发现时间、已见次数、状态）必须随之保存 —— 具体键约定见验收记录 §4。
 *
 * 幂等：唯一索引 `uq_drift_day (platform, day, drift_key) WHERE archived_at IS NULL`
 * → `ON CONFLICT (platform, day, drift_key) WHERE archived_at IS NULL`。
 */
export class PgDriftStore implements DriftStore {
  readonly name = 'postgres' as const;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly orgId: bigint = 1n,
  ) {}

  async probe(): Promise<{ ok: boolean; reason: string | null }> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ reg: string | null }>>(
      `SELECT to_regclass('public.drift_log')::text AS reg`,
    );
    const reg = rows[0]?.reg ?? null;
    return reg === null
      ? { ok: false, reason: 'drift_log 表不存在（需先执行 t37 迁移 20261020250000_orders_drift_after_sale）' }
      : { ok: true, reason: null };
  }

  private async ensure(): Promise<void> {
    const probe = await this.probe();
    if (!probe.ok) {
      throw new DriftStoreUnavailableError(
        `RECONCILE_STORE=postgres 但 drift_log 不可用：${probe.reason}`,
        PROPOSED_DRIFT_LOG_DDL,
      );
    }
  }

  /** 把 DriftRecord 的扩展字段打包进 `detail` jsonb（t37 表结构只有 detail 承载内容）。 */
  private detailPayload(drift: DetectedDrift): string {
    return JSON.stringify({
      text: drift.detail,
      subject: drift.subject,
      local: drift.local,
      platform_value: drift.platform_value,
      suggestion: drift.suggestion,
      status: 'open',
      first_detected_at: drift.detected_at,
      last_detected_at: drift.detected_at,
      seen_count: 1,
    });
  }

  async upsert(platform: Platform, day: string, drifts: readonly DetectedDrift[]): Promise<UpsertResult> {
    await this.ensure();
    const states: Array<'inserted' | 'updated' | 'unchanged'> = [];
    for (const drift of drifts) {
      if (!DRIFT_KINDS.includes(drift.kind)) throw new TypeError(`未知差异类型：${String(drift.kind)}`);
      const rows = await this.prisma.$queryRawUnsafe<Array<{ inserted: boolean }>>(
        `INSERT INTO drift_log
           (id, org_id, platform, day, drift_key, kind, severity, detail, detected_at)
         VALUES ($1::uuid, $2, $3, $4::date, $5, $6, $7, $8::jsonb, $9::timestamptz)
         ON CONFLICT (platform, day, drift_key) WHERE archived_at IS NULL DO UPDATE
           SET severity = EXCLUDED.severity,
               kind = EXCLUDED.kind,
               detail = jsonb_build_object(
                 'text', EXCLUDED.detail->>'text',
                 'subject', EXCLUDED.detail->'subject',
                 'local', EXCLUDED.detail->'local',
                 'platform_value', EXCLUDED.detail->'platform_value',
                 'suggestion', EXCLUDED.detail->'suggestion',
                 'status', COALESCE(drift_log.detail->>'status', 'open'),
                 'first_detected_at', COALESCE(drift_log.detail->>'first_detected_at', EXCLUDED.detail->>'first_detected_at'),
                 'last_detected_at', EXCLUDED.detail->>'last_detected_at',
                 'seen_count', (COALESCE((drift_log.detail->>'seen_count')::int, 0) + 1)
               ),
               updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        uuidv7(),
        this.orgId,
        platform,
        day,
        drift.drift_key,
        drift.kind,
        drift.severity,
        this.detailPayload(drift),
        drift.detected_at,
      );
      states.push(rows[0]?.inserted === true ? 'inserted' : 'updated');
    }
    return tally(states);
  }

  async list(day: string, platform?: Platform): Promise<DriftRecord[]> {
    await this.ensure();
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT platform, day::text AS day, drift_key, kind, severity, detail, detected_at
         FROM drift_log
        WHERE org_id = $1 AND day = $2::date AND archived_at IS NULL
          ${platform ? 'AND platform = $3' : ''}
        ORDER BY drift_key`,
      ...(platform ? [this.orgId, day, platform] : [this.orgId, day]),
    );
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Record<string, unknown>): DriftRecord {
    const iso = (value: unknown): string =>
      value instanceof Date ? value.toISOString() : String(value ?? '');
    const detail = (typeof row.detail === 'object' && row.detail !== null ? row.detail : {}) as Record<string, unknown>;
    const detectedAt = iso(row.detected_at);
    return {
      drift_key: String(row.drift_key),
      platform: row.platform as Platform,
      day: String(row.day),
      kind: row.kind as DriftKind,
      severity: row.severity as DriftRecord['severity'],
      subject: (detail.subject ?? null) as DriftRecord['subject'],
      local: (detail.local ?? null) as DriftRecord['local'],
      platform_value: (detail.platform_value ?? null) as DriftRecord['platform_value'],
      detail: String(detail.text ?? ''),
      suggestion: (detail.suggestion ?? {}) as DriftRecord['suggestion'],
      status: (detail.status ?? 'open') as DriftRecord['status'],
      detected_at: detectedAt,
      first_detected_at: String(detail.first_detected_at ?? detectedAt),
      last_detected_at: String(detail.last_detected_at ?? detectedAt),
      seen_count: Number(detail.seen_count ?? 1),
    };
  }

  async count(day: string, platform?: Platform, kind?: DriftKind): Promise<number> {
    const counts = await this.countByKind(day, platform, kind);
    return Object.values(counts).reduce((sum, value) => sum + value, 0);
  }

  async countByKind(day: string, platform?: Platform, kind?: DriftKind): Promise<Record<string, number>> {
    await this.ensure();
    const rows = await this.prisma.$queryRawUnsafe<Array<{ kind: string; count: number }>>(
      `SELECT kind, count(*)::int AS count
         FROM drift_log
        WHERE org_id = $1 AND day = $2::date AND archived_at IS NULL
          ${platform ? 'AND platform = $3' : ''}
          ${kind ? `AND kind = $${platform ? 4 : 3}` : ''}
        GROUP BY kind`,
      ...(platform && kind ? [this.orgId, day, platform, kind] : platform ? [this.orgId, day, platform] : kind ? [this.orgId, day, kind] : [this.orgId, day]),
    );
    return Object.fromEntries(rows.map((row) => [row.kind, Number(row.count)]));
  }
}

export interface DriftStoreConfig {
  mode: 'auto' | 'file' | 'postgres';
  directory: string;
  orgId?: bigint;
}

export interface DriftStoreBundle {
  store: DriftStore;
  note: string;
}

/** 创建存储：`auto` 优先 Postgres，表缺失时显式降级为文件并给出原因。 */
export async function createDriftStore(
  prisma: PrismaClient,
  config: DriftStoreConfig,
): Promise<DriftStoreBundle> {
  if (config.mode === 'file') {
    return { store: new FileDriftStore(config.directory), note: 'RECONCILE_STORE=file（显式文件存储）' };
  }
  const pg = new PgDriftStore(prisma, config.orgId ?? 1n);
  if (config.mode === 'postgres') {
    return { store: pg, note: 'RECONCILE_STORE=postgres（drift_log）' };
  }
  const probe = await pg.probe();
  if (probe.ok) return { store: pg, note: 'auto → drift_log' };
  return {
    store: new FileDriftStore(config.directory),
    note: `auto → 文件存储（${probe.reason ?? 'drift_log 不可用'}）`,
  };
}
