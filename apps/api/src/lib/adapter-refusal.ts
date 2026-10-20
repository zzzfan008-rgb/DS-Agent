/**
 * 平台 adapter 契约未核验时的统一硬拒绝。
 *
 * 用在所有"真实读取"入口（对账快照、同步 reader）：
 * - 返回 `publish_blocked`（HTTP 409），detail 带 `reason=adapter_contract_unverified` 与 TODO 列表；
 * - 不是 500、不是空数据 —— 让调用方与前端能区分"平台没数据"与"我们还没接通"。
 */

import { openTodos } from '@dssaas/adapters-1688';
import { ApiError } from './errors.js';
import type { Platform } from '../reconcile/types.js';

export const PDD_CONTRACT_TODO = 'TODO-PDD-CONTRACT-VERIFY';

export function platformTodoIds(platform: Platform): string[] {
  if (platform === '1688') return openTodos().map((item) => item.id);
  return [PDD_CONTRACT_TODO];
}

export function adapterContractRefusal(platform: Platform, purpose: string): ApiError {
  return new ApiError(
    'publish_blocked',
    `平台 ${platform} 契约未核验，拒绝${purpose}（不猜 method/字段名）`,
    {
      detail: {
        reason: 'adapter_contract_unverified',
        platform,
        purpose,
        todo_ids: platformTodoIds(platform),
        next_action: 'complete_contract_verification',
      },
    },
  );
}
