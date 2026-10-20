/** 写入门服务装配（进程内单例，测试可整体替换 port/confirm store）。 */
import type { FastifyInstance } from 'fastify';
import { ApprovalService } from './approval.js';
import { InMemoryConfirmTokenStore, type ConfirmTokenStore } from './confirm.js';
import { WriteGate } from './gate.js';
import { KillSwitchService } from './kill-switch.js';
import { AdapterDryRunPort, type PlatformWritePort } from './platform-port.js';

export interface WriteGateServices {
  approvals: ApprovalService;
  killSwitch: KillSwitchService;
  confirmTokens: ConfirmTokenStore;
  platform: PlatformWritePort;
  gate: WriteGate;
}

const registry = new WeakMap<FastifyInstance, WriteGateServices>();

export function getWriteGateServices(app: FastifyInstance): WriteGateServices {
  const existing = registry.get(app);
  if (existing) return existing;
  const confirmTokens = new InMemoryConfirmTokenStore();
  const platform = new AdapterDryRunPort();
  const killSwitch = new KillSwitchService(app.prisma, app.audit);
  const approvals = new ApprovalService(app.prisma, app.audit);
  const gate = new WriteGate({
    prisma: app.prisma,
    audit: app.audit,
    approvals,
    killSwitch,
    confirmTokens,
    platform,
  });
  const services = { approvals, killSwitch, confirmTokens, platform, gate };
  registry.set(app, services);
  return services;
}
