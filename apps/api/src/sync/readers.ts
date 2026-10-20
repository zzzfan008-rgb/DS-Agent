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

/** 合成 buyer_ref：sha256 hex（64 位小写）——DB 硬 CHECK，禁止明文买家信息。 */
const buyerRef = (suffix: string): string => suffix.padEnd(64, '0').slice(0, 64);

const RECORDED_PAGES: Record<SyncResource, RecordedPage[]> = {
  orders: [
    {
      cursor: 'ck-orders-1',
      items: [
        {
          order_id: 'ALI-ORDER-1001',
          status: 'paid',
          total_cents: 31600,
          freight_cents: 800,
          discount_cents: 0,
          paid_cents: 31600,
          buyer_ref: buyerRef('1a2b3c'),
          platform_created_at: '2026-10-18T02:00:00.000Z',
          items: [
            {
              platform_sku_ref: 'ALI-SKU-0001',
              title: '女式纯棉翻领长袖衬衫 本白 M',
              qty: 2,
              unit_price_cents: 15800,
              amount_cents: 31600,
              color_id: 'WH-0001',
              size_code: 'M',
            },
          ],
        },
        {
          order_id: 'ALI-ORDER-1003',
          status: 'shipped',
          total_cents: 15800,
          freight_cents: 0,
          discount_cents: 0,
          paid_cents: 15800,
          buyer_ref: buyerRef('4d5e6f'),
          platform_created_at: '2026-10-19T02:00:00.000Z',
          items: [
            {
              platform_sku_ref: 'ALI-SKU-0001',
              title: '女式纯棉翻领长袖衬衫 本白 M',
              qty: 1,
              unit_price_cents: 15800,
              amount_cents: 15800,
              color_id: 'WH-0001',
              size_code: 'M',
            },
          ],
        },
        {
          order_id: 'ALI-ORDER-1004',
          status: 'paid',
          total_cents: 30000,
          freight_cents: 0,
          discount_cents: 0,
          paid_cents: 30000,
          buyer_ref: buyerRef('7a8b9c'),
          platform_created_at: '2026-10-19T03:00:00.000Z',
          items: [
            {
              platform_sku_ref: 'ALI-SKU-0002',
              title: '女式纯棉翻领长袖衬衫 牛仔蓝 L',
              qty: 2,
              unit_price_cents: 15000,
              amount_cents: 30000,
              color_id: 'BL-0102',
              size_code: 'L',
            },
          ],
        },
      ],
    },
    {
      cursor: 'ck-orders-2',
      items: [
        {
          order_id: 'ALI-ORDER-1005',
          status: 'refunded',
          total_cents: 15800,
          freight_cents: 0,
          discount_cents: 0,
          paid_cents: 15800,
          buyer_ref: buyerRef('abcdef'),
          platform_created_at: '2026-10-19T04:00:00.000Z',
          items: [
            {
              platform_sku_ref: 'ALI-SKU-0003',
              title: '女式纯棉翻领长袖衬衫 本白 L',
              qty: 1,
              unit_price_cents: 15800,
              amount_cents: 15800,
              color_id: 'WH-0001',
              size_code: 'L',
            },
          ],
        },
        {
          order_id: 'ALI-ORDER-1006',
          status: 'paid',
          total_cents: 31600,
          freight_cents: 0,
          discount_cents: 0,
          paid_cents: 31600,
          buyer_ref: buyerRef('0f1e2d'),
          platform_created_at: '2026-10-19T05:00:00.000Z',
          items: [
            {
              platform_sku_ref: 'ALI-SKU-0001',
              title: '女式纯棉翻领长袖衬衫 本白 M',
              qty: 2,
              unit_price_cents: 15800,
              amount_cents: 31600,
              color_id: 'WH-0001',
              size_code: 'M',
            },
          ],
        },
      ],
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
      items: [
        {
          after_sale_id: 'ALI-AS-9001',
          order_id: 'ALI-ORDER-1004',
          kind: 'refund_only',
          status: 'open',
          amount_cents: 5000,
          opened_at: '2026-10-19T06:00:00.000Z',
        },
        {
          after_sale_id: 'ALI-AS-9002',
          order_id: 'ALI-ORDER-1005',
          kind: 'return_refund',
          status: 'closed',
          amount_cents: 15800,
          opened_at: '2026-10-19T07:00:00.000Z',
        },
      ],
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
