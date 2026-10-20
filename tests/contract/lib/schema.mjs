/**
 * 极简 JSON Schema 校验器（零依赖，契约测试用）。
 *
 * 只实现契约测试需要的子集：type / required / properties / additionalProperties /
 * items / enum / const / pattern / minimum / maximum / minLength / maxLength /
 * minItems / maxItems / oneOf。
 * 不引入 ajv 是为了让 PR 回放不依赖网络安装；复杂 schema 可在后续 t10+ 替换。
 */

const TYPE_CHECKS = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

function typeOk(value, type) {
  const check = TYPE_CHECKS[type];
  if (!check) return true;
  return check(value);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** @returns {string[]} 错误列表（空数组 = 通过） */
export function validateSchema(value, schema, pointer = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeOk(value, type))) {
      errors.push(`${pointer}: 期望类型 ${types.join('|')}，实际 ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`);
      return errors;
    }
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${pointer}: 期望常量 ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(value, item))) {
    errors.push(`${pointer}: 值 ${JSON.stringify(value)} 不在枚举 ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${pointer}: 长度 ${value.length} < ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${pointer}: 长度 ${value.length} > ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${pointer}: 不符合 pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${pointer}: ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${pointer}: ${value} > maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${pointer}: 数组长度 ${value.length} < ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${pointer}: 数组长度 ${value.length} > ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateSchema(item, schema.items, `${pointer}[${index}]`));
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${pointer}: 缺少必填字段 ${key}`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) errors.push(...validateSchema(value[key], child, `${pointer}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${pointer}: 不允许的额外字段 ${key}`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (!(key in properties)) {
          errors.push(...validateSchema(child, schema.additionalProperties, `${pointer}.${key}`));
        }
      }
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((option) => validateSchema(value, option, pointer).length === 0);
    if (matched.length !== 1) errors.push(`${pointer}: oneOf 命中 ${matched.length} 个分支（应为 1）`);
  }

  return errors;
}
