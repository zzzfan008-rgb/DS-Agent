/**
 * 参数 Schema 校验（docs/07 §2.2/§9.1）。
 * - 发布前：params_schema 要是合法 JSON Schema（object 根、properties、拒绝 additionalProperties:true）；
 * - 发布前：default_params 必须通过自身 schema；
 * - 调用前：调用参数也要通过 schema。
 */
import { createRequire } from 'node:module';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { ModelRow } from './types.js';

interface AjvLike {
  validateSchema(schema: unknown): boolean;
  compile(schema: unknown): ValidateFunction;
  errors: ErrorObject[] | null;
}

const require = createRequire(import.meta.url);
const Ajv = require('ajv') as new (options?: Record<string, unknown>) => AjvLike;
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const validatorCache = new Map<string, ValidateFunction>();

export interface ParamValidation {
  ok: boolean;
  errors: string[];
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`);
}

export function validateParamsSchema(schema: unknown): ParamValidation {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, errors: ['params_schema 必须是对象'] };
  }
  const record = schema as Record<string, unknown>;
  if (record.type !== 'object') return { ok: false, errors: ['params_schema.type 必须是 "object"'] };
  if (!record.properties || typeof record.properties !== 'object' || Array.isArray(record.properties)) {
    return { ok: false, errors: ['params_schema.properties 必须是对象'] };
  }
  if (record.additionalProperties === true) {
    return { ok: false, errors: ['params_schema 不允许 additionalProperties:true'] };
  }
  let schemaValid: boolean;
  try {
    schemaValid = ajv.validateSchema(schema);
  } catch (error) {
    return { ok: false, errors: [`params_schema 不是合法 JSON Schema: ${String(error)}`] };
  }
  if (!schemaValid) {
    return { ok: false, errors: formatErrors(ajv.errors) };
  }
  return { ok: true, errors: [] };
}

export function validateAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
  cacheKey?: string,
): ParamValidation {
  const cached = cacheKey ? validatorCache.get(cacheKey) : undefined;
  let validate: ValidateFunction;
  if (cached) {
    validate = cached;
  } else {
    try {
      validate = ajv.compile(schema);
    } catch (error) {
      return { ok: false, errors: [`参数 Schema 编译失败: ${String(error)}`] };
    }
    if (cacheKey) validatorCache.set(cacheKey, validate);
  }
  const ok = validate(value) as boolean;
  return { ok, errors: ok ? [] : formatErrors(validate.errors) };
}

/** 模型参数合法性（R2）：schema 合法 + default_params 通过 schema。 */
export function validateModelParams(
  model: Pick<ModelRow, 'id' | 'version' | 'paramsSchema' | 'defaultParams'>,
): ParamValidation {
  const schemaCheck = validateParamsSchema(model.paramsSchema);
  if (!schemaCheck.ok) return schemaCheck;
  const defaultsCheck = validateAgainstSchema(
    model.paramsSchema,
    model.defaultParams,
    `${model.id}:${model.version}`,
  );
  if (!defaultsCheck.ok) {
    return {
      ok: false,
      errors: defaultsCheck.errors.map((error) => `default_params: ${error}`),
    };
  }
  return { ok: true, errors: [] };
}
