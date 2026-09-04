// canonical JSON 与 envelope 摘要。
//
// 三个 Skill 此前各带一份实现，行为并不完全相同：
// - orchestrate 版不校验 UTF-16 代理对，也不拒绝非有限 number；
// - verify 与 loop 版两者都校验，并各自抛自己的 ValidationError 子类。
// 直接统一会改变其中一侧的失败面，而 canonicalJson 是所有 content_digest 的基础，
// 摘要语义受方案 §7 保护。因此这里只做实现去重：错误类与严格度由调用方注入，
// 各 Skill 的可观察行为保持不变。严格度的收敛是一次独立决策，不在本次搬迁里顺手做。
import { createHash } from 'node:crypto';

/** @param {string|Buffer} value */
export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** @param {Buffer|string} value */
export function digestBytes(value) {
  return sha256(value);
}

/**
 * @param {{ ValidationError: new (message: string) => Error, strict?: boolean, defaultDigestField?: string }} options
 *   strict=true 时校验未配对代理对并拒绝非有限 number（verify / loop 的现有行为）。
 */
export function createDigestKit({ ValidationError, strict = false, defaultDigestField }) {
  const assertValidUnicode = (value) => {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ValidationError('字符串含未配对 high surrogate');
        index += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw new ValidationError('字符串含未配对 low surrogate');
      }
    }
  };

  /** @param {unknown} value */
  function canonicalJson(value) {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
      if (strict && !Number.isFinite(value)) throw new ValidationError('canonical JSON 不接受非有限 number');
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (typeof value === 'string') {
      if (strict) assertValidUnicode(value);
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (typeof value === 'object') {
      const object = /** @type {Record<string, unknown>} */ (value);
      return `{${Object.keys(object).sort().map((key) => `${canonicalJson(key)}:${canonicalJson(object[key])}`).join(',')}}`;
    }
    throw new ValidationError(`canonical JSON 不支持 ${typeof value}`);
  }

  /** @param {Record<string, unknown>} object @param {string} [digestField] */
  function envelopeDigest(object, digestField = defaultDigestField) {
    const clone = { ...object };
    delete clone[digestField];
    return sha256(Buffer.from(canonicalJson(clone), 'utf8'));
  }

  return { canonicalJson, envelopeDigest, sha256, assertValidUnicode };
}
