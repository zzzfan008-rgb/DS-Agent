/** 统一错误处理与 404（docs/12 §4）。 */
import type { FastifyInstance } from 'fastify';
import { ApiError, errorEnvelope, toApiError } from '../lib/errors.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const apiError = toApiError(error);
    if (apiError.code === 'internal_error') {
      request.log.error({ err: error }, 'unhandled error');
    } else if (apiError.httpStatus >= 500) {
      request.log.warn({ err: error, code: apiError.code }, 'request failed with server error');
    }
    if (apiError.headers) reply.headers(apiError.headers);
    reply
      .code(apiError.httpStatus)
      .type('application/json; charset=utf-8')
      .send(errorEnvelope(request.requestId, apiError));
  });

  app.setNotFoundHandler((request, reply) => {
    const apiError =
      (request.method === 'HEAD' || request.method === 'GET') && request.url === '/'
        ? new ApiError('not_found', '接口不存在')
        : new ApiError('not_found', '接口不存在');
    reply
      .code(apiError.httpStatus)
      .type('application/json; charset=utf-8')
      .send(errorEnvelope(request.requestId, apiError));
  });
}
