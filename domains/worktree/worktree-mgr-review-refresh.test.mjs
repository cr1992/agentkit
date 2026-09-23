import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { appendTraceEvent } from './worktree-trace.mjs';
import {
  git,
  manager,
  makeRemoteRepo,
  publishProfile,
  waitFor,
  prepareReviewTask,
  recordFor,
  worktreeFor,
  branchFor,
  gitOk,
  managerStderr,
} from '../../tests/helpers/worktree-mgr-fixture.mjs';

test('touch ready_for_review 默认武装 watch，--no-watch 退出，HEAD 变化时重冻结', (t) => {
  const fixture = makeRemoteRepo();
  const task = 'auto-armed-review';
  t.after(() => {
    try {
      manager(fixture.repo, ['unwatch', task]);
    } catch {}
    try {
      manager(fixture.repo, ['unwatch', 'opted-out-review']);
    } catch {}
    try {
      manager(fixture.repo, ['unwatch', 'base-following-review']);
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
  git(fixture.repo, ['branch', 'review-target']);
  git(fixture.repo, ['push', 'origin', 'review-target']);

  // --no-watch：显式退出默认武装。
  manager(fixture.repo, [
    'spawn',
    'opted-out-review',
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'opted-out-thread',
    '--purpose',
    '退出自动武装',
  ]);
  const optedOutTree = worktreeFor(fixture, 'opted-out-review');
  writeFileSync(join(optedOutTree, 'f.txt'), 'x\n');
  git(optedOutTree, ['add', 'f.txt']);
  git(optedOutTree, ['commit', '-m', 'feat: opted out']);
  git(optedOutTree, ['push', '-u', 'origin', 'HEAD']);
  const optedOut = manager(fixture.repo, ['touch', 'opted-out-review', '--status', 'ready_for_review', '--no-watch']);
  assert.match(optedOut, /--no-watch/);
  const optedOutRecord = recordFor(fixture, 'opted-out-review');
  assert.equal(optedOutRecord.auto_reclaim ?? null, null);
  assert.equal(optedOutRecord.review_watch.policy, 'disabled');
  assert.equal(optedOutRecord.review_watch.reason, 'explicit_no_watch');
  assert.equal(
    JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.some(
      (finding) => finding.code === 'AUTO_RECLAIM_DISABLED',
    ),
    true,
  );

  // 人工 watch 的 target 属于显式指令，touch 不得静默改指。
  manager(fixture.repo, ['watch', 'opted-out-review', '--target', 'origin/main']);
  assert.equal(recordFor(fixture, 'opted-out-review').auto_reclaim.armed_by, 'explicit');
  const protectedTarget = manager(fixture.repo, [
    'touch',
    'opted-out-review',
    '--status',
    'ready_for_review',
    '--target',
    'origin/review-target',
  ]);
  assert.match(protectedTarget, /换目标请先 unwatch/);
  assert.equal(recordFor(fixture, 'opted-out-review').auto_reclaim.target_ref, 'origin/main');

  // 非默认 base 是该树登记的评审目标；自动武装不得被 Profile default_base 改回 main。
  manager(fixture.repo, [
    'spawn',
    'base-following-review',
    '--base',
    'origin/review-target',
    '--base-reason',
    '版本分支目标',
    '--agent',
    'codex',
    '--agent-id',
    'base-following-thread',
    '--purpose',
    '跟随登记 base',
  ]);
  const baseFollowingTree = worktreeFor(fixture, 'base-following-review');
  writeFileSync(join(baseFollowingTree, 'base-following.txt'), 'base\n');
  git(baseFollowingTree, ['add', 'base-following.txt']);
  git(baseFollowingTree, ['commit', '-m', 'feat: follow managed base']);
  git(baseFollowingTree, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'base-following-review', '--status', 'ready_for_review']);
  const baseFollowingRecord = recordFor(fixture, 'base-following-review');
  assert.equal(baseFollowingRecord.auto_reclaim.target_ref, 'origin/review-target');
  assert.equal(
    baseFollowingRecord.auto_reclaim.target_base_sha,
    git(fixture.repo, ['rev-parse', 'origin/review-target']),
  );

  // 默认：进入 ready_for_review 即自动武装，target 取 Profile default_base。
  manager(fixture.repo, [
    'spawn',
    task,
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'auto-armed-thread',
    '--purpose',
    '默认自动武装',
  ]);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, 'feature.txt'), 'first\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: first']);
  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  const firstHead = git(worktree, ['rev-parse', 'HEAD']);
  const armed = manager(fixture.repo, ['touch', task, '--status', 'ready_for_review']);
  assert.match(armed, /watch 已武装/);
  const armedRecord = recordFor(fixture, task);
  assert.equal(armedRecord.auto_reclaim.target_ref, 'origin/main');
  assert.equal(armedRecord.auto_reclaim.head_sha, firstHead);
  assert.equal(armedRecord.auto_reclaim.armed_by, 'auto_touch');

  // auto_touch 只是默认动作，当轮可直接改指并留下 rearm。
  const redirected = manager(fixture.repo, [
    'touch',
    task,
    '--status',
    'ready_for_review',
    '--target',
    'origin/review-target',
  ]);
  assert.match(redirected, /重新武装/);
  assert.equal(recordFor(fixture, task).auto_reclaim.target_ref, 'origin/review-target');

  // HEAD 前进后再 touch：重冻结到新 HEAD，而不是继续盯旧 SHA。
  writeFileSync(join(worktree, 'feature.txt'), 'second\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: second']);
  git(worktree, ['push', 'origin', 'HEAD']);
  const secondHead = git(worktree, ['rev-parse', 'HEAD']);
  const rearmed = manager(fixture.repo, ['touch', task, '--status', 'ready_for_review']);
  assert.match(rearmed, /重新武装/);
  assert.match(rearmed, /重冻结/);
  const rearmedRecord = recordFor(fixture, task);
  assert.equal(rearmedRecord.auto_reclaim.head_sha, secondHead);
  assert.equal(rearmedRecord.auto_reclaim.target_ref, 'origin/review-target');
  const audit = JSON.parse(manager(fixture.repo, ['audit', task, '--json']));
  assert.equal(
    audit.events.some((event) => event.event_type === 'auto_reclaim_rearmed'),
    true,
  );
});

test('未推送时持久化 pending intent，doctor 可见且 resume-all 在 push 后恢复', (t) => {
  const fixture = makeRemoteRepo();
  t.after(() => {
    try {
      manager(fixture.repo, ['unwatch', 'unpushed-review']);
    } catch {}
    fixture.cleanup();
  });
  manager(fixture.repo, [
    'spawn',
    'unpushed-review',
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'unpushed-thread',
    '--purpose',
    '未推送即进入验收',
  ]);
  const worktree = worktreeFor(fixture, 'unpushed-review');
  writeFileSync(join(worktree, 'feature.txt'), 'not pushed\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: not pushed']);

  const output = manager(fixture.repo, ['touch', 'unpushed-review', '--status', 'ready_for_review']);
  assert.match(output, /已更新/);
  assert.match(output, /watch 未武装/);
  assert.match(output, /尚未完整 push/);
  let record = recordFor(fixture, 'unpushed-review');
  assert.equal(record.task_status, 'ready_for_review');
  assert.equal(record.auto_reclaim ?? null, null);
  assert.equal(record.review_watch.policy, 'auto');
  assert.equal(record.review_watch.state, 'pending');
  assert.match(record.review_watch.reason, /尚未完整 push/);
  let doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'AUTO_RECLAIM_NOT_ARMED'),
    true,
  );

  const blocked = JSON.parse(manager(fixture.repo, ['resume-all', '--json']));
  assert.equal(blocked.resumed.length, 0);
  assert.equal(blocked.skipped.length, 1);
  assert.match(blocked.skipped[0].reason, /not fully pushed/);

  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  const resumed = JSON.parse(manager(fixture.repo, ['resume-all', '--json']));
  assert.equal(resumed.resumed.length, 1);
  record = recordFor(fixture, 'unpushed-review');
  assert.equal(record.review_watch.state, 'armed');
  assert.equal(record.auto_reclaim.state, 'watching');
  doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'AUTO_RECLAIM_NOT_ARMED'),
    false,
  );
});

test('legacy 评审态缺少 watch intent 时 doctor 和 resume-all 都不得静默忽略', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  const task = 'legacy-watch-intent';
  prepareReviewTask(fixture, task);
  const record = recordFor(fixture, task);
  appendTraceEvent({
    commonDir: join(fixture.repo, '.git'),
    worktreeId: record.worktree_id,
    eventType: 'legacy_watch_intent_fixture',
    actor: record.agent,
    mutate(current) {
      const next = structuredClone(current);
      delete next.review_watch;
      return next;
    },
  });

  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'AUTO_RECLAIM_INTENT_MISSING'),
    true,
  );
  const resumed = JSON.parse(manager(fixture.repo, ['resume-all', '--json']));
  assert.equal(resumed.resumed.length, 0);
  assert.equal(resumed.skipped.length, 1);
  assert.match(resumed.skipped[0].reason, /intent missing/);
});

test('watcher 区分 target 前进的干净预判，refresh-review 可暂停门禁后精确 push 并重冻结', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'review-refresh-clean';
  t.after(() => {
    try {
      manager(fixture.repo, ['unwatch', task]);
    } catch {}
    fixture.cleanup();
  });
  manager(fixture.repo, [
    'spawn',
    task,
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'review-refresh-clean-thread',
    '--purpose',
    '刷新无冲突评审',
  ]);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, 'feature.txt'), 'feature\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: refresh clean']);
  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--interval-ms', '100', '--notify', 'off']);
  const oldHead = git(worktree, ['rev-parse', 'HEAD']);

  writeFileSync(join(fixture.repo, 'target-next.txt'), 'target\n');
  git(fixture.repo, ['add', 'target-next.txt']);
  git(fixture.repo, ['commit', '-m', 'feat: advance target cleanly']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  const targetHead = git(fixture.repo, ['rev-parse', 'HEAD']);
  await waitFor(
    () => recordFor(fixture, task).auto_reclaim?.target_advance?.target_sha === targetHead,
    'watcher 未记录 target advance',
  );
  let record = recordFor(fixture, task);
  assert.equal(record.auto_reclaim.target_advance.prediction.state, 'clean');
  assert.equal(
    JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.some(
      (item) => item.code === 'TARGET_ADVANCED_REFRESH_CLEAN',
    ),
    true,
  );

  const paused = manager(fixture.repo, ['refresh-review', task, '--pause-before-push']);
  assert.match(paused, /暂停在 push 前/);
  record = recordFor(fixture, task);
  assert.equal(record.review_refresh.state, 'rebased');
  assert.equal(record.task_status, 'active');
  const rebasedHead = git(worktree, ['rev-parse', 'HEAD']);
  assert.notEqual(rebasedHead, oldHead);
  assert.equal(git(fixture.remote, ['rev-parse', `refs/heads/${record.branch}`]), oldHead, '暂停阶段不得提前改写远端');
  assert.equal(
    JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.some(
      (item) => item.code === 'REVIEW_REFRESH_PENDING',
    ),
    true,
  );

  git(fixture.repo, ['push', '--force', 'origin', `HEAD:refs/heads/${record.branch}`]);
  assert.throws(
    () => manager(fixture.repo, ['refresh-review', task, '--continue']),
    /upstream lease 已变化/,
    '并发改写 upstream 后必须拒绝覆盖',
  );
  assert.equal(git(fixture.remote, ['rev-parse', `refs/heads/${record.branch}`]), targetHead);
  git(worktree, ['push', '--force', 'origin', `${oldHead}:refs/heads/${record.branch}`]);

  const completed = manager(fixture.repo, ['refresh-review', task, '--continue']);
  assert.match(completed, /已 force-with-lease push 并重新武装 watcher/);
  record = recordFor(fixture, task);
  assert.equal(record.review_refresh, null);
  assert.equal(record.task_status, 'ready_for_review');
  assert.equal(record.base_sha, targetHead);
  assert.equal(record.auto_reclaim.head_sha, rebasedHead);
  assert.equal(record.auto_reclaim.target_ref, 'origin/main');
  assert.equal(record.auto_reclaim.target_base_sha, targetHead);
  assert.equal(record.auto_reclaim.armed_by, 'review_refresh');
  assert.equal(git(fixture.remote, ['rev-parse', `refs/heads/${record.branch}`]), rebasedHead);
  assert.equal(record.review_refreshes.at(-1).state, 'completed');
});

test('pause-before-push 门禁失败可 abort：补偿 managed rebase 元数据、恢复旧 HEAD 与 watcher', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'review-refresh-gate-abort';
  t.after(() => {
    try {
      manager(fixture.repo, ['unwatch', task]);
    } catch {}
    fixture.cleanup();
  });
  const initialBase = git(fixture.repo, ['rev-parse', 'origin/main']);
  manager(fixture.repo, [
    'spawn',
    task,
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'review-refresh-abort-thread',
    '--purpose',
    '门禁失败放弃刷新',
  ]);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, 'abort-feature.txt'), 'feature\n');
  git(worktree, ['add', 'abort-feature.txt']);
  git(worktree, ['commit', '-m', 'feat: refresh abort']);
  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  const oldHead = git(worktree, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--interval-ms', '100', '--notify', 'off']);

  writeFileSync(join(fixture.repo, 'abort-target.txt'), 'target\n');
  git(fixture.repo, ['add', 'abort-target.txt']);
  git(fixture.repo, ['commit', '-m', 'feat: advance target before abort']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  const targetHead = git(fixture.repo, ['rev-parse', 'HEAD']);
  await waitFor(
    () => recordFor(fixture, task).auto_reclaim?.target_advance?.target_sha === targetHead,
    'watcher 未记录 abort 场景的 target advance',
  );

  manager(fixture.repo, ['refresh-review', task, '--pause-before-push']);
  let record = recordFor(fixture, task);
  const rebasedHead = git(worktree, ['rev-parse', 'HEAD']);
  assert.notEqual(rebasedHead, oldHead);
  assert.equal(record.review_refresh.state, 'rebased');
  assert.equal(record.review_refresh.pause_before_push, true);
  assert.equal(record.base_sha, targetHead);

  git(worktree, ['push', 'origin', '--delete', record.branch]);
  assert.throws(() => manager(fixture.repo, ['refresh-review', task, '--continue']), /upstream 分支 .* 已不存在/);
  git(worktree, ['push', 'origin', `${oldHead}:refs/heads/${record.branch}`]);

  const aborted = manager(fixture.repo, ['refresh-review', task, '--abort']);
  assert.match(aborted, /已 abort/);
  record = recordFor(fixture, task);
  assert.equal(git(worktree, ['rev-parse', 'HEAD']), oldHead);
  assert.equal(git(fixture.remote, ['rev-parse', `refs/heads/${record.branch}`]), oldHead);
  assert.equal(record.review_refresh, null);
  assert.equal(record.history_operation, null);
  assert.equal(record.task_status, 'ready_for_review');
  assert.equal(record.base_ref, 'origin/main');
  assert.equal(record.base_sha, initialBase);
  assert.equal(record.history_rewrites.length, 1, '已发生的 rebase lineage 保留审计');
  assert.equal(record.history_rollbacks.at(-1).kind, 'review_refresh_abort');
  assert.equal(record.history_rollbacks.at(-1).from_head, rebasedHead);
  assert.equal(record.ownership_epochs.length, 3);
  assert.equal(record.ownership_epochs.at(-1).source, 'review_refresh_abort');
  assert.equal(record.auto_reclaim.head_sha, oldHead);
  assert.equal(record.auto_reclaim.target_base_sha, initialBase);
  assert.equal(record.auto_reclaim.armed_by, 'auto_touch');
  assert.equal(record.review_refreshes.at(-1).abort_kind, 'rebased_before_push');
});

test('refresh-review 冲突态 abort 继续复用 managed rebase 回滚并恢复 watcher', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'review-refresh-conflict-abort';
  t.after(() => {
    try {
      manager(fixture.repo, ['unwatch', task]);
    } catch {}
    fixture.cleanup();
  });
  writeFileSync(join(fixture.repo, 'abort-conflict.txt'), 'base\n');
  git(fixture.repo, ['add', 'abort-conflict.txt']);
  git(fixture.repo, ['commit', '-m', 'feat: conflict abort base']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  const initialBase = git(fixture.repo, ['rev-parse', 'HEAD']);
  manager(fixture.repo, [
    'spawn',
    task,
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'review-refresh-conflict-abort-thread',
    '--purpose',
    '冲突态放弃刷新',
  ]);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, 'abort-conflict.txt'), 'feature\n');
  git(worktree, ['add', 'abort-conflict.txt']);
  git(worktree, ['commit', '-m', 'feat: conflict abort feature']);
  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  const oldHead = git(worktree, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--interval-ms', '100', '--notify', 'off']);

  writeFileSync(join(fixture.repo, 'abort-conflict.txt'), 'target\n');
  git(fixture.repo, ['add', 'abort-conflict.txt']);
  git(fixture.repo, ['commit', '-m', 'feat: conflict abort target']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  const targetHead = git(fixture.repo, ['rev-parse', 'HEAD']);
  await waitFor(
    () => recordFor(fixture, task).auto_reclaim?.target_advance?.target_sha === targetHead,
    'watcher 未记录 conflict abort target advance',
  );
  assert.match(managerStderr(fixture.repo, ['refresh-review', task]), /managed rebase/);
  assert.equal(recordFor(fixture, task).history_operation.state, 'conflicted');

  assert.match(manager(fixture.repo, ['refresh-review', task, '--abort']), /已 abort/);
  const record = recordFor(fixture, task);
  assert.equal(git(worktree, ['rev-parse', 'HEAD']), oldHead);
  assert.equal(record.review_refresh, null);
  assert.equal(record.history_operation, null);
  assert.equal(record.base_sha, initialBase);
  assert.equal(record.history_rewrites ?? null, null);
  assert.equal(record.history_rollbacks ?? null, null);
  assert.equal(record.auto_reclaim.head_sha, oldHead);
  assert.equal(record.review_refreshes.at(-1).abort_kind, 'managed_rebase');
});

test('watcher 标记预判冲突，refresh-review 复用 managed rebase 并由自身 --continue 收口', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'review-refresh-conflict';
  t.after(() => {
    try {
      manager(fixture.repo, ['unwatch', task]);
    } catch {}
    fixture.cleanup();
  });
  writeFileSync(join(fixture.repo, 'shared-refresh.txt'), 'base\n');
  git(fixture.repo, ['add', 'shared-refresh.txt']);
  git(fixture.repo, ['commit', '-m', 'feat: shared refresh base']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);

  manager(fixture.repo, [
    'spawn',
    task,
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'review-refresh-conflict-thread',
    '--purpose',
    '刷新冲突评审',
  ]);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, 'shared-refresh.txt'), 'feature\n');
  git(worktree, ['add', 'shared-refresh.txt']);
  git(worktree, ['commit', '-m', 'feat: feature edits shared refresh']);
  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--interval-ms', '100', '--notify', 'off']);

  writeFileSync(join(fixture.repo, 'shared-refresh.txt'), 'target\n');
  git(fixture.repo, ['add', 'shared-refresh.txt']);
  git(fixture.repo, ['commit', '-m', 'feat: target edits shared refresh']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  const targetHead = git(fixture.repo, ['rev-parse', 'HEAD']);
  await waitFor(
    () => recordFor(fixture, task).auto_reclaim?.target_advance?.target_sha === targetHead,
    'watcher 未记录冲突 target advance',
  );
  assert.equal(recordFor(fixture, task).auto_reclaim.target_advance.prediction.state, 'conflict');
  assert.equal(
    JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.some((item) => item.code === 'REBASE_NEEDED'),
    true,
  );

  assert.match(managerStderr(fixture.repo, ['refresh-review', task]), /解决冲突.*refresh-review.*--continue/s);
  let record = recordFor(fixture, task);
  assert.equal(record.review_refresh.state, 'prepared');
  assert.equal(record.history_operation.state, 'conflicted');
  writeFileSync(join(worktree, 'shared-refresh.txt'), 'resolved\n');
  git(worktree, ['add', 'shared-refresh.txt']);
  const completed = manager(fixture.repo, ['refresh-review', task, '--continue']);
  assert.match(completed, /已 force-with-lease push 并重新武装 watcher/);
  record = recordFor(fixture, task);
  assert.equal(record.review_refresh, null);
  assert.equal(record.history_operation, null);
  assert.equal(record.task_status, 'ready_for_review');
  assert.equal(readFileSync(join(worktree, 'shared-refresh.txt'), 'utf8'), 'resolved\n');
  assert.equal(git(fixture.remote, ['rev-parse', `refs/heads/${record.branch}`]), git(worktree, ['rev-parse', 'HEAD']));
});

test('managed rebase 原子刷新堆叠父关系、base 与 ownership，并使旧 Artifact 失效', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);

  manager(fixture.repo, [
    'spawn',
    'stack-parent-managed',
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'stack-parent-thread',
    '--purpose',
    '堆叠父任务',
  ]);
  const parent = worktreeFor(fixture, 'stack-parent-managed');
  writeFileSync(join(parent, 'parent.txt'), 'parent v1\n');
  git(parent, ['add', 'parent.txt']);
  git(parent, ['commit', '-m', 'feat: parent v1']);
  git(parent, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'stack-parent-managed']);
  const parentBranch = branchFor(fixture, 'stack-parent-managed');

  manager(fixture.repo, [
    'spawn',
    'stack-child-managed',
    '--base',
    `origin/${parentBranch}`,
    '--base-reason',
    '依赖父任务',
    '--agent',
    'codex',
    '--agent-id',
    'stack-child-thread',
    '--purpose',
    '堆叠子任务',
  ]);
  const child = worktreeFor(fixture, 'stack-child-managed');
  writeFileSync(join(child, 'child.txt'), 'child v1\n');
  git(child, ['add', 'child.txt']);
  git(child, ['commit', '-m', 'feat: child v1']);
  const oldHead = git(child, ['rev-parse', 'HEAD']);
  const initialChildRecord = recordFor(fixture, 'stack-child-managed');
  assert.equal(initialChildRecord.stack_parent.worktree_id, recordFor(fixture, 'stack-parent-managed').worktree_id);
  assert.equal(initialChildRecord.stack_parent.parent_head_sha, initialChildRecord.base_sha);
  const oldArtifact = JSON.parse(manager(fixture.repo, ['artifact', 'stack-child-managed', '--json']));
  const oldArtifactPath = join(fixture.sandbox, 'old-stack-artifact.json');
  writeFileSync(oldArtifactPath, JSON.stringify(oldArtifact));
  assert.match(
    managerStderr(fixture.repo, [
      'rebase',
      'stack-child-managed',
      '--onto',
      branchFor(fixture, 'stack-child-managed'),
      '--expected-head',
      oldHead,
      '--reason',
      '非法自引用',
    ]),
    /stack parent 环/,
  );

  writeFileSync(join(parent, 'parent-next.txt'), 'parent v2\n');
  git(parent, ['add', 'parent-next.txt']);
  git(parent, ['commit', '-m', 'feat: parent v2']);
  git(parent, ['push', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'stack-parent-managed']);
  const parentV2 = git(parent, ['rev-parse', 'HEAD']);

  const output = manager(fixture.repo, [
    'rebase',
    'stack-child-managed',
    '--onto',
    `origin/${parentBranch}`,
    '--expected-head',
    oldHead,
    '--reason',
    '吸收父任务 v2',
  ]);
  assert.match(output, /已 rebase/);
  const childV2 = git(child, ['rev-parse', 'HEAD']);
  assert.notEqual(childV2, oldHead);
  assert.equal(gitOk(child, ['merge-base', '--is-ancestor', parentV2, childV2]), true);
  assert.equal(readFileSync(join(child, 'parent-next.txt'), 'utf8'), 'parent v2\n');

  const record = recordFor(fixture, 'stack-child-managed');
  assert.equal(record.base_sha, parentV2);
  assert.equal(record.base_ref, `origin/${parentBranch}`);
  assert.equal(record.stack_parent.worktree_id, recordFor(fixture, 'stack-parent-managed').worktree_id);
  assert.equal(record.stack_parent.parent_head_sha, parentV2);
  assert.equal(record.history_rewrites.length, 1);
  assert.equal(record.history_rewrites[0].old_head, oldHead);
  assert.equal(record.history_rewrites[0].new_head, childV2);
  assert.equal(record.ownership_epochs.length, 2);
  assert.match(managerStderr(fixture.repo, ['verify-artifact', oldArtifactPath, '--json']), /Artifact/);
  assert.match(
    managerStderr(fixture.repo, [
      'rebase',
      'stack-child-managed',
      '--onto',
      'origin/main',
      '--expected-head',
      oldHead,
      '--reason',
      'stale CAS',
    ]),
    /CAS/,
  );

  const retargeted = manager(fixture.repo, [
    'retarget',
    'stack-child-managed',
    '--base',
    'origin/main',
    '--expected-head',
    childV2,
    '--reason',
    'MR 改为直接合入 main',
  ]);
  assert.match(retargeted, /已 retarget/);
  const afterRetarget = recordFor(fixture, 'stack-child-managed');
  assert.equal(afterRetarget.base_ref, 'origin/main');
  assert.equal(afterRetarget.stack_parent, null);
  assert.equal(afterRetarget.ownership_epochs.length, 2, 'retarget 不改历史，不应新开 ownership epoch');
});

test('managed rebase 冲突保持 pending，交付命令 fail-closed，并由 manager --continue 恢复', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);

  manager(fixture.repo, [
    'spawn',
    'conflict-parent-managed',
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'conflict-parent-thread',
    '--purpose',
    '冲突父任务',
  ]);
  const parent = worktreeFor(fixture, 'conflict-parent-managed');
  writeFileSync(join(parent, 'shared.txt'), 'base\n');
  git(parent, ['add', 'shared.txt']);
  git(parent, ['commit', '-m', 'feat: shared base']);
  git(parent, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'conflict-parent-managed']);
  const parentBranch = branchFor(fixture, 'conflict-parent-managed');

  manager(fixture.repo, [
    'spawn',
    'conflict-child-managed',
    '--base',
    `origin/${parentBranch}`,
    '--base-reason',
    '依赖父任务',
    '--agent',
    'codex',
    '--agent-id',
    'conflict-child-thread',
    '--purpose',
    '冲突子任务',
  ]);
  const child = worktreeFor(fixture, 'conflict-child-managed');
  writeFileSync(join(child, 'shared.txt'), 'child\n');
  git(child, ['add', 'shared.txt']);
  git(child, ['commit', '-m', 'feat: child edits shared']);
  const oldHead = git(child, ['rev-parse', 'HEAD']);

  writeFileSync(join(parent, 'shared.txt'), 'parent\n');
  git(parent, ['add', 'shared.txt']);
  git(parent, ['commit', '-m', 'feat: parent edits shared']);
  git(parent, ['push', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'conflict-parent-managed']);

  const baseArgs = [
    'rebase',
    'conflict-child-managed',
    '--onto',
    `origin/${parentBranch}`,
    '--expected-head',
    oldHead,
    '--reason',
    '吸收冲突父任务',
  ];
  assert.match(managerStderr(fixture.repo, baseArgs), /发生冲突/);
  const pending = recordFor(fixture, 'conflict-child-managed');
  assert.equal(pending.history_operation.state, 'conflicted');
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'MANAGED_HISTORY_OPERATION_PENDING'),
    true,
  );
  assert.match(managerStderr(fixture.repo, ['artifact', 'conflict-child-managed', '--json']), /未完成/);

  writeFileSync(join(child, 'shared.txt'), 'resolved\n');
  git(child, ['add', 'shared.txt']);
  assert.match(
    managerStderr(fixture.repo, ['rebase', 'conflict-child-managed', '--onto', 'origin/main', '--continue']),
    /参数不一致/,
  );
  assert.match(manager(fixture.repo, ['rebase', 'conflict-child-managed', '--continue']), /finalize rebase/);
  const completed = recordFor(fixture, 'conflict-child-managed');
  assert.equal(completed.history_operation, null);
  assert.equal(completed.history_rewrites.length, 1);
  assert.equal(readFileSync(join(child, 'shared.txt'), 'utf8'), 'resolved\n');
});
