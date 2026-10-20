/**
 * 审计哈希链校验：按 seq 升序复算 chain_prev / chain_hash。
 * 用法：pnpm --filter @dssaas/api audit:verify
 * 退出码：0 = 链完整；1 = 断链/篡改。
 */
import { disconnectPrisma, getPrisma } from '@dssaas/db';
import { loadEnvFiles } from '../config.js';
import { AuditService } from '../services/audit.js';

async function main(): Promise<void> {
  loadEnvFiles();
  const service = new AuditService(getPrisma());
  try {
    const result = await service.verifyChain();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await disconnectPrisma();
  }
}

void main();
