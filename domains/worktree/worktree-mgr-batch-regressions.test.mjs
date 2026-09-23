import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  git,
  manager,
  managerKeep,
  makeRemoteRepo,
  publishProfile,
  recordFor,
  worktreeFor,
  managerStderr,
  prepareBatchInput,
  freezePlan,
} from '../../tests/helpers/worktree-mgr-fixture.mjs';

test('[P1-1] 被折叠的输入随后前进时，冻结计划必须判定为 stale 而不是静默漏合成', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  // 父 → 子链：plan-batch 会折叠父分支，included 只留子分支。
  manager(fixture.repo, [
    'spawn',
    'fold-parent',
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'fold-parent-thread',
    '--purpose',
    '父输入',
  ]);
  const parent = worktreeFor(fixture, 'fold-parent');
  writeFileSync(join(parent, 'parent.txt'), 'p1\n');
  git(parent, ['add', 'parent.txt']);
  git(parent, ['commit', '-m', 'feat: parent v1']);
  git(parent, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'fold-parent', '--status', 'ready_for_review', '--no-watch']);

  manager(fixture.repo, [
    'spawn',
    'fold-child',
    '--base',
    'origin/codex/fold-parent',
    '--base-reason',
    '依赖父输入',
    '--agent',
    'codex',
    '--agent-id',
    'fold-child-thread',
    '--purpose',
    '子输入',
  ]);
  const child = worktreeFor(fixture, 'fold-child');
  writeFileSync(join(child, 'child.txt'), 'c1\n');
  git(child, ['add', 'child.txt']);
  git(child, ['commit', '-m', 'feat: child v1']);
  git(child, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'fold-child', '--status', 'ready_for_review', '--no-watch']);

  const { plan, planPath } = freezePlan(fixture, ['fold-parent', 'fold-child']);
  assert.equal(plan.included.length, 1, '父分支应被折叠');
  assert.equal(plan.included[0].task, 'fold-child');
  assert.deepEqual(plan.requested_selectors, ['fold-parent', 'fold-child'], '计划必须留存原始 selector 全集');
  assert.equal(plan.excluded[0].task, 'fold-parent');

  // 父分支随后前进：它不再被子分支包含，合成边界已经变了。
  writeFileSync(join(parent, 'parent.txt'), 'p2\n');
  git(parent, ['add', 'parent.txt']);
  git(parent, ['commit', '-m', 'feat: parent v2']);
  git(parent, ['push', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'fold-parent', '--status', 'ready_for_review', '--no-watch']);

  const stderr = managerStderr(fixture.repo, [
    'batch-integrate',
    '--plan',
    planPath,
    '--agent',
    'codex',
    '--agent-id',
    'fold-integrator',
  ]);
  assert.match(stderr, /BATCH_PLAN_STALE/);
  assert.match(stderr, /重新执行 plan-batch/);
  // 关键：不得留下任何按旧计划合成出来的候选。
  const listing = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  const allRecords = [...listing.worktrees.map((row) => row.record).filter(Boolean), ...listing.records];
  assert.equal(
    allRecords.some((record) => record.batch_integration),
    false,
  );
});

test('[P1-2] 冻结 head 过期且无法重冻结时解除旧 watcher，不让它用过期证据推进终态', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'stale-freeze-review';
  t.after(() => {
    try {
      manager(fixture.repo, ['unwatch', task]);
    } catch {}
    fixture.cleanup();
  });
  writeFileSync(
    join(fixture.repo, '.worktree-trace.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        default_base: 'origin/main',
      },
      null,
      2,
    )}\n`,
  );
  publishProfile(fixture);

  manager(fixture.repo, [
    'spawn',
    task,
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'stale-freeze-thread',
    '--purpose',
    '过期冻结',
  ]);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, 'f.txt'), 'v1\n');
  git(worktree, ['add', 'f.txt']);
  git(worktree, ['commit', '-m', 'feat: v1']);
  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  const firstHead = git(worktree, ['rev-parse', 'HEAD']);
  assert.match(manager(fixture.repo, ['touch', task, '--status', 'ready_for_review']), /watch 已武装/);
  assert.equal(recordFor(fixture, task).auto_reclaim.head_sha, firstHead);

  // HEAD 前进但**未推送** → 无法重冻结。旧 watcher 仍盯 firstHead，若放任不管，
  // firstHead 合入会把任务推进到不可逆 done，而新 HEAD 未合入导致 reclaim 永久阻塞。
  writeFileSync(join(worktree, 'f.txt'), 'v2\n');
  git(worktree, ['add', 'f.txt']);
  git(worktree, ['commit', '-m', 'feat: v2 not pushed']);
  const secondHead = git(worktree, ['rev-parse', 'HEAD']);
  assert.notEqual(secondHead, firstHead);

  const auditBefore = JSON.parse(manager(fixture.repo, ['audit', task, '--json']));
  const output = manager(fixture.repo, ['touch', task, '--status', 'ready_for_review']);
  assert.match(output, /watch 已解除/);
  assert.match(output, /自动回收保持关闭/);
  const record = recordFor(fixture, task);
  assert.equal(record.auto_reclaim.state, 'disarmed');
  assert.equal(record.auto_reclaim.disarm_reason, 'stale_frozen_head');
  assert.equal(record.review_watch.state, 'pending');
  const audit = JSON.parse(manager(fixture.repo, ['audit', task, '--json']));
  assert.equal(audit.events.length, auditBefore.events.length + 2, '原子 disarm 后应另记一条可恢复 pending intent');
  assert.deepEqual(
    audit.events.slice(-2).map((event) => event.event_type),
    ['auto_reclaim_disarmed', 'review_watch_pending'],
  );
  const disarm = audit.events.filter((event) => event.event_type === 'auto_reclaim_disarmed').at(-1);
  assert.equal(disarm.details.source, 'auto_touch_head_drift');
  assert.equal(disarm.details.stale_head_sha, firstHead);
  assert.equal(disarm.details.live_head, secondHead);

  // 推送后重新 touch：恢复武装并冻结到新 HEAD。
  git(worktree, ['push', 'origin', 'HEAD']);
  assert.match(manager(fixture.repo, ['touch', task, '--status', 'ready_for_review']), /watch 已重新武装/);
  assert.equal(recordFor(fixture, task).auto_reclaim.head_sha, secondHead);
});

test('[P1-3] 合成后再生成步骤的提交不得被同指纹重跑抹掉；--recompose 才允许丢弃', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  writeFileSync(
    join(fixture.repo, '.worktree-trace.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        default_base: 'origin/main',
        post_integrate_steps: [{ name: 'regenerate-golden', hint: '重烤 golden 后提交' }],
      },
      null,
      2,
    )}\n`,
  );
  publishProfile(fixture);
  prepareBatchInput(fixture, 'postgen-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'postgen-beta', 'beta.txt', 'beta\n');
  const { planPath } = freezePlan(fixture, ['postgen-alpha', 'postgen-beta']);

  const first = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'postgen-integrator',
      '--json',
    ]),
  );
  assert.equal(first.outcome, 'composed');
  const candidatePath = first.candidate.path;

  // controller 执行声明的合成后步骤并提交 —— 候选 HEAD 从此不等于 composed_sha。
  writeFileSync(join(candidatePath, 'golden.txt'), 'regenerated\n');
  git(candidatePath, ['add', 'golden.txt']);
  git(candidatePath, ['commit', '-m', 'chore: regenerate golden']);
  const afterGolden = git(candidatePath, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['batch-step', first.candidate.task, '--step', 'regenerate-golden', '--state', 'done']);

  const second = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'postgen-integrator',
      '--json',
    ]),
  );
  assert.equal(second.outcome, 'already_composed');
  assert.equal(second.advanced_beyond_composition, true);
  assert.equal(second.composed_sha, first.composed_sha);
  assert.equal(second.head_sha, afterGolden);
  assert.equal(git(candidatePath, ['rev-parse', 'HEAD']), afterGolden, '生成提交不得被重置抹掉');
  assert.equal(existsSync(join(candidatePath, 'golden.txt')), true);
  assert.equal(
    second.post_integrate_steps.find((step) => step.name === 'regenerate-golden').state,
    'done',
    '已登记的步骤状态不得被重置回 pending',
  );

  // --recompose 还必须绑定候选当前完整 HEAD；缺失或陈旧授权都不得动树。
  assert.match(
    managerStderr(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--recompose',
      '--agent',
      'codex',
      '--agent-id',
      'postgen-integrator',
      '--json',
    ]),
    /必须同时提供 --recompose-head/,
  );
  assert.match(
    managerStderr(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--recompose',
      '--recompose-head',
      first.composed_sha,
      '--agent',
      'codex',
      '--agent-id',
      'postgen-integrator',
      '--json',
    ]),
    /RECOMPOSE_HEAD_STALE/,
  );
  assert.equal(git(candidatePath, ['rev-parse', 'HEAD']), afterGolden);
  assert.equal(existsSync(join(candidatePath, 'golden.txt')), true);

  // 完整 HEAD 明示授权后，才回到冻结 target 重新合成。
  const recomposed = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--recompose',
      '--recompose-head',
      afterGolden,
      '--agent',
      'codex',
      '--agent-id',
      'postgen-integrator',
      '--json',
    ]),
  );
  assert.equal(recomposed.outcome, 'composed');
  assert.equal(recomposed.recompose.authorized_head_sha, afterGolden);
  assert.equal(recomposed.recompose.discarded_head_sha, afterGolden);
  assert.equal(recomposed.recompose.previous_composed_sha, first.composed_sha);
  assert.equal(existsSync(join(candidatePath, 'golden.txt')), false, '--recompose 明示丢弃合成后的提交');
  assert.equal(recomposed.post_integrate_steps.find((step) => step.name === 'regenerate-golden').state, 'pending');
  const audit = JSON.parse(manager(fixture.repo, ['audit', first.candidate.task, '--json']));
  const authorized = audit.events.filter((event) => event.event_type === 'batch_candidate_recompose_authorized');
  assert.equal(authorized.length, 1);
  assert.equal(authorized[0].details.authorized_head_sha, afterGolden);
  assert.equal(authorized[0].details.discarded_head_sha, afterGolden);
  assert.deepEqual(authorized[0].details.requested_by, { host: 'codex', id: 'postgen-integrator' });
});

test('[P1-4] 同指纹候选跨会话只读可复用，任何续合或重合成必须先 handoff', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'owner-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'owner-beta', 'beta.txt', 'beta\n');
  const { planPath } = freezePlan(fixture, ['owner-alpha', 'owner-beta']);

  const first = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'owner-a',
      '--json',
    ]),
  );
  const candidatePath = first.candidate.path;
  writeFileSync(join(candidatePath, 'owner-a-result.txt'), 'must survive\n');
  git(candidatePath, ['add', 'owner-a-result.txt']);
  git(candidatePath, ['commit', '-m', 'chore: owner A post-step']);
  const ownerAHead = git(candidatePath, ['rev-parse', 'HEAD']);

  const readOnly = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'owner-b',
      '--json',
    ]),
  );
  assert.equal(readOnly.outcome, 'already_composed');
  assert.equal(readOnly.head_sha, ownerAHead);

  const denied = managerStderr(fixture.repo, [
    'batch-integrate',
    '--plan',
    planPath,
    '--recompose',
    '--recompose-head',
    ownerAHead,
    '--agent',
    'codex',
    '--agent-id',
    'owner-b',
    '--json',
  ]);
  assert.match(denied, /跨会话只允许读取 already_composed/);
  assert.match(denied, /handoff/);
  assert.equal(git(candidatePath, ['rev-parse', 'HEAD']), ownerAHead);
  assert.equal(existsSync(join(candidatePath, 'owner-a-result.txt')), true);
  assert.deepEqual(recordFor(fixture, first.candidate.task).agent, { host: 'codex', id: 'owner-a' });
});

test('[P2-1] 仓库已继承 rerere.enabled 时仍必须补齐 autoUpdate，否则重放不更新 index', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  // 只开 enabled、不开 autoUpdate：这正是重放"看起来生效、实际仍判冲突"的反例配置。
  git(fixture.repo, ['config', 'rerere.enabled', 'true']);
  prepareBatchInput(fixture, 'inherit-alpha', 'shared.txt', 'alpha side\n');
  prepareBatchInput(fixture, 'inherit-beta', 'shared.txt', 'beta side\n');
  const { planPath } = freezePlan(fixture, ['inherit-alpha', 'inherit-beta']);

  const first = JSON.parse(
    managerKeep(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'inherit-integrator',
      '--json',
    ]),
  );
  assert.equal(first.outcome, 'conflict');
  assert.equal(first.rerere.enabled, true);
  assert.equal(first.rerere.auto_update, true, '继承 enabled 也必须补齐 autoUpdate');
  const candidatePath = first.conflict.candidate_path;
  assert.equal(git(candidatePath, ['config', '--get', 'rerere.autoUpdate']), 'true');

  writeFileSync(join(candidatePath, 'shared.txt'), 'alpha side\nbeta side\n');
  git(candidatePath, ['add', 'shared.txt']);
  git(candidatePath, ['commit', '--no-edit']);

  const second = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'inherit-integrator',
      '--json',
    ]),
  );
  assert.equal(second.outcome, 'composed', '补齐 autoUpdate 后第二轮应自动重放解法');
  assert.equal(
    second.steps.some((step) => step.rerere_replayed),
    true,
  );
});

test('[P2-2] 自动写共享 extensions.worktreeConfig 留独立审计事件，并如实记录覆盖前值', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  git(fixture.repo, ['config', 'extensions.worktreeConfig', 'false']);
  assert.equal(git(fixture.repo, ['config', '--get', 'extensions.worktreeConfig']), 'false', '前置：扩展显式关闭');
  prepareBatchInput(fixture, 'audit-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'audit-beta', 'beta.txt', 'beta\n');
  const first = freezePlan(fixture, ['audit-alpha', 'audit-beta']);

  const round1 = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      first.planPath,
      '--agent',
      'codex',
      '--agent-id',
      'audit-integrator',
      '--json',
    ]),
  );
  assert.equal(round1.rerere.worktree_config_extension, 'enabled_by_this_command');
  assert.equal(git(fixture.repo, ['config', '--get', 'extensions.worktreeConfig']), 'true');
  const audit1 = JSON.parse(manager(fixture.repo, ['audit', round1.candidate.task, '--json']));
  const written = audit1.events.filter((event) => event.event_type === 'repository_config_extension_enabled');
  assert.equal(written.length, 1, '本轮写入共享 config 必须留且只留一条审计事件');
  assert.equal(written[0].details.key, 'extensions.worktreeConfig');
  assert.equal(written[0].details.previous, 'false');
  assert.equal(written[0].details.scope, 'shared_repository_config');
  assert.equal(written[0].details.written_by, 'batch-integrate');

  // 第二轮：扩展已启用 → 不应再记「本轮写入」事件。
  const betaTree = worktreeFor(fixture, 'audit-beta');
  writeFileSync(join(betaTree, 'beta.txt'), 'beta v2\n');
  git(betaTree, ['add', 'beta.txt']);
  git(betaTree, ['commit', '-m', 'feat: beta v2']);
  git(betaTree, ['push', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'audit-beta', '--status', 'ready_for_review', '--no-watch']);
  const second = freezePlan(fixture, ['audit-alpha', 'audit-beta']);
  const round2 = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      second.planPath,
      '--candidate-task',
      'batch-integration-audit-second',
      '--agent',
      'codex',
      '--agent-id',
      'audit-integrator',
      '--json',
    ]),
  );
  assert.notEqual(round2.rerere.worktree_config_extension, 'enabled_by_this_command');
  const audit2 = JSON.parse(manager(fixture.repo, ['audit', round2.candidate.task, '--json']));
  assert.equal(
    audit2.events.some((event) => event.event_type === 'repository_config_extension_enabled'),
    false,
    '扩展原本已启用时不得伪造写入事件',
  );
});
