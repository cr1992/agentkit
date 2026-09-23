import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { appendTraceEvent } from './worktree-trace.mjs';
import {
  git,
  manager,
  managerExit,
  managerKeep,
  makeRepo,
  makeRemoteRepo,
  publishProfile,
  waitFor,
  recordFor,
  worktreeFor,
  branchFor,
} from '../../tests/helpers/worktree-mgr-fixture.mjs';

test('doctor 报告 primary Profile 与 default base 的语义漂移', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  const profilePath = join(fixture.repo, '.worktree-trace.json');
  const baseline = {
    schema_version: 1,
    default_base: 'origin/main',
    branch_template: '{host}/{task}',
    path_template: '{host}-{task}',
    task_naming: { mode: 'semantic', example: 'ci-gate-hardening' },
  };
  writeFileSync(profilePath, `${JSON.stringify(baseline, null, 2)}\n`);
  publishProfile(fixture, 'chore: add baseline profile');

  writeFileSync(
    profilePath,
    `${JSON.stringify(
      {
        ...baseline,
        branch_template: 'legacy/{task}',
        path_template: '../legacy-{task}',
        task_naming: { mode: 'slug', example: 'feature-name' },
      },
      null,
      2,
    )}\n`,
  );
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  const finding = doctor.findings.find((item) => item.code === 'PRIMARY_PROFILE_DRIFT_FROM_BASE');
  assert.equal(finding.baseline_ref, 'origin/main');
  assert.equal(finding.path, realpathSync(profilePath));
  assert.equal(finding.severity, 'error');
  const before = git(fixture.repo, ['worktree', 'list', '--porcelain']);
  assert.throws(
    () =>
      manager(fixture.repo, [
        'spawn',
        'drift-9',
        '--agent',
        'codex',
        '--agent-id',
        'drift-guard',
        '--purpose',
        'must fail closed',
      ]),
    /status 2|Command failed/,
  );
  assert.equal(git(fixture.repo, ['worktree', 'list', '--porcelain']), before);
});

test('doctor 把已合入的孤儿本地分支列成 info notice，不动 findings 计数与退出码', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  // 默认分支由 refs/remotes/origin/HEAD 证明：fixture 的本地分支叫 trunk，写死 main 的实现在这里就会露馅。
  git(fixture.repo, ['remote', 'set-head', 'origin', 'main']);
  const baseline = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.deepEqual(baseline.notices, []);

  const mainSha = git(fixture.repo, ['rev-parse', 'origin/main']);
  git(fixture.repo, ['branch', 'merged-orphan', mainSha]);
  git(fixture.repo, ['branch', 'main', mainSha]);
  const unmergedSha = git(fixture.repo, [
    'commit-tree',
    `${mainSha}^{tree}`,
    '-p',
    mainSha,
    '-m',
    'chore: unmerged work',
  ]);
  git(fixture.repo, ['branch', 'unmerged-orphan', unmergedSha]);

  const listed = managerExit(fixture.repo, ['doctor', '--json']);
  assert.equal(listed.status, 0);
  const doctor = JSON.parse(listed.stdout);
  assert.equal(doctor.findings.length, baseline.findings.length, '孤儿分支不得改变 findings 计数');
  const notice = doctor.notices.find((item) => item.code === 'MERGED_ORPHAN_LOCAL_BRANCH');
  assert.deepEqual(
    doctor.notices.filter((item) => item.code === 'MERGED_ORPHAN_LOCAL_BRANCH').map((item) => item.branch),
    ['merged-orphan'],
    '默认分支本身、当前检出分支与未合入分支都不得列出',
  );
  assert.equal(notice.severity, 'info');
  assert.equal(notice.head_sha, mainSha);
  assert.equal(notice.default_branch, 'origin/main');
  assert.equal(notice.cleanup_command, 'git branch -d merged-orphan');
  assert.equal(
    doctor.findings.some((item) => item.severity === 'info'),
    false,
  );

  const text = managerExit(fixture.repo, ['doctor']);
  assert.equal(text.status, 0);
  assert.match(text.stdout, new RegExp(`doctor findings=${doctor.findings.length}(?!\\d)`));
  assert.match(text.stdout, /doctor notices=1/);
  assert.match(text.stdout, /\[info\] MERGED_ORPHAN_LOCAL_BRANCH git branch -d merged-orphan/);

  // record 登记过的分支：目录已移除，分支仍在，归 reclaim/archive 的分支清理管，不算孤儿。
  manager(fixture.repo, [
    'spawn',
    'recorded-branch-tree',
    '--agent',
    'codex',
    '--agent-id',
    'orphan-branch-thread',
    '--purpose',
    'record owns this branch',
  ]);
  const tracked = JSON.parse(manager(fixture.repo, ['list', '--json'])).worktrees.find((row) => row.kind === 'TRACKED');
  git(fixture.repo, ['worktree', 'remove', tracked.path]);
  // 被 worktree 检出但没有 record 的分支同样不算孤儿。
  git(fixture.repo, [
    'worktree',
    'add',
    '-b',
    'checked-out-orphan',
    join(fixture.sandbox, 'checked-out-tree'),
    mainSha,
  ]);

  const after = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.deepEqual(
    after.notices.filter((item) => item.code === 'MERGED_ORPHAN_LOCAL_BRANCH').map((item) => item.branch),
    ['merged-orphan'],
  );
  assert.equal(
    after.findings.some((item) => item.code === 'UNTRACKED_WORKTREE'),
    true,
    'worktree 维度的既有 finding 不受影响',
  );
});

test('无法证明默认分支时 doctor 跳过孤儿分支清点并说明原因', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  git(fixture.repo, ['branch', 'merged-orphan', 'trunk']);
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctor.notices.some((item) => item.code === 'MERGED_ORPHAN_LOCAL_BRANCH'),
    false,
  );
  const skipped = doctor.notices.find((item) => item.code === 'MERGED_ORPHAN_BRANCH_SCAN_SKIPPED');
  assert.equal(skipped.severity, 'info');
  assert.match(skipped.detail, /source=head/);
});

test('Profile semantic 模式拒绝纯编号命名，并让 doctor 报告历史漂移', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  const profilePath = join(fixture.repo, '.worktree-trace.json');
  const baseline = {
    schema_version: 1,
    default_base: 'origin/main',
    task_naming: { mode: 'slug', example: 'feature-name' },
  };
  writeFileSync(profilePath, `${JSON.stringify(baseline, null, 2)}\n`);
  publishProfile(fixture, 'chore: add slug profile');
  manager(fixture.repo, [
    'spawn',
    'trace-9',
    '--agent',
    'codex',
    '--agent-id',
    'legacy-task',
    '--purpose',
    'legacy opaque naming',
  ]);

  writeFileSync(
    profilePath,
    `${JSON.stringify(
      {
        ...baseline,
        task_naming: { mode: 'semantic', example: 'ci-gate-hardening' },
      },
      null,
      2,
    )}\n`,
  );
  publishProfile(fixture, 'chore: require task id naming');

  assert.throws(
    () =>
      manager(fixture.repo, [
        'spawn',
        'trace-10',
        '--agent',
        'codex',
        '--agent-id',
        'new-task',
        '--purpose',
        'must reject',
      ]),
    /status 1|Command failed/,
  );
  manager(fixture.repo, [
    'spawn',
    'ci-gate-hardening',
    '--agent',
    'codex',
    '--agent-id',
    'new-task',
    '--purpose',
    'valid semantic task',
  ]);
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  const finding = doctor.findings.find((item) => item.code === 'TASK_NAMING_DOD_FAILED');
  assert.equal(finding.task, 'trace-9');
  assert.equal(finding.severity, 'error');
});

test('doctor 报告验收状态下的 dirty、HEAD 漂移和未完成 Git 操作', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);

  manager(fixture.repo, [
    'spawn',
    'review-operation-conflict',
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'review-operation-thread',
    '--purpose',
    '验收状态冲突检查',
  ]);
  const conflictTree = worktreeFor(fixture, 'review-operation-conflict');
  writeFileSync(join(conflictTree, 'README.md'), 'feature\n');
  git(conflictTree, ['add', 'README.md']);
  git(conflictTree, ['commit', '-m', 'feat: conflict side']);
  git(conflictTree, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'review-operation-conflict', '--status', 'ready_for_review']);
  writeFileSync(join(fixture.repo, 'README.md'), 'target\n');
  git(fixture.repo, ['add', 'README.md']);
  git(fixture.repo, ['commit', '-m', 'test: target conflict']);
  assert.throws(() => git(conflictTree, ['merge', 'trunk']));

  manager(fixture.repo, [
    'spawn',
    'review-head-drift',
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'review-drift-thread',
    '--purpose',
    '验收 HEAD 漂移检查',
  ]);
  const driftTree = worktreeFor(fixture, 'review-head-drift');
  writeFileSync(join(driftTree, 'drift.txt'), 'first\n');
  git(driftTree, ['add', 'drift.txt']);
  git(driftTree, ['commit', '-m', 'feat: first drift boundary']);
  git(driftTree, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'review-head-drift', '--status', 'ready_for_review']);
  writeFileSync(join(driftTree, 'drift.txt'), 'second\n');
  git(driftTree, ['add', 'drift.txt']);
  git(driftTree, ['commit', '-m', 'feat: move drift boundary']);

  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctor.findings.some(
      (item) =>
        item.code === 'GIT_OPERATION_IN_PROGRESS' &&
        item.worktree_id === recordFor(fixture, 'review-operation-conflict').worktree_id,
    ),
    true,
  );
  assert.equal(
    doctor.findings.some(
      (item) =>
        item.code === 'REVIEW_STATE_DIRTY' &&
        item.worktree_id === recordFor(fixture, 'review-operation-conflict').worktree_id,
    ),
    true,
  );
  const driftFinding = doctor.findings.find(
    (item) => item.code === 'HEAD_DRIFT' && item.worktree_id === recordFor(fixture, 'review-head-drift').worktree_id,
  );
  assert.equal(driftFinding.severity, 'error');
  assert.notEqual(driftFinding.recorded_head, driftFinding.live_head);
});

test('list --present 只显示目录仍存在的 record，既有 TRACKED/UNTRACKED/MAIN 分类与默认行为不变', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'present-noise-task',
    '--agent',
    'codex',
    '--agent-id',
    'present-noise-1',
    '--purpose',
    'stays present',
  ]);
  manager(fixture.repo, [
    'spawn',
    'gone-noise-task',
    '--agent',
    'codex',
    '--agent-id',
    'gone-noise-1',
    '--purpose',
    'directory disappears',
  ]);
  const goneWorktree = worktreeFor(fixture, 'gone-noise-task');
  git(fixture.repo, ['worktree', 'remove', goneWorktree]);

  const defaultListing = JSON.parse(manager(fixture.repo, ['list', '--json']));
  assert.equal(defaultListing.summary.historical, 1);
  assert.equal(
    defaultListing.records.some((record) => record.task === 'gone-noise-task'),
    true,
  );
  assert.match(manager(fixture.repo, ['list']), /\[MISSING\][^\n]*gone-noise-task/);

  const presentListing = JSON.parse(manager(fixture.repo, ['list', '--present', '--json']));
  assert.equal(presentListing.summary.historical, 0);
  assert.deepEqual(presentListing.records, []);
  // --present 只隐藏 historical 区块；TRACKED/UNTRACKED/MAIN 分类和 rows 完全不变。
  assert.deepEqual(
    presentListing.worktrees.map((row) => ({ kind: row.kind, path: row.path })),
    defaultListing.worktrees.map((row) => ({ kind: row.kind, path: row.path })),
  );
  assert.equal(
    presentListing.worktrees.some((row) => row.kind === 'TRACKED' && row.record?.task === 'present-noise-task'),
    true,
  );

  const presentText = manager(fixture.repo, ['list', '--present']);
  assert.equal(presentText.includes('gone-noise-task'), false);
  assert.match(presentText, /present-noise-task/);
});

test('doctor 默认折叠目录已消失 record 的 WORKTREE_MISSING/BASE_OVERRIDE/EPHEMERAL_WORKTREE 噪声，--verbose 展开且 --json 完整不受影响', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  writeFileSync(
    join(fixture.repo, '.worktree-trace.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        default_base: 'origin/main',
        branch_template: '{host}/{task}',
        path_template: '{host}-{task}',
        task_naming: { mode: 'semantic', example: 'ci-gate-hardening' },
      },
      null,
      2,
    )}\n`,
  );
  publishProfile(fixture);

  const missingTasks = ['missing-noise-one', 'missing-noise-two'];
  const missingPaths = [];
  for (const task of missingTasks) {
    manager(fixture.repo, [
      'spawn',
      task,
      '--base',
      'HEAD',
      '--base-reason',
      '依赖链噪声 fixture',
      '--agent',
      'codex',
      '--agent-id',
      `noise-${task}`,
      '--purpose',
      'noise fixture',
    ]);
    const record = recordFor(fixture, task);
    missingPaths.push(record.path);
    git(fixture.repo, ['worktree', 'remove', record.path]);
  }

  manager(fixture.repo, [
    'spawn',
    'real-issue',
    '--agent',
    'codex',
    '--agent-id',
    'real-issue-1',
    '--purpose',
    'must stay visible',
  ]);
  const realWorktree = worktreeFor(fixture, 'real-issue');
  writeFileSync(join(realWorktree, 'drift.txt'), 'drift\n');
  git(realWorktree, ['add', 'drift.txt']);
  git(realWorktree, ['commit', '-m', 'feat: drift fixture']);
  manager(fixture.repo, ['touch', 'real-issue', '--status', 'ready_for_review', '--no-watch']);
  writeFileSync(join(realWorktree, 'more.txt'), 'more\n');

  const jsonDoctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  for (const path of missingPaths) {
    const codes = jsonDoctor.findings.filter((finding) => finding.path === path).map((finding) => finding.code);
    assert.equal(codes.includes('WORKTREE_MISSING'), true);
    assert.equal(codes.includes('BASE_OVERRIDE'), true);
    assert.equal(codes.includes('EPHEMERAL_WORKTREE'), true);
  }
  assert.equal(
    jsonDoctor.findings.some((finding) => finding.code === 'REVIEW_STATE_DIRTY' && finding.path === realWorktree),
    true,
  );

  const defaultText = manager(fixture.repo, ['doctor']);
  assert.match(defaultText, /\[summary\] missing_worktrees=2 \(run doctor --verbose to expand\)/);
  for (const path of missingPaths) {
    assert.equal(defaultText.includes(`WORKTREE_MISSING ${path}`), false);
    assert.equal(defaultText.includes(`BASE_OVERRIDE ${path}`), false);
    assert.equal(defaultText.includes(`EPHEMERAL_WORKTREE ${path}`), false);
  }
  // 目录仍然存在的真实问题不受折叠影响：REVIEW_STATE_DIRTY（error，本来就不折叠）与该
  // worktree 自己的 EPHEMERAL_WORKTREE（目录仍存在，不属于"目录已消失"折叠范围）都必须可见。
  assert.match(defaultText, /REVIEW_STATE_DIRTY/);
  assert.equal(defaultText.includes(`EPHEMERAL_WORKTREE ${realWorktree}`), true);

  const verboseText = manager(fixture.repo, ['doctor', '--verbose']);
  assert.equal(/\[summary\]/.test(verboseText), false);
  for (const path of missingPaths) {
    assert.equal(verboseText.includes(`WORKTREE_MISSING ${path}`), true);
    assert.equal(verboseText.includes(`BASE_OVERRIDE ${path}`), true);
    assert.equal(verboseText.includes(`EPHEMERAL_WORKTREE ${path}`), true);
  }
});

test('archive 对目录仍存在、分支未合入、watcher 武装分别 KEEP；全部满足后归档并从 list/doctor 隐藏，list --archived 可见，audit/event chain 保留', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);

  // (1) 目录仍然存在 -> KEEP
  manager(fixture.repo, [
    'spawn',
    'archive-present',
    '--agent',
    'codex',
    '--agent-id',
    'archive-present-1',
    '--purpose',
    'still present',
  ]);
  assert.match(managerKeep(fixture.repo, ['archive', 'archive-present', '--reason', 'noise cleanup']), /目录仍然存在/);

  // (2) 目录已消失但分支未合入任何已知 base -> KEEP
  manager(fixture.repo, [
    'spawn',
    'archive-unmerged',
    '--agent',
    'codex',
    '--agent-id',
    'archive-unmerged-1',
    '--purpose',
    'unmerged branch',
  ]);
  const unmergedWorktree = worktreeFor(fixture, 'archive-unmerged');
  writeFileSync(join(unmergedWorktree, 'wip.txt'), 'wip\n');
  git(unmergedWorktree, ['add', 'wip.txt']);
  git(unmergedWorktree, ['commit', '-m', 'feat: unmerged wip']);
  git(fixture.repo, ['worktree', 'remove', unmergedWorktree]);
  assert.match(managerKeep(fixture.repo, ['archive', 'archive-unmerged', '--reason', 'noise cleanup']), /未合入/);

  // (3) 目录已消失、分支已合入，但 watcher 仍武装 -> KEEP；unwatch 后才允许归档（basis=branch_merged）
  manager(fixture.repo, [
    'spawn',
    'archive-watched',
    '--agent',
    'codex',
    '--agent-id',
    'archive-watched-1',
    '--purpose',
    'watched then archived',
  ]);
  const watchedRecord = recordFor(fixture, 'archive-watched');
  writeFileSync(join(watchedRecord.path, 'feature.txt'), 'feature\n');
  git(watchedRecord.path, ['add', 'feature.txt']);
  git(watchedRecord.path, ['commit', '-m', 'feat: archive-watched fixture']);
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', watchedRecord.branch]);
  git(fixture.repo, ['worktree', 'remove', watchedRecord.path]);
  appendTraceEvent({
    commonDir: join(fixture.repo, '.git'),
    worktreeId: watchedRecord.worktree_id,
    eventType: 'watch_started_fixture',
    actor: watchedRecord.agent,
    mutate(current) {
      return { ...current, auto_reclaim: { state: 'watching', token: 'fixture-archive-token' } };
    },
  });
  assert.match(managerKeep(fixture.repo, ['archive', 'archive-watched', '--reason', 'noise cleanup']), /武装监听状态/);
  appendTraceEvent({
    commonDir: join(fixture.repo, '.git'),
    worktreeId: watchedRecord.worktree_id,
    eventType: 'watch_disarmed_fixture',
    actor: watchedRecord.agent,
    mutate(current) {
      const next = structuredClone(current);
      next.auto_reclaim.state = 'disarmed';
      return next;
    },
  });
  const archiveOutput = manager(fixture.repo, ['archive', 'archive-watched', '--reason', 'confirmed merged noise']);
  assert.match(archiveOutput, /已归档/);
  assert.match(archiveOutput, /basis=branch_merged/);
  assert.match(managerKeep(fixture.repo, ['archive', 'archive-watched', '--reason', 'again']), /已经归档/);

  const defaultListing = JSON.parse(manager(fixture.repo, ['list', '--json']));
  assert.equal(
    defaultListing.records.some((record) => record.worktree_id === watchedRecord.worktree_id),
    false,
  );
  const archivedListing = JSON.parse(manager(fixture.repo, ['list', '--archived', '--json']));
  const archivedRecord = archivedListing.records.find((record) => record.worktree_id === watchedRecord.worktree_id);
  assert.ok(archivedRecord, 'list --archived 必须能看到已归档 record');
  assert.equal(archivedRecord.worktree_state, 'archived');
  assert.equal(archivedRecord.archive.basis, 'branch_merged');
  assert.match(manager(fixture.repo, ['list', '--archived']), /\[ARCHIVED\][^\n]*archive-watched/);

  const doctorAfter = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctorAfter.findings.some((finding) => finding.worktree_id === watchedRecord.worktree_id),
    false,
  );
  assert.equal(manager(fixture.repo, ['doctor', '--verbose']).includes(watchedRecord.worktree_id), false);

  const audit = JSON.parse(manager(fixture.repo, ['audit', 'archive-watched', '--json']));
  assert.equal(audit.record.worktree_state, 'archived');
  const archivedEvent = audit.events.find((event) => event.event_type === 'archived');
  assert.ok(archivedEvent, 'audit 必须仍能看到 archived event');
  assert.equal(archivedEvent.details.reason, 'confirmed merged noise');
  assert.equal(archivedEvent.details.basis, 'branch_merged');

  // (4) 分支已经不存在的成功路径（basis=branch_absent），覆盖前置条件 2 的另一半 OR 分支
  manager(fixture.repo, [
    'spawn',
    'archive-branch-absent',
    '--agent',
    'codex',
    '--agent-id',
    'archive-absent-1',
    '--purpose',
    'branch already deleted',
  ]);
  const absentRecord = recordFor(fixture, 'archive-branch-absent');
  git(fixture.repo, ['worktree', 'remove', absentRecord.path]);
  git(fixture.repo, ['branch', '-D', absentRecord.branch]);
  const absentOutput = manager(fixture.repo, [
    'archive',
    'archive-branch-absent',
    '--reason',
    'branch already deleted',
  ]);
  assert.match(absentOutput, /basis=branch_absent/);
});

test('doctor 对已回收 record 不再生成需要活树才能收敛的 metadata finding', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);

  manager(fixture.repo, [
    'spawn',
    'stack-parent-reclaim-noise',
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'reclaim-noise-parent',
    '--purpose',
    '堆叠父任务',
  ]);
  const parent = worktreeFor(fixture, 'stack-parent-reclaim-noise');
  writeFileSync(join(parent, 'parent.txt'), 'parent v1\n');
  git(parent, ['add', 'parent.txt']);
  git(parent, ['commit', '-m', 'feat: parent v1']);
  git(parent, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'stack-parent-reclaim-noise']);
  const parentBranch = branchFor(fixture, 'stack-parent-reclaim-noise');

  manager(fixture.repo, [
    'spawn',
    'stack-child-reclaim-noise',
    '--base',
    `origin/${parentBranch}`,
    '--base-reason',
    '依赖父任务',
    '--agent',
    'codex',
    '--agent-id',
    'reclaim-noise-child',
    '--purpose',
    '堆叠子任务',
  ]);
  const child = worktreeFor(fixture, 'stack-child-reclaim-noise');
  const childId = recordFor(fixture, 'stack-child-reclaim-noise').worktree_id;
  writeFileSync(join(child, 'child.txt'), 'child v1\n');
  git(child, ['add', 'child.txt']);
  git(child, ['commit', '-m', 'feat: child v1']);

  // 父任务 HEAD 前进。树还活着时这是真信号（managed rebase / retarget 都做得到），必须照报。
  writeFileSync(join(parent, 'parent-next.txt'), 'parent v2\n');
  git(parent, ['add', 'parent-next.txt']);
  git(parent, ['commit', '-m', 'feat: parent v2']);
  git(parent, ['push', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'stack-parent-reclaim-noise']);

  const live = JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.filter(
    (finding) => finding.worktree_id === childId,
  );
  assert.equal(
    live.some((finding) => finding.code === 'STACK_PARENT_ADVANCED'),
    true,
    '活树上父 HEAD 前进仍然必须照报，guard 不能把真信号一起吃掉',
  );

  const childBranch = branchFor(fixture, 'stack-child-reclaim-noise');
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', childBranch]);
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['reclaim', 'stack-child-reclaim-noise', '--pushed', pushed]);

  // 目录已删除：下面这些 finding 的补救动作全都需要活树，对已回收 record 只会是永远清不掉的噪声，
  // 其中 error 级的还会按「任何 error 都暂停 spawn/adopt」把后续派工钉死。
  const after = JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.filter(
    (finding) => finding.worktree_id === childId,
  );
  for (const code of [
    'EPHEMERAL_WORKTREE',
    'MANAGED_HISTORY_OPERATION_PENDING',
    'REVIEW_REFRESH_PENDING',
    'STACK_PARENT_MISSING',
    'STACK_PARENT_BRANCH_MISMATCH',
    'STACK_PARENT_ADVANCED',
    'BASE_OVERRIDE',
  ]) {
    assert.equal(
      after.some((finding) => finding.code === code),
      false,
      `已回收 record 不得再报 ${code}`,
    );
  }
});

test('已回收 record 不再报挂起的托管操作：reclaim 不清 review_refresh，doctor 不能靠它卡住派工', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'reclaim-pending-refresh';
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
    'reclaim-pending-refresh-thread',
    '--purpose',
    '回收时仍挂起的评审刷新',
  ]);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, 'feature.txt'), 'feature\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: pending refresh']);
  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--interval-ms', '100', '--notify', 'off']);

  writeFileSync(join(fixture.repo, 'target-next.txt'), 'target\n');
  git(fixture.repo, ['add', 'target-next.txt']);
  git(fixture.repo, ['commit', '-m', 'feat: advance target cleanly']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  const targetHead = git(fixture.repo, ['rev-parse', 'HEAD']);
  await waitFor(
    () => recordFor(fixture, task).auto_reclaim?.target_advance?.target_sha === targetHead,
    'watcher 未记录 target advance',
  );

  // 暂停在 push 前：托管操作挂起，但工作树是干净的——reclaimPreflight 只挡 git 层面的操作态
  // （rebase-merge/MERGE_HEAD 之类），挡不住 agentkit 自己的 review_refresh 字段。
  manager(fixture.repo, [`refresh-review`, task, '--pause-before-push']);
  const record = recordFor(fixture, task);
  assert.equal(record.review_refresh.state, 'rebased');
  assert.equal(
    JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.some(
      (finding) => finding.worktree_id === record.worktree_id && finding.code === 'REVIEW_REFRESH_PENDING',
    ),
    true,
    '活树上挂起的刷新是真信号，必须照报',
  );

  git(fixture.repo, ['merge', '--no-ff', '--no-edit', record.branch]);
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['reclaim', task, '--pushed', pushed]);
  const reclaimed = recordFor(fixture, task, true);
  assert.equal(reclaimed.worktree_state, 'reclaimed');
  assert.ok(reclaimed.review_refresh, 'reclaim 不清 review_refresh：噪声的来源就是这条残留');

  // 残留字段是既有行为，本用例只钉死 doctor 的口径：目录没了就不能再报一条谁也 finalize
  // 不掉的 error，否则「任何 error 都暂停 spawn/adopt」会把整条派工链钉死。
  assert.equal(
    JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.some(
      (finding) => finding.worktree_id === record.worktree_id && finding.code === 'REVIEW_REFRESH_PENDING',
    ),
    false,
    '已回收 record 不得再报 REVIEW_REFRESH_PENDING',
  );
});
