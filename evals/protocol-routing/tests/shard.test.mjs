// @ts-check
// 分片与合并自测。全部走回放驱动器，零模型费用。
//
// 要钉住的那一条：**合并后的报告与串行报告逐项相等**——两栏 Σk/Σn、逐条 k/n、
// 无效运行、会话失败、两条平凡基线。分片只改「谁跟谁一起跑」；一旦合并这一步自带口径，
// 「并行跑出来的分数」和「串行跑出来的分数」就不是同一个东西了。

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CASES } from '../cases.mjs';
import { mergeReports } from '../lib/merge.mjs';
import { parseShardSpec, planShards, selectShard, shardLoads } from '../lib/shard.mjs';
import { main as mergeMain, parseArgs as parseMergeArgs, resolveReportPath } from '../merge-reports.mjs';
import { main as runMain } from '../run.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPLAY = join(ROOT, 'fixtures', 'replay', 'always-write');

test('每条用例都有耗时权重，分片按耗时装箱而不是按编号均分', () => {
  for (const item of CASES) {
    assert.equal(typeof item.weight, 'number', `用例 ${item.id} 没有 weight`);
    assert.ok(item.weight > 0, `用例 ${item.id} 的 weight 必须为正`);
  }

  // 分 3 片：11 条用例一条不多一条不少，且互不重叠。
  const shards = planShards(CASES, 3);
  assert.equal(shards.length, 3);
  assert.deepEqual(
    shards
      .flat()
      .map((item) => item.id)
      .sort((a, b) => a - b),
    CASES.map((item) => item.id),
  );
  for (const shard of shards)
    assert.deepEqual(
      shard.map((item) => item.id),
      [...shard.map((item) => item.id)].sort((a, b) => a - b),
      '每片内部按 id 升序',
    );

  // 最重的三条（7≈540、6≈400、4≈350）必须落在三个不同的片上，否则并行等于白做。
  const heavy = [4, 6, 7];
  const placements = heavy.map((id) => shards.findIndex((shard) => shard.some((item) => item.id === id)));
  assert.equal(new Set(placements).size, 3, `第 4、6、7 条被堆到了同一片：${JSON.stringify(placements)}`);

  // 均衡度：最重的一片不该超过「平均 + 最重的一条」——LPT 的经典上界，也是实际要的性质。
  const loads = shardLoads(CASES, 3);
  const total = loads.reduce((sum, load) => sum + load, 0);
  const heaviestCase = Math.max(...CASES.map((item) => item.weight));
  assert.ok(Math.max(...loads) <= total / 3 + heaviestCase, `分片不均衡：${JSON.stringify(loads)}`);

  // 确定性：同一组输入永远分出同一份结果。
  assert.deepEqual(
    planShards(CASES, 3).map((s) => s.map((i) => i.id)),
    planShards(CASES, 3).map((s) => s.map((i) => i.id)),
  );
});

test('--shard i/n 的解析与边界', () => {
  assert.deepEqual(parseShardSpec('2/3'), { index: 2, total: 3 });
  assert.deepEqual(parseShardSpec(' 1 / 1 '), { index: 1, total: 1 });
  assert.throws(() => parseShardSpec('3'), /要写成 i\/n/u);
  assert.throws(() => parseShardSpec('0/3'), /必须在 1\.\.3/u);
  assert.throws(() => parseShardSpec('4/3'), /必须在 1\.\.3/u);
  assert.throws(() => parseShardSpec('1/0'), /n 必须 ≥ 1/u);
  // n=1 就是不分片。
  assert.deepEqual(
    selectShard(CASES, { index: 1, total: 1 }).map((item) => item.id),
    CASES.map((item) => item.id),
  );
  // 用例比片还多不出来时，后面的片是空的（run.mjs 对此当场报错）。
  assert.deepEqual(
    planShards(
      CASES.filter((item) => item.id === 1),
      3,
    ).map((shard) => shard.length),
    [1, 0, 0],
  );
});

/** 跑一遍回放驱动器，返回写出来的 report.json。 */
async function replayRun(out, extra = []) {
  const code = await runMain([
    '--driver',
    'replay',
    '--replay',
    REPLAY,
    '--runs',
    '3',
    '--out',
    out,
    '--quiet',
    ...extra,
  ]);
  assert.equal(code, 0);
  return JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
}

test('端到端：串行跑一份、分 3 片跑再合并一份，两份报告逐项相等', async () => {
  const base = mkdtempSync(join(tmpdir(), 'protocol-routing-shard-'));
  try {
    const serial = await replayRun(join(base, 'serial'));

    const shardDirs = [];
    for (const index of [1, 2, 3]) {
      const dir = join(base, `shard-${index}`);
      const report = await replayRun(dir, ['--shard', `${index}/3`]);
      assert.deepEqual(report.shard, { index, total: 3 });
      shardDirs.push(dir);
    }

    const code = await mergeMain(['--out', join(base, 'merged'), ...shardDirs, '--quiet']);
    assert.equal(code, 0);
    const merged = JSON.parse(readFileSync(join(base, 'merged', 'report.json'), 'utf8'));

    // 1) 两栏 Σk/Σn
    assert.deepEqual(merged.columns, serial.columns);
    // 2) 逐条 k/n、无效次数、计划 n、断言口径——逐字段对齐，不只对 k/n。
    assert.deepEqual(
      merged.cases.map((item) => item.id),
      serial.cases.map((item) => item.id),
    );
    for (const [index, item] of merged.cases.entries()) {
      const expected = serial.cases[index];
      for (const key of [
        'id',
        'category',
        'title',
        'expectation',
        'setup',
        'assert_scope',
        'k',
        'n',
        'planned_n',
        'invalid',
      ]) {
        assert.deepEqual(item[key], expected[key], `用例 ${item.id} 的 ${key} 对不上`);
      }
      assert.deepEqual(
        item.runs.map((run) => [run.run, run.observation, run.satisfied]),
        expected.runs.map((run) => [run.run, run.observation, run.satisfied]),
      );
    }
    // 3) 平凡基线（合并这一步重算，不是把各片的数加起来）
    assert.deepEqual(merged.trivial_baselines, serial.trivial_baselines);
    // 4) 无效运行与会话失败
    assert.deepEqual(merged.invalid_runs, serial.invalid_runs);
    assert.deepEqual(merged.session_failures, serial.session_failures);
    // 5) 报告口径的其余字段
    assert.deepEqual(merged.selected_cases, serial.selected_cases);
    assert.equal(merged.requested_runs, serial.requested_runs);
    assert.equal(merged.total_cases, serial.total_cases);

    // 人读的那份也必须一致：两栏与两条基线那几行逐字相同。
    const rows = (/** @type {string} */ text) => text.split('\n').filter((line) => /^\| (正向|禁止|永远) /u.test(line));
    assert.deepEqual(
      rows(readFileSync(join(base, 'merged', 'report.md'), 'utf8')),
      rows(readFileSync(join(base, 'serial', 'report.md'), 'utf8')),
    );
    // 合并留档：每一片贡献了哪几条用例。
    assert.deepEqual(
      merged.driver.merged_from
        .map((item) => item.cases)
        .flat()
        .sort((a, b) => a - b),
      CASES.map((item) => item.id),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('合并拒绝拼接对不上的两轮：runs、模型、skill digest、重叠用例', () => {
  const report = (overrides = {}) => ({
    schema_version: 1,
    requested_runs: 3,
    driver: {
      driver: 'claude-headless',
      host: 'claude-code',
      host_version: '2.1.276',
      model: 'm',
      skills: { a: 'sha256:1' },
    },
    cases: [{ id: 1, category: 'positive', k: 1, n: 1, planned_n: 3, invalid: 0, runs: [] }],
    columns: { positive: { k: 1, n: 1 }, forbidden: { k: 0, n: 0 } },
    invalid_runs: [],
    session_failures: [],
    total_cases: 11,
    ...overrides,
  });
  const other = (id) =>
    report({
      cases: [{ id, category: 'forbidden', k: 1, n: 1, planned_n: 3, invalid: 0, runs: [] }],
      columns: { positive: { k: 0, n: 0 }, forbidden: { k: 1, n: 1 } },
    });

  assert.throws(() => mergeReports([]), /没有可合并的报告/u);
  assert.throws(
    () =>
      mergeReports([
        { path: 'a', report: report() },
        { path: 'b', report: report() },
      ]),
    /用例 1 在多份报告里都出现了/u,
  );
  assert.throws(
    () =>
      mergeReports([
        { path: 'a', report: report() },
        { path: 'b', report: { ...other(8), requested_runs: 10 } },
      ]),
    /--runs/u,
  );
  assert.throws(
    () =>
      mergeReports([
        { path: 'a', report: report() },
        { path: 'b', report: { ...other(8), driver: { ...report().driver, model: 'n' } } },
      ]),
    /driver\.model/u,
  );
  assert.throws(
    () =>
      mergeReports([
        { path: 'a', report: report() },
        { path: 'b', report: { ...other(8), driver: { ...report().driver, skills: { a: 'sha256:2' } } } },
      ]),
    /content_digest 不同/u,
  );
  assert.throws(
    () =>
      mergeReports([
        { path: 'a', report: report() },
        { path: 'b', report: other(99) },
      ]),
    /当前用例表不认识的用例/u,
  );

  // 正常路径：两片互不重叠，栏分数相加，平凡基线按合并后的有效 n 重算。
  const merged = mergeReports([
    { path: 'a', report: report() },
    { path: 'b', report: other(8) },
  ]);
  assert.deepEqual(merged.columns, { positive: { k: 1, n: 1 }, forbidden: { k: 1, n: 1 } });
  assert.deepEqual(merged.selected_cases, [1, 8]);
  assert.deepEqual(merged.trivial_baselines.always_write.positive, { k: 1, n: 1, cases: 1, satisfied_cases: 1 });
  assert.deepEqual(merged.trivial_baselines.always_write.forbidden, { k: 0, n: 1, cases: 1, satisfied_cases: 0 });
});

test('merge-reports.mjs 的参数校验与目录 / 文件两种输入', () => {
  assert.throws(() => parseMergeArgs([]), /--out .*必填/u);
  assert.throws(() => parseMergeArgs(['--out', '/tmp/x']), /至少要给两份/u);
  assert.throws(() => parseMergeArgs(['--out']), /--out 需要取值/u);
  assert.throws(() => parseMergeArgs(['--out', '/tmp/x', '--nope', 'a', 'b']), /未知选项/u);
  assert.deepEqual(parseMergeArgs(['--out', '/tmp/x', 'a', 'b', '--quiet']), {
    out: '/tmp/x',
    quiet: true,
    inputs: ['a', 'b'],
  });
  assert.throws(() => resolveReportPath(join(tmpdir(), 'protocol-routing-nowhere')), /找不到/u);
});

test('run.mjs：分片是空的时候当场报错，不静默产出一份 0/0 的报告', async () => {
  await assert.rejects(
    () =>
      runMain([
        '--driver',
        'replay',
        '--replay',
        REPLAY,
        '--cases',
        '1',
        '--shard',
        '2/3',
        '--out',
        join(tmpdir(), 'protocol-routing-empty-shard'),
      ]),
    /这一片是空的/u,
  );
});
