/**
 * 平台快照 reader —— 录制样本 / 真实 adapter 两种模式。
 *
 * 真实 reader 的硬拒绝（任务要求"未核验接口硬拒绝"）：
 * - 1688：`Alibaba1688Client.plan()` 直接返回 blocked + TODO 缺口，本模块据此抛
 *   `publish_blocked`（HTTP 409），detail 带 `reason=adapter_contract_unverified` 与 TODO 列表；
 * - 拼多多：`PddClient` 同样未核验，抛同一错误并给 `TODO-PDD-CONTRACT-VERIFY`。
 * 这样接口行为是"明确的阻塞"，而不是"假装成功返回空差异"。
 */

import { adapterContractRefusal } from '../lib/adapter-refusal.js';
import type { Platform, PlatformSnapshot } from './types.js';
import { RECORDED_PLATFORM_SNAPSHOTS } from './recorded-samples.js';

export type ReaderMode = 'recorded' | 'adapter';

export interface SnapshotReadContext {
  /** 业务日（YYYY-MM-DD）。 */
  day: string;
  /** 读取时刻（ISO）。 */
  now: string;
}

export interface PlatformSnapshotReader {
  readonly mode: ReaderMode;
  read(platform: Platform, context: SnapshotReadContext): Promise<PlatformSnapshot>;
}

/** 录制样本 reader：只读、确定性、无网络。 */
export class RecordedPlatformReader implements PlatformSnapshotReader {
  readonly mode = 'recorded' as const;

  async read(platform: Platform, context: SnapshotReadContext): Promise<PlatformSnapshot> {
    const snapshot = RECORDED_PLATFORM_SNAPSHOTS[platform];
    // 深拷贝，避免调用方修改共享样本；capturedAt 保留样本录制时间，便于区分"样本时间"与"对账时间"。
    return {
      ...JSON.parse(JSON.stringify(snapshot)) as PlatformSnapshot,
      platform,
      note: `${snapshot.note}（对账日 ${context.day}，读取于 ${context.now}）`,
    };
  }
}

/** 真实 adapter reader（当前必然硬拒绝）。 */
export class AdapterPlatformReader implements PlatformSnapshotReader {
  readonly mode = 'adapter' as const;

  async read(platform: Platform, _context: SnapshotReadContext): Promise<PlatformSnapshot> {
    throw adapterContractRefusal(platform, '对账读取平台商品快照');
  }
}

export function createPlatformReader(mode: ReaderMode): PlatformSnapshotReader {
  return mode === 'adapter' ? new AdapterPlatformReader() : new RecordedPlatformReader();
}
