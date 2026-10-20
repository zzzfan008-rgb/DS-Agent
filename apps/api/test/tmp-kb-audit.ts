import { PrismaClient } from '@dssaas/db';
const prisma = new PrismaClient();
const rows = await prisma.auditLog.findMany({ where: { action: 'kb.document_ingest' }, orderBy: { seq: 'desc' }, take: 3 });
console.log(JSON.stringify(rows.map(r => r.meta), null, 2));
const routes = await prisma.modelRoute.findMany({ where: { purpose: 'embed' }, select: { id: true, status: true, priority: true, modelId: true } });
console.log('routes', routes);
const logs = await prisma.modelCallLog.findMany({ where: { purpose: 'embed' }, orderBy: { createdAt: 'desc' }, take: 3, select: { status: true, errorCode: true, modelId: true } });
console.log('logs', logs);
await prisma.$disconnect();
