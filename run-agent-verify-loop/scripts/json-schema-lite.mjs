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

function validate(value, schema, root, path) {
  if (schema.$ref) return validate(value, resolveRef(root, schema.$ref), root, path);
  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) throw new Error(`${path} 必须等于 ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) throw new Error(`${path} 不在允许枚举中`);
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = kind(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) throw new Error(`${path} 类型应为 ${allowed.join('|')}，实际 ${actual}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path} 长度不足`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) throw new Error(`${path} 格式不匹配`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} 小于最小值`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path} 项数不足`);
    if (schema.items) value.forEach((item, index) => validate(item, schema.items, root, `${path}[${index}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const field of schema.required ?? []) if (!Object.hasOwn(value, field)) throw new Error(`${path} 缺少 ${field}`);
    const properties = schema.properties ?? {};
    for (const [field, child] of Object.entries(value)) {
      if (properties[field]) validate(child, properties[field], root, `${path}.${field}`);
      else if (schema.additionalProperties === false) throw new Error(`${path} 包含未知字段 ${field}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(child, schema.additionalProperties, root, `${path}.${field}`);
    }
  }
}

export function validateJsonSchema(value, schema, label = '$') {
  validate(value, schema, schema, label);
  return value;
}
