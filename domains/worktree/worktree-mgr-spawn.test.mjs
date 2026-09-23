import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  git,
  manager,
  managerWithEnvironment,
  managerAsync,
  makeRepo,
  makeRemoteRepo,
  publishProfile,
  configureGitlabSubmit,
  waitFor,
  recordFor,
  worktreeFor,
  branchFor,
  managerStderr,
} from '../../tests/helpers/worktree-mgr-fixture.mjs';

test('submit 以真实 GitLab push-options 推送、登记 MR 并自动 arm watcher', async (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  const optionsLog = configureGitlabSubmit(fixture);
  const task = 'gitlab-submit';
  manager(fixture.repo, [
    'spawn',
    task,
    '--agent',
    'codex',
    '--agent-id',
    'submit-thread',
    '--purpose',
    'one command MR',
  ]);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, 'submit.txt'), 'submitted\n');
  git(worktree, ['add', 'submit.txt']);
  git(worktree, ['commit', '-m', 'feat: submit fixture']);

  const output = manager(fixture.repo, [
    'submit',
    task,
    '--description',
    'portable submit fixture',
    '--interval-ms',
    '100',
    '--notify',
    'off',
  ]);
  assert.match(output, /GitLab MR 已提交/);
  assert.match(output, /watcher 已启动/);
  assert.deepEqual(readFileSync(optionsLog, 'utf8').trim().split('\n'), [
    'merge_request.create',
    'merge_request.target=main',
    'merge_request.title=feat: submit fixture',
    'merge_request.description=portable submit fixture',
    'merge_request.remove_source_branch',
  ]);

  let record = recordFor(fixture, task);
  assert.equal(record.task_status, 'ready_for_review');
  assert.equal(record.change_request.provider, 'gitlab');
  assert.equal(record.change_request.head_sha, git(worktree, ['rev-parse', 'HEAD']));
  assert.equal(record.auto_reclaim.state, 'watching');
  assert.equal(record.auto_reclaim.change_ref, `GitLab MR ${branchFor(fixture, task)} -> main`);

  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, task)]);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  await waitFor(() => recordFor(fixture, task, true)?.worktree_state === 'reclaimed', 'submit watcher 未在合入后回收');
  record = recordFor(fixture, task, true);
  assert.equal(record.task_status, 'done');
  assert.equal(record.reclaim_summary.change_ref, `GitLab MR ${record.branch} -> main`);
});

test('submit 对已经完整推送的 HEAD 明确拒绝，不伪造 MR 创建', async (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  configureGitlabSubmit(fixture);
  const task = 'submit-up-to-date';
  manager(fixture.repo, [
    'spawn',
    task,
    '--agent',
    'codex',
    '--agent-id',
    'submit-upstream',
    '--purpose',
    'upstream guard',
  ]);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, 'already.txt'), 'already pushed\n');
  git(worktree, ['add', 'already.txt']);
  git(worktree, ['commit', '-m', 'feat: already pushed']);
  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  git(worktree, ['branch', '--unset-upstream']);

  const result = await managerAsync(fixture.repo, ['submit', task, '--notify', 'off']);
  assert.ok(result.error);
  assert.match(result.stderr, /当前 HEAD 已完整存在于 remote/);
  const record = recordFor(fixture, task);
  assert.equal(record.task_status, 'active');
  assert.equal(record.auto_reclaim, undefined);
});

test('generic 双 Agent 生命周期、audit、reclaim 与同名返工', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'portable-task',
    '--agent',
    'codex',
    '--agent-id',
    'thread-1',
    '--purpose',
    'portable lifecycle',
  ]);
  const worktree = worktreeFor(fixture, 'portable-task');
  writeFileSync(join(worktree, 'feature.txt'), 'first agent\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: first agent change']);

  manager(fixture.repo, ['touch', 'portable-task', '--status', 'blocked', '--note', 'fixture wait']);
  manager(fixture.repo, ['touch', 'portable-task', '--status', 'active']);
  manager(fixture.repo, [
    'handoff',
    'portable-task',
    '--to-agent',
    'kiro',
    '--to-agent-id',
    'task-2',
    '--note',
    'continue tests',
  ]);
  git(worktree, ['commit', '--amend', '-m', 'feat: rewritten after handoff']);
  manager(fixture.repo, ['touch', 'portable-task', '--status', 'ready_for_review']);
  manager(fixture.repo, ['touch', 'portable-task', '--status', 'integrating']);
  manager(fixture.repo, ['touch', 'portable-task', '--status', 'active', '--note', 'integration regression']);
  manager(fixture.repo, ['touch', 'portable-task', '--status', 'ready_for_review']);
  manager(fixture.repo, ['touch', 'portable-task', '--status', 'integrating']);
  manager(fixture.repo, ['touch', 'portable-task', '--status', 'done']);

  const audit = JSON.parse(manager(fixture.repo, ['audit', 'portable-task', '--json']));
  assert.equal(audit.record.agent.host, 'kiro');
  assert.equal(audit.ownership_epochs.length, 2);
  assert.equal(audit.ownership_epochs[0].attribution.commits[0].subject, 'feat: first agent change');
  assert.equal(audit.ownership_epochs[1].attribution.degraded, true);
  assert.match(audit.ownership_epochs[1].attribution.reason, /rewritten/);
  const firstId = audit.record.worktree_id;

  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, 'portable-task')]);
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['reclaim', 'portable-task', '--pushed', pushed]);
  const all = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  const reclaimedFirst = all.records.find((record) => record.worktree_id === firstId);
  const finalEpoch = reclaimedFirst.ownership_epochs.at(-1);
  assert.equal(reclaimedFirst.task_status, 'done');
  assert.equal(reclaimedFirst.worktree_state, 'reclaimed');
  assert.equal(reclaimedFirst.branch_cleanup.status, 'deleted');
  assert.equal(finalEpoch.end_sha, reclaimedFirst.last_head);
  assert.equal(finalEpoch.ended_at, reclaimedFirst.reclaimed_at);

  manager(fixture.repo, [
    'spawn',
    'portable-task',
    '--agent',
    'claude',
    '--agent-id',
    'session-3',
    '--purpose',
    'same task rework',
  ]);
  const second = JSON.parse(manager(fixture.repo, ['list', '--json']));
  const current = second.worktrees.find((row) => row.kind === 'TRACKED');
  assert.notEqual(current.record.worktree_id, firstId);
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'RECLAIMED_PATH_CONFLICT'),
    false,
  );
});

test('spawn 同 Agent/task 幂等复用，不同 Agent 同 task 获得可读且唯一的命名', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const args = [
    'spawn',
    'shared-task',
    '--agent',
    'codex',
    '--agent-id',
    'same-thread',
    '--purpose',
    'idempotent naming',
  ];
  manager(fixture.repo, args);
  const first = recordFor(fixture, 'shared-task');
  manager(fixture.repo, args);
  let listing = JSON.parse(manager(fixture.repo, ['list', '--json']));
  assert.equal(listing.worktrees.filter((row) => row.record?.task === 'shared-task').length, 1);
  assert.match(first.path, /\.worktrees\/generic-repo\/codex-shared-task$/);
  assert.equal(first.branch, 'codex/shared-task');

  assert.throws(
    () =>
      manager(fixture.repo, [
        'spawn',
        'shared-task',
        '--agent',
        'codex',
        '--agent-id',
        'other-thread',
        '--purpose',
        'must not add random suffix',
      ]),
    /status 1|Command failed/,
  );

  manager(fixture.repo, [
    'spawn',
    'shared-task',
    '--agent',
    'claude',
    '--agent-id',
    'other-session',
    '--purpose',
    'parallel same task',
  ]);
  listing = JSON.parse(manager(fixture.repo, ['list', '--json']));
  const records = listing.worktrees.filter((row) => row.record?.task === 'shared-task').map((row) => row.record);
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((record) => record.path)).size, 2);
  assert.equal(new Set(records.map((record) => record.branch)).size, 2);
  assert.equal(
    records.some((record) => record.branch === 'claude/shared-task'),
    true,
  );
});

test('spawn 同一 Agent 会话换 task 默认拒绝，独立并行必须显式留原因', async (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'ios-capability-validation',
    '--agent',
    'codex',
    '--agent-id',
    'same-delivery-thread',
    '--purpose',
    'iOS 能力验收',
  ]);

  const blocked = await managerAsync(fixture.repo, [
    'spawn',
    'ios-latest-main-validation',
    '--agent',
    'codex',
    '--agent-id',
    'same-delivery-thread',
    '--purpose',
    '刷新 main 后继续 iOS 能力验收',
  ]);
  assert.ok(blocked.error);
  assert.match(blocked.stderr, /DELIVERY_WORKTREE_EXISTS/);
  assert.match(blocked.stderr, /直接进入原路径工作/);
  assert.equal(recordFor(fixture, 'ios-latest-main-validation'), undefined);

  manager(fixture.repo, [
    'spawn',
    'independent-release-audit',
    '--agent',
    'codex',
    '--agent-id',
    'same-delivery-thread',
    '--purpose',
    '独立发布审计',
    '--parallel-reason',
    '与 iOS 验收可独立评审、合入和回退',
  ]);
  const parallel = recordFor(fixture, 'independent-release-audit');
  assert.equal(parallel.delivery_relation.kind, 'parallel');
  assert.match(parallel.delivery_relation.reason, /独立评审/);
  assert.equal(parallel.delivery_relation.related_worktree_ids.length, 1);
});

test('spawn 拒绝复用同名存量 branch，避免返工静默继承旧 tip', async (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const task = 'stale-branch-rework';
  const branch = `codex/${task}`;
  git(fixture.repo, ['switch', '-c', branch]);
  writeFileSync(join(fixture.repo, 'stale.txt'), 'old unmerged work\n');
  git(fixture.repo, ['add', 'stale.txt']);
  git(fixture.repo, ['commit', '-m', 'test: stale branch fixture']);
  const staleTip = git(fixture.repo, ['rev-parse', 'HEAD']);
  git(fixture.repo, ['switch', 'trunk']);

  const result = await managerAsync(fixture.repo, [
    'spawn',
    task,
    '--agent',
    'codex',
    '--agent-id',
    'rework-thread',
    '--purpose',
    'must not reuse stale tip',
  ]);
  assert.ok(result.error);
  assert.match(result.stderr, /BRANCH_ALREADY_EXISTS/);
  assert.match(result.stderr, /静默继承旧 tip/);
  assert.match(result.stderr, /handoff/);
  assert.match(result.stderr, /adopt/);
  assert.equal(git(fixture.repo, ['rev-parse', branch]), staleTip);
  assert.equal(recordFor(fixture, task), undefined);
  assert.equal(existsSync(join(fixture.sandbox, '.worktrees', 'generic-repo', `codex-${task}`)), false);
});

test('spawn --root 显式覆盖 WORKTREE_ROOT 并仍追加短仓库容器', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const explicitRoot = join(fixture.sandbox, 'explicit-root');
  manager(fixture.repo, [
    'spawn',
    'root-precedence',
    '--agent',
    'codex',
    '--agent-id',
    'root-1',
    '--purpose',
    'verify root precedence',
    '--root',
    explicitRoot,
  ]);
  const record = recordFor(fixture, 'root-precedence');
  const canonicalRoot = realpathSync(explicitRoot);
  assert.equal(record.path.startsWith(join(canonicalRoot, 'generic-repo')), true);
  assert.equal(record.naming.repository_root, join(canonicalRoot, 'generic-repo'));
  assert.equal(record.naming.root_source, 'cli');
});

test('零配置默认 root 不可写时降级到仓库同级目录并记录来源', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows ACL 不能用 POSIX chmod 稳定构造 EACCES；行为由跨平台错误码分支覆盖');
    return;
  }
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const lockedHome = join(fixture.sandbox, 'locked-home');
  mkdirSync(lockedHome);
  chmodSync(lockedHome, 0o555);
  t.after(() => {
    if (existsSync(lockedHome)) chmodSync(lockedHome, 0o755);
  });

  const output = managerWithEnvironment(
    fixture.repo,
    [
      'spawn',
      'sandbox-fallback',
      '--agent',
      'codex',
      '--agent-id',
      'sandbox-root-1',
      '--purpose',
      'verify sandbox root fallback',
    ],
    { HOME: lockedHome, WORKTREE_ROOT: undefined },
  );

  assert.match(output, /默认 worktree_root 不可写.*fallback:repository-sibling/);
  const record = recordFor(fixture, 'sandbox-fallback');
  assert.equal(record.path.startsWith(join(realpathSync(fixture.sandbox), '.worktrees', 'generic-repo')), true);
  assert.equal(record.naming.root_source, 'fallback:repository-sibling');
});

test('显式 root 不可写时 fail-closed 且不遗留空 branch', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows ACL 不能用 POSIX chmod 稳定构造 EACCES；行为由跨平台错误码分支覆盖');
    return;
  }
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const lockedRoot = join(fixture.sandbox, 'locked-root');
  mkdirSync(lockedRoot);
  chmodSync(lockedRoot, 0o555);
  t.after(() => {
    if (existsSync(lockedRoot)) chmodSync(lockedRoot, 0o755);
  });

  const task = 'strict-root-failure';
  const result = await managerAsync(fixture.repo, [
    'spawn',
    task,
    '--agent',
    'codex',
    '--agent-id',
    'strict-root-1',
    '--purpose',
    'verify explicit root failure',
    '--root',
    lockedRoot,
  ]);
  assert.ok(result.error);
  assert.match(result.stderr, /WORKTREE_ROOT_UNWRITABLE/);
  assert.throws(() => git(fixture.repo, ['show-ref', '--verify', '--quiet', `refs/heads/codex/${task}`]));
});

test('git worktree add 创建路径失败后只回滚未挂载且等于 base 的空 branch', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows long-path 策略依宿主配置而异，不能稳定制造 add 阶段的 ENAMETOOLONG');
    return;
  }
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  writeFileSync(
    join(fixture.repo, '.worktree-trace.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        path_template: '{host}-{task}-{task}-{task}-{task}-{task}',
      },
      null,
      2,
    )}\n`,
  );

  const task = `branch-rollback-${'x'.repeat(40)}`;
  const result = await managerAsync(fixture.repo, [
    'spawn',
    task,
    '--agent',
    'codex',
    '--agent-id',
    'branch-rollback-1',
    '--purpose',
    'verify add failure branch rollback',
  ]);
  assert.ok(result.error);
  assert.match(result.stderr, /git worktree add 失败[\s\S]*empty branch removed/);
  assert.throws(() => git(fixture.repo, ['show-ref', '--verify', '--quiet', `refs/heads/codex/${task}`]));
});

test('外部 worktree 默认 UNTRACKED，adopt 自动推断 task；detached 强制 task', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const external = join(fixture.sandbox, 'external tree');
  git(fixture.repo, ['worktree', 'add', '-b', 'fix/external-adopt', external]);
  let listed = JSON.parse(manager(fixture.repo, ['list', '--json']));
  assert.equal(listed.summary.untracked, 1);
  manager(fixture.repo, [
    'adopt',
    external,
    '--agent',
    'claude',
    '--agent-id',
    'session-x',
    '--purpose',
    'adopt harness tree',
  ]);
  listed = JSON.parse(manager(fixture.repo, ['list', '--json']));
  assert.equal(listed.summary.untracked, 0);
  assert.equal(listed.worktrees.find((row) => row.kind === 'TRACKED').record.task, 'external-adopt');

  const detached = join(fixture.sandbox, 'detached tree');
  git(fixture.repo, ['worktree', 'add', '--detach', detached]);
  assert.throws(
    () =>
      manager(fixture.repo, [
        'adopt',
        detached,
        '--agent',
        'codex',
        '--agent-id',
        'thread-y',
        '--purpose',
        'detached fixture',
      ]),
    /status 1|Command failed/,
  );
  manager(fixture.repo, [
    'adopt',
    detached,
    '--task',
    'detached-task',
    '--agent',
    'codex',
    '--agent-id',
    'thread-y',
    '--purpose',
    'detached fixture',
  ]);
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.filter((finding) => finding.code === 'UNTRACKED_WORKTREE').length, 0);
});

test('handoff 拒绝脏树', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'dirty-task',
    '--agent',
    'codex',
    '--agent-id',
    'thread-d',
    '--purpose',
    'dirty handoff guard',
  ]);
  const worktree = worktreeFor(fixture, 'dirty-task');
  writeFileSync(join(worktree, 'dirty.txt'), 'not committed\n');
  assert.throws(
    () =>
      manager(fixture.repo, [
        'handoff',
        'dirty-task',
        '--to-agent',
        'kiro',
        '--to-agent-id',
        'task-d',
        '--note',
        'should fail',
      ]),
    /status 1|Command failed/,
  );
});

test('repository Profile 使用可读 host/task 分支与 origin/main base', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const remote = join(fixture.sandbox, 'origin.git');
  mkdirSync(remote);
  git(remote, ['init', '--bare']);
  git(fixture.repo, ['remote', 'add', 'origin', remote]);
  git(fixture.repo, ['push', 'origin', 'trunk:main']);
  git(fixture.repo, ['fetch', 'origin']);
  writeFileSync(
    join(fixture.repo, '.worktree-trace.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        default_base: 'origin/main',
        branch_template: '{host}/{task}',
        path_template: '{host}-{task}',
        task_naming: { mode: 'semantic', example: 'ci-gate-hardening' },
        scan: { sources: ['git_worktrees', 'recent_commits'] },
        ephemeral_path_patterns: [],
        extensions: { fixture: { finish_command: 'must-not-execute' } },
      },
      null,
      2,
    )}\n`,
  );
  publishProfile(fixture);
  manager(fixture.repo, [
    'spawn',
    'profile-task',
    '--agent',
    'kiro',
    '--agent-id',
    'profile-1',
    '--purpose',
    'profile integration',
  ]);
  const listed = JSON.parse(manager(fixture.repo, ['list', '--json']));
  const tracked = listed.worktrees.find((row) => row.kind === 'TRACKED');
  assert.equal(tracked.branch, 'kiro/profile-task');
  assert.equal(tracked.record.base_ref, 'origin/main');
});

test('非默认 base 必须记录原因，record 与 doctor 持续可见', (t) => {
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

  assert.throws(
    () =>
      manager(fixture.repo, [
        'spawn',
        'dependency-base',
        '--base',
        'HEAD',
        '--agent',
        'codex',
        '--agent-id',
        'base-guard-1',
        '--purpose',
        'dependency branch fixture',
      ]),
    /status 2|Command failed/,
  );

  manager(fixture.repo, [
    'spawn',
    'dependency-base',
    '--base',
    'HEAD',
    '--base-reason',
    '先进入依赖分支',
    '--agent',
    'codex',
    '--agent-id',
    'base-guard-1',
    '--purpose',
    'dependency branch fixture',
  ]);
  const record = recordFor(fixture, 'dependency-base');
  assert.equal(record.base_ref, 'HEAD');
  assert.equal(record.base_reason, '先进入依赖分支');
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  const finding = doctor.findings.find(
    (item) => item.worktree_id === record.worktree_id && item.code === 'BASE_OVERRIDE',
  );
  assert.equal(finding.base_reason, '先进入依赖分支');
  assert.equal(finding.default_base, 'origin/main');
});

test('touch 可一次登记 MR URL、评审状态与 watcher target，并拒绝非 HTTP URL', (t) => {
  const fixture = makeRemoteRepo();
  const task = 'structured-mr-touch';
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
    'structured-mr-thread',
    '--purpose',
    '一次登记 MR',
  ]);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, 'mr.txt'), 'mr\n');
  git(worktree, ['add', 'mr.txt']);
  git(worktree, ['commit', '-m', 'feat: structured MR']);
  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  const mrUrl = 'https://gitlab.example.invalid/group/project/-/merge_requests/42';
  const output = manager(fixture.repo, [
    'touch',
    task,
    '--status',
    'ready_for_review',
    '--mr',
    mrUrl,
    '--watch-target',
    'origin/main',
    '--interval-ms',
    '100',
    '--notify',
    'off',
  ]);
  assert.match(output, /watch 已武装/);
  const record = recordFor(fixture, task);
  assert.equal(record.task_status, 'ready_for_review');
  assert.equal(record.change_request.url, mrUrl);
  assert.equal(record.change_request.target_ref, 'origin/main');
  assert.equal(record.auto_reclaim.target_ref, 'origin/main');
  assert.equal(record.auto_reclaim.change_ref, mrUrl);
  assert.match(
    managerStderr(fixture.repo, [
      'touch',
      task,
      '--status',
      'ready_for_review',
      '--mr',
      'javascript:alert(1)',
      '--no-watch',
    ]),
    /http/iu,
  );
});
