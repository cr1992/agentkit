#!/usr/bin/env node
// @ts-check
// 协议路由评测入口。
//
//   # 回放自测：不起任何会话，零模型费用
//   node evals/protocol-routing/run.mjs --driver replay --replay evals/protocol-routing/fixtures/replay/always-none
//
//   # 真实评测：33 个会话（11 条用例 × 3 次）
//   # --allow-bypass-permissions 必须显式加：会话在 bypassPermissions 下跑，
//   # 不经确认就能执行任意命令，只应在一次性环境（CI runner / 容器 / 虚拟机）里用。
//   node evals/protocol-routing/run.mjs --driver claude-headless --model <模型 ID> \
//     --allow-bypass-permissions --out /tmp/pr-eval
//
//   # 子集加跑（改动前后对比时把受影响用例加到 n ≥ 10）
//   node evals/protocol-routing/run.mjs --driver claude-headless --model <模型 ID> \
//     --allow-bypass-permissions --cases 7,8 --runs 10 --out /tmp/pr-eval

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CASES, selectCases } from './cases.mjs';
import { createHeadlessClaudeDriver, createReplayDriver } from './drivers/index.mjs';
import { redactSecrets } from './lib/redact.mjs';
import { buildReport, renderMarkdown } from './lib/report.mjs';
import { classifyRunValidity } from './lib/run-validity.mjs';

/**
 * 无效运行（基础设施故障）最多重试几次。1 次正常 + 2 次重试 = 最多 3 次尝试。
 * 仍然无效就记 `invalid`，不进 k/n，报告里单列一节。判据见 lib/run-validity.mjs。
 */
export const MAX_ATTEMPTS = 3;
/** 重试退避（毫秒），按尝试次序取。故障多半是瞬时网络/证书问题，立刻重试大概率还是同一个错。 */
export const RETRY_BACKOFF_MS = Object.freeze([5000, 20000]);

const defaultSleep = (/** @type {number} */ ms) => new Promise((done) => { setTimeout(done, ms); });

/** 布尔开关：不吃下一个 token。 */
const FLAGS = new Set(['quiet', 'allow-bypass-permissions']);

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const options = { driver: 'replay', runs: '3', cases: 'all', out: '', replay: '', model: '', bin: 'claude', 'budget-usd': '', quiet: false, 'allow-bypass-permissions': false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`未知参数 ${token}`);
    const key = token.slice(2);
    if (!Object.hasOwn(options, key)) throw new Error(`未知选项 --${key}，可选：${Object.keys(options).map((name) => `--${name}`).join(' ')}`);
    if (FLAGS.has(key)) { options[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要取值`);
    options[key] = value;
    i += 1;
  }
  return options;
}

/** @param {Record<string, any>} options */
function makeDriver(options, outDir) {
  if (options.driver === 'replay') {
    if (!options.replay) throw new Error('--driver replay 需要 --replay <预录目录>');
    return createReplayDriver({ dir: resolve(options.replay) });
  }
  if (options.driver === 'claude-headless') {
    if (!options.model) throw new Error('--driver claude-headless 需要 --model <模型 ID>：评测必须固定模型并记录模型 ID');
    return createHeadlessClaudeDriver({
      bin: options.bin,
      model: options.model,
      outDir,
      // 不给默认值：bypassPermissions 只能由运行者当轮显式同意，不能从配置里继承。
      allowBypassPermissions: options['allow-bypass-permissions'] === true,
      budgetUsd: options['budget-usd'] ? Number(options['budget-usd']) : null,
    });
  }
  throw new Error(`未知驱动器 ${options.driver}，可选：replay, claude-headless`);
}

/**
 * 跑一次会话；判定为「无效运行」时退避重试，最多 MAX_ATTEMPTS 次尝试。
 *
 * 为什么重试而不是直接丢掉：无效运行的代价是该用例的 n 变小，而 n 本来就只有 3。
 * 为什么有上限：现场整段不可用时（证书、限流、断网），无限重试只会把一轮评测拖死在
 * 第一条用例上，而且烧的是真实额度。
 *
 * @param {{
 *   driver: { runSession: (input: any) => Promise<any> },
 *   evalCase: any,
 *   runIndex: number,
 *   maxAttempts?: number,
 *   backoffMs?: readonly number[],
 *   sleep?: (ms: number) => Promise<void>,
 * }} input
 * @returns {Promise<{ observation: any, attempts: number, validity: import('./lib/run-validity.mjs').Validity, discarded: Array<import('./lib/run-validity.mjs').Validity> }>}
 */
export async function runSessionWithRetries({ driver, evalCase, runIndex, maxAttempts = MAX_ATTEMPTS, backoffMs = RETRY_BACKOFF_MS, sleep = undefined }) {
  const wait = sleep ?? defaultSleep;
  /** @type {Array<import('./lib/run-validity.mjs').Validity>} */
  const discarded = [];
  let observation = null;
  let validity = { valid: false, signal: null, reason: '没有跑出任何记录' };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    observation = await driver.runSession({ evalCase, runIndex, attempt });
    validity = classifyRunValidity(observation);
    if (validity.valid) return { observation, attempts: attempt, validity, discarded };
    discarded.push(validity);
    if (attempt < maxAttempts) await wait(backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0);
  }
  return { observation, attempts: maxAttempts, validity, discarded };
}

/**
 * @param {string[]} argv
 * @param {{ sleep?: (ms: number) => Promise<void> }} [hooks] 只给自测注入用：把重试退避换成不睡。
 */
export async function main(argv, hooks = {}) {
  const options = parseArgs(argv);
  const runs = Number(options.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs 必须是正整数');
  const cases = selectCases(String(options.cases));
  const outDir = resolve(String(options.out) || `./protocol-routing-eval-${Date.now()}`);
  // 先建驱动器再建目录：被拒绝时（例如没显式同意 bypassPermissions）不该留下空目录。
  const driver = makeDriver(options, outDir);
  mkdirSync(outDir, { recursive: true });
  // 开跑前的一次性准备（skill 每轮装一次，见 lib/skill-install.mjs）。
  // 故意不 catch：装不上就整轮当场停，而不是让每个会话各丢一个样本。
  const prepared = driver.prepare ? await driver.prepare() : null;
  /** @type {Array<{ case_id: number, run: number, observation: any }>} */
  const sessions = [];
  /** @type {string[]} */
  const failures = [];
  /** @type {Array<{ case_id: number, run: number, attempts: number, signal: string | null, reason: string }>} */
  const invalidRuns = [];
  for (const evalCase of cases) {
    for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
      try {
        const attempted = await runSessionWithRetries({ driver, evalCase, runIndex, sleep: hooks.sleep });
        if (attempted.validity.valid) { sessions.push({ case_id: evalCase.id, run: runIndex, observation: attempted.observation }); continue; }
        // 无效运行：基础设施故障，不是协议行为。重试用尽后记 `invalid`，**不进 k/n**，
        // 在报告里单列一节（用例、run、原因摘要、重试次数）。判据见 lib/run-validity.mjs。
        invalidRuns.push({ case_id: evalCase.id, run: runIndex, attempts: attempted.attempts, signal: attempted.validity.signal, reason: attempted.validity.reason });
      } catch (error) {
        // 单个会话起不来不终止整轮，但也不算「不符合」——没跑出来的会话不是数据点。
        // 它表现为该用例的 n 比 --runs 小，同时列进 report.session_failures，退出码 1。
        failures.push(`用例 ${evalCase.id} 第 ${runIndex} 次：${/** @type {Error} */ (error).message}`);
      }
    }
  }

  const meta = { ...driver.meta, ...(prepared ?? {}) };
  const firstSession = sessions[0]?.observation;
  if (firstSession?.meta?.skills) meta.skills = firstSession.meta.skills;
  if (!meta.model && firstSession?.meta?.model) meta.model = firstSession.meta.model;
  const report = { ...buildReport({ cases, runs, driver: meta, sessions, invalidRuns }), session_failures: failures, selected_cases: cases.map((item) => item.id), total_cases: CASES.length };

  // 脱敏兜底：报告里不该出现 ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN 的取值。
  // 主防线是「取值只经环境变量传递、command.json 只记键名」，这里只是最后一道字面替换，
  // 防的是某段 stderr 或会话输出把取值带进了报告。见 lib/redact.mjs。
  writeFileSync(resolve(outDir, 'report.json'), redactSecrets(`${JSON.stringify(report, null, 2)}\n`));
  const markdown = redactSecrets(renderMarkdown(report));
  writeFileSync(resolve(outDir, 'report.md'), markdown);
  if (!options.quiet) process.stdout.write(markdown);
  if (failures.length) {
    if (!options.quiet) process.stderr.write(redactSecrets(`\n${failures.length} 个会话没有跑出记录：\n- ${failures.join('\n- ')}\n`));
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
}
