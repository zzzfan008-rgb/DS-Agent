/**
 * 同步 reader —— 录制样本（干跑）/ 真实 adapter（硬拒绝）。
 *
 * 录制 reader 的游标是**合成**的（`ck-orders-1` 等），仅用于验证：
 * 分页推进 → `sync_cursor` 落库 → 中断后从游标续跑；不代表平台真实游标格式。
 */

import { adapterContractRefusal } from '../lib/adapter-refusal.js';
import type { Platform } from '../reconcile/types.js';
import type { SyncPage, SyncReadInput, SyncReader, SyncResource } from './types.js';

interface RecordedPage {
  cursor: string;
  items: unknown[];
}

const RECORDED_AT = '2026-10-20T02:00:00.000Z';

const RECORDED_PAGES: Record<SyncResource, RecordedPage[]> = {
  orders: [
    {
      cursor: 'ck-orders-1',
      items: [
        { order_id: 'ALI-ORDER-1001', status: 'paid', amount_cents: 31600, sku_count: 1 },
        { order_id: 'ALI-ORDER-1002', status: 'paid', amount_cents: 63200, sku_count: 2 },
      ],
    },
    {
      cursor: 'ck-orders-2',
      items: [{ order_id: 'ALI-ORDER-1003', status: 'shipped', amount_cents: 15800, sku_count: 1 }],
    },
  ],
  products: [
    {
      cursor: 'ck-products-1',
      items: [
        { item_id: 'ALI-2026-0001', state: 'online' },
        { item_id: 'ALI-2026-0002', state: 'online' },
        { item_id: 'ALI-2026-0006', state: 'online' },
      ],
    },
  ],
  stock: [
    {
      cursor: 'ck-stock-1',
      items: [
        { item_id: 'ALI-2026-0001', platform_sku_id: 'ALI-SKU-0001', stock_qty: 480 },
        { item_id: 'ALI-2026-0003', platform_sku_id: 'ALI-SKU-0003', stock_qty: 0 },
      ],
    },
  ],
  after_sale: [
    {
      cursor: 'ck-aftersale-1',
      items: [{ after_sale_id: 'ALI-AS-9001', order_id: 'ALI-ORDER-1001', status: 'refund_pending' }],
    },
  ],
  messages: [
    {
      cursor: 'ck-messages-1',
      items: [{ conversation_id: 'ali-conv-1', message_id: 'ali-msg-1' }],
    },
  ],
};

export class RecordedSyncReader implements SyncReader {
  readonly source = 'recorded' as const;

  constructor(private readonly resource: SyncResource) {}

  async read(input: SyncReadInput): Promise<SyncPage> {
    const pages = RECORDED_PAGES[this.resource];
    let index = 0;
    if (input.cursor !== null) {
      const found = pages.findIndex((page) => page.cursor === input.cursor);
      index = found + 1;
    }
    if (index >= pages.length) {
      return { items: [], nextCursor: input.cursor, hasMore: false, watermarkAt: RECORDED_AT };
    }
    const page = pages[index]!;
    return {
      items: page.items,
      nextCursor: page.cursor,
      hasMore: index + 1 < pages.length,
      watermarkAt: RECORDED_AT,
    };
  }
}

export class AdapterSyncReader implements SyncReader {
  readonly source = 'adapter' as const;

  constructor(private readonly resource: SyncResource) {}

  async read(input: SyncReadInput): Promise<SyncPage> {
    throw adapterContractRefusal(input.platform, `同步 ${this.resource}（真实接口未核验）`);
  }
}

export type ReaderMode = 'recorded' | 'adapter';

/** 按模式构造全部 resource 的 reader。 */
export function createSyncReaders(mode: ReaderMode): Record<SyncResource, SyncReader> {
  const make = (resource: SyncResource): SyncReader =>
    mode === 'adapter' ? new AdapterSyncReader(resource) : new RecordedSyncReader(resource);
  return {
    products: make('products'),
    orders: make('orders'),
    messages: make('messages'),
    after_sale: make('after_sale'),
    stock: make('stock'),
  };
}

/** 供测试断言：录制样本覆盖的订单号。 */
export function recordedOrderIds(platform: Platform = '1688'): string[] {
  void platform;
  return RECORDED_PAGES.orders.flatMap((page) =>
    page.items.map((item) => String((item as { order_id: string }).order_id)),
  );
}
