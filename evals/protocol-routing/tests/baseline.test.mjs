// @ts-check
// 平凡基线自测。全部离线，不起任何会话、不产生任何模型费用。
//
// 这条测试钉的是 issue #15「报告」一节写明的两组数字。它们不是装饰：
// 只报正向栏时「永远 NONE」拿 0/7 但「永远 WRITE」能白拿 2/7；
// 只报禁止栏时「永远 NONE」直接满分 4/4。两栏同时看，平凡策略才无处藏身。

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CASES, FORBIDDEN_CASES, POSITIVE_CASES, selectCases } from '../cases.mjs';
import { createReplayDriver } from '../drivers/replay.mjs';
import { buildReport, renderMarkdown, trivialBaseline } from '../lib/report.mjs';
import { main, parseArgs } from '../run.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPLAY = join(ROOT, 'fixtures', 'replay');

/** 用回放驱动器把某个合成会话喂给全部 11 条用例，返回两栏 Σk/Σn。 */
async function replayColumns(fixture, runs) {
  const driver = createReplayDriver({ dir: join(REPLAY, fixture) });
  const sessions = [];
  for (const evalCase of CASES) {
    for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
      sessions.push({ case_id: evalCase.id, run: runIndex, observation: await driver.runSession({ evalCase, runIndex }) });
    }
  }
  return buildReport({ cases: CASES, runs, driver: driver.meta, sessions });
}

test('用例表就是 issue #15 的 11 条：正向 7 条、禁止 4 条', () => {
  assert.equal(CASES.length, 11);
  assert.equal(POSITIVE_CASES.length, 7);
  assert.equal(FORBIDDEN_CASES.length, 4);
  assert.deepEqual(CASES.map((item) => item.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('回放「永远 NONE」：正向 0/7、禁止 4/4；n=3 时 0/21 与 12/12', async () => {
  const single = await replayColumns('always-none', 1);
  assert.deepEqual(single.columns.positive, { k: 0, n: 7 });
  assert.deepEqual(single.columns.forbidden, { k: 4, n: 4 });
  for (const item of single.cases) assert.equal(item.runs[0].observation, 'NONE', `用例 ${item.id}`);

  const triple = await replayColumns('always-none', 3);
  assert.deepEqual(triple.columns.positive, { k: 0, n: 21 });
  assert.deepEqual(triple.columns.forbidden, { k: 12, n: 12 });
});

test('回放「永远 WRITE」：正向 2/7、禁止 2/4；n=3 时 6/21 与 6/12', async () => {
  const single = await replayColumns('always-write', 1);
  assert.deepEqual(single.columns.positive, { k: 2, n: 7 });
  assert.deepEqual(single.columns.forbidden, { k: 2, n: 4 });
  for (const item of single.cases) assert.equal(item.runs[0].observation, 'WRITE', `用例 ${item.id}`);
  // 正向那 2 分只来自第 1、2 条；禁止那 2 分只来自第 10、11 条（它们不禁止写）。
  assert.deepEqual(single.cases.filter((item) => item.category === 'positive' && item.k === 1).map((item) => item.id), [1, 2]);
  assert.deepEqual(single.cases.filter((item) => item.category === 'forbidden' && item.k === 1).map((item) => item.id), [10, 11]);

  const triple = await replayColumns('always-write', 3);
  assert.deepEqual(triple.columns.positive, { k: 6, n: 21 });
  assert.deepEqual(triple.columns.forbidden, { k: 6, n: 12 });
});

test('报告器自带的平凡基线与回放结果一致，并按同一 n 换算', async () => {
  assert.deepEqual(trivialBaseline(CASES, 'NONE', 1).positive, { k: 0, n: 7, cases: 7, satisfied_cases: 0 });
  assert.deepEqual(trivialBaseline(CASES, 'NONE', 1).forbidden, { k: 4, n: 4, cases: 4, satisfied_cases: 4 });
  assert.deepEqual(trivialBaseline(CASES, 'WRITE', 1).positive, { k: 2, n: 7, cases: 7, satisfied_cases: 2 });
  assert.deepEqual(trivialBaseline(CASES, 'WRITE', 1).forbidden, { k: 2, n: 4, cases: 4, satisfied_cases: 2 });

  const report = await replayColumns('always-none', 3);
  assert.deepEqual(report.trivial_baselines.always_none.positive, { k: 0, n: 21, cases: 7, satisfied_cases: 0 });
  assert.deepEqual(report.trivial_baselines.always_none.forbidden, { k: 12, n: 12, cases: 4, satisfied_cases: 4 });
  assert.deepEqual(report.trivial_baselines.always_write.positive, { k: 6, n: 21, cases: 7, satisfied_cases: 2 });
  assert.deepEqual(report.trivial_baselines.always_write.forbidden, { k: 6, n: 12, cases: 4, satisfied_cases: 2 });
});

test('run.mjs 走回放驱动器可以端到端跑完，产出 report.json 与 report.md', async () => {
  const out = mkdtempSync(join(tmpdir(), 'protocol-routing-run-'));
  try {
    const code = await main(['--driver', 'replay', '--replay', join(REPLAY, 'always-write'), '--runs', '2', '--cases', '1,8', '--out', out, '--quiet']);
    assert.equal(code, 0);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    assert.deepEqual(report.selected_cases, [1, 8]);
    assert.deepEqual(report.columns, { positive: { k: 2, n: 2 }, forbidden: { k: 0, n: 2 } });
    // 子集加跑时平凡基线按被选用例和同一 n 换算，不拿全量 11 条的数字冒充。
    assert.deepEqual(report.trivial_baselines.always_write.positive, { k: 2, n: 2, cases: 1, satisfied_cases: 1 });
    const markdown = readFileSync(join(out, 'report.md'), 'utf8');
    assert.match(markdown, /## 两栏分数/u);
    assert.match(markdown, /## 平凡基线（按同一 n 换算）/u);
    assert.ok(!/总分|总体通过率|综合得分/u.test(markdown), '报告不得汇总成单一百分比');
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('run.mjs 参数校验：未知选项、非法 runs、缺模型、缺回放目录都当场报错', async () => {
  assert.throws(() => parseArgs(['--unknown', 'x']), /未知选项/u);
  assert.throws(() => parseArgs(['--runs']), /需要取值/u);
  assert.deepEqual(parseArgs(['--quiet']).quiet, true);
  await assert.rejects(() => main(['--runs', '0', '--replay', REPLAY]), /--runs 必须是正整数/u);
  await assert.rejects(() => main(['--driver', 'replay']), /需要 --replay/u);
  await assert.rejects(() => main(['--driver', 'claude-headless']), /需要 --model/u);
  assert.throws(() => selectCases('99'), /未知用例 99/u);
  assert.deepEqual(selectCases('7,8').map((item) => item.id), [7, 8]);
});

test('renderMarkdown 逐条列出 k/n，并同时给出两栏与两条平凡基线', () => {
  const markdown = renderMarkdown(buildReport({ cases: CASES, runs: 3, driver: { driver: 'replay' }, sessions: [] }));
  assert.match(markdown, /\| 正向 \| 0\/0 \|/u);
  assert.match(markdown, /\| 永远 NONE \| 0\/21 \| 12\/12 \|/u);
  assert.match(markdown, /\| 永远 WRITE \| 6\/21 \| 6\/12 \|/u);
  for (const item of CASES) assert.ok(markdown.includes(`#${item.id} ${item.title}`), `明细缺少用例 ${item.id}`);
});

test('逐条报告原始计数，不取多数：2/3 与 3/3 在报告里是两个不同的数', async () => {
  const driver = createReplayDriver({ dir: join(REPLAY, 'always-write') });
  const none = createReplayDriver({ dir: join(REPLAY, 'always-none') });
  const one = CASES.filter((item) => item.id === 1);
  const sessions = [
    { case_id: 1, run: 1, observation: await driver.runSession({ evalCase: one[0], runIndex: 1 }) },
    { case_id: 1, run: 2, observation: await driver.runSession({ evalCase: one[0], runIndex: 2 }) },
    { case_id: 1, run: 3, observation: await none.runSession({ evalCase: one[0], runIndex: 3 }) },
  ];
  const report = buildReport({ cases: one, runs: 3, driver: {}, sessions });
  assert.deepEqual([report.cases[0].k, report.cases[0].n], [2, 3]);
  assert.deepEqual(report.cases[0].runs.map((run) => run.observation), ['WRITE', 'WRITE', 'NONE']);
});
