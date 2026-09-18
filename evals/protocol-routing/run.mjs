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

/** @param {string[]} argv */
export async function main(argv) {
  const options = parseArgs(argv);
  const runs = Number(options.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs 必须是正整数');
  const cases = selectCases(String(options.cases));
  const outDir = resolve(String(options.out) || `./protocol-routing-eval-${Date.now()}`);
  // 先建驱动器再建目录：被拒绝时（例如没显式同意 bypassPermissions）不该留下空目录。
  const driver = makeDriver(options, outDir);
  mkdirSync(outDir, { recursive: true });
  /** @type {Array<{ case_id: number, run: number, observation: any }>} */
  const sessions = [];
  /** @type {string[]} */
  const failures = [];
  for (const evalCase of cases) {
    for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
      try {
        const observation = await driver.runSession({ evalCase, runIndex });
        sessions.push({ case_id: evalCase.id, run: runIndex, observation });
      } catch (error) {
        // 单个会话起不来不终止整轮，但也不算「不符合」——没跑出来的会话不是数据点。
        // 它表现为该用例的 n 比 --runs 小，同时列进 report.session_failures，退出码 1。
        failures.push(`用例 ${evalCase.id} 第 ${runIndex} 次：${/** @type {Error} */ (error).message}`);
      }
    }
  }

  const meta = { ...driver.meta };
  const firstSession = sessions[0]?.observation;
  if (firstSession?.meta?.skills) meta.skills = firstSession.meta.skills;
  if (!meta.model && firstSession?.meta?.model) meta.model = firstSession.meta.model;
  const report = { ...buildReport({ cases, runs, driver: meta, sessions }), session_failures: failures, selected_cases: cases.map((item) => item.id), total_cases: CASES.length };

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
