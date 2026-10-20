/**
 * t34 证据脚本：DB 级租约语义（抢占/过期接手/旧 worker 写入被拒/续租失败）。
 * 运行：DATABASE_URL=... tsx scripts/lease-check.ts
 */
import { PrismaClient } from '@dssaas/db';
import { PrismaMediaRepository } from '../src/media/prisma-repository.js';

const JOB_ID = '99999999-9999-7999-8999-999999999999';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const repo = new PrismaMediaRepository(prisma);
    await prisma.mediaJob.update({
      where: { id: JOB_ID },
      data: { status: 'retrieved', lockedBy: null, lockedUntil: null, pollAfter: null },
    });
    const now = new Date();

    const claimedA = await repo.claimDueJobs(now, 1, 'lease-worker-a', 90_000);
    const expires = new Date(Date.now() - 1_000);
    await prisma.mediaJob.update({ where: { id: JOB_ID }, data: { lockedUntil: expires } });
    const claimedB = await repo.claimDueJobs(now, 1, 'lease-worker-b', 90_000);
    const renewA = await repo.renewLease(JOB_ID, 'lease-worker-a', 90_000);
    const writeA = await repo.updateLockedJob(JOB_ID, 'lease-worker-a', { status: 'failed' });
    const writeB = await repo.updateLockedJob(JOB_ID, 'lease-worker-b', { status: 'polling' });
    console.log(
      JSON.stringify({
        claimed_by_a: claimedA.length,
        after_expiry_claimed_by_b: claimedB.length,
        worker_b_lock: claimedB[0]?.lockedBy ?? null,
        renew_old_worker: renewA,
        write_old_worker: writeA,
        write_new_worker: writeB,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
