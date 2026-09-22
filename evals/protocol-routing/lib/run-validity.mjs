// @ts-check
// 「这一次会话算不算一个数据点」的判据。
//
// 由来：第一次真实运行里 3 个会话（4-2、5-2、5-3）的最终文本是
// `API Error: Unable to connect to API (…CERTIFICATE_VERIFICATION_ERROR)`，`num_turns = 1`、
// 零工具调用，却被当成 `NONE` 计进了 k/n（issue #15 的缺陷 2）。基础设施故障不是协议行为。
//
// ⚠️ 判据必须依赖**宿主自己给的错误信号**，不能只看「零工具调用」。
// 「模型什么都没做」恰恰是评测要量的一种结果（正向用例的 `NONE`），把它判成无效
// 等于把失守洗掉。所以这里宁可漏判为有效，也不放一条只凭「没动静」成立的判据。
//
// 宿主信号长什么样（claude-code 2.1.276 的 stream-json，实测自第一次真实运行的结果目录）：
// - 成功与失败共用 `subtype: "success"` 这一个 result 事件，区分只看 `is_error`：
//   正常会话 `is_error: false`；那 3 个故障会话 `is_error: true`、`num_turns: 1`，
//   `result` 字段是以 `API Error` 开头的文本，前面还有一串 `system: api_retry` 事件。
// - 另有一组带错误 subtype 的 result 事件（`error_during_execution` /
//   `error_max_budget_usd` / `error_max_structured_output_retries` / `error_max_turns`），
//   schema 来自宿主二进制里的 zod 定义。其中只有 `error_max_turns` **不算故障**：
//   它是会话正常跑到轮次上限，是一个真实终点，不该重试。
//
// 判据是一个具名纯函数，输入观测记录，输出 { valid, signal, reason }。

/** 宿主 result 事件里表示「这次会话没跑成」的 subtype。`error_max_turns` 不在内：那是真实终点。 */
export const FAILURE_RESULT_SUBTYPES = Object.freeze([
  'error_during_execution',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
]);

/** 最终文本以它开头时，宿主是在替 API 报错，而不是模型在回答。 */
export const API_ERROR_PREFIX = 'API Error';

/**
 * @typedef {{
 *   subtype?: string | null,
 *   is_error?: boolean | null,
 *   num_turns?: number | null,
 *   api_error_status?: number | null,
 *   final_text_prefix?: string | null,
 * }} HostResult
 */

/**
 * @typedef {{ valid: boolean, signal: string | null, reason: string }} Validity
 */

/**
 * @param {{ events?: Array<unknown>, end?: { exit_code?: number | null, host_result?: HostResult | null, early_terminated?: { at_seq: number, reason: string } | null } | null }} observation
 * @returns {Validity}
 */
export function classifyRunValidity(observation) {
  const end = observation?.end ?? null;
  const host = end?.host_result ?? null;
  const events = observation?.events ?? [];

  // 0) harness 自己掐掉的会话：正向断言已经成立，再跑下去改不了结论（见
  //    drivers/claude-headless.mjs 的 canTerminateEarly）。这种会话拿不到 result 事件、
  //    退出码也不是 0，所以这一条必须排在所有故障判据前面——否则每一次提前终止
  //    都会被当成崩溃重试一遍，省下来的时间又原样还回去。
  if (end?.early_terminated) {
    return {
      valid: true,
      signal: null,
      reason: `正向断言在第 ${end.early_terminated.at_seq} 个事件成立，会话由 harness 主动终止`,
    };
  }

  // 1) 宿主在 result 事件上明确标了错误。最强的一条，且与工具调用数无关。
  if (host?.is_error === true) {
    const status = typeof host.api_error_status === 'number' ? `，api_error_status=${host.api_error_status}` : '';
    const text =
      typeof host.final_text_prefix === 'string' && host.final_text_prefix.trim()
        ? `：${oneLine(host.final_text_prefix)}`
        : '';
    return {
      valid: false,
      signal: 'result_is_error',
      reason: `宿主 result 事件 is_error=true（subtype=${host.subtype ?? '未知'}，num_turns=${host.num_turns ?? '未知'}${status}）${text}`,
    };
  }

  // 2) 宿主用错误 subtype 收尾（`error_max_turns` 除外，见文件头）。
  if (typeof host?.subtype === 'string' && FAILURE_RESULT_SUBTYPES.includes(host.subtype)) {
    return { valid: false, signal: 'result_error_subtype', reason: `宿主 result 事件 subtype=${host.subtype}` };
  }

  // 3) 最终文本以 `API Error` 开头：宿主替 API 报错，不是模型在回答。
  //    留作兜底——万一某个宿主版本忘了把 is_error 置起来。
  const finalText = typeof host?.final_text_prefix === 'string' ? host.final_text_prefix.trimStart() : '';
  if (finalText.startsWith(API_ERROR_PREFIX)) {
    return {
      valid: false,
      signal: 'final_text_api_error',
      reason: `最终文本以「${API_ERROR_PREFIX}」开头：${oneLine(finalText)}`,
    };
  }

  // 4) 会话进程非零退出**且**零工具事件：连 result 事件都没拿到的崩溃。
  //    「零工具事件」在这里只是收窄条件，不单独成立——单独成立就会误伤合法的 `NONE`。
  if (typeof end?.exit_code === 'number' && end.exit_code !== 0 && events.length === 0) {
    return { valid: false, signal: 'nonzero_exit_no_events', reason: `会话进程退出码 ${end.exit_code} 且零工具事件` };
  }

  return { valid: true, signal: null, reason: '宿主未报错，计入 k/n' };
}

/** 报告里只放一行、有界的原因摘要——无效运行的文本是宿主错误信息，不是会话内容。 */
export function oneLine(text, limit = 160) {
  const flat = String(text).replace(/\s+/gu, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}
