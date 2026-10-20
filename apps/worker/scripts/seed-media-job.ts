/**
 * t34 证据脚本：造一个 status=retrieved 的 media_job（两个 worker 并发消费用）。
 * 运行：DATABASE_URL=... tsx scripts/seed-media-job.ts
 */
import { PrismaClient } from '@dssaas/db';

const prisma = new PrismaClient();
const JOB_ID = '99999999-9999-7999-8999-999999999999';

async function main(): Promise<void> {
  await prisma.costLedger.deleteMany({ where: { refType: 'media_job', refId: JOB_ID } });
  await prisma.mediaAsset.deleteMany({ where: { mediaJobId: JOB_ID } });
  await prisma.mediaJob.deleteMany({ where: { id: JOB_ID } });

  const provider =
    (await prisma.provider.findFirst({ where: { name: 't34_race_provider' } })) ??
    (await prisma.provider.create({
      data: {
        name: 't34_race_provider',
        kind: 'image',
        vendor: 'other',
        baseUrl: 'https://example.com',
        credentialRef: 'dsh/t34-race',
        status: 'active',
      },
    }));
  const model =
    (await prisma.model.findFirst({ where: { name: 't34_race_model' } })) ??
    (await prisma.model.create({
      data: {
        providerId: provider.id,
        name: 't34_race_model',
        externalModelId: 't34_race_ext',
        displayName: 'T34 竞争测试模型',
        capability: 'image',
        paramsSchema: {},
        price: {},
      },
    }));

  await prisma.mediaJob.create({
    data: {
      id: JOB_ID,
      purpose: 'image',
      providerId: provider.id,
      modelId: model.id,
      params: { kind: 'scene', source: 'shoot' },
      status: 'retrieved',
      idempotencyKey: 't34-race-idem',
      externalJobId: 'seed-retrieved',
      pollAfter: null,
      costCents: 4,
      subjectType: 'other',
    },
  });
  console.log(JOB_ID);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
