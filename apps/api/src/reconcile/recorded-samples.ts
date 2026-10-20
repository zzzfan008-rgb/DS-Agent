/**
 * 录制样本（平台侧快照）—— 用于 M8 对账机制验证。
 *
 * **诚实性声明**：以下数据是**合成样本**（`verified: false`, `source: 'recorded'`），
 * 按 docs/06 `listing`/`sku_bindings` 与 docs/02 的平台态语义构造，用于覆盖 6 类差异；
 * 它们**不是** 1688 或拼多多的真实返回报文。真实接入后由 adapter reader 替换
 * （见 `readers.ts` 的 `AdapterPlatformReader`，契约未核验时硬拒绝）。
 *
 * 与本地种子数据（`test/reconcile.test.ts`）的约定：
 * - `ALI-2026-0001` 与本地一致（无差异，作为基线）；
 * - `ALI-2026-0002` 价格不一致；`ALI-2026-0003` 库存不一致；
 * - `ALI-2026-0004` 平台下架；`ALI-2026-0005` 平台驳回/违规；
 * - `ALI-2026-0006` 平台独有（本地无 listing）；
 * - 本地 `ALI-2026-0007` 在平台上不存在（本地 published 但平台无）。
 */

import type { PlatformSnapshot } from './types.js';

export const RECORDED_CAPTURED_AT = '2026-10-20T02:00:00.000Z';

export const RECORDED_PLATFORM_SNAPSHOTS: Record<'pdd' | '1688', PlatformSnapshot> = {
  '1688': {
    platform: '1688',
    capturedAt: RECORDED_CAPTURED_AT,
    source: 'recorded',
    verified: false,
    complete: true,
    note: '合成样本：覆盖 6 类差异；非 1688 真实报文（TODO-1688-001/012）',
    items: [
      {
        itemId: 'ALI-2026-0001',
        title: '女式纯棉翻领长袖衬衫（基线，一致）',
        state: 'online',
        updatedAt: '2026-10-20T01:00:00.000Z',
        skus: [{ platformSkuId: 'ALI-SKU-0001', priceCents: 15800, stockQty: 480 }],
      },
      {
        itemId: 'ALI-2026-0002',
        title: '女式纯棉翻领长袖衬衫（价格差异）',
        state: 'online',
        updatedAt: '2026-10-20T01:05:00.000Z',
        skus: [{ platformSkuId: 'ALI-SKU-0002', priceCents: 14900, stockQty: 120 }],
      },
      {
        itemId: 'ALI-2026-0003',
        title: '女式纯棉翻领长袖衬衫（库存差异）',
        state: 'online',
        updatedAt: '2026-10-20T01:10:00.000Z',
        skus: [{ platformSkuId: 'ALI-SKU-0003', priceCents: 15800, stockQty: 0 }],
      },
      {
        itemId: 'ALI-2026-0004',
        title: '女式纯棉翻领长袖衬衫（平台已下架）',
        state: 'offline',
        updatedAt: '2026-10-20T01:15:00.000Z',
        skus: [{ platformSkuId: 'ALI-SKU-0004', priceCents: 15800, stockQty: 200 }],
      },
      {
        itemId: 'ALI-2026-0005',
        title: '女式纯棉翻领长袖衬衫（平台驳回/违规下架）',
        state: 'violation_offline',
        updatedAt: '2026-10-20T01:20:00.000Z',
        skus: [{ platformSkuId: 'ALI-SKU-0005', priceCents: 15800, stockQty: 200 }],
      },
      {
        itemId: 'ALI-2026-0006',
        title: '平台独有商品（本地未建档）',
        state: 'online',
        updatedAt: '2026-10-20T01:25:00.000Z',
        skus: [{ platformSkuId: 'ALI-SKU-0006', priceCents: 9900, stockQty: 50 }],
      },
    ],
  },
  pdd: {
    platform: 'pdd',
    capturedAt: RECORDED_CAPTURED_AT,
    source: 'recorded',
    verified: false,
    complete: false,
    note: '合成样本：M8 无 PDD 契约录制，返回空且不完整快照（不据此推断平台缺商品；真实接通条件见验收文档 §7）',
    items: [],
  },
};
