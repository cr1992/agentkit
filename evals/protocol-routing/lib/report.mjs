// @ts-check
// 报告器。
//
// 口径按 issue #15「报告」一节，三条都是硬约束：
// - 逐条报告原始计数 k/n，**不取多数**——2/3 和 3/3 是两回事，取多数恰好丢掉要看的信息；
// - 正向、禁止两栏必须同时出现，栏分数是该栏所有用例的 Σk / Σn；
// - 平凡基线（永远 NONE、永远 WRITE）与结果一起报，按同一 n 换算；
// - 不汇总成单一百分比，暂不设红线。
//
// n 是**有效次数**，不是计划次数。基础设施故障（`API Error` 一类）经重试仍无效的运行记
// `invalid`，不进 k/n，单列一节；平凡基线随之按有效 n 换算，否则基线和结果的分母对不上。
// 判据见 lib/run-validity.mjs，重试见 run.mjs。
//
// 另有两列**信息性**记录，不参与任何计分：
// - 该次会话有没有加载 skill（事件流里有没有 `Skill` 工具调用）。第一次真实运行里
//   用例 10、11 多数没加载 skill 就表现正确，这个信号值得留在明细里。
// - 该次会话有没有主动发起 `verify *`，或声明 `independent_evidence` 的 `ledger add-node`。
//   它是第 7 条从正向改成禁止时被摘下来的那条断言——不再计分，但仍然值得看见。

import { classify, declaresIndependentEvidence } from './classifier.mjs';
import { oneLine } from './run-validity.mjs';

/** 宿主用来加载 skill 的工具名。 */
const SKILL_TOOL = 'Skill';

/** 平凡基线用的合成分类结果：不起会话，直接喂给同一批断言。 */
const SYNTHETIC = {
  NONE: () => /** @type {import('./classifier.mjs').Classification} */ ({
    observation: 'NONE', observation_kind: 'none', observed_at: null, observed_call: null, calls: [], writes: [],
  }),
  WRITE: () => /** @type {import('./classifier.mjs').Classification} */ ({
    observation: 'WRITE', observation_kind: 'write', observed_at: 1, observed_call: null, calls: [], writes: [{ seq: 1, tool_name: 'Write' }],
  }),
};

/**
 * 平凡基线：对每条用例喂同一个合成观测量，按**同一 n** 换算。
 * `runs` 可以是一个数（每条用例都跑这么多次），也可以是「用例 id → 有效次数」的映射——
 * 有无效运行时必须传映射，否则基线的分母会比结果大，两边不再可比。
 *
 * @param {import('../cases.mjs').EvalCase[]} cases
 * @param {'NONE' | 'WRITE'} kind
 * @param {number | Map<number, number> | Record<number, number>} runs
 */
export function trivialBaseline(cases, kind, runs) {
  const nOf = (/** @type {number} */ id) => {
    if (typeof runs === 'number') return runs;
    if (runs instanceof Map) return runs.get(id) ?? 0;
    return runs[id] ?? 0;
  };
  const columns = { positive: { k: 0, n: 0, cases: 0, satisfied_cases: 0 }, forbidden: { k: 0, n: 0, cases: 0, satisfied_cases: 0 } };
  for (const item of cases) {
    const verdict = item.assert(SYNTHETIC[kind](), {});
    const column = columns[item.category];
    const n = nOf(item.id);
    column.cases += 1;
    column.n += n;
    if (verdict.satisfied) { column.k += n; column.satisfied_cases += 1; }
  }
  return columns;
}

/**
 * @param {{
 *   cases: import('../cases.mjs').EvalCase[],
 *   runs: number,
 *   driver: Record<string, any>,
 *   sessions: Array<{ case_id: number, run: number, observation: import('../lib/observation.mjs').Observation & { source?: string } }>,
 *   invalidRuns?: Array<{ case_id: number, run: number, attempts: number, signal: string | null, reason: string }>,
 * }} input
 */
export function buildReport({ cases, runs, driver, sessions, invalidRuns = [] }) {
  const byCase = new Map(cases.map((item) => [item.id, item]));
  /** @type {Map<number, any[]>} */
  const perCase = new Map(cases.map((item) => [item.id, []]));

  for (const session of sessions) {
    const evalCase = byCase.get(session.case_id);
    if (!evalCase) continue;
    const classification = classify({ initial_repo: session.observation.initial_repo, events: session.observation.events });
    const options = { payloads: session.observation.payloads };
    const verdict = evalCase.assert(classification, options);
    perCase.get(evalCase.id)?.push({
      run: session.run,
      observation: classification.observation,
      observation_kind: classification.observation_kind,
      observed_at: classification.observed_at,
      satisfied: verdict.satisfied,
      reason: verdict.reason,
      agentkit_calls: classification.calls.map((call) => ({ seq: call.seq, label: call.label, observable: call.observable })),
      writes: classification.writes,
      // 以下两项信息性，不计分。
      skill_loaded: (session.observation.events ?? []).some((event) => event.tool_name === SKILL_TOOL),
      initiated_independent_verification: initiatedIndependentVerification(classification, options),
      exit_code: session.observation.end?.exit_code ?? null,
      source: session.observation.source ?? null,
    });
  }

  /** @type {Map<number, number>} */
  const invalidByCase = new Map(cases.map((item) => [item.id, 0]));
  for (const invalid of invalidRuns) invalidByCase.set(invalid.case_id, (invalidByCase.get(invalid.case_id) ?? 0) + 1);

  const columns = { positive: { k: 0, n: 0 }, forbidden: { k: 0, n: 0 } };
  /** @type {Map<number, number>} 平凡基线用的分母：每条用例的**有效**次数。 */
  const validNByCase = new Map();
  const caseReports = cases.map((item) => {
    const results = perCase.get(item.id) ?? [];
    const k = results.filter((result) => result.satisfied).length;
    const n = results.length;
    columns[item.category].k += k;
    columns[item.category].n += n;
    validNByCase.set(item.id, n);
    return {
      id: item.id, category: item.category, title: item.title, expectation: item.expectation, setup: item.setup,
      k, n, planned_n: runs, invalid: invalidByCase.get(item.id) ?? 0, runs: results,
    };
  });

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    requested_runs: runs,
    driver,
    cases: caseReports,
    columns,
    invalid_runs: invalidRuns,
    trivial_baselines: {
      always_none: trivialBaseline(cases, 'NONE', validNByCase),
      always_write: trivialBaseline(cases, 'WRITE', validNByCase),
    },
  };
}

/**
 * 信息列：这次会话有没有主动发起 `verify *`，或声明 `independent_evidence` 的 `ledger add-node`。
 * 不计分——它是第 7 条从正向改成禁止时摘下来的那条断言。
 * @param {import('./classifier.mjs').Classification} classification
 * @param {{ payloads?: Record<string, unknown> }} options
 */
function initiatedIndependentVerification(classification, options) {
  for (const call of classification.calls) {
    if (call.domain === 'verify') return true;
    if (declaresIndependentEvidence(call, options)) return true;
  }
  return false;
}

const fraction = (/** @type {{k: number, n: number}} */ value) => `${value.k}/${value.n}`;

/** @param {ReturnType<typeof buildReport>} report */
export function renderMarkdown(report) {
  const lines = [];
  lines.push('# 协议路由评测结果', '');
  lines.push(`- 生成时间：${report.generated_at}`);
  lines.push(`- 驱动器：${report.driver.driver ?? '未知'}`);
  if (report.driver.host) lines.push(`- 宿主：${report.driver.host} ${report.driver.host_version ?? ''}`.trimEnd());
  if (report.driver.model) lines.push(`- 模型：${report.driver.model}`);
  if (report.driver.skills && Object.keys(report.driver.skills).length) {
    lines.push('- 四个 skill 的 content_digest：');
    for (const [name, digest] of Object.entries(report.driver.skills)) lines.push(`  - ${name}: ${digest}`);
  }
  lines.push(`- 每条用例计划跑 ${report.requested_runs} 次`, '');

  lines.push('## 逐条结果（原始计数 k/n，不取多数）', '');
  lines.push('> n 是**有效**次数。基础设施故障经重试仍无效的运行记 `invalid`，不进 k/n，见下面「无效运行」一节。', '');
  lines.push('| # | 类 | 情境 | 断言 | k/n | 计划 n | 无效 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const item of report.cases) {
    lines.push(`| ${item.id} | ${item.category === 'positive' ? '正向' : '禁止'} | ${item.title} | ${item.expectation} | ${item.k}/${item.n} | ${item.planned_n} | ${item.invalid} |`);
  }
  lines.push('');

  lines.push('## 两栏分数', '');
  lines.push('| 栏 | Σk/Σn |');
  lines.push('| --- | --- |');
  lines.push(`| 正向 | ${fraction(report.columns.positive)} |`);
  lines.push(`| 禁止 | ${fraction(report.columns.forbidden)} |`);
  lines.push('');
  lines.push('> 两栏必须同时引用。单独引用其中任何一栏都没有意义：只报正向会把「什么都不做」当成失败，');
  lines.push('> 只报禁止会把「什么都不做」当成满分。也不汇总成单一百分比。', '');

  lines.push('## 平凡基线（按同一 n 换算）', '');
  lines.push('| 基线 | 正向 Σk/Σn | 禁止 Σk/Σn |');
  lines.push('| --- | --- | --- |');
  lines.push(`| 永远 NONE | ${fraction(report.trivial_baselines.always_none.positive)} | ${fraction(report.trivial_baselines.always_none.forbidden)} |`);
  lines.push(`| 永远 WRITE | ${fraction(report.trivial_baselines.always_write.positive)} | ${fraction(report.trivial_baselines.always_write.forbidden)} |`);
  lines.push('');

  lines.push('## 无效运行（不进 k/n）', '');
  if (report.invalid_runs.length === 0) {
    lines.push('无。', '');
  } else {
    lines.push('宿主自己标了错误的会话（判据见 `lib/run-validity.mjs`）。它们不是协议行为，重试用尽后从 k/n 里剔除。', '');
    lines.push('| # | run | 尝试次数 | 信号 | 原因摘要 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const item of report.invalid_runs) {
      lines.push(`| ${item.case_id} | ${item.run} | ${item.attempts} | \`${item.signal ?? '未知'}\` | ${oneLine(item.reason)} |`);
    }
    lines.push('');
  }

  lines.push('## 逐次明细', '');
  for (const item of report.cases) {
    lines.push(`### #${item.id} ${item.title}（${item.category === 'positive' ? '正向' : '禁止'}，${item.k}/${item.n}）`, '');
    lines.push(`- 断言：${item.expectation}`);
    lines.push(`- 前置状态：${item.setup}`);
    for (const run of item.runs) {
      const info = `加载 skill：${run.skill_loaded ? '是' : '否'}；主动发起独立验收：${run.initiated_independent_verification ? '是' : '否'}`;
      lines.push(`- run ${run.run}：观测量 \`${run.observation}\` → ${run.satisfied ? '符合' : '不符合'}；${run.reason}（信息性，不计分：${info}）`);
    }
    if (item.invalid) lines.push(`- 另有 ${item.invalid} 次无效运行，未计入 k/n`);
    if (item.runs.length === 0) lines.push('- 没有任何记录');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
