import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { batchFingerprint, deliverReclaimNotification, isCliEntry, normalizeCodegraphMode, processIsAlive, runFileTry } from './worktree-mgr.mjs';
import { appendTraceEvent } from './worktree-trace.mjs';

const MANAGER = join(dirname(fileURLToPath(import.meta.url)), 'worktree-mgr.mjs');

test('CodeGraph mode 默认 auto 且只接受 auto/on/off', () => {
  assert.equal(normalizeCodegraphMode(null), 'auto');
  assert.equal(normalizeCodegraphMode('auto'), 'auto');
  assert.equal(normalizeCodegraphMode('on'), 'on');
  assert.equal(normalizeCodegraphMode('off'), 'off');
  assert.throws(() => normalizeCodegraphMode('shared'), /auto\/on\/off/);
});

test('批次指纹只绑定 Git SHA 与输入顺序，不依赖宿主路径', () => {
  const target = 'a'.repeat(40);
  const inputs = ['b'.repeat(40), 'c'.repeat(40)];
  assert.equal(batchFingerprint(target, inputs), batchFingerprint(target, [...inputs]));
  assert.notEqual(batchFingerprint(target, inputs), batchFingerprint(target, [...inputs].reverse()));
  assert.notEqual(batchFingerprint(target, inputs), batchFingerprint('d'.repeat(40), inputs));
  assert.match(batchFingerprint(target, inputs), /^sha256:[0-9a-f]{64}$/);
});

test('外部命令超过 timeout 后有界失败，不无限阻塞 spawn', () => {
  const startedAt = Date.now();
  const result = runFileTry(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 5_000)'],
    { timeoutMs: 50 },
  );
  assert.equal(result.ok, false);
  assert.ok(Date.now() - startedAt < 1_000);
});

test('PID probe 的 EPERM 表示进程存在，不能误报 watcher stale', () => {
  assert.equal(processIsAlive(123, () => {}), true);
  assert.equal(processIsAlive(123, () => {
    const error = new Error('sandbox denied signal probe');
    error.code = 'EPERM';
    throw error;
  }), true);
  assert.equal(processIsAlive(123, () => {
    const error = new Error('missing process');
    error.code = 'ESRCH';
    throw error;
  }), false);
});

test('回收通知 adapter 使用固定 argv，关闭或平台不可用都不影响终态', () => {
  const record = {
    task: 'notify-task',
    auto_reclaim: { notify: 'auto' },
    reclaim_summary: { change_ref: 'MR !42' },
  };
  const calls = [];
  const delivered = deliverReclaimNotification(record, {
    platform: 'darwin',
    runner(command, args, options) {
      calls.push({ command, args, options });
      return { ok: true, out: '' };
    },
  });
  assert.equal(delivered.delivered, true);
  assert.equal(calls[0].command, 'osascript');
  assert.equal(calls[0].args.at(-2), 'notify-task (MR !42) 已自动回收');
  assert.equal(calls[0].args.includes('notify-task'), false, '用户文本不能插入 AppleScript 源码参数');

  const disabled = deliverReclaimNotification({ ...record, auto_reclaim: { notify: 'off' } }, { platform: 'darwin' });
  assert.deepEqual(disabled, { attempted: false, delivered: false, adapter: 'off', reason: 'disabled' });
  const unavailable = deliverReclaimNotification(record, { platform: 'freebsd' });
  assert.equal(unavailable.adapter, 'unavailable');
  assert.equal(unavailable.attempted, false);
});

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** @param {string} cwd @param {string[]} args */
function manager(cwd, args) {
  return execFileSync(process.execPath, [MANAGER, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORKTREE_ROOT: join(dirname(cwd), '.worktrees') },
  }).trim();
}

/** @param {string} cwd @param {string[]} args @param {Record<string,string|undefined>} overrides */
function managerWithEnvironment(cwd, args, overrides) {
  const env = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return execFileSync(process.execPath, [MANAGER, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  }).trim();
}

/** @param {string} cwd @param {string[]} args */
function managerKeep(cwd, args) {
  try {
    manager(cwd, args);
    assert.fail('KEEP command should exit non-zero');
  } catch (error) {
    assert.equal(error.status, 1);
    return String(error.stdout ?? '').trim();
  }
}

/** @param {string} cwd @param {string[]} args */
function managerAsync(cwd, args) {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [MANAGER, ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, WORKTREE_ROOT: join(dirname(cwd), '.worktrees') },
    }, (error, stdout, stderr) => resolvePromise({ error, stdout, stderr }));
  });
}

function makeRepo() {
  const sandbox = mkdtempSync(join(tmpdir(), 'worktree-mgr-test-'));
  const repo = join(sandbox, 'generic-repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'trunk']);
  git(repo, ['config', 'user.name', 'Manager Test']);
  git(repo, ['config', 'user.email', 'manager-test@example.invalid']);
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'chore: init']);
  return { sandbox, repo, cleanup: () => rmSync(sandbox, { recursive: true, force: true }) };
}

function makeRemoteRepo() {
  const fixture = makeRepo();
  const remote = join(fixture.sandbox, 'origin.git');
  mkdirSync(remote);
  git(remote, ['init', '--bare']);
  git(fixture.repo, ['remote', 'add', 'origin', remote]);
  git(fixture.repo, ['push', 'origin', 'trunk:main']);
  git(fixture.repo, ['fetch', 'origin', 'main']);
  return { ...fixture, remote };
}

function publishProfile(fixture, message = 'chore: publish worktree profile') {
  git(fixture.repo, ['add', '.worktree-trace.json']);
  git(fixture.repo, ['commit', '-m', message]);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
}

function configureGitlabSubmit(fixture) {
  writeFileSync(join(fixture.repo, '.worktree-trace.json'), `${JSON.stringify({
    schema_version: 1,
    default_base: 'origin/main',
    change_request: {
      provider: 'gitlab',
      remote: 'origin',
      target_branch: 'main',
      remove_source_branch: true,
    },
  }, null, 2)}\n`);
  publishProfile(fixture);
  git(fixture.remote, ['config', 'receive.advertisePushOptions', 'true']);
  const hook = join(fixture.remote, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh
log="$(dirname "$0")/push-options.log"
printf '%s\n' "$GIT_PUSH_OPTION_0" "$GIT_PUSH_OPTION_1" "$GIT_PUSH_OPTION_2" "$GIT_PUSH_OPTION_3" "$GIT_PUSH_OPTION_4" > "$log"
cat >/dev/null
`);
  chmodSync(hook, 0o755);
  return join(fixture.remote, 'hooks', 'push-options.log');
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  assert.fail(message);
}

function prepareReviewTask(fixture, task) {
  manager(fixture.repo, ['spawn', task, '--base', 'origin/main', '--agent', 'codex', '--agent-id', `watch-${task}`, '--purpose', 'auto reclaim fixture']);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, 'feature.txt'), `${task}\n`);
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', `feat: ${task}`]);
  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--note', 'fixture MR created']);
  return { worktree };
}

function prepareWatchedTask(fixture, task) {
  const prepared = prepareReviewTask(fixture, task);
  const output = manager(fixture.repo, ['watch', task, '--target', 'origin/main', '--interval-ms', '100', '--change-ref', `MR !${task}`, '--notify', 'off']);
  assert.match(output, /watcher 已启动/);
  return prepared;
}

function recordFor(fixture, task, includeAll = false) {
  const args = ['list'];
  if (includeAll) args.push('--all');
  args.push('--json');
  const listing = JSON.parse(manager(fixture.repo, args));
  return listing.worktrees.find((row) => row.record?.task === task)?.record
    ?? listing.records.find((record) => record.task === task);
}

function worktreeFor(fixture, task) {
  return recordFor(fixture, task).path;
}

function branchFor(fixture, task) {
  return recordFor(fixture, task).branch;
}

/** 造一个本地裸源仓，供 `git submodule add` 用 file 协议克隆，不依赖网络。 */
function makeSubmoduleSource(fixture) {
  const source = join(fixture.sandbox, 'submodule-source');
  mkdirSync(source);
  git(source, ['init', '-q', '-b', 'main']);
  git(source, ['config', 'user.name', 'Manager Test']);
  git(source, ['config', 'user.email', 'manager-test@example.invalid']);
  writeFileSync(join(source, 'lib.txt'), 'submodule fixture\n');
  git(source, ['add', 'lib.txt']);
  git(source, ['commit', '-m', 'chore: submodule init']);
  return source;
}

/**
 * 在 fixture.repo 的 trunk 上登记一个 submodule（供后续 spawn 的 task 分支带上）。
 * `ignoreAll` 用于隔离测试：设 `submodule.<path>.ignore=all` 后顶层 `git status --porcelain`
 * 不再反映 submodule 内部脏状态，才能验证 reclaim 自己的逐 submodule 检查确实生效，
 * 而不是被更早的顶层 dirty 审计先行拦下。
 */
function addSubmoduleFixture(fixture, { ignoreAll = false } = {}) {
  const source = makeSubmoduleSource(fixture);
  git(fixture.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'vendor/sub']);
  if (ignoreAll) git(fixture.repo, ['config', '-f', '.gitmodules', 'submodule.vendor/sub.ignore', 'all']);
  git(fixture.repo, ['add', '.gitmodules', 'vendor/sub']);
  git(fixture.repo, ['commit', '-m', 'chore: add submodule fixture']);
}

/** `git worktree add` 不会自动初始化 submodule，测试里需要显式补一步。 */
function initSubmoduleInWorktree(worktree) {
  git(worktree, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init']);
}

/** 树私有的 submodule 元数据目录：$GIT_COMMON_DIR/worktrees/<id>/modules/。 */
function submodulesModulesDir(worktree) {
  const gitDir = execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
  return join(gitDir, 'modules');
}

test('submit 以真实 GitLab push-options 推送、登记 MR 并自动 arm watcher', async (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  const optionsLog = configureGitlabSubmit(fixture);
  const task = 'gitlab-submit';
  manager(fixture.repo, ['spawn', task, '--agent', 'codex', '--agent-id', 'submit-thread', '--purpose', 'one command MR']);
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
  manager(fixture.repo, ['spawn', task, '--agent', 'codex', '--agent-id', 'submit-upstream', '--purpose', 'upstream guard']);
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
  manager(fixture.repo, ['spawn', 'portable-task', '--agent', 'codex', '--agent-id', 'thread-1', '--purpose', 'portable lifecycle']);
  const worktree = worktreeFor(fixture, 'portable-task');
  writeFileSync(join(worktree, 'feature.txt'), 'first agent\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: first agent change']);

  manager(fixture.repo, ['touch', 'portable-task', '--status', 'blocked', '--note', 'fixture wait']);
  manager(fixture.repo, ['touch', 'portable-task', '--status', 'active']);
  manager(fixture.repo, ['handoff', 'portable-task', '--to-agent', 'kiro', '--to-agent-id', 'task-2', '--note', 'continue tests']);
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

  manager(fixture.repo, ['spawn', 'portable-task', '--agent', 'claude', '--agent-id', 'session-3', '--purpose', 'same task rework']);
  const second = JSON.parse(manager(fixture.repo, ['list', '--json']));
  const current = second.worktrees.find((row) => row.kind === 'TRACKED');
  assert.notEqual(current.record.worktree_id, firstId);
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.some((finding) => finding.code === 'RECLAIMED_PATH_CONFLICT'), false);
});

test('spawn 同 Agent/task 幂等复用，不同 Agent 同 task 获得可读且唯一的命名', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const args = ['spawn', 'shared-task', '--agent', 'codex', '--agent-id', 'same-thread', '--purpose', 'idempotent naming'];
  manager(fixture.repo, args);
  const first = recordFor(fixture, 'shared-task');
  manager(fixture.repo, args);
  let listing = JSON.parse(manager(fixture.repo, ['list', '--json']));
  assert.equal(listing.worktrees.filter((row) => row.record?.task === 'shared-task').length, 1);
  assert.match(first.path, /\.worktrees\/generic-repo\/codex-shared-task$/);
  assert.equal(first.branch, 'codex/shared-task');

  assert.throws(
    () => manager(fixture.repo, [
      'spawn', 'shared-task', '--agent', 'codex', '--agent-id', 'other-thread', '--purpose', 'must not add random suffix',
    ]),
    /status 1|Command failed/,
  );

  manager(fixture.repo, ['spawn', 'shared-task', '--agent', 'claude', '--agent-id', 'other-session', '--purpose', 'parallel same task']);
  listing = JSON.parse(manager(fixture.repo, ['list', '--json']));
  const records = listing.worktrees.filter((row) => row.record?.task === 'shared-task').map((row) => row.record);
  assert.equal(records.length, 2);
  assert.equal(new Set(records.map((record) => record.path)).size, 2);
  assert.equal(new Set(records.map((record) => record.branch)).size, 2);
  assert.equal(records.some((record) => record.branch === 'claude/shared-task'), true);
});

test('spawn 同一 Agent 会话换 task 默认拒绝，独立并行必须显式留原因', async (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn', 'ios-capability-validation', '--agent', 'codex', '--agent-id', 'same-delivery-thread',
    '--purpose', 'iOS 能力验收',
  ]);

  const blocked = await managerAsync(fixture.repo, [
    'spawn', 'ios-latest-main-validation', '--agent', 'codex', '--agent-id', 'same-delivery-thread',
    '--purpose', '刷新 main 后继续 iOS 能力验收',
  ]);
  assert.ok(blocked.error);
  assert.match(blocked.stderr, /DELIVERY_WORKTREE_EXISTS/);
  assert.match(blocked.stderr, /直接进入原路径工作/);
  assert.equal(recordFor(fixture, 'ios-latest-main-validation'), undefined);

  manager(fixture.repo, [
    'spawn', 'independent-release-audit', '--agent', 'codex', '--agent-id', 'same-delivery-thread',
    '--purpose', '独立发布审计', '--parallel-reason', '与 iOS 验收可独立评审、合入和回退',
  ]);
  const parallel = recordFor(fixture, 'independent-release-audit');
  assert.equal(parallel.delivery_relation.kind, 'parallel');
  assert.match(parallel.delivery_relation.reason, /独立评审/);
  assert.equal(parallel.delivery_relation.related_worktree_ids.length, 1);
});

test('spawn 替代树要求旧树先冻结且干净，并双向登记关系', async (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn', 'ios-old-baseline', '--agent', 'codex', '--agent-id', 'replacement-thread',
    '--purpose', '旧 iOS 基线',
  ]);

  const activeBlocked = await managerAsync(fixture.repo, [
    'spawn', 'ios-current-baseline', '--agent', 'codex', '--agent-id', 'replacement-thread',
    '--purpose', '新 iOS 基线', '--supersedes', 'ios-old-baseline', '--replacement-reason', '旧基线无法继续',
  ]);
  assert.ok(activeBlocked.error);
  assert.match(activeBlocked.stderr, /替代前必须先冻结旧树/);

  manager(fixture.repo, ['touch', 'ios-old-baseline', '--status', 'abandoned', '--note', '冻结旧树，迁移到新基线']);
  manager(fixture.repo, [
    'spawn', 'ios-current-baseline', '--agent', 'codex', '--agent-id', 'replacement-thread',
    '--purpose', '新 iOS 基线', '--supersedes', 'ios-old-baseline', '--replacement-reason', '旧基线无法继续且迁移边界已冻结',
  ]);

  const replacement = recordFor(fixture, 'ios-current-baseline');
  const superseded = recordFor(fixture, 'ios-old-baseline');
  assert.equal(replacement.delivery_relation.kind, 'supersedes');
  assert.equal(replacement.delivery_relation.superseded_worktree_id, superseded.worktree_id);
  assert.equal(superseded.superseded_by.worktree_id, replacement.worktree_id);
});

test('supersede 为存量替代树补齐双向关系并消除未声明并存告警', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn', 'legacy-old-baseline', '--agent', 'codex', '--agent-id', 'legacy-replacement-thread',
    '--purpose', '旧基线',
  ]);
  manager(fixture.repo, ['touch', 'legacy-old-baseline', '--status', 'abandoned', '--note', '冻结旧基线']);
  manager(fixture.repo, [
    'spawn', 'legacy-current-baseline', '--agent', 'codex', '--agent-id', 'legacy-replacement-thread',
    '--purpose', '新基线', '--supersedes', 'legacy-old-baseline', '--replacement-reason', '旧基线已被替代',
  ]);

  const oldBefore = recordFor(fixture, 'legacy-old-baseline');
  const replacementBefore = recordFor(fixture, 'legacy-current-baseline');
  appendTraceEvent({
    commonDir: join(fixture.repo, '.git'),
    worktreeId: oldBefore.worktree_id,
    eventType: 'test_remove_superseded_by',
    actor: oldBefore.agent,
    mutate(current) {
      const next = structuredClone(current);
      delete next.superseded_by;
      return next;
    },
  });
  appendTraceEvent({
    commonDir: join(fixture.repo, '.git'),
    worktreeId: replacementBefore.worktree_id,
    eventType: 'test_remove_delivery_relation',
    actor: replacementBefore.agent,
    mutate(current) {
      const next = structuredClone(current);
      delete next.delivery_relation;
      return next;
    },
  });

  let doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.some((finding) => finding.code === 'UNDECLARED_SESSION_WORKTREE_MULTIPLICITY'), true);
  assert.equal(doctor.findings.some((finding) => finding.code === 'ABANDONED_WORKTREE_RECLAIM_PENDING'), true);

  assert.match(manager(fixture.repo, [
    'supersede', 'legacy-old-baseline', '--by', 'legacy-current-baseline', '--reason', '旧基线已被替代',
  ]), /替代关系已登记/);
  const oldAfter = recordFor(fixture, 'legacy-old-baseline');
  const replacementAfter = recordFor(fixture, 'legacy-current-baseline');
  assert.equal(oldAfter.superseded_by.worktree_id, replacementAfter.worktree_id);
  assert.equal(replacementAfter.delivery_relation.superseded_worktree_id, oldAfter.worktree_id);
  assert.doesNotThrow(() => manager(fixture.repo, [
    'supersede', 'legacy-old-baseline', '--by', 'legacy-current-baseline', '--reason', '旧基线已被替代',
  ]), '同一关系应可幂等重跑');

  doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.some((finding) => finding.code === 'UNDECLARED_SESSION_WORKTREE_MULTIPLICITY'), false);
  assert.equal(doctor.findings.some((finding) => finding.code === 'SUPERSESSION_RELATION_BROKEN'), false);
  assert.equal(doctor.findings.some((finding) => finding.code === 'SUPERSEDED_WORKTREE_RECLAIM_PENDING'), true);
});

test('superseded reclaim 默认归档未推送旧 HEAD 后回收目录和分支', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn', 'archived-old-baseline', '--agent', 'codex', '--agent-id', 'archive-replacement-thread',
    '--purpose', '待归档旧基线',
  ]);
  const oldWorktree = worktreeFor(fixture, 'archived-old-baseline');
  writeFileSync(join(oldWorktree, 'unique-old.txt'), 'recoverable old work\n');
  git(oldWorktree, ['add', 'unique-old.txt']);
  git(oldWorktree, ['commit', '-m', 'feat: unique old work']);
  const oldHead = git(oldWorktree, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['touch', 'archived-old-baseline', '--status', 'abandoned', '--note', '独有提交待归档']);
  manager(fixture.repo, [
    'spawn', 'archived-current-baseline', '--agent', 'codex', '--agent-id', 'archive-replacement-thread',
    '--purpose', '替代基线', '--supersedes', 'archived-old-baseline', '--replacement-reason', '旧提交语义已迁移',
  ]);
  const oldRecord = recordFor(fixture, 'archived-old-baseline');
  const replacement = recordFor(fixture, 'archived-current-baseline');
  const archiveRef = `refs/worktree-archive/superseded/${oldRecord.worktree_id}`;

  writeFileSync(join(oldWorktree, 'unsaved.txt'), 'must block archive\n');
  assert.throws(() => manager(fixture.repo, [
    'reclaim', 'archived-old-baseline', '--superseded-by', 'archived-current-baseline',
  ]));
  assert.throws(() => git(fixture.repo, ['show-ref', '--verify', archiveRef]), 'dirty 旧树不得提前创建归档证据');
  rmSync(join(oldWorktree, 'unsaved.txt'));

  const output = manager(fixture.repo, [
    'reclaim', 'archived-old-baseline', '--superseded-by', 'archived-current-baseline',
  ]);
  assert.match(output, /已回收/);
  assert.match(output, /归档=refs\/worktree-archive\/superseded/);
  assert.equal(existsSync(oldWorktree), false);
  assert.equal(git(fixture.repo, ['rev-parse', `${archiveRef}^{commit}`]), oldHead);
  assert.equal(git(fixture.repo, ['show', `${archiveRef}:unique-old.txt`]), 'recoverable old work');
  assert.throws(() => git(fixture.repo, ['show-ref', '--verify', `refs/heads/${oldRecord.branch}`]));

  const reclaimed = recordFor(fixture, 'archived-old-baseline', true);
  assert.equal(reclaimed.worktree_state, 'reclaimed');
  assert.equal(reclaimed.task_status, 'abandoned');
  assert.equal(reclaimed.superseded_recovery.mode, 'archive_ref');
  assert.equal(reclaimed.reclaim_summary.reclaim_evidence.archive_ref, archiveRef);
  assert.equal(recordFor(fixture, 'archived-current-baseline').worktree_state, 'present');
  assert.equal(recordFor(fixture, 'archived-current-baseline').worktree_id, replacement.worktree_id);
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.some((finding) => finding.code === 'SUPERSEDED_WORKTREE_RECLAIM_PENDING'), false);
  assert.equal(doctor.findings.some((finding) => finding.code === 'UNDECLARED_SESSION_WORKTREE_MULTIPLICITY'), false);
});

test('superseded reclaim 只有精确 --discard SHA 才允许无归档回收', async (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn', 'discarded-old-baseline', '--agent', 'codex', '--agent-id', 'discard-replacement-thread',
    '--purpose', '待丢弃旧基线',
  ]);
  const oldWorktree = worktreeFor(fixture, 'discarded-old-baseline');
  writeFileSync(join(oldWorktree, 'obsolete.txt'), 'obsolete work\n');
  git(oldWorktree, ['add', 'obsolete.txt']);
  git(oldWorktree, ['commit', '-m', 'feat: obsolete work']);
  const oldHead = git(oldWorktree, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['touch', 'discarded-old-baseline', '--status', 'abandoned', '--note', '明确废弃']);
  manager(fixture.repo, [
    'spawn', 'discarded-current-baseline', '--agent', 'codex', '--agent-id', 'discard-replacement-thread',
    '--purpose', '替代基线', '--supersedes', 'discarded-old-baseline', '--replacement-reason', '旧实现无需保留',
  ]);
  const oldRecord = recordFor(fixture, 'discarded-old-baseline');
  const archiveRef = `refs/worktree-archive/superseded/${oldRecord.worktree_id}`;

  const wrong = await managerAsync(fixture.repo, [
    'reclaim', 'discarded-old-baseline', '--superseded-by', 'discarded-current-baseline',
    '--discard', '0'.repeat(40),
  ]);
  assert.ok(wrong.error);
  assert.match(wrong.stderr, /SHA 与旧树 HEAD 不一致/);
  assert.equal(existsSync(oldWorktree), true);

  assert.match(manager(fixture.repo, [
    'reclaim', 'discarded-old-baseline', '--superseded-by', 'discarded-current-baseline',
    '--discard', oldHead,
  ]), /精确 SHA 授权丢弃/);
  assert.equal(existsSync(oldWorktree), false);
  assert.throws(() => git(fixture.repo, ['show-ref', '--verify', archiveRef]));
  const reclaimed = recordFor(fixture, 'discarded-old-baseline', true);
  assert.equal(reclaimed.superseded_recovery.mode, 'discard');
  assert.equal(reclaimed.superseded_recovery.source_sha, oldHead);
  assert.equal(reclaimed.reclaim_summary.reclaim_evidence.kind, 'superseded_discard');
});

test('doctor 报告同一会话遗留的未声明多 worktree', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn', 'first-delivery-tree', '--agent', 'codex', '--agent-id', 'doctor-thread', '--purpose', 'first tree',
  ]);
  manager(fixture.repo, [
    'spawn', 'second-delivery-tree', '--agent', 'codex', '--agent-id', 'doctor-thread', '--purpose', 'second tree',
    '--parallel-reason', 'fixture needs a declared second tree',
  ]);

  let doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.some((finding) => finding.code === 'UNDECLARED_SESSION_WORKTREE_MULTIPLICITY'), false);

  const second = recordFor(fixture, 'second-delivery-tree');
  appendTraceEvent({
    commonDir: join(fixture.repo, '.git'),
    worktreeId: second.worktree_id,
    eventType: 'test_remove_delivery_relation',
    actor: second.agent,
    mutate(current) {
      const next = structuredClone(current);
      delete next.delivery_relation;
      return next;
    },
  });
  doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.some((finding) => finding.code === 'UNDECLARED_SESSION_WORKTREE_MULTIPLICITY'), true);
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
    'spawn', task, '--agent', 'codex', '--agent-id', 'rework-thread', '--purpose', 'must not reuse stale tip',
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

  const output = managerWithEnvironment(fixture.repo, [
    'spawn',
    'sandbox-fallback',
    '--agent',
    'codex',
    '--agent-id',
    'sandbox-root-1',
    '--purpose',
    'verify sandbox root fallback',
  ], { HOME: lockedHome, WORKTREE_ROOT: undefined });

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
  writeFileSync(join(fixture.repo, '.worktree-trace.json'), `${JSON.stringify({
    schema_version: 1,
    path_template: '{host}-{task}-{task}-{task}-{task}-{task}',
  }, null, 2)}\n`);

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
  manager(fixture.repo, ['adopt', external, '--agent', 'claude', '--agent-id', 'session-x', '--purpose', 'adopt harness tree']);
  listed = JSON.parse(manager(fixture.repo, ['list', '--json']));
  assert.equal(listed.summary.untracked, 0);
  assert.equal(listed.worktrees.find((row) => row.kind === 'TRACKED').record.task, 'external-adopt');

  const detached = join(fixture.sandbox, 'detached tree');
  git(fixture.repo, ['worktree', 'add', '--detach', detached]);
  assert.throws(
    () => manager(fixture.repo, ['adopt', detached, '--agent', 'codex', '--agent-id', 'thread-y', '--purpose', 'detached fixture']),
    /status 1|Command failed/,
  );
  manager(fixture.repo, ['adopt', detached, '--task', 'detached-task', '--agent', 'codex', '--agent-id', 'thread-y', '--purpose', 'detached fixture']);
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.filter((finding) => finding.code === 'UNTRACKED_WORKTREE').length, 0);
});

test('handoff 拒绝脏树', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, ['spawn', 'dirty-task', '--agent', 'codex', '--agent-id', 'thread-d', '--purpose', 'dirty handoff guard']);
  const worktree = worktreeFor(fixture, 'dirty-task');
  writeFileSync(join(worktree, 'dirty.txt'), 'not committed\n');
  assert.throws(
    () => manager(fixture.repo, ['handoff', 'dirty-task', '--to-agent', 'kiro', '--to-agent-id', 'task-d', '--note', 'should fail']),
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
    `${JSON.stringify({
      schema_version: 1,
      default_base: 'origin/main',
      branch_template: '{host}/{task}',
      path_template: '{host}-{task}',
      task_naming: { mode: 'semantic', example: 'ci-gate-hardening' },
      scan: { sources: ['git_worktrees', 'recent_commits'] },
      ephemeral_path_patterns: [],
      extensions: { fixture: { finish_command: 'must-not-execute' } },
    }, null, 2)}\n`,
  );
  publishProfile(fixture);
  manager(fixture.repo, ['spawn', 'profile-task', '--agent', 'kiro', '--agent-id', 'profile-1', '--purpose', 'profile integration']);
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
    `${JSON.stringify({
      schema_version: 1,
      default_base: 'origin/main',
      branch_template: '{host}/{task}',
      path_template: '{host}-{task}',
      task_naming: { mode: 'semantic', example: 'ci-gate-hardening' },
    }, null, 2)}\n`,
  );
  publishProfile(fixture);

  assert.throws(
    () => manager(fixture.repo, [
      'spawn', 'dependency-base', '--base', 'HEAD',
      '--agent', 'codex', '--agent-id', 'base-guard-1', '--purpose', 'dependency branch fixture',
    ]),
    /status 2|Command failed/,
  );

  manager(fixture.repo, [
    'spawn', 'dependency-base', '--base', 'HEAD', '--base-reason', '先进入依赖分支',
    '--agent', 'codex', '--agent-id', 'base-guard-1', '--purpose', 'dependency branch fixture',
  ]);
  const record = recordFor(fixture, 'dependency-base');
  assert.equal(record.base_ref, 'HEAD');
  assert.equal(record.base_reason, '先进入依赖分支');
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  const finding = doctor.findings.find((item) =>
    item.worktree_id === record.worktree_id && item.code === 'BASE_OVERRIDE');
  assert.equal(finding.base_reason, '先进入依赖分支');
  assert.equal(finding.default_base, 'origin/main');
});

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

  writeFileSync(profilePath, `${JSON.stringify({
    ...baseline,
    branch_template: 'legacy/{task}',
    path_template: '../legacy-{task}',
    task_naming: { mode: 'slug', example: 'feature-name' },
  }, null, 2)}\n`);
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  const finding = doctor.findings.find((item) => item.code === 'PRIMARY_PROFILE_DRIFT_FROM_BASE');
  assert.equal(finding.baseline_ref, 'origin/main');
  assert.equal(finding.path, realpathSync(profilePath));
  assert.equal(finding.severity, 'error');
  const before = git(fixture.repo, ['worktree', 'list', '--porcelain']);
  assert.throws(
    () => manager(fixture.repo, [
      'spawn', 'drift-9', '--agent', 'codex', '--agent-id', 'drift-guard', '--purpose', 'must fail closed',
    ]),
    /status 2|Command failed/,
  );
  assert.equal(git(fixture.repo, ['worktree', 'list', '--porcelain']), before);
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
  manager(fixture.repo, ['spawn', 'trace-9', '--agent', 'codex', '--agent-id', 'legacy-task', '--purpose', 'legacy opaque naming']);

  writeFileSync(profilePath, `${JSON.stringify({
    ...baseline,
    task_naming: { mode: 'semantic', example: 'ci-gate-hardening' },
  }, null, 2)}\n`);
  publishProfile(fixture, 'chore: require task id naming');

  assert.throws(
    () => manager(fixture.repo, ['spawn', 'trace-10', '--agent', 'codex', '--agent-id', 'new-task', '--purpose', 'must reject']),
    /status 1|Command failed/,
  );
  manager(fixture.repo, ['spawn', 'ci-gate-hardening', '--agent', 'codex', '--agent-id', 'new-task', '--purpose', 'valid semantic task']);
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  const finding = doctor.findings.find((item) => item.code === 'TASK_NAMING_DOD_FAILED');
  assert.equal(finding.task, 'trace-9');
  assert.equal(finding.severity, 'error');
});

test('touch 拒绝已回收 record 且不改写物理终态', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, ['spawn', 'immutable-history', '--agent', 'codex', '--agent-id', 'history-1', '--purpose', 'protect reclaimed history']);
  const record = JSON.parse(manager(fixture.repo, ['list', '--json'])).worktrees
    .find((row) => row.kind === 'TRACKED').record;
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['reclaim', 'immutable-history', '--pushed', pushed]);

  assert.throws(
    () => manager(fixture.repo, ['touch', 'immutable-history', '--status', 'done']),
    /status 1|Command failed/,
  );
  const all = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  assert.equal(all.records.find((item) => item.worktree_id === record.worktree_id).worktree_state, 'reclaimed');
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.some((finding) =>
    finding.worktree_id === record.worktree_id && finding.code === 'WORKTREE_MISSING'), false);
});

test('reclaim_ready 后目录和分支已消失仍可幂等收尾', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, ['spawn', 'crash-task', '--agent', 'codex', '--agent-id', 'crash-1', '--purpose', 'reclaim crash recovery']);
  const listed = JSON.parse(manager(fixture.repo, ['list', '--json']));
  const record = listed.worktrees.find((row) => row.kind === 'TRACKED').record;
  const worktree = worktreeFor(fixture, 'crash-task');
  writeFileSync(join(worktree, 'done.txt'), 'done\n');
  git(worktree, ['add', 'done.txt']);
  git(worktree, ['commit', '-m', 'feat: crash fixture']);
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, 'crash-task')]);
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);
  appendTraceEvent({
    commonDir: join(fixture.repo, '.git'),
    worktreeId: record.worktree_id,
    eventType: 'reclaim_ready',
    actor: record.agent,
    mutate(current) {
      return { ...current, worktree_state: 'reclaim_ready', last_head: git(worktree, ['rev-parse', 'HEAD']) };
    },
  });
  manager(fixture.repo, ['touch', 'crash-task', '--status', 'active', '--note', 'heartbeat during reclaim']);
  let doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.find((finding) =>
    finding.worktree_id === record.worktree_id && finding.code === 'RECLAIM_INTERRUPTED').phase, 'before_remove');
  git(fixture.repo, ['worktree', 'remove', worktree]);
  git(fixture.repo, ['branch', '-D', record.branch]);
  doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.find((finding) =>
    finding.worktree_id === record.worktree_id && finding.code === 'RECLAIM_INTERRUPTED').phase, 'after_remove');
  manager(fixture.repo, ['reclaim', 'crash-task', '--pushed', pushed]);
  const all = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  const reclaimed = all.records.find((item) => item.worktree_id === record.worktree_id);
  assert.equal(reclaimed.worktree_state, 'reclaimed');
  assert.equal(reclaimed.branch_cleanup.status, 'absent');
});

test('本地分支删除失败不伪装完整收尾，doctor/list 持续可见且 reclaim 可幂等重试', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, ['spawn', 'branch-cleanup', '--agent', 'codex', '--agent-id', 'cleanup-1', '--purpose', 'branch cleanup audit']);
  const record = recordFor(fixture, 'branch-cleanup');
  const worktree = record.path;
  writeFileSync(join(worktree, 'cleanup.txt'), 'branch cleanup\n');
  git(worktree, ['add', 'cleanup.txt']);
  git(worktree, ['commit', '-m', 'feat: branch cleanup fixture']);
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', record.branch]);
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);
  appendTraceEvent({
    commonDir: join(fixture.repo, '.git'),
    worktreeId: record.worktree_id,
    eventType: 'reclaim_ready',
    actor: record.agent,
    mutate(current) {
      return { ...current, worktree_state: 'reclaim_ready', last_head: git(worktree, ['rev-parse', 'HEAD']) };
    },
  });
  git(fixture.repo, ['worktree', 'remove', worktree]);

  const holder = join(fixture.sandbox, 'branch-holder');
  git(fixture.repo, ['worktree', 'add', holder, record.branch]);
  const firstOutput = manager(fixture.repo, ['reclaim', 'branch-cleanup', '--pushed', pushed]);
  assert.match(firstOutput, /目录已回收.*本地分支.*清理待重试/);

  let listed = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  let reclaimed = listed.records.find((item) => item.worktree_id === record.worktree_id);
  assert.equal(reclaimed.worktree_state, 'reclaimed');
  assert.equal(reclaimed.branch_cleanup.status, 'failed');
  assert.equal(reclaimed.branch_cleanup.attempts, 1);
  assert.match(reclaimed.branch_cleanup.reason, /checked out|used by worktree/i);
  assert.equal(reclaimed.reclaim_summary.branch_cleanup.status, 'failed');

  const defaultList = JSON.parse(manager(fixture.repo, ['list', '--json']));
  assert.equal(defaultList.records.find((item) => item.worktree_id === record.worktree_id).branch_cleanup_pending, true);
  assert.match(manager(fixture.repo, ['list']), /\[BRANCH_PENDING\].*branch=failed/);
  let doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  const finding = doctor.findings.find((item) =>
    item.worktree_id === record.worktree_id && item.code === 'LOCAL_BRANCH_CLEANUP_FAILED');
  assert.equal(finding.branch, record.branch);
  assert.equal(finding.branch_exists, true);

  writeFileSync(join(holder, 'late-work.txt'), 'must not be deleted\n');
  git(holder, ['add', 'late-work.txt']);
  git(holder, ['commit', '-m', 'feat: late branch work']);
  git(holder, ['switch', '--detach']);
  const refusedRetry = manager(fixture.repo, ['reclaim', 'branch-cleanup', '--pushed', pushed]);
  assert.match(refusedRetry, /清理待重试.*not merged into pushed sha/);
  assert.equal(git(fixture.repo, ['show-ref', '--verify', `refs/heads/${record.branch}`]).length > 0, true);
  listed = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  reclaimed = listed.records.find((item) => item.worktree_id === record.worktree_id);
  assert.equal(reclaimed.branch_cleanup.status, 'failed');
  assert.equal(reclaimed.branch_cleanup.attempts, 2);

  git(fixture.repo, ['merge', '--no-ff', '--no-edit', record.branch]);
  const pushedAfterLateWork = git(fixture.repo, ['rev-parse', 'HEAD']);
  const retryOutput = manager(fixture.repo, ['reclaim', 'branch-cleanup', '--pushed', pushedAfterLateWork]);
  assert.match(retryOutput, /branch=deleted/);
  listed = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  reclaimed = listed.records.find((item) => item.worktree_id === record.worktree_id);
  assert.equal(reclaimed.branch_cleanup.status, 'deleted');
  assert.equal(reclaimed.branch_cleanup.attempts, 3);
  assert.equal(reclaimed.reclaim_summary.branch_cleanup.status, 'deleted');
  assert.throws(() => git(fixture.repo, ['show-ref', '--verify', `refs/heads/${record.branch}`]));
  doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.some((item) =>
    item.worktree_id === record.worktree_id && item.code === 'LOCAL_BRANCH_CLEANUP_FAILED'), false);
  const audit = JSON.parse(manager(fixture.repo, ['audit', 'branch-cleanup', '--json']));
  assert.equal(audit.events.filter((event) => event.event_type === 'branch_cleanup_retried').length, 2);
});

test('旧 reclaimed record 无 branch_cleanup 字段时按本地 ref 对账并可补齐', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, ['spawn', 'legacy-cleanup', '--agent', 'codex', '--agent-id', 'legacy-1', '--purpose', 'legacy branch cleanup']);
  const record = recordFor(fixture, 'legacy-cleanup');
  const worktree = record.path;
  writeFileSync(join(worktree, 'legacy.txt'), 'legacy cleanup\n');
  git(worktree, ['add', 'legacy.txt']);
  git(worktree, ['commit', '-m', 'feat: legacy cleanup fixture']);
  const sourceHead = git(worktree, ['rev-parse', 'HEAD']);
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', record.branch]);
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);
  git(fixture.repo, ['worktree', 'remove', worktree]);
  appendTraceEvent({
    commonDir: join(fixture.repo, '.git'),
    worktreeId: record.worktree_id,
    eventType: 'legacy_reclaimed_fixture',
    actor: record.agent,
    mutate(current) {
      return { ...current, worktree_state: 'reclaimed', reclaimed_at: new Date().toISOString() };
    },
  });

  const defaultList = JSON.parse(manager(fixture.repo, ['list', '--json']));
  const legacy = defaultList.records.find((item) => item.worktree_id === record.worktree_id);
  assert.equal(legacy.branch_cleanup, undefined);
  assert.equal(legacy.branch_cleanup_pending, true);
  let doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  const finding = doctor.findings.find((item) =>
    item.worktree_id === record.worktree_id && item.code === 'LOCAL_BRANCH_CLEANUP_FAILED');
  assert.equal(finding.status, 'legacy');
  assert.equal(finding.branch_exists, true);

  assert.match(manager(fixture.repo, ['reclaim', 'legacy-cleanup', '--pushed', pushed]), /branch=deleted/);
  const all = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  const reconciled = all.records.find((item) => item.worktree_id === record.worktree_id);
  const finalEpoch = reconciled.ownership_epochs.at(-1);
  assert.equal(reconciled.task_status, 'done');
  assert.equal(reconciled.branch_cleanup.status, 'deleted');
  assert.equal(reconciled.branch_cleanup.attempts, 1);
  assert.equal(finalEpoch.end_sha, sourceHead);
  assert.equal(finalEpoch.ended_at, reconciled.reclaimed_at);
  const audit = JSON.parse(manager(fixture.repo, ['audit', 'legacy-cleanup', '--json']));
  assert.equal(audit.events.at(-2).event_type, 'reclaim_terminal_reconciled');
  doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.some((item) =>
    item.worktree_id === record.worktree_id && item.code === 'LOCAL_BRANCH_CLEANUP_FAILED'), false);
});

test('reclaim 对 dirty、未合入和 stash 分别 KEEP，条件清空后才回收', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, ['spawn', 'safety-task', '--agent', 'codex', '--agent-id', 'safe-1', '--purpose', 'reclaim safety']);
  const worktree = worktreeFor(fixture, 'safety-task');
  writeFileSync(join(worktree, 'safety.txt'), 'dirty\n');
  let pushed = git(fixture.repo, ['rev-parse', 'HEAD']);
  assert.match(managerKeep(fixture.repo, ['reclaim', 'safety-task', '--pushed', pushed]), /KEEP.*dirty/);

  git(worktree, ['add', 'safety.txt']);
  git(worktree, ['commit', '-m', 'feat: safety fixture']);
  assert.match(managerKeep(fixture.repo, ['reclaim', 'safety-task', '--pushed', pushed]), /KEEP.*not merged/);

  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, 'safety-task')]);
  pushed = git(fixture.repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(fixture.repo, 'README.md'), 'stashed main change\n');
  git(fixture.repo, ['stash', 'push', '-m', 'fixture stash']);
  assert.match(managerKeep(fixture.repo, ['reclaim', 'safety-task', '--pushed', pushed]), /KEEP.*stash/);
  git(fixture.repo, ['stash', 'drop']);
  assert.match(manager(fixture.repo, ['reclaim', 'safety-task', '--pushed', pushed]), /已回收/);

  const audit = JSON.parse(manager(fixture.repo, ['audit', 'safety-task', '--json']));
  assert.equal(audit.events.filter((event) => event.event_type === 'reclaim_blocked').length, 3);
});

test('reclaim 删除目录权限不足时保留 Git 原始错误且不伪装回收', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, ['spawn', 'permission-denied-task', '--agent', 'codex', '--agent-id', 'permission-denied-1', '--purpose', 'permission denied reclaim']);
  const record = recordFor(fixture, 'permission-denied-task');
  const worktree = record.path;
  writeFileSync(join(worktree, 'feature.txt'), 'permission denied task\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: permission denied task']);
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', record.branch]);
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);

  chmodSync(dirname(worktree), 0o555);
  let output;
  try {
    output = managerKeep(fixture.repo, ['reclaim', 'permission-denied-task', '--pushed', pushed]);
  } finally {
    chmodSync(dirname(worktree), 0o755);
  }
  assert.match(output, /KEEP.*(?:Permission denied|Operation not permitted)/i);
  assert.equal(existsSync(worktree), true, '权限不足时物理目录仍在');
  const after = recordFor(fixture, 'permission-denied-task', true);
  assert.notEqual(after.worktree_state, 'reclaimed');
  assert.match(after.last_reclaim_error.reason, /Permission denied|Operation not permitted/i);
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  const finding = doctor.findings.find((item) => item.worktree_id === record.worktree_id && item.code === 'RECLAIM_INTERRUPTED');
  assert.match(finding.last_reclaim_error.reason, /Permission denied|Operation not permitted/i);
  const audit = JSON.parse(manager(fixture.repo, ['audit', 'permission-denied-task', '--json']));
  assert.equal(audit.events.at(-1).event_type, 'reclaim_failed');
});

test('reclaim 不把已失去 Git 登记但物理目录仍在的树标成 reclaimed', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, ['spawn', 'orphan-directory-task', '--agent', 'codex', '--agent-id', 'orphan-directory-1', '--purpose', 'orphan directory recovery']);
  const record = recordFor(fixture, 'orphan-directory-task');
  const worktree = record.path;
  writeFileSync(join(worktree, 'feature.txt'), 'orphan directory task\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: orphan directory task']);
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', record.branch]);
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);

  const worktreeGitDir = git(worktree, ['rev-parse', '--absolute-git-dir']);
  rmSync(worktreeGitDir, { recursive: true, force: true });
  git(fixture.repo, ['worktree', 'prune']);
  assert.equal(existsSync(worktree), true, '边界前提：物理目录仍在');
  assert.doesNotMatch(git(fixture.repo, ['worktree', 'list', '--porcelain']), new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const output = managerKeep(fixture.repo, ['reclaim', 'orphan-directory-task', '--pushed', pushed]);
  assert.match(output, /KEEP.*physical directory remains without Git worktree registration/);
  const after = recordFor(fixture, 'orphan-directory-task', true);
  assert.notEqual(after.worktree_state, 'reclaimed');
  assert.equal(existsSync(worktree), true, '不自动删除无法审计的孤儿目录');
});

test('reclaim 含干净 submodule 的树：先 deinit 清私有元数据，再正常回收', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  addSubmoduleFixture(fixture);
  manager(fixture.repo, ['spawn', 'submodule-clean-task', '--agent', 'codex', '--agent-id', 'submod-clean-1', '--purpose', 'submodule reclaim clean']);
  const worktree = worktreeFor(fixture, 'submodule-clean-task');
  initSubmoduleInWorktree(worktree);
  writeFileSync(join(worktree, 'feature.txt'), 'submodule-clean-task\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: submodule-clean-task']);
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, 'submodule-clean-task')]);
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);

  const modulesDir = submodulesModulesDir(worktree);
  assert.equal(existsSync(modulesDir), true, '初始化过的 submodule 应留下树私有元数据目录');
  assert.throws(() => git(fixture.repo, ['worktree', 'remove', worktree]), /submodule/, '非 force remove 应先被 git 自身拒绝');

  assert.match(manager(fixture.repo, ['reclaim', 'submodule-clean-task', '--pushed', pushed]), /已回收/);
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(modulesDir), false, 'reclaim 应清理树私有 submodule 元数据');
});

test('reclaim submodule 脏时 KEEP，不 deinit 也不删目录', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  addSubmoduleFixture(fixture, { ignoreAll: true });
  manager(fixture.repo, ['spawn', 'submodule-dirty-task', '--agent', 'codex', '--agent-id', 'submod-dirty-1', '--purpose', 'submodule reclaim dirty']);
  const worktree = worktreeFor(fixture, 'submodule-dirty-task');
  initSubmoduleInWorktree(worktree);
  writeFileSync(join(worktree, 'feature.txt'), 'submodule-dirty-task\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: submodule-dirty-task']);
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, 'submodule-dirty-task')]);
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);

  writeFileSync(join(worktree, 'vendor', 'sub', 'untracked.txt'), 'dirty submodule\n');
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }).trim(),
    '',
    'submodule.ignore=all 应让顶层树状态保持干净，确保命中的是 reclaim 自己的 submodule 检查',
  );

  const modulesDir = submodulesModulesDir(worktree);
  const output = managerKeep(fixture.repo, ['reclaim', 'submodule-dirty-task', '--pushed', pushed]);
  assert.match(output, /KEEP.*submodule dirty.*vendor\/sub/);
  assert.equal(existsSync(worktree), true, 'submodule 脏时不得删除工作树');
  assert.equal(existsSync(modulesDir), true, 'submodule 脏时不得 deinit/清理元数据');
});

test('reclaim submodule 已 deinit 但树私有元数据残留：清理与初始化状态解耦，照常回收', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  addSubmoduleFixture(fixture);
  manager(fixture.repo, ['spawn', 'submodule-deinit-task', '--agent', 'codex', '--agent-id', 'submod-deinit-1', '--purpose', 'submodule reclaim deinit residue']);
  const worktree = worktreeFor(fixture, 'submodule-deinit-task');
  initSubmoduleInWorktree(worktree);
  writeFileSync(join(worktree, 'feature.txt'), 'submodule-deinit-task\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: submodule-deinit-task']);
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, 'submodule-deinit-task')]);
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);

  // 复现边界：手工 deinit 后 submodule 变未初始化（status 带 '-' 前缀），
  // 但 deinit 不清树私有 modules/ 元数据，非 force remove 依旧被 git 拒绝。
  git(worktree, ['submodule', 'deinit', '--all', '-f']);
  const modulesDir = submodulesModulesDir(worktree);
  assert.equal(existsSync(modulesDir), true, 'deinit 后树私有元数据应仍残留（边界前提）');
  assert.match(
    execFileSync('git', ['submodule', 'status'], { cwd: worktree, encoding: 'utf8' }),
    /^-/,
    'deinit 后 submodule 应处于未初始化态（边界前提）',
  );
  assert.throws(() => git(fixture.repo, ['worktree', 'remove', worktree]), /submodule/, '元数据残留时非 force remove 仍应先被 git 自身拒绝');

  assert.match(manager(fixture.repo, ['reclaim', 'submodule-deinit-task', '--pushed', pushed]), /已回收/);
  assert.equal(existsSync(worktree), false, '未初始化但元数据残留的树应可回收');
  assert.equal(existsSync(modulesDir), false, '残留元数据应被清理');
});

test('reclaim submodule 工作目录残留悬空 .git 指针时 KEEP 且保留不可审计内容', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  addSubmoduleFixture(fixture);
  manager(fixture.repo, ['spawn', 'submodule-pointer-task', '--agent', 'codex', '--agent-id', 'submod-pointer-1', '--purpose', 'submodule reclaim dangling pointer']);
  const worktree = worktreeFor(fixture, 'submodule-pointer-task');
  initSubmoduleInWorktree(worktree);
  writeFileSync(join(worktree, 'feature.txt'), 'submodule-pointer-task\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: submodule-pointer-task']);
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, 'submodule-pointer-task')]);
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);

  // 复现边界：deinit 后元数据被清、submodule 工作目录却残留指向该元数据的 .git 指针文件。
  // 悬空指针让顶层 git status 与 git worktree remove 直接 fatal「not a git repository」。
  git(worktree, ['submodule', 'deinit', '--all', '-f']);
  const modulesDir = submodulesModulesDir(worktree);
  rmSync(modulesDir, { recursive: true, force: true });
  const pointerFile = join(worktree, 'vendor', 'sub', '.git');
  writeFileSync(pointerFile, `gitdir: ${join(modulesDir, 'vendor', 'sub')}\n`);
  const preserved = join(worktree, 'vendor', 'sub', 'unrecoverable.txt');
  writeFileSync(preserved, 'must not delete\n');
  assert.throws(() => git(fixture.repo, ['worktree', 'remove', worktree]), /not a git repository/, '悬空指针应让非 force remove 直接 fatal（边界前提）');

  const output = managerKeep(fixture.repo, ['reclaim', 'submodule-pointer-task', '--pushed', pushed]);
  assert.match(output, /KEEP.*dangling.*vendor\/sub/);
  assert.equal(existsSync(worktree), true, '无法审计的 submodule 必须保留工作树');
  assert.equal(readFileSync(preserved, 'utf8'), 'must not delete\n', '不可审计内容不得被回收流程删除');
});

test('CLI rebuild 可在 record cache 已损坏时直接按 event-chain UUID 恢复', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, ['spawn', 'rebuild-task', '--agent', 'kiro', '--agent-id', 'rebuild-1', '--purpose', 'cache rebuild']);
  const listed = JSON.parse(manager(fixture.repo, ['list', '--json']));
  const id = listed.worktrees.find((row) => row.kind === 'TRACKED').record.worktree_id;
  writeFileSync(join(fixture.repo, '.git', 'worktree-trace', 'v1', 'records', `${id}.json`), '{broken');
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.some((finding) => finding.code === 'RECORD_CACHE_INVALID'), true);
  manager(fixture.repo, ['rebuild', '--id', id.slice(0, 8)]);
  const recovered = JSON.parse(manager(fixture.repo, ['list', '--json']));
  assert.equal(recovered.worktrees.find((row) => row.kind === 'TRACKED').record.worktree_id, id);
});

test('MR head 进入目标 ref 后 detached watcher 自动流转状态并回收', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'auto-merge';
  t.after(() => {
    try { manager(fixture.repo, ['unwatch', task]); } catch {}
    fixture.cleanup();
  });
  const { worktree } = prepareWatchedTask(fixture, task);
  const armed = recordFor(fixture, task);
  assert.equal(armed.task_status, 'ready_for_review');
  assert.equal(armed.auto_reclaim.target_ref, 'origin/main');

  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, task)]);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  await waitFor(() => !existsSync(worktree), 'watcher 未在 MR head 合入后自动回收 worktree');

  const reclaimed = recordFor(fixture, task, true);
  assert.equal(reclaimed.task_status, 'done');
  assert.equal(reclaimed.worktree_state, 'reclaimed');
  assert.equal(reclaimed.auto_reclaim.state, 'reclaimed');
  const audit = JSON.parse(manager(fixture.repo, ['audit', task, '--json']));
  const eventTypes = audit.events.map((event) => event.event_type);
  for (const expected of ['auto_reclaim_armed', 'auto_reclaim_watcher_started', 'merge_detected', 'auto_integrating', 'auto_done', 'final_snapshot', 'reclaim_ready', 'reclaimed']) {
    assert.equal(eventTypes.includes(expected), true, `缺少 event: ${expected}`);
  }
  const heartbeat = join(fixture.repo, '.git', 'worktree-trace', 'v1', 'watchers', `${reclaimed.worktree_id}.json`);
  assert.equal(existsSync(heartbeat), false);
});

test('watch 首次 arm 要求 MR head 已完整 push 到 upstream', (t) => {
  const fixture = makeRemoteRepo();
  const task = 'auto-unpushed';
  t.after(fixture.cleanup);
  manager(fixture.repo, ['spawn', task, '--base', 'origin/main', '--agent', 'codex', '--agent-id', 'watch-unpushed', '--purpose', 'reject unpushed watcher']);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, 'feature.txt'), 'local only\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: local only']);
  manager(fixture.repo, ['touch', task, '--status', 'ready_for_review']);

  assert.throws(
    () => manager(fixture.repo, ['watch', task, '--target', 'origin/main', '--interval-ms', '100']),
    (error) => String(error?.stderr).includes('本地 HEAD 与 upstream SHA 不一致'),
  );
  assert.equal(recordFor(fixture, task).auto_reclaim, undefined);
  assert.equal(existsSync(worktree), true);
});

test('merge_detected 前 unwatch 赢得 record lock 后旧 watcher 不得复活或回收', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'auto-unwatch';
  t.after(() => {
    try { manager(fixture.repo, ['unwatch', task]); } catch {}
    fixture.cleanup();
  });
  const { worktree } = prepareWatchedTask(fixture, task);
  manager(fixture.repo, ['unwatch', task]);
  assert.equal(recordFor(fixture, task).auto_reclaim.state, 'disarmed');

  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, task)]);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));

  assert.equal(existsSync(worktree), true);
  assert.equal(recordFor(fixture, task).auto_reclaim.state, 'disarmed');
  const audit = JSON.parse(manager(fixture.repo, ['audit', task, '--json']));
  assert.equal(audit.events.some((event) => event.event_type === 'merge_detected'), false);
});

test('MR 已合入但 stash/dirty 时 watcher 保留并在阻塞清除后自动重试', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'auto-blocked';
  t.after(() => {
    try { manager(fixture.repo, ['unwatch', task]); } catch {}
    fixture.cleanup();
  });
  const { worktree } = prepareWatchedTask(fixture, task);
  const lateFile = join(worktree, 'late-untracked.txt');
  writeFileSync(lateFile, 'must survive\n');
  writeFileSync(join(fixture.repo, 'README.md'), 'stash blocks reclaim\n');
  git(fixture.repo, ['stash', 'push', '-m', 'auto-reclaim fixture']);
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, task)]);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);

  await waitFor(() => {
    const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
    return doctor.findings.some((finding) => finding.code === 'AUTO_RECLAIM_BLOCKED' && /stash/.test(finding.detail));
  }, 'watcher 未报告 stash 阻塞');
  assert.equal(existsSync(lateFile), true);

  git(fixture.repo, ['stash', 'drop']);
  await waitFor(() => {
    const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
    return doctor.findings.some((finding) => finding.code === 'AUTO_RECLAIM_BLOCKED' && /dirty/.test(finding.detail));
  }, 'watcher 未在 stash 清除后继续报告 dirty 阻塞');
  assert.equal(existsSync(lateFile), true);

  rmSync(lateFile);
  await waitFor(() => !existsSync(worktree), 'dirty 清除后 watcher 未自动重试回收');
  const audit = JSON.parse(manager(fixture.repo, ['audit', task, '--json']));
  assert.equal(audit.events.filter((event) => event.event_type === 'merge_detected').length, 1);
  assert.equal(audit.events.filter((event) => event.event_type === 'reclaim_blocked').length, 0);
});

test('watcher 崩溃由 doctor 暴露，同一 watch 命令可 re-arm', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'auto-rearm';
  t.after(() => {
    try { manager(fixture.repo, ['unwatch', task]); } catch {}
    fixture.cleanup();
  });
  prepareWatchedTask(fixture, task);
  const first = recordFor(fixture, task);
  const firstPid = first.auto_reclaim.pid;
  process.kill(firstPid, 'SIGTERM');
  await waitFor(() => {
    const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
    return doctor.findings.some((finding) => finding.code === 'AUTO_RECLAIM_WATCHER_STALE');
  }, 'doctor 未报告死亡 watcher');

  const output = manager(fixture.repo, ['watch', task, '--target', 'origin/main', '--interval-ms', '100']);
  assert.match(output, /watcher 已启动/);
  const second = recordFor(fixture, task);
  assert.notEqual(second.auto_reclaim.pid, firstPid);
  assert.equal(second.auto_reclaim.state, 'watching');
  manager(fixture.repo, ['unwatch', task]);
  await waitFor(() => {
    const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
    return doctor.findings.every((finding) => finding.code !== 'AUTO_RECLAIM_WATCHER_STALE');
  }, 'unwatch 后仍残留 stale finding');
});

test('resume-all 在真实 watcher 崩溃后批量恢复，dirty 只阻塞回收且最近回执默认可见', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'auto-resume-all';
  t.after(() => {
    try { manager(fixture.repo, ['unwatch', task]); } catch {}
    fixture.cleanup();
  });
  const { worktree } = prepareWatchedTask(fixture, task);
  const first = recordFor(fixture, task);
  process.kill(first.auto_reclaim.pid, 'SIGTERM');
  await waitFor(() => {
    const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
    return doctor.findings.some((finding) => finding.code === 'AUTO_RECLAIM_WATCHER_STALE');
  }, 'doctor 未报告待 resume 的 watcher');

  const lateFile = join(worktree, 'resume-blocker.txt');
  writeFileSync(lateFile, 'survive restart\n');
  const resumed = JSON.parse(manager(fixture.repo, ['resume-all', '--json']));
  assert.equal(resumed.resumed.length, 1);
  assert.equal(resumed.resumed[0].worktree_id, first.worktree_id);
  assert.equal(resumed.resumed[0].dirty, true);
  assert.notEqual(resumed.resumed[0].pid, first.auto_reclaim.pid);

  const idempotent = JSON.parse(manager(fixture.repo, ['resume-all', '--json']));
  assert.equal(idempotent.resumed.length, 0);
  assert.equal(idempotent.healthy.length, 1);

  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, task)]);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  await waitFor(() => {
    const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
    return doctor.findings.some((finding) => finding.code === 'AUTO_RECLAIM_BLOCKED' && /dirty/.test(finding.detail));
  }, '恢复后的 watcher 未如实报告 dirty 阻塞');
  assert.equal(existsSync(lateFile), true);
  rmSync(lateFile);
  await waitFor(() => !existsSync(worktree), '阻塞清除后恢复的 watcher 未自动回收');

  const listing = JSON.parse(manager(fixture.repo, ['list', '--json']));
  assert.equal(listing.last_reclaim.task, task);
  assert.equal(listing.last_reclaim.change_ref, `MR !${task}`);
  assert.equal(listing.last_reclaim.source_sha, first.auto_reclaim.head_sha);
  assert.equal(typeof listing.last_reclaim.target_sha, 'string');
  const reclaimed = recordFor(fixture, task, true);
  assert.equal(reclaimed.reclaim_notification.adapter, 'off');
  assert.equal(reclaimed.worktree_state, 'reclaimed');
});

test('resume-all 与 unwatch 多进程并发时解除状态不能被旧 token 复活', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'resume-unwatch-race';
  t.after(() => {
    try { manager(fixture.repo, ['unwatch', task]); } catch {}
    fixture.cleanup();
  });
  prepareWatchedTask(fixture, task);
  const armed = recordFor(fixture, task);
  process.kill(armed.auto_reclaim.pid, 'SIGTERM');
  await waitFor(() => {
    const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
    return doctor.findings.some((finding) => finding.code === 'AUTO_RECLAIM_WATCHER_STALE');
  }, '竞态测试未进入 stale 前置状态');

  await Promise.all([
    managerAsync(fixture.repo, ['resume-all', '--json']),
    managerAsync(fixture.repo, ['unwatch', task]),
  ]);
  await waitFor(() => recordFor(fixture, task).auto_reclaim.state === 'disarmed', '并发 unwatch 后 record 被旧 resume 快照复活');
  const audit = JSON.parse(manager(fixture.repo, ['audit', task, '--json']));
  const lifecycle = audit.events.filter((event) => ['auto_reclaim_rearmed', 'auto_reclaim_disarmed'].includes(event.event_type));
  assert.equal(lifecycle.at(-1).event_type, 'auto_reclaim_disarmed');
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.some((finding) => finding.code === 'AUTO_RECLAIM_WATCHER_STALE'), false);
});

test('两个真实 watcher 监听同一 target 时通过 common-dir cache 合并 fetch', async (t) => {
  const fixture = makeRemoteRepo();
  const tasks = ['cache-one', 'cache-two', 'cache-other'];
  t.after(() => {
    for (const task of tasks) try { manager(fixture.repo, ['unwatch', task]); } catch {}
    fixture.cleanup();
  });
  git(fixture.repo, ['checkout', '-b', 'other-target']);
  writeFileSync(join(fixture.repo, 'other.txt'), 'distinct target\n');
  git(fixture.repo, ['add', 'other.txt']);
  git(fixture.repo, ['commit', '-m', 'test: distinct target']);
  git(fixture.repo, ['push', 'origin', 'HEAD:other']);
  const otherTargetSha = git(fixture.repo, ['rev-parse', 'HEAD']);
  git(fixture.repo, ['checkout', 'trunk']);
  for (const task of tasks) prepareReviewTask(fixture, task);
  for (const task of tasks.slice(0, 2)) {
    manager(fixture.repo, ['watch', task, '--target', 'origin/main', '--interval-ms', '5000', '--change-ref', `MR !${task}`, '--notify', 'off']);
  }
  manager(fixture.repo, ['watch', 'cache-other', '--target', 'origin/other', '--interval-ms', '5000', '--change-ref', 'MR !cache-other', '--notify', 'off']);

  const records = tasks.map((task) => recordFor(fixture, task));
  const heartbeatPaths = records.map((record) => join(fixture.repo, '.git', 'worktree-trace', 'v1', 'watchers', `${record.worktree_id}.json`));
  let heartbeats;
  await waitFor(() => {
    if (!heartbeatPaths.every(existsSync)) return false;
    heartbeats = heartbeatPaths.map((path) => JSON.parse(readFileSync(path, 'utf8')));
    return heartbeats.every((heartbeat) => Object.hasOwn(heartbeat, 'fetch_cache_hit'));
  }, '两个 watcher 未完成首轮共享 target 检查');
  assert.equal(heartbeats.slice(0, 2).some((heartbeat) => heartbeat.fetch_cache_hit === true), true);

  const cacheDir = join(fixture.repo, '.git', 'worktree-trace', 'v1', 'watch-targets');
  const cacheFiles = readdirSync(cacheDir).filter((name) => name.endsWith('.json'));
  assert.equal(cacheFiles.length, 2);
  const caches = cacheFiles.map((name) => JSON.parse(readFileSync(join(cacheDir, name), 'utf8')));
  const mainCache = caches.find((cache) => cache.target_ref === 'origin/main');
  const otherCache = caches.find((cache) => cache.target_ref === 'origin/other');
  assert.equal(mainCache.fetch_count, 1);
  assert.equal(otherCache.fetch_count, 1);
  assert.equal(otherCache.target_sha, otherTargetSha);
  assert.notEqual(mainCache.target_sha, otherCache.target_sha);
});

test('plan-batch 固定 target 与已推送 HEAD，并折叠被子分支覆盖的输入', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);

  manager(fixture.repo, [
    'spawn', 'batch-parent-feature', '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'batch-parent-thread', '--purpose', '批次父 feature',
  ]);
  const parent = worktreeFor(fixture, 'batch-parent-feature');
  writeFileSync(join(parent, 'parent.txt'), 'parent\n');
  git(parent, ['add', 'parent.txt']);
  git(parent, ['commit', '-m', 'feat: parent']);
  git(parent, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'batch-parent-feature', '--status', 'ready_for_review']);

  manager(fixture.repo, [
    'spawn', 'batch-child-feature', '--base', 'origin/codex/batch-parent-feature',
    '--base-reason', '依赖父 feature 的已推送契约',
    '--agent', 'codex', '--agent-id', 'batch-child-thread', '--purpose', '批次子 feature',
  ]);
  const child = worktreeFor(fixture, 'batch-child-feature');
  writeFileSync(join(child, 'child.txt'), 'child\n');
  git(child, ['add', 'child.txt']);
  git(child, ['commit', '-m', 'feat: child']);
  git(child, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'batch-child-feature', '--status', 'ready_for_review']);

  const first = JSON.parse(manager(fixture.repo, [
    'plan-batch', 'batch-parent-feature', 'batch-child-feature', '--target', 'origin/main', '--json',
  ]));
  const second = JSON.parse(manager(fixture.repo, [
    'plan-batch', 'batch-parent-feature', 'batch-child-feature', '--target', 'origin/main', '--json',
  ]));
  assert.equal(first.ready, true);
  assert.equal(first.included.length, 1);
  assert.equal(first.included[0].task, 'batch-child-feature');
  assert.equal(first.excluded[0].task, 'batch-parent-feature');
  assert.equal(first.excluded[0].reasons[0].code, 'COVERED_BY_DESCENDANT');
  assert.match(first.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.fingerprint, second.fingerprint, '时间戳不得改变批次指纹');
  assert.equal(first.target.sha, git(fixture.repo, ['rev-parse', 'origin/main']));

  writeFileSync(join(child, 'dirty.txt'), 'not committed\n');
  const blocked = JSON.parse(managerKeep(fixture.repo, [
    'plan-batch', 'batch-parent-feature', 'batch-child-feature', '--target', 'origin/main', '--json',
  ]));
  assert.equal(blocked.ready, false);
  assert.equal(blocked.fingerprint, null);
  assert.equal(blocked.blockers.some((item) => item.task === 'batch-child-feature' && item.code === 'DIRTY_WORKTREE'), true);

  rmSync(join(child, 'dirty.txt'));
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', 'codex/batch-child-feature']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  const integratedSha = git(fixture.repo, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['reclaim', 'batch-child-feature', '--pushed', integratedSha]);
  const historical = JSON.parse(managerKeep(fixture.repo, [
    'plan-batch', 'batch-parent-feature', 'batch-child-feature', '--target', 'origin/main', '--json',
  ]));
  assert.equal(historical.excluded.every((item) => item.state === 'already_integrated'), true);
  assert.equal(historical.blockers.some((item) => item.code === 'WORKTREE_NOT_PRESENT'), false);
  assert.equal(historical.blockers.some((item) => item.code === 'NO_UNIQUE_INPUT'), true);
});

test('doctor 报告验收状态下的 dirty、HEAD 漂移和未完成 Git 操作', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);

  manager(fixture.repo, [
    'spawn', 'review-operation-conflict', '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'review-operation-thread', '--purpose', '验收状态冲突检查',
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
    'spawn', 'review-head-drift', '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'review-drift-thread', '--purpose', '验收 HEAD 漂移检查',
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
  assert.equal(doctor.findings.some((item) => item.code === 'GIT_OPERATION_IN_PROGRESS' && item.worktree_id === recordFor(fixture, 'review-operation-conflict').worktree_id), true);
  assert.equal(doctor.findings.some((item) => item.code === 'REVIEW_STATE_DIRTY' && item.worktree_id === recordFor(fixture, 'review-operation-conflict').worktree_id), true);
  const driftFinding = doctor.findings.find((item) => item.code === 'HEAD_DRIFT' && item.worktree_id === recordFor(fixture, 'review-head-drift').worktree_id);
  assert.equal(driftFinding.severity, 'error');
  assert.notEqual(driftFinding.recorded_head, driftFinding.live_head);
});

test('CLI 入口判定按 realpath 归一：软链安装的 skill 也能跑 main()', () => {
  // 回归：skill 常以软链装在 ~/.claude/skills/<name>。旧实现直接比对
  // import.meta.url 与 pathToFileURL(argv[1])——软链下前者是真实路径、后者是
  // 软链路径，永不相等 → main() 不跑、退出码 0、stdout/stderr 全空，调用方只
  // 看到「命令成功但没有输出」，极难归因（2026-07-30 实地踩中）。
  const self = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, '.mjs');
  const root = mkdtempSync(join(tmpdir(), 'wt-clientry-'));

  // 1) 真实路径调用：必须成立
  assert.equal(isCliEntry(self, pathToFileURL(self).href), true);

  // 2) 软链路径调用：修复前为 false，修复后必须成立
  const link = join(root, 'linked-mgr.mjs');
  symlinkSync(self, link);
  assert.equal(isCliEntry(link, pathToFileURL(self).href), true);

  // 3) 被 import（argv[1] 是别的脚本）：必须为 false，不能误跑 main()
  const other = join(root, 'other.mjs');
  writeFileSync(other, '// not the manager\n');
  assert.equal(isCliEntry(other, pathToFileURL(self).href), false);

  // 4) 无 argv[1]（REPL / -e）：不跑
  assert.equal(isCliEntry(undefined, pathToFileURL(self).href), false);

  rmSync(root, { recursive: true, force: true });
});
