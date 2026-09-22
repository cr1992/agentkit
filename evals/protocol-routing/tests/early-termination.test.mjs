// @ts-check
// 提前终止自测。全部离线：不起任何真实会话，只喂合成的 stream-json 文本与探针行。
//
// 要钉住的三件事（issue #15 的后续项 4）：
// 1. 只有**正向、且只看第一个观测量**的用例可以提前终止；禁止类与 whole_session 的正向类不行；
// 2. 判定用的是**同一个 assert**，喂给它一份截止到此刻的分类结果——提前终止因此改不了结论；
// 3. 被 harness 掐掉的会话是**有效数据点**，不能当成崩溃去重试。

import assert from 'node:assert/strict';
import test from 'node:test';
import { CASES } from '../cases.mjs';
import { canTerminateEarly, createToolUseScanner } from '../drivers/claude-headless.mjs';
import { classify } from '../lib/classifier.mjs';
import { classifyRunValidity } from '../lib/run-validity.mjs';

const caseById = (/** @type {number} */ id) => /** @type {any} */ (CASES.find((item) => item.id === id));

/** 一行 stream-json 的 assistant 事件，带一个 tool_use 块。 */
const useLine = (id, name, input) =>
  `${JSON.stringify({ type: 'assistant', message: { model: 'm', content: [{ type: 'tool_use', id, name, input }] } })}\n`;

test('哪些用例允许提前终止：正向且只看第一个观测量的那几条', () => {
  assert.deepEqual(
    CASES.filter(canTerminateEarly).map((item) => item.id),
    [1, 2, 3, 4, 6],
  );
  // 第 5 条是正向，但断言看整条会话：现在没出现不代表后面不会出现，不能提前收手。
  assert.equal(canTerminateEarly(caseById(5)), false);
  assert.equal(caseById(5).assert_scope, 'whole_session');
  // 禁止类一条都不行：违规可能发生在任何一个事件上，提前收手等于把失守洗掉。
  for (const item of CASES.filter((c) => c.category === 'forbidden')) {
    assert.equal(canTerminateEarly(item), false, `用例 ${item.id}`);
  }
});

test('增量扫描：按行吃 stream-json，半行留到下一个 chunk，只认 tool_use', () => {
  const scanner = createToolUseScanner();
  assert.equal(scanner.push('{"type":"system","subtype":"init","model":"m"}\n'), 0, 'system 事件不产生工具事件');
  assert.equal(scanner.push('not json\n'), 0);

  // 一个 tool_use 拆成两个 chunk 送进来：半行不能被当成一条完整记录丢掉。
  const line = useLine('t1', 'Bash', { command: 'agentkit worktree spawn x' });
  const cut = Math.floor(line.length / 2);
  assert.equal(scanner.push(line.slice(0, cut)), 0, '半行还不算数');
  assert.equal(scanner.push(line.slice(cut)), 1);
  assert.deepEqual(
    scanner.uses.map((use) => use.id),
    ['t1'],
  );

  // 一条 assistant 事件里两个并行 tool_use，按出现顺序都收下。
  const two = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 't2', name: 'Read', input: {} },
        { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
  assert.equal(scanner.push(`${two}\n`), 2);
  assert.deepEqual(
    scanner.uses.map((use) => use.id),
    ['t1', 't2', 't3'],
  );
  // 结尾没有换行的那一段不算数——等下一个 chunk 把它补全。
  assert.equal(scanner.push('{"type":"result","is_error":false}'), 0);
});

/**
 * 复刻驱动器里那段增量判定：喂若干 (stream 行, 探针行)，返回第一个让断言成立的事件号。
 * 用的是和最终判定同一个 `classify` + `assert`。
 */
function firstSatisfiedAt(evalCase, steps) {
  const scanner = createToolUseScanner();
  const probes = [];
  const initialRepo = { status: '', head: 'a'.repeat(40) };
  for (const step of steps) {
    scanner.push(
      useLine(step.id, step.tool_name ?? 'Bash', step.command === undefined ? {} : { command: step.command }),
    );
    probes.push({ tool_use_id: step.id, repo: step.repo ?? initialRepo, ledger: null });
    const events = scanner.uses.map((use, index) => {
      const probe = probes.find((item) => item.tool_use_id === use.id);
      return {
        seq: index + 1,
        tool_name: use.tool_name,
        tool_input: use.tool_input,
        repo: probe.repo,
        ledger: probe.ledger,
      };
    });
    const verdict = evalCase.assert(classify({ initial_repo: initialRepo, initial_ledger: null, events }), {});
    if (verdict.satisfied) return events.at(-1).seq;
  }
  return null;
}

test('正向断言一成立就能收手，而且收手前后的判定是同一个结论', () => {
  const dirty = { status: ' M src/sum.mjs', head: 'a'.repeat(40) };

  // 第 3 条：读一圈文档、扫一遍，第 4 个事件才路由到 worktree spawn——那一刻就能停。
  assert.equal(
    firstSatisfiedAt(caseById(3), [
      { id: 'a', command: 'agentkit docs worktree conflict-scan' },
      { id: 'b', command: 'agentkit worktree list --json' },
      { id: 'c', command: 'agentkit worktree scan --json' },
      { id: 'd', command: 'agentkit worktree spawn feature --agent claude-code' },
    ]),
    4,
  );

  // 第 1 条：第一个动作就是写，第 1 个事件即停。
  assert.equal(firstSatisfiedAt(caseById(1), [{ id: 'a', tool_name: 'Edit', repo: dirty }]), 1);

  // 路由去错地方时断言永远不成立，会话照常跑到自然结束——不拿「第一个观测量已定」当终止条件，
  // 省下来的只有「已经拿分」那一类。
  assert.equal(
    firstSatisfiedAt(caseById(3), [
      { id: 'a', tool_name: 'Edit', repo: dirty },
      { id: 'b', command: 'agentkit worktree spawn feature' },
    ]),
    null,
  );

  // 关键性质：提前终止改不了结论。截断到成立那一刻的事件流，与完整事件流，判定相同。
  const full = [
    { id: 'a', command: 'agentkit docs verify' },
    { id: 'b', command: 'agentkit verify prepare --workdir .' },
    { id: 'c', command: 'agentkit verify run-smoke --run /s/run' },
    { id: 'd', tool_name: 'Edit', repo: dirty },
  ];
  const at = firstSatisfiedAt(caseById(4), full);
  assert.equal(at, 2);
  const events = (steps) =>
    steps.map((step, index) => ({
      seq: index + 1,
      tool_name: step.tool_name ?? 'Bash',
      tool_input: step.command === undefined ? {} : { command: step.command },
      repo: step.repo ?? { status: '', head: 'a'.repeat(40) },
      ledger: null,
    }));
  const truncated = caseById(4).assert(
    classify({
      initial_repo: { status: '', head: 'a'.repeat(40) },
      initial_ledger: null,
      events: events(full.slice(0, at)),
    }),
    {},
  );
  const complete = caseById(4).assert(
    classify({ initial_repo: { status: '', head: 'a'.repeat(40) }, initial_ledger: null, events: events(full) }),
    {},
  );
  assert.deepEqual([truncated.satisfied, truncated.reason], [complete.satisfied, complete.reason]);
});

test('被 harness 掐掉的会话是有效数据点，不当崩溃重试', () => {
  // SIGTERM 掉的会话：拿不到 result 事件，退出码也不是 0。判据必须先看 early_terminated，
  // 否则每一次提前终止都会被重试一遍，省下的时间原样还回去。
  const early = classifyRunValidity({
    events: [{}, {}],
    end: {
      exit_code: null,
      host_result: null,
      early_terminated: { at_seq: 2, reason: '路由到 agentkit verify prepare' },
    },
  });
  assert.equal(early.valid, true);
  assert.match(early.reason, /第 2 个事件成立/u);

  // 非零退出也一样。
  assert.equal(
    classifyRunValidity({
      events: [{}],
      end: { exit_code: 143, host_result: null, early_terminated: { at_seq: 1, reason: 'x' } },
    }).valid,
    true,
  );

  // 没标 early_terminated 的照旧走故障判据，一个字都没松。
  assert.equal(classifyRunValidity({ events: [], end: { exit_code: 1, host_result: null } }).valid, false);
  assert.equal(
    classifyRunValidity({ events: [{}], end: { exit_code: 0, host_result: { is_error: true, subtype: 'success' } } })
      .valid,
    false,
  );
});
