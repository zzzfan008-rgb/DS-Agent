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
    // t51（M9 P1）：错误按 code 打点。连接池耗尽属于容量问题，必须能与"代码 bug 的 500"
    // 分开看 —— `dssaas_errors_total{code="db_pool_exhausted"}` 持续增长 = 该调池子/加实例。
    //
    // 必须 try/catch：错误处理本身不能因为打点失败而抛错 —— 那会把 422/409 洗成 500，
    // 正好毁掉这次修复想表达的信息。测试里 app 可能尚未 decorate metricsRegistry。
    try {
      app.metricsRegistry?.inc('dssaas_errors_total', '业务错误数（按错误码）', {
        code: apiError.code,
        retryable: String(apiError.retryable),
      });
    } catch (metricsError) {
      request.log.warn({ err: metricsError, code: apiError.code }, 'error metric increment failed');
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
