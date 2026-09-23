import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  git,
  manager,
  managerKeep,
  makeRemoteRepo,
  recordFor,
  gitOk,
  managerStderr,
  prepareBatchInput,
  freezePlan,
} from '../../tests/helpers/worktree-mgr-fixture.mjs';

test('batch-integrate 按冻结顺序合成多分支，指纹与每步 merge commit 落账', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'compose-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'compose-beta', 'beta.txt', 'beta\n');
  const { plan, planPath } = freezePlan(fixture, ['compose-alpha', 'compose-beta']);

  const result = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'compose-integrator',
      '--json',
    ]),
  );
  assert.equal(result.outcome, 'composed');
  assert.equal(result.fingerprint, plan.fingerprint);
  assert.equal(result.steps.length, 2);
  assert.deepEqual(
    result.steps.map((step) => step.input_sha),
    plan.included.map((item) => item.head),
  );

  // 候选树确实带上了两个 feature 的内容，且 HEAD 等于落账的 composed_sha。
  const candidatePath = result.candidate.path;
  assert.equal(existsSync(join(candidatePath, 'alpha.txt')), true);
  assert.equal(existsSync(join(candidatePath, 'beta.txt')), true);
  assert.equal(git(candidatePath, ['rev-parse', 'HEAD']), result.composed_sha);
  for (const item of plan.included) {
    assert.equal(gitOk(candidatePath, ['merge-base', '--is-ancestor', item.head, 'HEAD']), true);
  }

  const record = recordFor(fixture, result.candidate.task);
  assert.equal(record.task_status, 'integrating');
  assert.equal(record.batch_integration.fingerprint, plan.fingerprint);
  assert.equal(record.batch_integration.target_sha, plan.target.sha);
  assert.equal(record.batch_integration.state, 'composed');
  assert.deepEqual(
    record.batch_integration.ordered_inputs.map((item) => item.head),
    plan.included.map((item) => item.head),
  );
  const audit = JSON.parse(manager(fixture.repo, ['audit', result.candidate.task, '--json']));
  assert.equal(
    audit.events.some((event) => event.event_type === 'batch_candidate_composed'),
    true,
  );

  // 幂等：同指纹重跑不再合成，直接返回既有候选。
  const again = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'compose-integrator',
      '--json',
    ]),
  );
  assert.equal(again.outcome, 'already_composed');
  assert.equal(again.composed_sha, result.composed_sha);
  assert.equal(again.candidate.worktree_id, result.candidate.worktree_id);
});

// 回归：拆分曾把 printPostIntegrateSteps 留在另一个模块的闭包里，所有非 --json 成功路径
// 在合成落账之后 ReferenceError；而全部 happy-path 用例都带 --json，掩盖了展示层缺陷。
test('batch-integrate 非 --json 成功与幂等路径完整回显，不依赖 --json 才能走通', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'plain-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'plain-beta', 'beta.txt', 'beta\n');
  const { planPath } = freezePlan(fixture, ['plain-alpha', 'plain-beta']);

  const output = manager(fixture.repo, [
    'batch-integrate',
    '--plan',
    planPath,
    '--agent',
    'codex',
    '--agent-id',
    'plain-integrator',
  ]);
  assert.match(output, /批次合成完成/);
  assert.match(output, /下一步由 controller 执行门禁/);

  const again = manager(fixture.repo, [
    'batch-integrate',
    '--plan',
    planPath,
    '--agent',
    'codex',
    '--agent-id',
    'plain-integrator',
  ]);
  assert.match(again, /同指纹候选已合成，幂等返回/);
});

test('batch-integrate 拒绝已漂移的冻结计划，并要求重新 plan-batch', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'drift-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'drift-beta', 'beta.txt', 'beta\n');
  const { planPath } = freezePlan(fixture, ['drift-alpha', 'drift-beta']);

  // target 前进 → 冻结计划失效。
  writeFileSync(join(fixture.repo, 'target.txt'), 'moved\n');
  git(fixture.repo, ['add', 'target.txt']);
  git(fixture.repo, ['commit', '-m', 'chore: move target']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  git(fixture.repo, ['fetch', 'origin', 'main']);

  const stderr = managerStderr(fixture.repo, [
    'batch-integrate',
    '--plan',
    planPath,
    '--agent',
    'codex',
    '--agent-id',
    'drift-integrator',
  ]);
  assert.match(stderr, /BATCH_PLAN_STALE/);
  assert.match(stderr, /target SHA/);
  assert.match(stderr, /重新执行 plan-batch/);
  // fail-closed：不得留下任何已合成候选。
  const listing = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  const allRecords = [...listing.worktrees.map((row) => row.record).filter(Boolean), ...listing.records];
  assert.equal(
    allRecords.some((record) => record.batch_integration),
    false,
  );
});

test('batch-integrate 冲突时 fail-closed：停在冲突处、输出结构化报告、不自动解也不自动 abort', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  // 两个 feature 改同一文件同一行 → 合成必冲突。
  prepareBatchInput(fixture, 'conflict-alpha', 'shared.txt', 'alpha side\n');
  prepareBatchInput(fixture, 'conflict-beta', 'shared.txt', 'beta side\n');
  const { plan, planPath } = freezePlan(fixture, ['conflict-alpha', 'conflict-beta']);

  const stdout = managerKeep(fixture.repo, [
    'batch-integrate',
    '--plan',
    planPath,
    '--agent',
    'codex',
    '--agent-id',
    'conflict-integrator',
    '--json',
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.conflict.files.includes('shared.txt'), true);
  assert.equal(result.conflict.input_sha, plan.included[1].head);
  assert.equal(result.conflict.aborted, false);
  assert.equal(typeof result.conflict.candidate_path, 'string');
  assert.equal(result.composed_sha, null);

  // 不自动 abort：候选树仍停在冲突态，留给 controller 裁决。
  assert.equal(existsSync(join(result.conflict.candidate_path, '.git')), true);
  const status = git(result.conflict.candidate_path, ['status', '--porcelain']);
  assert.match(status, /^(UU|AA) /m);
  const record = recordFor(fixture, result.candidate.task);
  assert.equal(record.batch_integration.state, 'conflict');
  assert.notEqual(record.task_status, 'integrating');
  const audit = JSON.parse(manager(fixture.repo, ['audit', result.candidate.task, '--json']));
  assert.equal(
    audit.events.some((event) => event.event_type === 'batch_candidate_conflict'),
    true,
  );
});

test('batch-integrate --abort-on-conflict 一键回滚到干净 target', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'abort-alpha', 'shared.txt', 'alpha side\n');
  prepareBatchInput(fixture, 'abort-beta', 'shared.txt', 'beta side\n');
  const { plan, planPath } = freezePlan(fixture, ['abort-alpha', 'abort-beta']);

  const result = JSON.parse(
    managerKeep(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--abort-on-conflict',
      '--agent',
      'codex',
      '--agent-id',
      'abort-integrator',
      '--json',
    ]),
  );
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.conflict.aborted, true);
  const candidatePath = result.conflict.candidate_path;
  assert.equal(git(candidatePath, ['rev-parse', 'HEAD']), plan.target.sha);
  assert.equal(git(candidatePath, ['status', '--porcelain']), '');
});

test('rerere 让第二轮候选自动重放上一轮已录的冲突解法', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'rerere-alpha', 'shared.txt', 'alpha side\n');
  prepareBatchInput(fixture, 'rerere-beta', 'shared.txt', 'beta side\n');
  const { plan, planPath } = freezePlan(fixture, ['rerere-alpha', 'rerere-beta']);

  const first = JSON.parse(
    managerKeep(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'rerere-integrator',
      '--json',
    ]),
  );
  assert.equal(first.outcome, 'conflict');
  assert.equal(first.rerere.enabled, true, 'rerere 必须在候选树启用，否则解法无法被录下');
  const candidatePath = first.conflict.candidate_path;

  // controller 手工裁决并提交这次 merge —— rerere 在此录下解法。
  writeFileSync(join(candidatePath, 'shared.txt'), 'alpha side\nbeta side\n');
  git(candidatePath, ['add', 'shared.txt']);
  git(candidatePath, ['commit', '--no-edit']);

  // 第二轮：重置到 target 重新合成，同一冲突应被 rerere 自动重放，无需再次手解。
  const second = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'rerere-integrator',
      '--json',
    ]),
  );
  assert.equal(second.outcome, 'composed', '第二轮应由 rerere 自动解出，不再冲突');
  assert.equal(
    second.steps.some((step) => step.rerere_replayed),
    true,
  );
  assert.equal(
    readFileSync(join(second.candidate.path, 'shared.txt'), 'utf8'),
    'alpha side\nbeta side\n',
    '重放出来的必须是上一轮录下的那个解法',
  );
  // rerere 缓存位于共享 common dir，因此跨候选树可复用。
  assert.equal(existsSync(join(fixture.repo, '.git', 'rr-cache')), true);
  assert.equal(gitOk(fixture.repo, ['config', '--get', 'rerere.enabled']), false, 'rerere 不得泄漏到主工作树');
  assert.equal(plan.included.length, 2);
});

test('批次输入变化时新指纹另起候选，并双向登记替代关系', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'supersede-alpha', 'alpha.txt', 'alpha\n');
  const betaTree = prepareBatchInput(fixture, 'supersede-beta', 'beta.txt', 'beta\n');
  const first = freezePlan(fixture, ['supersede-alpha', 'supersede-beta']);
  const round1 = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      first.planPath,
      '--agent',
      'codex',
      '--agent-id',
      'supersede-integrator',
      '--json',
    ]),
  );
  assert.equal(round1.outcome, 'composed');

  // 输入前进 → 新指纹。
  writeFileSync(join(betaTree, 'beta.txt'), 'beta v2\n');
  git(betaTree, ['add', 'beta.txt']);
  git(betaTree, ['commit', '-m', 'feat: beta v2']);
  git(betaTree, ['push', 'origin', 'HEAD']);
  // 推进输入后必须刷新 trace last_head，否则 plan-batch 会按 HEAD_DRIFT 拒绝——这正是它该做的。
  manager(fixture.repo, ['touch', 'supersede-beta', '--status', 'ready_for_review', '--no-watch']);
  const second = freezePlan(fixture, ['supersede-alpha', 'supersede-beta']);
  assert.notEqual(second.plan.fingerprint, first.plan.fingerprint);

  // 沿用同一 candidate task 会被拒绝：一次性候选不复用交付身份。
  const refused = managerStderr(fixture.repo, [
    'batch-integrate',
    '--plan',
    second.planPath,
    '--agent',
    'codex',
    '--agent-id',
    'supersede-integrator',
  ]);
  assert.match(refused, /--candidate-task/);

  const round2 = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      second.planPath,
      '--candidate-task',
      'batch-integration-second-candidate',
      '--agent',
      'codex',
      '--agent-id',
      'supersede-integrator',
      '--json',
    ]),
  );
  assert.equal(round2.outcome, 'composed');
  assert.notEqual(round2.candidate.worktree_id, round1.candidate.worktree_id);

  const oldRecord = recordFor(fixture, round1.candidate.task, true);
  const newRecord = recordFor(fixture, round2.candidate.task);
  assert.equal(oldRecord.task_status, 'abandoned');
  assert.equal(oldRecord.superseded_by.worktree_id, newRecord.worktree_id);
  assert.equal(newRecord.delivery_relation.kind, 'supersedes');
  assert.equal(newRecord.delivery_relation.superseded_worktree_id, oldRecord.worktree_id);
});
