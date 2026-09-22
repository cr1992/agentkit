// @ts-check
// 把若干分片的 report.json 合并成一份。
//
// 硬要求：**合并后的报告与串行跑出来的报告逐项相等**——两栏 Σk/Σn、逐条 k/n、无效运行、
// 会话失败、平凡基线。分片只改「谁跟谁一起跑」，不改任何判定口径；一旦合并这一步自带口径，
// 「并行跑的结果」和「串行跑的结果」就不再是同一个东西，那这套并行就没有意义了。
// `tests/shard.test.mjs` 拿回放驱动器串行跑一份、分 3 片跑再合并一份，逐项对等。
//
// 做法上只有一条规矩：**能重算的一律重算，不做算术拼接。** 平凡基线因此不是把各片的
// 分数加起来，而是拿合并后的「每条用例有效 n」重新过一遍 `trivialBaseline()`——
// 和串行路径调的是同一个函数。

import { CASES } from '../cases.mjs';
import { trivialBaseline } from './report.mjs';

/** 各分片之间必须一致的元数据：不一致就说明这几份报告根本不是同一轮评测。 */
const MUST_MATCH = ['driver', 'host', 'host_version', 'model'];

/**
 * @param {Array<{ path?: string, report: any }>} inputs
 * @returns {any} 合并后的 report 对象，形状与 `buildReport()` 的产出一致。
 */
export function mergeReports(inputs) {
  if (!inputs.length) throw new Error('没有可合并的报告');
  const reports = inputs.map((item) => item.report);
  const label = (/** @type {number} */ i) => inputs[i].path ?? `第 ${i + 1} 份`;

  const head = reports[0];
  for (let i = 1; i < reports.length; i += 1) {
    if (reports[i].schema_version !== head.schema_version)
      throw new Error(`${label(i)} 的 schema_version 与 ${label(0)} 不同，拒绝合并`);
    if (reports[i].requested_runs !== head.requested_runs)
      throw new Error(
        `${label(i)} 的 --runs 是 ${reports[i].requested_runs}，${label(0)} 是 ${head.requested_runs}，拒绝合并`,
      );
    for (const key of MUST_MATCH) {
      const a = head.driver?.[key] ?? null;
      const b = reports[i].driver?.[key] ?? null;
      if (a !== b)
        throw new Error(
          `${label(i)} 的 driver.${key}=${JSON.stringify(b)} 与 ${label(0)} 的 ${JSON.stringify(a)} 不同，拒绝合并`,
        );
    }
    // skill 的 content_digest 是报告里唯一能回溯到源码的锚点；分片之间对不上，
    // 说明各片测的不是同一份 skill，合起来的数字没有意义。
    const digests = (/** @type {any} */ report) => JSON.stringify(report.driver?.skills ?? null);
    if (digests(reports[i]) !== digests(head) && reports[i].driver?.skills && head.driver?.skills) {
      throw new Error(`${label(i)} 与 ${label(0)} 的 skill content_digest 不同，拒绝合并`);
    }
  }

  /** @type {Map<number, any>} */
  const byCase = new Map();
  for (let i = 0; i < reports.length; i += 1) {
    for (const item of reports[i].cases ?? []) {
      if (byCase.has(item.id)) throw new Error(`用例 ${item.id} 在多份报告里都出现了（${label(i)}）：分片必须互不重叠`);
      byCase.set(item.id, item);
    }
  }
  const cases = [...byCase.values()].sort((a, b) => a.id - b.id);

  const columns = { positive: { k: 0, n: 0 }, forbidden: { k: 0, n: 0 } };
  /** @type {Map<number, number>} */
  const validNByCase = new Map();
  for (const item of cases) {
    columns[item.category].k += item.k;
    columns[item.category].n += item.n;
    validNByCase.set(item.id, item.n);
  }

  // 平凡基线重算，不拼接：分母必须是合并后的有效 n，而且要走串行路径的同一个函数。
  const selected = cases.map((item) => item.id);
  const caseDefs = CASES.filter((item) => selected.includes(item.id));
  if (caseDefs.length !== selected.length) {
    const unknown = selected.filter((id) => !CASES.some((item) => item.id === id));
    throw new Error(`报告里有当前用例表不认识的用例：${unknown.join(', ')}；用例表变过就不能跨版本合并`);
  }

  return {
    schema_version: head.schema_version,
    generated_at: new Date().toISOString(),
    requested_runs: head.requested_runs,
    driver: {
      ...head.driver,
      merged_from: inputs.map((item, i) => ({
        source: item.path ?? null,
        cases: (reports[i].cases ?? []).map((c) => c.id),
      })),
    },
    cases,
    columns,
    invalid_runs: reports
      .flatMap((report) => report.invalid_runs ?? [])
      .sort((a, b) => a.case_id - b.case_id || a.run - b.run),
    trivial_baselines: {
      always_none: trivialBaseline(caseDefs, 'NONE', validNByCase),
      always_write: trivialBaseline(caseDefs, 'WRITE', validNByCase),
    },
    session_failures: reports.flatMap((report) => report.session_failures ?? []),
    selected_cases: selected,
    total_cases: head.total_cases ?? CASES.length,
  };
}
