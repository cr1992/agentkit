// @ts-check
// 观测记录（observation JSONL）：驱动器与分类器之间唯一的接口。
//
// 每份会话一个文件，每行一条 JSON：
//   {"type":"session", "case_id":3, "run":1, "host":…, "host_version":…, "model":…,
//    "skills":{…content_digest…}, "initial_repo":{"status":…,"head":…}, "initial_ledger":{…}}
//   {"type":"tool", "seq":1, "tool_name":"Bash", "tool_input":{…}, "repo":{…}, "ledger":{…}}
//   {"type":"payload", "ref":"/abs/path/node.json", "value":{…}}   // 可选：内联 --input 载荷
//   {"type":"end", "exit_code":0, "error":null, "host_result":{…}, "early_terminated":{…}}
//
// `host_result` 是宿主 stream-json 的 result 事件摘要（`subtype` / `is_error` / `num_turns` /
// `api_error_status` / 最终文本的有界前缀）。它是判「这次会话算不算数据点」的唯一可靠信号，
// 口径见 lib/run-validity.mjs。回放录制里可以不写，缺省按「宿主没报错」处理。
//
// `early_terminated` 非空表示这次会话是 harness 在正向断言成立之后主动终止的，不是故障，
// 同样见 lib/run-validity.mjs。
//
// `repo` 是**该事件之后**的 fixture 仓摘要。`initial_repo` 是前置状态构造完、会话开始前的摘要。
// `ledger` / `initial_ledger` 同理，是台账快照（没有台账的现场为 null），口径见 lib/ledger-probe.mjs。
// 分类器只吃这个格式，因此无头驱动器与回放驱动器的判定结果按构造一致。

/**
 * @typedef {{ status: string, head: string }} RepoSummary
 * @typedef {import('./ledger-probe.mjs').LedgerSnapshot} LedgerSnapshot
 * @typedef {{ seq: number, tool_name: string, tool_input?: any, repo: RepoSummary, ledger?: LedgerSnapshot | null }} ToolEvent
 * @typedef {{
 *   meta: Record<string, any>,
 *   initial_repo: RepoSummary,
 *   initial_ledger: LedgerSnapshot | null,
 *   events: ToolEvent[],
 *   payloads: Record<string, unknown>,
 *   end: {
 *     exit_code: number | null,
 *     error?: string | null,
 *     host_result?: import('./run-validity.mjs').HostResult | null,
 *     early_terminated?: { at_seq: number, reason: string } | null,
 *   } | null,
 * }} Observation
 */

/**
 * @param {string} text
 * @returns {Observation}
 */
export function parseObservation(text) {
  /** @type {Observation} */
  const out = { meta: {}, initial_repo: { status: '', head: '' }, initial_ledger: null, events: [], payloads: {}, end: null };
  let seen = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = JSON.parse(trimmed);
    if (record.type === 'session') {
      const { type, initial_repo: initial, initial_ledger: initialLedger, ...meta } = record;
      out.meta = meta;
      out.initial_repo = initial ?? out.initial_repo;
      out.initial_ledger = initialLedger ?? null;
      seen = true;
    } else if (record.type === 'tool') {
      out.events.push({ seq: record.seq ?? out.events.length + 1, tool_name: record.tool_name, tool_input: record.tool_input, repo: record.repo, ledger: record.ledger ?? null });
    } else if (record.type === 'payload') {
      out.payloads[record.ref] = record.value;
    } else if (record.type === 'end') {
      out.end = { exit_code: record.exit_code ?? null, error: record.error ?? null, host_result: record.host_result ?? null, early_terminated: record.early_terminated ?? null };
    }
  }
  if (!seen) throw new Error('观测记录缺少 session 头行');
  return out;
}

/**
 * @param {Observation} observation
 * @returns {string}
 */
export function serializeObservation(observation) {
  const lines = [JSON.stringify({ type: 'session', ...observation.meta, initial_repo: observation.initial_repo, initial_ledger: observation.initial_ledger ?? null })];
  for (const event of observation.events) lines.push(JSON.stringify({ type: 'tool', ...event }));
  for (const [ref, value] of Object.entries(observation.payloads ?? {})) lines.push(JSON.stringify({ type: 'payload', ref, value }));
  if (observation.end) lines.push(JSON.stringify({ type: 'end', ...observation.end }));
  return `${lines.join('\n')}\n`;
}
