/** event_log 清理 CLI：`pnpm --filter @dssaas/api job:purge-event-log`。 */
import { getPrisma, disconnectPrisma } from '@dssaas/db';
import { purgeEventLog } from './retention.js';

const prisma = getPrisma();
try {
  const result = await purgeEventLog(prisma, { logger: console });
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await disconnectPrisma();
}
