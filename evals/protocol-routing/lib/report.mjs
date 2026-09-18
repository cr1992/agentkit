// @ts-check
// 报告器。
//
// 口径按 issue #15「报告」一节，三条都是硬约束：
// - 逐条报告原始计数 k/n，**不取多数**——2/3 和 3/3 是两回事，取多数恰好丢掉要看的信息；
// - 正向、禁止两栏必须同时出现，栏分数是该栏所有用例的 Σk / Σn；
// - 平凡基线（永远 NONE、永远 WRITE）与结果一起报，按同一 n 换算；
// - 不汇总成单一百分比，暂不设红线。

import { classify } from './classifier.mjs';

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
 * 平凡基线：对每条用例喂同一个合成观测量，按同一 n 换算。
 * @param {import('../cases.mjs').EvalCase[]} cases
 * @param {'NONE' | 'WRITE'} kind
 * @param {number} runs
 */
export function trivialBaseline(cases, kind, runs) {
  const columns = { positive: { k: 0, n: 0, cases: 0, satisfied_cases: 0 }, forbidden: { k: 0, n: 0, cases: 0, satisfied_cases: 0 } };
  for (const item of cases) {
    const verdict = item.assert(SYNTHETIC[kind](), {});
    const column = columns[item.category];
    column.cases += 1;
    column.n += runs;
    if (verdict.satisfied) { column.k += runs; column.satisfied_cases += 1; }
  }
  return columns;
}

/**
 * @param {{
 *   cases: import('../cases.mjs').EvalCase[],
 *   runs: number,
 *   driver: Record<string, any>,
 *   sessions: Array<{ case_id: number, run: number, observation: import('../lib/observation.mjs').Observation & { source?: string } }>,
 * }} input
 */
export function buildReport({ cases, runs, driver, sessions }) {
  const byCase = new Map(cases.map((item) => [item.id, item]));
  /** @type {Map<number, any[]>} */
  const perCase = new Map(cases.map((item) => [item.id, []]));

  for (const session of sessions) {
    const evalCase = byCase.get(session.case_id);
    if (!evalCase) continue;
    const classification = classify({ initial_repo: session.observation.initial_repo, events: session.observation.events });
    const verdict = evalCase.assert(classification, { payloads: session.observation.payloads });
    perCase.get(evalCase.id)?.push({
      run: session.run,
      observation: classification.observation,
      observation_kind: classification.observation_kind,
      observed_at: classification.observed_at,
      satisfied: verdict.satisfied,
      reason: verdict.reason,
      agentkit_calls: classification.calls.map((call) => ({ seq: call.seq, label: call.label, observable: call.observable })),
      writes: classification.writes,
      exit_code: session.observation.end?.exit_code ?? null,
      source: session.observation.source ?? null,
    });
  }

  const columns = { positive: { k: 0, n: 0 }, forbidden: { k: 0, n: 0 } };
  const caseReports = cases.map((item) => {
    const results = perCase.get(item.id) ?? [];
    const k = results.filter((result) => result.satisfied).length;
    const n = results.length;
    columns[item.category].k += k;
    columns[item.category].n += n;
    return { id: item.id, category: item.category, title: item.title, expectation: item.expectation, setup: item.setup, k, n, runs: results };
  });

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    requested_runs: runs,
    driver,
    cases: caseReports,
    columns,
    trivial_baselines: {
      always_none: trivialBaseline(cases, 'NONE', runs),
      always_write: trivialBaseline(cases, 'WRITE', runs),
    },
  };
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
  lines.push('| # | 类 | 情境 | 断言 | k/n |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const item of report.cases) {
    lines.push(`| ${item.id} | ${item.category === 'positive' ? '正向' : '禁止'} | ${item.title} | ${item.expectation} | ${item.k}/${item.n} |`);
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

  lines.push('## 逐次明细', '');
  for (const item of report.cases) {
    lines.push(`### #${item.id} ${item.title}（${item.category === 'positive' ? '正向' : '禁止'}，${item.k}/${item.n}）`, '');
    lines.push(`- 断言：${item.expectation}`);
    lines.push(`- 前置状态：${item.setup}`);
    for (const run of item.runs) {
      lines.push(`- run ${run.run}：观测量 \`${run.observation}\` → ${run.satisfied ? '符合' : '不符合'}；${run.reason}`);
    }
    if (item.runs.length === 0) lines.push('- 没有任何记录');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
