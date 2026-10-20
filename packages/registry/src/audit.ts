/** Registry 与审计的窄接口：由 apps/api 的 AuditService 适配，registry 不依赖 Fastify。 */
export interface AuditSink {
  record(input: {
    action: string;
    actorType: 'user' | 'agent' | 'worker' | 'system';
    actorId: string | null;
    requestId: string;
    resourceType: string;
    resourceId: string | null;
    before?: unknown;
    after?: unknown;
    irreversible?: boolean;
    meta?: Record<string, unknown>;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<unknown>;
}
