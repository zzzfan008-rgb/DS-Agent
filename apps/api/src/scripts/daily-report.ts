/**
 * 每日对账 + 日报脚本（cron / 手动）。
 *
 * 用法：
 *   pnpm --filter @dssaas/api daily:report                       # 今天，双平台，默认 recorded 干跑
 *   pnpm --filter @dssaas/api daily:report -- --date=2026-10-20
 *   pnpm --filter @dssaas/api daily:report -- --platform=1688 --no-reconcile
 *   RECONCILE_READER=adapter pnpm --filter @dssaas/api daily:report   # 真实平台（未核验会 409）
 *
 * 产物：
 * - `artifacts/daily/<day>.json`：快照（双平台 + 合并口径），可直接进 Git/归档；
 * - `event_log` 中 topic=`reconcile.alert`：阈值触发的告警记录（同日同指标幂等）；
 * - stdout：逐平台摘要（上架/驳回/积压/消息/媒体成本/差异数/告警数）。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { disconnectPrisma, getPrisma } from '@dssaas/db';
import { loadConfig, loadEnvFiles } from '../config.js';
import { assertRecordedAllowed } from '../lib/adapter-refusal.js';
import { isDayString, todayBusinessDay } from '../lib/day.js';
import { createDriftStore } from '../reconcile/stores.js';
import { createPlatformReader, type ReaderMode } from '../reconcile/readers.js';
import { ReconcileService } from '../reconcile/service.js';
import type { Platform } from '../reconcile/types.js';
import { buildDailyReport, type DailyReport } from '../daily/report.js';
import { persistAlerts } from '../daily/alerts.js';
import { criticalThresholdStatus } from '../daily/thresholds.js';

interface CliOptions {
  day: string;
  platforms: Platform[];
  reconcile: boolean;
  mode: ReaderMode;
}

function parseArgs(argv: string[], defaultMode: ReaderMode): CliOptions {
  let day = todayBusinessDay(new Date());
  let platformArg = 'both';
  let reconcile = true;
  let mode: ReaderMode = defaultMode;

  for (const arg of argv) {
    if (arg.startsWith('--date=')) day = arg.slice('--date='.length);
    else if (arg.startsWith('--platform=')) platformArg = arg.slice('--platform='.length);
    else if (arg === '--no-reconcile') reconcile = false;
    else if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length);
      if (value !== 'recorded' && value !== 'adapter') throw new Error(`--mode 只接受 recorded|adapter，收到 ${value}`);
      mode = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数：${arg}`);
    }
  }

  if (!isDayString(day)) throw new Error(`--date 必须是 YYYY-MM-DD，收到 ${day}`);
  if (platformArg === 'both') return { day, platforms: ['pdd', '1688'], reconcile, mode };
  if (platformArg === 'pdd' || platformArg === '1688') return { day, platforms: [platformArg], reconcile, mode };
  throw new Error(`--platform 只接受 both|pdd|1688，收到 ${platformArg}`);
}

async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();
  const options = parseArgs(process.argv.slice(2), config.reconcileReader);
  assertRecordedAllowed(config.nodeEnv, options.mode, '生成日报');
  const prisma = getPrisma();

  try {
    const bundle = await createDriftStore(prisma, {
      mode: config.reconcileStore,
      directory: config.reconcileDir,
    });
    console.log(`[daily] day=${options.day} platforms=${options.platforms.join(',')} reconcile=${options.reconcile} mode=${options.mode}`);
    console.log(`[daily] drift store = ${bundle.store.name}（${bundle.note}）`);
    console.log(`[daily] thresholds = ${config.dailyAlertThresholds ? JSON.stringify(config.dailyAlertThresholds) : '未配置（只报事实，不告警）'}`);
    // t49：关键差异告警未配置时显式点名 —— 不配置不算错，但必须让人看见风险敞口。
    {
      const critical = criticalThresholdStatus(config.dailyAlertThresholds);
      for (const item of critical) {
        console.log(
          `[daily] critical alert ${item.kind}: ${item.configured ? `已配置阈值 ${item.threshold}` : `未配置（推荐 ${item.recommended}）`}`,
        );
      }
      const missing = critical.filter((item) => !item.configured);
      if (missing.length > 0) {
        console.warn(
          `[daily] WARNING: ${missing.map((item) => item.kind).join(', ')} 未配置告警阈值 —— ` +
            '这类差异出现时不会产生 event_log 告警，风险敞口无人看着。' +
            `建议在 DAILY_ALERT_THRESHOLDS 里加 "drift_by_kind":{"${missing[0]!.kind}":0}`,
        );
      }
    }

    const perPlatform: DailyReport[] = [];
    const reconcileSummaries: Array<{ platform: Platform; total: number; by_kind: Record<string, number>; store: string; persisted: { inserted: number; updated: number; unchanged: number } }> = [];

    for (const platform of options.platforms) {
      if (options.reconcile) {
        const service = new ReconcileService({
          prisma,
          store: bundle.store,
          storeNote: bundle.note,
          reader: createPlatformReader(options.mode),
        });
        const result = await service.run(platform, {
          day: options.day,
          requestId: `daily-report-${options.day}-${platform}`,
          actorId: '',
          mode: options.mode,
        });
        reconcileSummaries.push({
          platform,
          total: result.summary.total,
          by_kind: result.summary.by_kind,
          store: result.store,
          persisted: result.persisted,
        });
        console.log(
          `[daily] reconcile ${platform}: total=${result.summary.total} kinds=${JSON.stringify(result.summary.by_kind)} ` +
            `persisted(inserted=${result.persisted.inserted},updated=${result.persisted.updated},unchanged=${result.persisted.unchanged}) store=${result.store}`,
        );
      }

      const report = await buildDailyReport({
        prisma,
        driftStore: bundle.store,
        driftStoreNote: bundle.note,
        day: options.day,
        platform,
        thresholds: config.dailyAlertThresholds,
      });
      perPlatform.push(report);
      const alerts = await persistAlerts({
        prisma,
        day: options.day,
        platform,
        alerts: report.alerts,
      });
      if (report.alerts.length > 0) {
        console.log(`[daily] ${platform} alerts=${report.alerts.length}（写入 ${alerts.inserted}，已存在 ${alerts.skipped}）`);
        for (const alert of report.alerts) console.log(`[daily]   - ${alert.level} ${alert.metric}=${alert.value} > ${alert.threshold}：${alert.message}`);
      }
      console.log(
        `[daily] metrics ${platform}: listed=${report.metrics.listed} rejected=${report.metrics.rejected} ` +
          `approvals_pending=${report.metrics.approvals_pending} messages=${report.metrics.messages} ` +
          `media_cost_cents=${report.metrics.media_cost_cents} drift_total=${report.metrics.drift_total}`,
      );
    }

    const combined = await buildDailyReport({
      prisma,
      driftStore: bundle.store,
      driftStoreNote: bundle.note,
      day: options.day,
      platform: null,
      thresholds: config.dailyAlertThresholds,
    });
    const combinedAlerts = await persistAlerts({ prisma, day: options.day, platform: null, alerts: combined.alerts });
    console.log(
      `[daily] metrics all: listed=${combined.metrics.listed} rejected=${combined.metrics.rejected} ` +
        `approvals_pending=${combined.metrics.approvals_pending} messages=${combined.metrics.messages} ` +
        `media_cost_cents=${combined.metrics.media_cost_cents} drift_total=${combined.metrics.drift_total} ` +
        `alerts=${combined.alerts.length}（写入 ${combinedAlerts.inserted}，已存在 ${combinedAlerts.skipped}）`,
    );

    const snapshot = {
      schema: 'dssaas-daily-report/v1',
      day: options.day,
      generated_at: new Date().toISOString(),
      mode: options.mode,
      drift_store: { name: bundle.store.name, note: bundle.note },
      thresholds_configured: config.dailyAlertThresholds !== null,
      reconcile: options.reconcile ? reconcileSummaries : null,
      platforms: perPlatform,
      combined,
    };
    await mkdir(config.dailySnapshotDir, { recursive: true });
    const file = path.join(config.dailySnapshotDir, `${options.day}.json`);
    await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    console.log(`[daily] snapshot written: ${file}`);
  } finally {
    await disconnectPrisma();
  }
}

main().catch((error: unknown) => {
  console.error('[daily] failed:', error instanceof Error ? error.message : error);
  if (error instanceof Error && 'detail' in error) console.error('[daily] detail:', JSON.stringify((error as { detail?: unknown }).detail));
  process.exitCode = 1;
});
