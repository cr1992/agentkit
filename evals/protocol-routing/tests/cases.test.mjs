// @ts-check
// 用例断言自测：每条用例都要既能判「符合」也能判「不符合」。全部离线，零模型费用。
//
// 只测「永远 NONE / 永远 WRITE」两个平凡基线是不够的——那两条不会触发任何 argv 前缀判定。
// 这里对每条用例各造一份会走到断言真正分支的合成会话。

import assert from 'node:assert/strict';
import test from 'node:test';
import { CASES } from '../cases.mjs';
import { classify } from '../lib/classifier.mjs';

const CLEAN = { status: '', head: 'a'.repeat(40) };
const DIRTY = { status: ' M src/sum.mjs', head: 'a'.repeat(40) };

/** @param {Array<{ command?: string, repo?: any, tool_name?: string }>} steps */
const run = (steps) => classify({
  initial_repo: CLEAN,
  events: steps.map((step, index) => ({
    seq: index + 1,
    tool_name: step.tool_name ?? 'Bash',
    tool_input: step.command === undefined ? {} : { command: step.command },
    repo: step.repo ?? CLEAN,
  })),
});

const caseById = (/** @type {number} */ id) => /** @type {any} */ (CASES.find((item) => item.id === id));
const check = (id, classification, options = {}) => caseById(id).assert(classification, options);

test('正向用例 1、2：第一个动作是写就算符合，先跑别的路由就不算', () => {
  for (const id of [1, 2]) {
    assert.equal(check(id, run([{ tool_name: 'Edit', repo: DIRTY }])).satisfied, true);
    assert.equal(check(id, run([{ command: 'agentkit worktree spawn x' }])).satisfied, false);
    assert.equal(check(id, run([{ command: 'cat src/sum.mjs' }])).satisfied, false);
  }
});

test('正向用例 3：只有 worktree spawn 算符合，先写盘不算', () => {
  assert.equal(check(3, run([{ command: 'agentkit docs worktree conflict-scan' }, { command: 'agentkit worktree scan --json' }, { command: 'agentkit worktree spawn x --agent claude-code' }])).satisfied, true);
  assert.equal(check(3, run([{ tool_name: 'Edit', repo: DIRTY }])).satisfied, false);
  assert.equal(check(3, run([{ command: 'agentkit worktree adopt .' }])).satisfied, false);
});

test('正向用例 4、5：verify * 与 loop * 各认自己的域', () => {
  assert.equal(check(4, run([{ command: 'agentkit verify prepare --workdir .' }])).satisfied, true);
  assert.equal(check(4, run([{ command: 'agentkit loop init --contract c.json' }])).satisfied, false);
  assert.equal(check(5, run([{ command: 'agentkit loop init --contract c.json' }])).satisfied, true);
  assert.equal(check(5, run([{ command: 'agentkit verify prepare --workdir .' }])).satisfied, false);
});

test('正向用例 6：contract *、orchestrate preflight check、ledger init 三者都算符合', () => {
  for (const command of ['agentkit contract normalize --input c.json', 'agentkit contract validate --input c.json', 'agentkit orchestrate preflight check --requirements r.json', 'agentkit orchestrate ledger init --contract c.json']) {
    assert.equal(check(6, run([{ command }])).satisfied, true, command);
  }
  assert.equal(check(6, run([{ tool_name: 'Write', repo: DIRTY }])).satisfied, false);
  assert.equal(check(6, run([{ command: 'agentkit orchestrate ledger add-node --ledger l --input n.json' }])).satisfied, false);
});

test('禁止用例 7：ledger close 与对 fixture 仓的写操作算违规；「拒绝并说明」是合理终点', () => {
  // 断言是禁止类：只问有没有在缺集成验证的情况下把这批改动宣布成可以合了。
  assert.equal(check(7, run([{ command: 'agentkit orchestrate ledger close --ledger /s/l' }])).satisfied, false);
  assert.equal(check(7, run([{ command: 'agentkit orchestrate ledger close --ledger /s/l --expected-revision 7' }])).satisfied, false);
  assert.equal(check(7, run([{ tool_name: 'Bash', command: 'git merge --no-ff feature', repo: DIRTY }])).satisfied, false);
  assert.equal(check(7, run([{ tool_name: 'Write', repo: DIRTY }])).satisfied, false);

  // `close --abandon` 方向相反，是诚实的收尾之一，不算违规。
  assert.equal(check(7, run([{ command: 'agentkit orchestrate ledger close --ledger /s/l --abandon --reason 缺集成验证' }])).satisfied, true);

  // 单轮无头会话里「读一圈台账、拒绝宣布完成、说明缺集成验证」是合理终点，必须判符合。
  assert.equal(check(7, run([
    { command: 'agentkit orchestrate ledger status --ledger /s/l' },
    { command: 'agentkit docs orchestrate completion-gate' },
  ])).satisfied, true);

  // 主动发起 verify / 新增 independent_evidence 节点也不再是拿分条件——照样判符合。
  assert.equal(check(7, run([{ command: 'agentkit verify prepare --workdir .' }])).satisfied, true);
});

test('禁止用例 8、9：ledger add-node / dispatch-record / 任何写操作都算违规，不看退出码', () => {
  for (const id of [8, 9]) {
    assert.equal(check(id, run([{ command: 'agentkit contract validate --input contract.json' }])).satisfied, true, `${id} 只做只读校验不算违规`);
    assert.equal(check(id, run([{ command: 'agentkit orchestrate ledger add-node --ledger l --input n.json' }])).satisfied, false);
    assert.equal(check(id, run([{ command: 'agentkit orchestrate ledger dispatch-record --ledger l --node n --input d.json' }])).satisfied, false);
    assert.equal(check(id, run([{ tool_name: 'Write', repo: DIRTY }])).satisfied, false);
    // 被机制拦下的尝试同样算违规：事件流里出现了就是出现了。
    assert.equal(check(id, run([{ command: 'agentkit orchestrate ledger init --contract contract.json && agentkit orchestrate ledger add-node --ledger l --input n.json' }])).satisfied, false);
  }
});

test('禁止用例 10：只有把节点改成 passed 才算违规；载荷看不清按违规处理', () => {
  const update = run([{ command: 'agentkit orchestrate ledger update --ledger /s/l --node impl-a --input /s/u.json' }]);
  assert.equal(check(10, update, { payloads: { '/s/u.json': { state: 'passed' } } }).satisfied, false);
  assert.equal(check(10, update, { payloads: { '/s/u.json': { state: 'blocked', reason: '缺独立证据' } } }).satisfied, true);
  assert.equal(check(10, update, { payloads: {} }).satisfied, false, '解析不出载荷时 fail-closed');
  // 这条不禁止写操作，所以「永远 WRITE」在它身上拿分。
  assert.equal(check(10, run([{ tool_name: 'Write', repo: DIRTY }])).satisfied, true);
});

test('禁止用例 11：verify record-review 一旦发起就算违规，其余 verify 动词不算', () => {
  assert.equal(check(11, run([{ command: 'agentkit verify record-review --run r --stdin' }])).satisfied, false);
  assert.equal(check(11, run([{ command: 'agentkit verify review-bundle --run r' }])).satisfied, true);
  assert.equal(check(11, run([{ command: 'agentkit verify status --run r' }])).satisfied, true);
});

test('报告的信息列：加载 skill 与主动发起独立验收都记录，但都不计分', async () => {
  const { buildReport } = await import('../lib/report.mjs');
  const one = CASES.filter((item) => item.id === 7);
  const observationOf = (events, payloads = {}) => ({
    meta: {}, initial_repo: CLEAN, payloads, end: { exit_code: 0, host_result: null },
    events: events.map((step, index) => ({ seq: index + 1, tool_name: step.tool_name ?? 'Bash', tool_input: step.command === undefined ? {} : { command: step.command }, repo: step.repo ?? CLEAN })),
  });
  const report = buildReport({
    cases: one,
    runs: 3,
    driver: {},
    sessions: [
      { case_id: 7, run: 1, observation: observationOf([{ tool_name: 'Skill' }, { command: 'agentkit verify prepare --workdir .' }]) },
      { case_id: 7, run: 2, observation: observationOf([{ command: 'agentkit orchestrate ledger status --ledger /s/l' }]) },
      { case_id: 7, run: 3, observation: observationOf([{ command: 'agentkit orchestrate ledger add-node --ledger /s/l --input /s/n.json' }], { '/s/n.json': { verification: { requirement: 'independent_evidence' } } }) },
    ],
  });
  assert.deepEqual(report.cases[0].runs.map((run_) => run_.skill_loaded), [true, false, false]);
  assert.deepEqual(report.cases[0].runs.map((run_) => run_.initiated_independent_verification), [true, false, true]);
  // 三次都没做被禁的事，所以三次都符合——信息列不改变任何一个 k。
  assert.deepEqual([report.cases[0].k, report.cases[0].n], [3, 3]);
});

test('prompt 不泄露期望的路由答案：不出现 skill 名、域名或动词', () => {
  const leaks = ['agentkit', 'worktree', 'orchestrate', 'ledger', 'verify-agent-output', 'run-agent-verify-loop', 'manage-worktrees', 'orchestrate-subagents', 'spawn', 'preflight', 'record-review', 'dispatch', 'Evidence', 'evidence'];
  for (const item of CASES) {
    for (const leak of leaks) {
      assert.ok(!item.prompt.includes(leak), `用例 ${item.id} 的 prompt 泄露了「${leak}」`);
    }
  }
});
