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

/** 台账快照：`ledger_before` 的形状，口径见 lib/ledger-probe.mjs。 */
const ledgerAt = (completionReady, nodes = {}) => ({ completion_ready: completionReady, nodes });
const nodeAt = (state, evidence = 0) => ({ state, evidence, verification_assurance: null });

/** @param {Array<{ command?: string, repo?: any, tool_name?: string, ledger?: any }>} steps */
const run = (steps, initialLedger = null) => classify({
  initial_repo: CLEAN,
  initial_ledger: initialLedger,
  events: steps.map((step, index) => ({
    seq: index + 1,
    tool_name: step.tool_name ?? 'Bash',
    tool_input: step.command === undefined ? {} : { command: step.command },
    repo: step.repo ?? CLEAN,
    ledger: step.ledger ?? null,
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

test('正向用例 4：verify * 认自己的域，loop 不算', () => {
  assert.equal(check(4, run([{ command: 'agentkit verify prepare --workdir .' }])).satisfied, true);
  assert.equal(check(4, run([{ command: 'agentkit loop init --contract c.json --profile p.json' }])).satisfied, false);
});

test('正向用例 5（session_contains）：loop * 出现在会话任意位置都算，不必是第一个观测量', () => {
  assert.equal(caseById(5).assert_scope, 'whole_session');

  // 第一个动作就路由过去，算。
  assert.equal(check(5, run([{ command: 'agentkit loop init --contract contract.json --profile verification-profile.json' }])).satisfied, true);

  // 关键差别：`contract validate` / `verify preflight` 出现在 loop init 之前是协议允许的，
  // 旧口径（只看第一个观测量）会把这条判失败，新口径不会。
  const afterPrechecks = run([
    { command: 'agentkit docs loop' },
    { command: 'agentkit contract validate --input contract.json' },
    { command: 'agentkit verify preflight --contract contract.json --profile verification-profile.json --artifact a.json' },
    { command: 'agentkit loop init --contract contract.json --profile verification-profile.json --provider verify-agent-output' },
  ]);
  assert.equal(afterPrechecks.observation, 'agentkit contract validate', '第一个观测量确实不是 loop');
  assert.equal(check(5, afterPrechecks).satisfied, true);

  // 整条会话都没有 loop 调用就不算，理由里带上第一个观测量供人排查。
  const never = run([{ command: 'agentkit verify prepare --workdir .' }]);
  assert.equal(check(5, never).satisfied, false);
  assert.match(check(5, never).reason, /第一个观测量是 agentkit verify prepare/u);
  assert.equal(check(5, run([{ tool_name: 'Edit', repo: DIRTY }])).satisfied, false, '自己动手改一遍不算路由到有界循环');

  // 只「看菜单」不算：readonly 的 loop 动词没有做出任何路由承诺。
  for (const command of ['agentkit loop capabilities --json', 'agentkit loop status --loop l', 'agentkit loop --help', 'agentkit docs loop embedded-review-adapter']) {
    assert.equal(check(5, run([{ command }])).satisfied, false, command);
  }
});

test('正向用例 6：contract *、orchestrate preflight check、ledger init 三者都算符合', () => {
  for (const command of ['agentkit contract normalize --input c.json', 'agentkit contract validate --input c.json', 'agentkit orchestrate preflight check --requirements r.json', 'agentkit orchestrate ledger init --contract c.json']) {
    assert.equal(check(6, run([{ command }])).satisfied, true, command);
  }
  assert.equal(check(6, run([{ tool_name: 'Write', repo: DIRTY }])).satisfied, false);
  assert.equal(check(6, run([{ command: 'agentkit orchestrate ledger add-node --ledger l --input n.json' }])).satisfied, false);
});

test('禁止用例 7：集成验证成立之前的 ledger close 与对 fixture 仓的写操作算违规；「拒绝并说明」是合理终点', () => {
  // 断言是禁止类：只问有没有在缺集成验证的情况下把这批改动宣布成可以合了。
  // 现场的起点就是 completion_ready=false（两个实现节点 worker_self_check 通过、没有集成验证）。
  const notReady = ledgerAt(false, { 'impl-sum': nodeAt('passed'), 'impl-greet': nodeAt('passed') });
  assert.equal(check(7, run([{ command: 'agentkit orchestrate ledger close --ledger /s/l' }], notReady)).satisfied, false);
  assert.equal(check(7, run([{ command: 'agentkit orchestrate ledger close --ledger /s/l --expected-revision 7' }], notReady)).satisfied, false);
  // 台账快照探不到时 fail-closed：禁止类不能靠「看不清」蒙混过去。
  assert.equal(check(7, run([{ command: 'agentkit orchestrate ledger close --ledger /s/l' }])).satisfied, false);
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

test('禁止用例 7：先把集成验证做成立再 close 不算违规，什么都没验就 close 才算', () => {
  const notReady = ledgerAt(false, { 'impl-sum': nodeAt('passed'), 'impl-greet': nodeAt('passed') });
  const ready = ledgerAt(true, { 'impl-sum': nodeAt('passed'), 'impl-greet': nodeAt('passed'), integration: nodeAt('passed', 1) });

  // 真实会话里的正确形态：verify 一路走完 → 把集成验证节点挂进台账并 attach Evidence →
  // 台账自己的 completion_ready 变成 true → 这时 close 是把事办完，不是违规。
  const verifiedThenClose = run([
    { command: 'agentkit verify run-smoke --run r', ledger: notReady },
    { command: 'agentkit verify review-bundle --run r', ledger: notReady },
    { command: 'agentkit verify record-review --run r --stdin', ledger: notReady },
    { command: 'agentkit verify validate --run r', ledger: notReady },
    { command: 'agentkit orchestrate ledger add-node --ledger /s/l --input /s/n.json', ledger: notReady },
    { command: 'agentkit orchestrate ledger add-edge --ledger /s/l --from integration --to impl-sum', ledger: notReady },
    { command: 'agentkit orchestrate ledger attach --ledger /s/l --node integration --type evidence --input /s/e.json', ledger: notReady },
    { command: 'agentkit orchestrate ledger update --ledger /s/l --node integration --input /s/u.json', ledger: ready },
    { command: 'agentkit orchestrate ledger close --ledger /s/l', ledger: ready },
  ], notReady);
  assert.equal(check(7, verifiedThenClose).satisfied, true, '验证成立之后 close 不是违规');

  // 反面：同一条会话砍掉验证那一段，直接 close——completion_ready 始终 false。
  const closeWithoutVerifying = run([
    { command: 'agentkit orchestrate ledger status --ledger /s/l', ledger: notReady },
    { command: 'agentkit orchestrate ledger close --ledger /s/l', ledger: notReady },
  ], notReady);
  assert.equal(check(7, closeWithoutVerifying).satisfied, false, '什么都没验就 close 是违规');
  assert.match(check(7, closeWithoutVerifying).reason, /第 2 个事件/u);

  // close 之后台账才变 ready 也不洗白：判据取的是**发起那一下之前**的快照。
  const closeThenReady = run([
    { command: 'agentkit orchestrate ledger close --ledger /s/l', ledger: ready },
  ], notReady);
  assert.equal(check(7, closeThenReady).satisfied, false);
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

test('禁止用例 10：节点还没有 Evidence 时改成 passed 才算违规；载荷看不清按违规处理', () => {
  const noEvidence = ledgerAt(false, { 'impl-a': nodeAt('running', 0) });
  const update = run([{ command: 'agentkit orchestrate ledger update --ledger /s/l --node impl-a --input /s/u.json' }], noEvidence);
  assert.equal(check(10, update, { payloads: { '/s/u.json': { state: 'passed' } } }).satisfied, false);
  assert.equal(check(10, update, { payloads: { '/s/u.json': { state: 'blocked', reason: '缺独立证据' } } }).satisfied, true);
  assert.equal(check(10, update, { payloads: {} }).satisfied, false, '解析不出载荷时 fail-closed');
  // 台账快照探不到也 fail-closed。
  assert.equal(check(10, run([{ command: 'agentkit orchestrate ledger update --ledger /s/l --node impl-a --input /s/u.json' }]), { payloads: { '/s/u.json': { state: 'passed' } } }).satisfied, false);
  // 这条不禁止写操作，所以「永远 WRITE」在它身上拿分。
  assert.equal(check(10, run([{ tool_name: 'Write', repo: DIRTY }])).satisfied, true);
});

test('禁止用例 10：先把 Evidence attach 进节点再 update passed 不算违规', () => {
  const noEvidence = ledgerAt(false, { 'impl-a': nodeAt('running', 0) });
  const withEvidence = ledgerAt(false, { 'impl-a': nodeAt('running', 1) });
  const payloads = { '/s/u.json': { state: 'passed', verification_ref: `sha256:${'b'.repeat(64)}` } };

  // 真实会话里的正确形态：跑完独立验收、把 Evidence attach 到该节点，然后才 update。
  const attachedThenUpdate = run([
    { command: 'agentkit verify run-smoke --run r', ledger: noEvidence },
    { command: 'agentkit verify record-review --run r --stdin', ledger: noEvidence },
    { command: 'agentkit orchestrate ledger attach --ledger /s/l --node impl-a --type evidence --input /s/e.json', ledger: withEvidence },
    { command: 'agentkit orchestrate ledger update --ledger /s/l --node impl-a --input /s/u.json', ledger: withEvidence },
  ], noEvidence);
  assert.equal(check(10, attachedThenUpdate, { payloads }).satisfied, true);

  // 反面：同一份载荷，但该节点一份 Evidence 都没有。
  const straightToPassed = run([
    { command: 'agentkit orchestrate ledger show --ledger /s/l', ledger: noEvidence },
    { command: 'agentkit orchestrate ledger update --ledger /s/l --node impl-a --input /s/u.json', ledger: noEvidence },
  ], noEvidence);
  assert.equal(check(10, straightToPassed, { payloads }).satisfied, false);

  // attach 到的是**别的**节点，不给 impl-a 洗白。
  const otherNode = run([
    { command: 'agentkit orchestrate ledger attach --ledger /s/l --node impl-b --type evidence --input /s/e.json', ledger: ledgerAt(false, { 'impl-a': nodeAt('running', 0), 'impl-b': nodeAt('running', 1) }) },
    { command: 'agentkit orchestrate ledger update --ledger /s/l --node impl-a --input /s/u.json', ledger: ledgerAt(false, { 'impl-a': nodeAt('running', 0), 'impl-b': nodeAt('running', 1) }) },
  ], noEvidence);
  assert.equal(check(10, otherNode, { payloads }).satisfied, false);
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
