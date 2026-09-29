import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  git,
  manager,
  managerResult,
  makeRemoteRepo,
  recordFor,
  contentSha,
  recordFilePath,
  prepareBatchInput,
  freezePlan,
  batchEvidence,
} from '../../tests/helpers/worktree-mgr-fixture.mjs';

// batch-result / batch-integrate 的破坏性守卫：这些分支防的是「把错误结果冻结成终态」和
// 「未经精确授权就 reset --hard 候选树」。拒绝用例统一断言退出码、专属文案，以及候选 record
// 字节不变 / batch_result 未被写入 / 候选目录状态未变。全部经公开 CLI 触发。

/** 合成一个 present、integrating 状态的一次性集成候选，供多条不改状态的 batch-result 守卫共享。 */
function composeCandidate(fixture, prefix) {
  prepareBatchInput(fixture, `${prefix}-alpha`, 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, `${prefix}-beta`, 'beta.txt', 'beta\n');
  const { plan, planPath } = freezePlan(fixture, [`${prefix}-alpha`, `${prefix}-beta`]);
  const composed = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      `${prefix}-integrator`,
      '--json',
    ]),
  );
  assert.equal(composed.outcome, 'composed');
  return { composed, plan, planPath };
}

test('batch-result 的输入/证据守卫在冻结前拒绝，且不写 batch_result', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  const { composed } = composeCandidate(fixture, 'br');
  const task = composed.candidate.task;
  const sha = composed.composed_sha;
  const targetSha = git(fixture.repo, ['rev-parse', 'origin/main']);
  const passedEvidence = batchEvidence(fixture, 'br-passed', 'passed');
  const failedEvidence = batchEvidence(fixture, 'br-failed', 'failed');
  const recordPath = recordFilePath(fixture, composed.candidate.worktree_id);
  const before = contentSha(recordPath);

  const cases = [
    {
      name: '非法 --state',
      argv: ['batch-result', task, '--state', 'maybe', '--candidate', sha, '--evidence', passedEvidence],
      message: /--state 只接受 passed \/ failed \/ stale/,
    },
    {
      name: '缺 --candidate',
      argv: ['batch-result', task, '--state', 'passed', '--evidence', passedEvidence],
      message: /batch-result 需要 --candidate/,
    },
    {
      name: 'passed 缺 --evidence',
      argv: ['batch-result', task, '--state', 'passed', '--candidate', sha],
      message: /passed 结果需要 --evidence/,
    },
    {
      name: 'stale 缺 --reason',
      argv: ['batch-result', task, '--state', 'stale', '--candidate', sha],
      message: /stale 结果需要 --reason/,
    },
    {
      name: 'passed 但证据含非 passed check',
      argv: ['batch-result', task, '--state', 'passed', '--candidate', sha, '--evidence', failedEvidence],
      message: /passed 结果要求所有 evidence checks 都为 passed/,
    },
    {
      name: 'failed 但证据无 failed check',
      argv: ['batch-result', task, '--state', 'failed', '--candidate', sha, '--evidence', passedEvidence],
      message: /failed 结果至少需要一个 failed evidence check/,
    },
    {
      name: '--candidate 与 live HEAD 不一致',
      argv: ['batch-result', task, '--state', 'passed', '--candidate', targetSha, '--evidence', passedEvidence],
      message: /--candidate 与 live HEAD 不一致/,
    },
  ];
  for (const testCase of cases) {
    const result = managerResult(fixture.repo, testCase.argv);
    assert.equal(result.status, 2, `${testCase.name} 退出码；stderr=${result.stderr}`);
    assert.match(result.stderr, testCase.message, testCase.name);
    assert.equal(contentSha(recordPath), before, `${testCase.name}: 候选 record 字节应不变`);
    assert.equal(recordFor(fixture, task).batch_result, undefined, `${testCase.name}: 不得写入 batch_result`);
  }
  assert.equal(recordFor(fixture, task).task_status, 'integrating');
});

test('batch-result 拒绝脏候选，不冻结结果也不动候选树', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  const { composed } = composeCandidate(fixture, 'brd');
  const evidence = batchEvidence(fixture, 'brd-passed', 'passed');
  writeFileSync(join(composed.candidate.path, 'uncommitted.txt'), 'wip\n');
  const recordPath = recordFilePath(fixture, composed.candidate.worktree_id);
  const before = contentSha(recordPath);
  const result = managerResult(fixture.repo, [
    'batch-result',
    composed.candidate.task,
    '--state',
    'passed',
    '--candidate',
    composed.composed_sha,
    '--evidence',
    evidence,
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /候选 worktree 必须干净/);
  assert.equal(contentSha(recordPath), before, '候选 record 字节应不变');
  assert.equal(recordFor(fixture, composed.candidate.task).batch_result, undefined);
  assert.equal(existsSync(join(composed.candidate.path, 'uncommitted.txt')), true, '不得清理候选树改动');
});

test('batch-result 在候选 worktree 缺失时拒绝，不冻结结果', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  const { composed } = composeCandidate(fixture, 'brm');
  const evidence = batchEvidence(fixture, 'brm-passed', 'passed');
  git(fixture.repo, ['worktree', 'remove', '--force', composed.candidate.path]);
  assert.equal(existsSync(composed.candidate.path), false, '前置：候选目录已移除');
  const recordPath = recordFilePath(fixture, composed.candidate.worktree_id);
  const before = contentSha(recordPath);
  const result = managerResult(fixture.repo, [
    'batch-result',
    composed.candidate.task,
    '--state',
    'passed',
    '--candidate',
    composed.composed_sha,
    '--evidence',
    evidence,
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /候选 worktree missing/);
  assert.equal(contentSha(recordPath), before, '候选 record 字节应不变');
  assert.equal(recordFor(fixture, composed.candidate.task, true).batch_result, undefined);
});

test('batch-result 拒绝非集成候选，不写 batch_result', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  const tree = prepareBatchInput(fixture, 'plain-candidate', 'feature.txt', 'feature\n');
  const evidence = batchEvidence(fixture, 'plain-passed', 'passed');
  const head = git(tree, ['rev-parse', 'HEAD']);
  const record = recordFor(fixture, 'plain-candidate');
  const recordPath = recordFilePath(fixture, record.worktree_id);
  const before = contentSha(recordPath);
  const result = managerResult(fixture.repo, [
    'batch-result',
    'plain-candidate',
    '--state',
    'passed',
    '--candidate',
    head,
    '--evidence',
    evidence,
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /不是已合成的集成候选/);
  assert.equal(contentSha(recordPath), before, 'record 字节应不变');
  assert.equal(recordFor(fixture, 'plain-candidate').batch_result, undefined);
});

test('batch-integrate --recompose 缺精确 HEAD 授权时拒绝，不新建候选', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'rc-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'rc-beta', 'beta.txt', 'beta\n');
  const { planPath } = freezePlan(fixture, ['rc-alpha', 'rc-beta']);
  const result = managerResult(fixture.repo, [
    'batch-integrate',
    '--plan',
    planPath,
    '--recompose',
    '--agent',
    'codex',
    '--agent-id',
    'rc-integrator',
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--recompose 是破坏性操作，必须同时提供 --recompose-head/);
  const listing = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  const all = [...listing.worktrees.map((row) => row.record).filter(Boolean), ...listing.records];
  assert.equal(all.some((record) => record.batch_integration), false, 'fail-closed：不得留下任何候选');
});

test('batch-integrate --recompose-head 脱离 --recompose 时拒绝', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'rch-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'rch-beta', 'beta.txt', 'beta\n');
  const { planPath } = freezePlan(fixture, ['rch-alpha', 'rch-beta']);
  const head = git(fixture.repo, ['rev-parse', 'origin/main']);
  const result = managerResult(fixture.repo, [
    'batch-integrate',
    '--plan',
    planPath,
    '--recompose-head',
    head,
    '--agent',
    'codex',
    '--agent-id',
    'rch-integrator',
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--recompose-head 只能与 --recompose 一起使用/);
});

test('batch-integrate 拒绝 --plan 与位置 selector 并用', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'mx-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'mx-beta', 'beta.txt', 'beta\n');
  const { planPath } = freezePlan(fixture, ['mx-alpha', 'mx-beta']);
  const result = managerResult(fixture.repo, [
    'batch-integrate',
    'mx-alpha',
    '--plan',
    planPath,
    '--agent',
    'codex',
    '--agent-id',
    'mx-integrator',
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--plan 与 selector 位置参数互斥/);
});

test('batch-integrate 即时规划少于两个 selector 时拒绝', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'solo-feature', 'feature.txt', 'feature\n');
  const result = managerResult(fixture.repo, [
    'batch-integrate',
    'solo-feature',
    '--agent',
    'codex',
    '--agent-id',
    'solo-integrator',
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /batch-integrate 需要 --plan <plan\.json>，或至少两个 feature selector/);
});
