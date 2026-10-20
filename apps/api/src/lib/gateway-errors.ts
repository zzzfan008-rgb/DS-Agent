/** 把 registry 的 GatewayError 映射为 API 统一错误码（docs/07 §12.2 → docs/12 §4）。 */
import { GatewayError } from '@dssaas/registry';
import { ApiError } from './errors.js';

export function throwGatewayError(error: unknown): never {
  if (error instanceof GatewayError) {
    const detail = error.detail;
    switch (error.code) {
      case 'no_route':
        throw new ApiError('no_route', undefined, { detail });
      case 'route_exhausted':
        throw new ApiError('route_exhausted', undefined, { detail });
      case 'quota_exceeded':
        throw new ApiError('quota_exceeded', undefined, { detail });
      case 'provider_unavailable':
        throw new ApiError('provider_unavailable', undefined, { detail });
      case 'model_not_published':
        throw new ApiError('model_not_published', undefined, { detail });
      case 'model_purpose_mismatch':
        throw new ApiError('model_purpose_mismatch', undefined, { detail });
      case 'role_forbidden':
        throw new ApiError('role_forbidden', undefined, { detail });
      case 'schema_invalid':
        throw new ApiError('schema_invalid', undefined, { detail });
      case 'invalid_request':
        throw new ApiError('validation_failed', '模型调用参数不合法', { detail });
      default:
        throw new ApiError('internal_error', undefined, { cause: error });
    }
  }
  throw error;
}
