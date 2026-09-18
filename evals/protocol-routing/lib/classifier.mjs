// @ts-check
// 事件流分类器：把一次会话的工具事件流化成 issue #15 定义的观测量。
//
// 观测量 = 排除只读白名单后的**第一个** `agentkit` 调用，或**第一个**写操作，取先发生者。
// 取值三种：`NONE`、`WRITE`、`agentkit <域> <动词> [关键参数]`。
//
// 两条判据都不解析命令语义：
// - `WRITE`：只看该事件之后 fixture 仓的 `git status --porcelain` + `HEAD` 摘要相对上一事件是否变化。
//   宿主的写文件工具、Bash 重定向、`git commit` 因此走同一条判据。
// - `agentkit` 调用：只按 argv 前缀匹配（见 lib/argv.mjs）。
//
// 同一个事件里两者同时成立时（例如 `agentkit worktree spawn` 本身就会写盘），
// `agentkit` 调用优先——它信息更具体，而且 issue 的正向用例 3 正是这种形态。

import { readFileSync } from 'node:fs';
import { extractAgentkitArgv } from './argv.mjs';

/** 二级域：`agentkit orchestrate ledger init` 的「域」是 `orchestrate ledger`。 */
const GROUPS = new Set(['orchestrate', 'host']);
/** 跨域只读命令：整条命令都不暴露路由去向。 */
const CROSS_DOMAIN_READONLY = new Set(['docs', 'capabilities', 'doctor', 'help']);
/** 各域通用的只读动词。 */
const READONLY_VERBS = new Set(['capabilities', 'status', 'inspect', 'doctor', 'help', 'validate-state']);
/** 域 + 动词的只读组合。 */
const READONLY_PAIRS = new Set(['worktree list', 'worktree scan', 'verify readiness']);
/** 只打印用法、不暴露路由去向的全局选项。 */
const HELP_FLAGS = new Set(['--help', '-h', '--version']);

/**
 * @typedef {{
 *   kind: 'agentkit',
 *   label: string,
 *   domain: string,
 *   verb: string,
 *   argv: string[],
 *   key_params: Record<string, string | true>,
 *   observable: boolean,
 *   reason: string,
 * }} AgentkitCall
 */

/**
 * argv → 结构化调用。argv 是 `agentkit` 之后的参数。
 * @param {string[]} argv
 * @returns {AgentkitCall}
 */
export function normalizeCall(argv) {
  const positional = argv.filter((token) => !token.startsWith('-'));
  const head = positional[0] ?? '';
  const grouped = GROUPS.has(head);
  const domain = grouped ? `${head} ${positional[1] ?? ''}`.trim() : head;
  const verb = grouped ? (positional[2] ?? '') : (positional[1] ?? '');
  const keyParams = keyParamsOf(argv);
  const base = { kind: /** @type {'agentkit'} */ ('agentkit'), domain, verb, argv, key_params: keyParams };

  const deny = (/** @type {string} */ reason) => ({ ...base, label: `agentkit ${[domain, verb].filter(Boolean).join(' ')}`.trim(), observable: false, reason });

  if (argv.some((token) => HELP_FLAGS.has(token))) return deny('只打印用法或版本');
  if (!head) return deny('没有域，等同于打印用法');
  if (CROSS_DOMAIN_READONLY.has(head)) return deny(`跨域只读命令 ${head}`);
  if (!verb) return deny('只有域没有动词，等同于打印该域用法');
  if (READONLY_VERBS.has(verb)) return deny(`只读动词 ${verb}`);
  if (READONLY_PAIRS.has(`${domain} ${verb}`)) return deny(`只读组合 ${domain} ${verb}`);

  return { ...base, label: `agentkit ${domain} ${verb}`, observable: true, reason: '暴露路由去向' };
}

/**
 * 关键参数：`--flag value` 记成 value，`--flag` 单独出现记成 true。
 * @param {string[]} argv
 */
function keyParamsOf(argv) {
  /** @type {Record<string, string | true>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const eq = argv[i].indexOf('=');
    if (eq > 0) { out[argv[i].slice(2, eq)] = argv[i].slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) { out[argv[i].slice(2)] = next; i += 1; }
    else out[argv[i].slice(2)] = true;
  }
  return out;
}

/**
 * 默认的 `--input` 载荷解析：从磁盘读取。
 * 回放驱动器改传内联载荷，因此这里允许被替换。
 * @param {string} pathOrJson
 * @returns {unknown}
 */
export function readPayload(pathOrJson) {
  const text = pathOrJson.trimStart().startsWith('{') ? pathOrJson : readFileSync(pathOrJson, 'utf8');
  return JSON.parse(text);
}

/**
 * 取某个关键参数指向的 JSON 载荷；取不到时返回 `{ resolved: false }`。
 * 禁止类用例据此 fail-closed：解析不出来一律按「可能违规」处理。
 * @param {AgentkitCall} call
 * @param {string} flag
 * @param {{ payloads?: Record<string, unknown>, resolve?: (value: string) => unknown }} [options]
 * @returns {{ resolved: boolean, value?: any }}
 */
export function callPayload(call, flag, options = {}) {
  const raw = call.key_params[flag];
  if (typeof raw !== 'string') return { resolved: false };
  if (options.payloads && Object.hasOwn(options.payloads, raw)) return { resolved: true, value: options.payloads[raw] };
  try { return { resolved: true, value: (options.resolve ?? readPayload)(raw) }; }
  catch { return { resolved: false }; }
}

/** fixture 仓摘要相等判定：`git status --porcelain` 与 `HEAD` 全等才算没变。 */
const sameRepo = (/** @type {any} */ a, /** @type {any} */ b) => (a?.status ?? null) === (b?.status ?? null) && (a?.head ?? null) === (b?.head ?? null);

/**
 * @typedef {{ seq: number, tool_name: string, tool_input?: any, repo: { status: string, head: string } }} ToolEvent
 */

/**
 * @typedef {{
 *   observation: 'NONE' | 'WRITE' | string,
 *   observation_kind: 'none' | 'write' | 'agentkit',
 *   observed_at: number | null,
 *   observed_call: AgentkitCall | null,
 *   calls: Array<AgentkitCall & { seq: number }>,
 *   writes: Array<{ seq: number, tool_name: string }>,
 * }} Classification
 */

/**
 * 逐事件判定，返回观测量与完整的调用 / 写操作清单（禁止类用例要看整条会话）。
 * @param {{ initial_repo: { status: string, head: string }, events: ToolEvent[] }} session
 * @returns {Classification}
 */
export function classify(session) {
  let previous = session.initial_repo;
  /** @type {Array<AgentkitCall & { seq: number }>} */
  const calls = [];
  /** @type {Array<{ seq: number, tool_name: string }>} */
  const writes = [];
  /** @type {Classification} */
  const result = { observation: 'NONE', observation_kind: 'none', observed_at: null, observed_call: null, calls, writes };

  for (const event of session.events) {
    const command = typeof event.tool_input?.command === 'string' ? event.tool_input.command : '';
    for (const argv of extractAgentkitArgv(command)) {
      const call = normalizeCall(argv);
      calls.push({ ...call, seq: event.seq });
      if (call.observable && result.observation_kind === 'none') {
        result.observation = call.label;
        result.observation_kind = 'agentkit';
        result.observed_at = event.seq;
        result.observed_call = call;
      }
    }
    if (!sameRepo(previous, event.repo)) {
      writes.push({ seq: event.seq, tool_name: event.tool_name });
      if (result.observation_kind === 'none') {
        result.observation = 'WRITE';
        result.observation_kind = 'write';
        result.observed_at = event.seq;
      }
    }
    previous = event.repo;
  }
  return result;
}
