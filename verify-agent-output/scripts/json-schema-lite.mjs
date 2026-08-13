// @ts-check

function kind(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`只支持本地 JSON Schema ref: ${ref}`);
  return ref.slice(2).split('/').reduce((value, part) => value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], root);
}

function collect(value, schema, root, path, errors) {
  if (schema.$ref) return collect(value, resolveRef(root, schema.$ref), root, path, errors);
  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) errors.push(`${path} 必须等于 ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) errors.push(`${path} 不在允许枚举中`);
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = kind(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) {
      errors.push(`${path} 类型应为 ${allowed.join('|')}，实际 ${actual}`);
      return;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} 长度不足`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path} 格式不匹配`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} 小于最小值`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} 项数不足`);
    if (schema.items) value.forEach((item, index) => collect(item, schema.items, root, `${path}[${index}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const field of schema.required ?? []) if (!Object.hasOwn(value, field)) errors.push(`${path} 缺少 ${field}`);
    const properties = schema.properties ?? {};
    for (const [field, child] of Object.entries(value)) {
      if (properties[field]) collect(child, properties[field], root, `${path}.${field}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path} 包含未知字段 ${field}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') collect(child, schema.additionalProperties, root, `${path}.${field}`, errors);
    }
  }
}

export function collectJsonSchemaErrors(value, schema, label = '$') {
  const errors = [];
  collect(value, schema, schema, label, errors);
  return errors;
}

export function validateJsonSchema(value, schema, label = '$') {
  const errors = collectJsonSchemaErrors(value, schema, label);
  if (errors.length > 0) throw new Error(errors[0]);
  return value;
}
