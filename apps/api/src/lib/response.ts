/** 统一成功响应信封（docs/12 §1.1）。 */
import type { FastifyRequest } from 'fastify';

export interface SuccessEnvelope<T> {
  request_id: string;
  data: T;
  meta?: Record<string, unknown>;
}

export function ok<T>(request: FastifyRequest, data: T, meta?: Record<string, unknown>): SuccessEnvelope<T> {
  return meta === undefined
    ? { request_id: request.requestId, data }
    : { request_id: request.requestId, data, meta };
}
