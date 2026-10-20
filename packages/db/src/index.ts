/**
 * @dssaas/db —— Prisma 客户端入口。
 *
 * 硬规则（方案总纲 19.1）：
 * - Postgres 是业务唯一事实源，业务读取路径只能经由本包；
 * - 业务代码不得读取 DSH 工作目录下的 .jsonl 或 storage-json 数据；
 * - 凭据（平台 appSecret、模型 key）不入库，本包只存 credential_ref 引用。
 */
import { PrismaClient } from '@prisma/client';

export { Prisma, PrismaClient } from '@prisma/client';
export type { PrismaClient as DbClient } from '@prisma/client';

let singleton: PrismaClient | undefined;

/** 进程内复用同一个连接池；worker 与 api 各自持有一个实例。 */
export function getPrisma(): PrismaClient {
  singleton ??= new PrismaClient({
    log: ['warn', 'error'],
  });
  return singleton;
}

/** 优雅退出时调用，避免容器重启留下悬挂连接。 */
export async function disconnectPrisma(): Promise<void> {
  if (singleton) {
    await singleton.$disconnect();
    singleton = undefined;
  }
}
