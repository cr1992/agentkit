// @ts-check
// 「无效运行」判据与重试自测（issue #15 的缺陷 2）。全部离线，不起任何会话、零模型费用。
//
// 两个方向都要钉：
// - 宿主标了错误的运行必须判无效（否则基础设施故障会被记成 `NONE` 进 k/n，第一次真实运行
//   里 4-2 / 5-2 / 5-3 三个会话就是这样丢的）；
// - **「模型什么都没做」必须仍然判有效**。那是正向用例要量的一种真实结果，把它判成无效
//   等于把失守洗掉。所以判据只认宿主的错误信号，绝不单凭「零工具调用」成立。

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CASES } from '../cases.mjs';
import { createReplayDriver } from '../drivers/replay.mjs';
import { buildReport, renderMarkdown } from '../lib/report.mjs';
import { FAILURE_RESULT_SUBTYPES, classifyRunValidity } from '../lib/run-validity.mjs';
import { MAX_ATTEMPTS, main, runSessionWithRetries } from '../run.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPLAY = join(ROOT, 'fixtures', 'replay');
const noSleep = async () => {};

/** 第一次真实运行里那三个故障会话的 result 事件形状（字段口径，不含会话内容）。 */
const API_ERROR_RESULT = {
  subtype: 'success',
  is_error: true,
  num_turns: 1,
  api_error_status: null,
  final_text_prefix: 'API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)',
};

test('宿主 result 事件 is_error=true 即判无效，不论 subtype 是不是 success', () => {
  const verdict = classifyRunValidity({ events: [], end: { exit_code: 1, host_result: API_ERROR_RESULT } });
  assert.equal(verdict.valid, false);
  assert.equal(verdict.signal, 'result_is_error');
  assert.match(verdict.reason, /is_error=true/u);
  assert.match(verdict.reason, /API Error/u);
});

test('错误 subtype 判无效，但 error_max_turns 是真实终点，仍然有效', () => {
  for (const subtype of FAILURE_RESULT_SUBTYPES) {
    const verdict = classifyRunValidity({
      events: [],
      end: { exit_code: 1, host_result: { subtype, is_error: false } },
    });
    assert.equal(verdict.valid, false, subtype);
    assert.equal(verdict.signal, 'result_error_subtype');
  }
  assert.ok(!FAILURE_RESULT_SUBTYPES.includes('error_max_turns'));
  const maxTurns = classifyRunValidity({
    events: [{}],
    end: { exit_code: 0, host_result: { subtype: 'error_max_turns', is_error: false } },
  });
  assert.equal(maxTurns.valid, true, '跑到轮次上限是会话自己的终点，不该重试');
});

test('最终文本以 API Error 开头是兜底判据：宿主忘了置 is_error 也拦得住', () => {
  const verdict = classifyRunValidity({
    events: [],
    end: {
      exit_code: 0,
      host_result: { subtype: 'success', is_error: false, final_text_prefix: '  API Error: overloaded' },
    },
  });
  assert.equal(verdict.valid, false);
  assert.equal(verdict.signal, 'final_text_api_error');
});

test('非零退出 + 零工具事件判无效；但零工具事件本身绝不单独成立', () => {
  assert.equal(
    classifyRunValidity({ events: [], end: { exit_code: 2, host_result: null } }).signal,
    'nonzero_exit_no_events',
  );

  // ⚠️ 这条是整个判据的安全面：一个「读了文档、想了想、什么都没做」的会话，
  // 观测量就是 `NONE`，是正向用例要量的真实结果，必须仍然计入 k/n。
  const didNothing = classifyRunValidity({
    events: [],
    end: {
      exit_code: 0,
      host_result: {
        subtype: 'success',
        is_error: false,
        num_turns: 4,
        final_text_prefix: '我看了一下，这件事不需要隔离。',
      },
    },
  });
  assert.equal(didNothing.valid, true);
  assert.equal(didNothing.signal, null);

  // 连 end 都没有（回放录制不写 host_result）时按「宿主没报错」处理，不误伤。
  assert.equal(classifyRunValidity({ events: [], end: null }).valid, true);
  assert.equal(classifyRunValidity({ events: [{}], end: { exit_code: 0 } }).valid, true);
});

test('回放一份合成的「API Error」会话：重试到上限后仍然无效', async () => {
  const driver = createReplayDriver({ dir: join(REPLAY, 'api-error') });
  const attempted = await runSessionWithRetries({ driver, evalCase: CASES[0], runIndex: 1, sleep: noSleep });
  assert.equal(attempted.attempts, MAX_ATTEMPTS, '1 次正常 + 2 次重试');
  assert.equal(attempted.validity.valid, false);
  assert.equal(attempted.discarded.length, MAX_ATTEMPTS);
});

test('回放「第 1 次 API Error、第 2 次正常」：重试成功后只留下有效那一次', async () => {
  const driver = createReplayDriver({ dir: join(REPLAY, 'api-error-then-ok') });
  const attempted = await runSessionWithRetries({ driver, evalCase: CASES[0], runIndex: 1, sleep: noSleep });
  assert.equal(attempted.attempts, 2);
  assert.equal(attempted.validity.valid, true);
  assert.equal(attempted.discarded.length, 1);
  assert.equal(attempted.discarded[0].signal, 'result_is_error');
});

test('端到端：整轮都是 API Error 时 k/n 全为 0/0，报告单列无效运行一节', async () => {
  const out = mkdtempSync(join(tmpdir(), 'protocol-routing-invalid-'));
  try {
    const code = await main(
      [
        '--driver',
        'replay',
        '--replay',
        join(REPLAY, 'api-error'),
        '--runs',
        '2',
        '--cases',
        '1,8',
        '--out',
        out,
        '--quiet',
      ],
      { sleep: noSleep },
    );
    assert.equal(code, 0, '无效运行不是「会话起不来」，不该让整轮非零退出');
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    // 不进 k/n：两栏分母都是 0，而计划次数仍然是 2。
    assert.deepEqual(report.columns, { positive: { k: 0, n: 0 }, forbidden: { k: 0, n: 0 } });
    for (const item of report.cases) {
      assert.deepEqual([item.k, item.n, item.planned_n, item.invalid], [0, 0, 2, 2], `用例 ${item.id}`);
    }
    assert.equal(report.invalid_runs.length, 4);
    for (const invalid of report.invalid_runs) {
      assert.equal(invalid.attempts, MAX_ATTEMPTS);
      assert.equal(invalid.signal, 'result_is_error');
    }
    // 平凡基线按有效 n 换算：有效 n 是 0，基线也必须是 0/0，不能拿计划次数冒充。
    assert.deepEqual(report.trivial_baselines.always_none.forbidden, { k: 0, n: 0, cases: 1, satisfied_cases: 1 });

    const markdown = readFileSync(join(out, 'report.md'), 'utf8');
    assert.match(markdown, /## 无效运行（不进 k\/n）/u);
    assert.match(markdown, /result_is_error/u);
    assert.match(markdown, /另有 2 次无效运行，未计入 k\/n/u);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('没有无效运行时报告里那一节写「无」，逐条明细的计划 n 与有效 n 相等', () => {
  const markdown = renderMarkdown(
    buildReport({ cases: CASES, runs: 3, driver: { driver: 'replay' }, sessions: [], invalidRuns: [] }),
  );
  assert.match(markdown, /## 无效运行（不进 k\/n）\n\n无。/u);
  assert.match(markdown, /\| # \| 类 \| 情境 \| 断言 \| k\/n \| 计划 n \| 无效 \|/u);
});
