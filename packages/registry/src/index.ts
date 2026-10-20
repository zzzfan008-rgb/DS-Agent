/**
 * @dssaas/registry —— 模型网关（M2）。
 *
 * 唯一决定「这次调用打哪个供应商/模型、用什么参数、花多少钱」的模块（docs/07 §0）。
 */
export const REGISTRY_PACKAGE = '@dssaas/registry';

export * from './types.js';
export * from './policy.js';
export * from './metering.js';
export * from './params.js';
export * from './breaker.js';
export * from './quota.js';
export * from './credentials.js';
export * from './adapters.js';
export * from './repo.js';
export * from './gateway.js';
export type { AuditSink } from './audit.js';
