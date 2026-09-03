import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createHash } from 'node:crypto';
import * as managerApi from './worktree-mgr.mjs';
import {
  batchFingerprint,
  canonicalJson,
  codegraphStdio,
  deliverReclaimNotification,
  isCliEntry,
  normalizeCodegraphMode,
  processIsAlive,
  refreshTargetRefCached,
} from './worktree-mgr.mjs';
import { appendTraceEvent } from './worktree-trace.mjs';

const MANAGER = join(dirname(fileURLToPath(import.meta.url)), 'worktree-mgr.mjs');

test('兼容入口保留拆分前的完整公共导出面', () => {
  const baselineExports = [
    'batchFingerprint',
    'canonicalJson',
    'classifyPairState',
    'codegraphStdio',
    'deliverReclaimNotification',
    'isCliEntry',
    'mergeTreeScanSupported',
    'normalizeCodegraphMode',
    'parseGitVersion',
    'predictReviewRefresh',
    'processIsAlive',
    'refreshTargetRefCached',
    'regeneratedPathKind',
    'runFileCapture',
    'runFileTry',
    'verifyArtifactEnvelope',
    'worktreeSkillDigest',
  ];
  assert.deepEqual(
    baselineExports.filter((name) => typeof managerApi[name] !== 'function'),
    [],
    'composition root 必须继续导出拆分前的全部公共 helper',
  );
  assert.deepEqual(canonicalJson({ b: 2, a: 1 }), { a: 1, b: 2 });
  assert.equal(typeof refreshTargetRefCached, 'function');
});

test('CodeGraph mode 默认 auto 且只接受 auto/on/off', () => {
  assert.equal(normalizeCodegraphMode(null), 'auto');
  assert.equal(normalizeCodegraphMode('auto'), 'auto');
  assert.equal(normalizeCodegraphMode('on'), 'on');
  assert.equal(normalizeCodegraphMode('off'), 'off');
  assert.throws(() => normalizeCodegraphMode('shared'), /auto\/on\/off/);
  assert.equal(codegraphStdio(true), 'inherit');
  assert.deepEqual(codegraphStdio(false), ['ignore', 'pipe', 'pipe']);
});

test('批次指纹只绑定 Git SHA 与输入顺序，不依赖宿主路径', () => {
  const target = 'a'.repeat(40);
  const inputs = ['b'.repeat(40), 'c'.repeat(40)];
  assert.equal(batchFingerprint(target, inputs), batchFingerprint(target, [...inputs]));
  assert.notEqual(batchFingerprint(target, inputs), batchFingerprint(target, [...inputs].reverse()));
  assert.notEqual(batchFingerprint(target, inputs), batchFingerprint('d'.repeat(40), inputs));
  assert.match(batchFingerprint(target, inputs), /^sha256:[0-9a-f]{64}$/);
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

test('Artifact/Binding 可机械联动 verifier，incident 只生成 proposed 改进候选', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, ['spawn', 'artifact-contract', '--agent', 'codex', '--agent-id', 'artifact-thread', '--purpose', 'freeze artifact']);
  const listed = JSON.parse(manager(fixture.repo, ['list', '--json']));
  const tracked = listed.worktrees.find((row) => row.kind === 'TRACKED');
  writeFileSync(join(tracked.path, 'artifact.txt'), 'frozen\n');
  git(tracked.path, ['add', 'artifact.txt']);
  git(tracked.path, ['commit', '-m', 'feat: frozen artifact']);

  const binding = JSON.parse(manager(fixture.repo, ['binding', 'artifact-contract', '--json']));
  const artifact = JSON.parse(manager(fixture.repo, ['artifact', 'artifact-contract', '--json']));
  assert.equal(binding.worktree_id, artifact.worktree_id);
  assert.equal(binding.head_sha, artifact.artifact_sha);
  assert.equal(binding.owner.epoch, artifact.ownership_epoch);
  const artifactPath = join(fixture.sandbox, 'artifact-ref.json');
  writeFileSync(artifactPath, JSON.stringify(artifact));
  assert.equal(JSON.parse(manager(fixture.repo, ['verify-artifact', artifactPath, '--json'])).valid, true);
  for (const [name, mutate] of [
    ['missing-worktree', (value) => { delete value.worktree_id; }],
    ['missing-epoch', (value) => { delete value.ownership_epoch; }],
    ['stale-epoch', (value) => { value.ownership_epoch += 1; }],
  ]) {
    const invalid = structuredClone(artifact);
    mutate(invalid);
    const invalidPath = join(fixture.sandbox, `${name}.json`);
    writeFileSync(invalidPath, JSON.stringify(invalid));
    assert.throws(() => manager(fixture.repo, ['verify-artifact', invalidPath, '--json']), /Artifact/);
  }
  writeFileSync(join(tracked.path, 'dirty.txt'), 'dirty\n');
  assert.throws(() => manager(fixture.repo, ['verify-artifact', artifactPath, '--json']), /变脏/);
  rmSync(join(tracked.path, 'dirty.txt'));
  writeFileSync(join(tracked.path, 'drift.txt'), 'drift\n');
  git(tracked.path, ['add', 'drift.txt']);
  git(tracked.path, ['commit', '-m', 'feat: drift head']);
  assert.throws(() => manager(fixture.repo, ['verify-artifact', artifactPath, '--json']), /live HEAD/);

  const capabilities = JSON.parse(manager(fixture.repo, ['capabilities', '--json']));
  assert.deepEqual(capabilities.contracts.artifact_ref, [1]);
  const incidentInput = join(fixture.sandbox, 'incident.json');
  writeFileSync(incidentInput, JSON.stringify({ contract_digest: `sha256:${'1'.repeat(64)}`, classification: 'tool_gap', observation: 'trace event 暴露了可复现边界', impact: 'medium', confidence: 'high', recommended_disposition: 'continue' }));
  const incident = JSON.parse(manager(fixture.repo, ['incident', 'artifact-contract', '--input', incidentInput]));
  assert.equal(incident.reflection.evidence_refs.length, 1);
  const proposalInput = join(fixture.sandbox, 'worktree-proposal.json');
  writeFileSync(proposalInput, JSON.stringify({ problem_type: 'skill_gap', proposed_change: '强化 owner epoch 校验', affected_scope: ['artifact'], counterexamples: [], validation_plan: { replay_cases: ['handoff'], regression_suites: ['worktree-mgr'] } }));
  const proposed = JSON.parse(manager(fixture.repo, ['propose-improvement', '--reflection', incident.reflection.reflection_id, '--input', proposalInput]));
  assert.equal(proposed.proposal.lifecycle, 'proposed');
  assert.equal(existsSync(proposed.ref), true);
  assert.equal(JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.some((item) => item.code.startsWith('LEARNING_')), false);
  const tampered = JSON.parse(readFileSync(proposed.ref, 'utf8'));
  tampered.lifecycle = 'accepted';
  writeFileSync(proposed.ref, JSON.stringify(tampered));
  assert.equal(JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.some((item) => item.code === 'LEARNING_PROPOSAL_INVALID'), true);
});

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** @param {string} path */
function contentSha(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
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
  // 这些 fixture 要么随后显式 watch，要么根本不关心监听；用 --no-watch 退出默认自动武装，
  // 保持各用例原本的武装语义，并避免留下与用例无关的 watcher 进程。
  manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--note', 'fixture MR created', '--no-watch']);
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
  assert.match(output, /KEEP[\s\S]*(?:Permission denied|Operation not permitted)/i);
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

/**
 * 冲突矩阵 fixture：在同一 target 上造出四种关系——同 hunk 冲突、同文件相邻（能自动合但
 * 两支都改了）、结构性冲突（改/删）、完全正交。这正是 patchbay 那轮聚合里只有合到一半
 * 才暴露出来的那几类关系。
 */
function makeConflictScanFixture(t) {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.repo, 'shared.txt'), 'sentinel = base\nkeep\n');
  writeFileSync(join(fixture.repo, 'notes.txt'), Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join('\n') + '\n');
  writeFileSync(join(fixture.repo, 'pnpm-lock.yaml'), 'lockfileVersion: 1\n');
  git(fixture.repo, ['add', 'shared.txt', 'notes.txt', 'pnpm-lock.yaml']);
  git(fixture.repo, ['commit', '-m', 'chore: conflict scan baseline']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  git(fixture.repo, ['fetch', 'origin', 'main']);

  const prepare = (task, mutate) => {
    manager(fixture.repo, [
      'spawn', task, '--base', 'origin/main',
      '--agent', 'codex', '--agent-id', `${task}-thread`, '--purpose', '冲突矩阵 fixture',
    ]);
    const worktree = worktreeFor(fixture, task);
    mutate(worktree);
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-m', `feat: ${task}`]);
    git(worktree, ['push', '-u', 'origin', 'HEAD']);
    manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--no-watch']);
    return worktree;
  };

  const notes = (mutate) => (worktree) => {
    const lines = readFileSync(join(worktree, 'notes.txt'), 'utf8').split('\n');
    mutate(lines);
    writeFileSync(join(worktree, 'notes.txt'), lines.join('\n'));
  };

  // alpha / beta：shared.txt 同一行两种改法（同 hunk），notes.txt 一头一尾（同文件相邻），
  // pnpm-lock.yaml 各自重生成（同 hunk + 产物类）。
  prepare('scan-alpha', (worktree) => {
    writeFileSync(join(worktree, 'shared.txt'), 'sentinel = alpha\nkeep\n');
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 2\n');
    notes((lines) => { lines[0] = 'line-1-alpha'; })(worktree);
  });
  prepare('scan-beta', (worktree) => {
    writeFileSync(join(worktree, 'shared.txt'), 'sentinel = beta\nkeep\n');
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 3\n');
    notes((lines) => { lines[11] = 'line-12-beta'; })(worktree);
  });
  // gamma：完全正交，只加自己的文件。
  prepare('scan-gamma', (worktree) => writeFileSync(join(worktree, 'only-gamma.txt'), 'gamma\n'));
  // delta：删掉 shared.txt，与 alpha/beta 构成 modify/delete 这类结构性冲突。
  prepare('scan-delta', (worktree) => rmSync(join(worktree, 'shared.txt')));
  return fixture;
}

test('plan-batch --scan-conflicts 在冻结前给出冲突矩阵，并区分同 hunk、结构性与同文件相邻', (t) => {
  const fixture = makeConflictScanFixture(t);
  const selectors = ['scan-alpha', 'scan-beta', 'scan-gamma', 'scan-delta'];
  const planned = JSON.parse(manager(fixture.repo, ['plan-batch', ...selectors, '--target', 'origin/main', '--json']));
  const scanned = JSON.parse(manager(fixture.repo, ['plan-batch', ...selectors, '--target', 'origin/main', '--scan-conflicts', '--json']));

  assert.equal(planned.conflict_scan, undefined, '不加 flag 时不做扫描');
  assert.equal(scanned.fingerprint, planned.fingerprint, '扫描是附加输出，不得改变冻结指纹');
  const scan = scanned.conflict_scan;
  assert.equal(scan.supported, true, `merge-tree 干跑不可用: ${scan.reason}`);
  assert.equal(scan.summary.pair_count, 6);
  assert.equal(scan.summary.conflicting_pairs, 3);
  assert.equal(scan.summary.failed_pairs, 0);

  const pairOf = (left, right) => scan.pairs.find((pair) =>
    (pair.a.task === left && pair.b.task === right) || (pair.a.task === right && pair.b.task === left));
  const fileOf = (pair, path) => pair.files.find((file) => file.path === path);

  const alphaBeta = pairOf('scan-alpha', 'scan-beta');
  assert.equal(alphaBeta.state, 'conflict');
  assert.equal(alphaBeta.conflict_files, 2, 'shared.txt 与 pnpm-lock.yaml 都是同 hunk 冲突');
  assert.equal(alphaBeta.adjacent_files, 1, 'notes.txt 两头各改一行：能自动合，但仍是同文件相邻');
  assert.equal(fileOf(alphaBeta, 'shared.txt').class, 'overlapping');
  assert.equal(fileOf(alphaBeta, 'shared.txt').conflict_type, 'CONFLICT (contents)');
  assert.equal(fileOf(alphaBeta, 'notes.txt').class, 'adjacent');
  assert.equal(fileOf(alphaBeta, 'notes.txt').conflict_type, null);
  assert.equal(fileOf(alphaBeta, 'pnpm-lock.yaml').regenerated, 'lockfile');
  assert.equal(alphaBeta.merge_base, git(fixture.repo, ['rev-parse', 'origin/main']));

  const alphaDelta = pairOf('scan-alpha', 'scan-delta');
  assert.equal(alphaDelta.conflict_files, 1);
  assert.equal(fileOf(alphaDelta, 'shared.txt').class, 'structural');
  assert.match(fileOf(alphaDelta, 'shared.txt').conflict_type, /modify\/delete/);

  for (const [left, right] of [['scan-alpha', 'scan-gamma'], ['scan-beta', 'scan-gamma'], ['scan-gamma', 'scan-delta']]) {
    const pair = pairOf(left, right);
    assert.equal(pair.state, 'clean', `${left} × ${right} 应为正交`);
    assert.equal(pair.conflict_files, 0);
    assert.equal(pair.adjacent_files, 0);
  }

  // 各输入对 target 单独干跑：这批都是 target 的后代，逐支落地本身不冲突——
  // 说明冲突只在「合到一起」时出现，正是矩阵要提前暴露的信息。
  assert.equal(scan.against_target.length, 4);
  assert.equal(scan.against_target.every((row) => row.state === 'clean'), true);

  // 冲突面排序：直接支撑「冲突面大的压轴」。
  assert.deepEqual(scan.summary.inputs.map((row) => row.task), ['scan-alpha', 'scan-beta', 'scan-delta', 'scan-gamma']);
  assert.equal(scan.summary.inputs[0].conflict_files, 3);
  assert.equal(scan.summary.inputs[0].conflicting_peers, 2);
  assert.equal(scan.summary.inputs.at(-1).conflict_files, 0);
  assert.equal(scan.summary.max_pair_conflict_files, 2);

  const regenerated = scan.summary.regenerated_paths;
  assert.equal(regenerated.length, 1);
  assert.equal(regenerated[0].path, 'pnpm-lock.yaml');
  assert.equal(regenerated[0].kind, 'lockfile');
  assert.deepEqual(regenerated[0].classes, ['overlapping']);

  const human = manager(fixture.repo, ['plan-batch', ...selectors, '--target', 'origin/main', '--scan-conflicts']);
  assert.match(human, /\[PAIR\] scan-alpha × scan-beta conflict=2 adjacent=1/);
  assert.match(human, /\[LOAD\] scan-alpha /);
  assert.match(human, /\[REGEN\] pnpm-lock\.yaml \(lockfile\)/);
  assert.match(human, /post_integrate_steps/);
});

test('冲突矩阵是写树式干跑：不动任何 worktree、index、ref 和合并中间态', (t) => {
  const fixture = makeConflictScanFixture(t);
  const selectors = ['scan-alpha', 'scan-beta', 'scan-gamma', 'scan-delta'];
  const trees = [fixture.repo, ...selectors.map((task) => worktreeFor(fixture, task))];
  const snapshot = () => ({
    refs: git(fixture.repo, ['show-ref']),
    stash: git(fixture.repo, ['stash', 'list']),
    index: contentSha(join(fixture.repo, '.git', 'index')),
    trees: trees.map((tree) => ({
      head: git(tree, ['rev-parse', 'HEAD']),
      status: git(tree, ['status', '--porcelain']),
      staged: git(tree, ['diff', '--cached', '--name-only']),
      operation: ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']
        .filter((marker) => existsSync(join(git(tree, ['rev-parse', '--absolute-git-dir']), marker))),
    })),
  });

  const before = snapshot();
  manager(fixture.repo, ['plan-batch', ...selectors, '--target', 'origin/main', '--scan-conflicts', '--json']);
  const after = snapshot();

  assert.deepEqual(after, before, 'merge-tree 干跑只应往对象库写游离对象，不得改动工作区、index 或 ref');
  assert.equal(after.trees.every((tree) => tree.status === '' && tree.operation.length === 0), true);
});

test('冲突判定以 merge-tree 退出码为准：目录重命名类冲突没有文件条目也不得判成 clean', (t) => {
  // git-merge-tree(1) MISTAKES TO AVOID 原文：「Do NOT interpret an empty Conflicted file info
  // list as a clean merge; check the exit status. A merge can have conflicts without having
  // individual files conflict (there are a few types of directory rename conflicts ...)」
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  mkdirSync(join(fixture.repo, 'a'));
  writeFileSync(join(fixture.repo, 'a', 'x'), 'x\n');
  writeFileSync(join(fixture.repo, 'a', 'y'), 'y\n');
  git(fixture.repo, ['add', '-A']);
  git(fixture.repo, ['commit', '-m', 'chore: directory rename baseline']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  git(fixture.repo, ['fetch', 'origin', 'main']);

  const prepare = (task, mutate) => {
    manager(fixture.repo, [
      'spawn', task, '--base', 'origin/main',
      '--agent', 'codex', '--agent-id', `${task}-thread`, '--purpose', '目录重命名冲突 fixture',
    ]);
    const worktree = worktreeFor(fixture, task);
    mutate(worktree);
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-m', `feat: ${task}`]);
    git(worktree, ['push', '-u', 'origin', 'HEAD']);
    manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--no-watch']);
  };
  // 一支把 a/ 拆成 b/ 与 c/（没有哪个目的地拿到多数），另一支往 a/ 加文件：
  // Git 无从判断新文件该跟去哪里，报冲突但**不产生任何 unmerged 文件条目**。
  prepare('scan-split', (worktree) => {
    mkdirSync(join(worktree, 'b'));
    mkdirSync(join(worktree, 'c'));
    git(worktree, ['mv', 'a/x', 'b/x']);
    git(worktree, ['mv', 'a/y', 'c/y']);
  });
  prepare('scan-addfile', (worktree) => writeFileSync(join(worktree, 'a', 'z'), 'z\n'));

  const plan = JSON.parse(manager(fixture.repo, [
    'plan-batch', 'scan-split', 'scan-addfile', '--target', 'origin/main', '--scan-conflicts', '--json',
  ]));
  const pair = plan.conflict_scan.pairs[0];
  assert.equal(pair.conflict_files, 0, '这类冲突本来就没有文件条目');
  assert.equal(pair.state, 'conflict', '退出码 1 即冲突，不得因为文件条目为空而判成 clean/adjacent');
  assert.equal(plan.conflict_scan.summary.conflicting_pairs, 1);
  // 没有文件条目时必须把信息性冲突记录亮出来，否则读者只看到 conflict=0 无从下手。
  assert.ok(pair.conflict_notes.length > 0, '缺少信息性冲突记录');
  assert.match(pair.conflict_notes[0].conflict_type, /directory rename/i);
  assert.deepEqual(pair.conflict_notes[0].paths, ['a']);

  const human = manager(fixture.repo, [
    'plan-batch', 'scan-split', 'scan-addfile', '--target', 'origin/main', '--scan-conflicts',
  ]);
  assert.match(human, /\[NOTE\][\s\S]*directory rename/i, '人读输出必须显示无文件条目的冲突');
});

test('产物类汇总在截断前统计：排在 50 项之后的 lock 文件不得从 REGEN 汇总消失', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  const paths = [...Array.from({ length: 60 }, (_, index) => `f-${String(index).padStart(2, '0')}.txt`), 'zzz/pnpm-lock.yaml'];
  mkdirSync(join(fixture.repo, 'zzz'));
  for (const path of paths) writeFileSync(join(fixture.repo, path), 'base\n');
  git(fixture.repo, ['add', '-A']);
  git(fixture.repo, ['commit', '-m', 'chore: truncation baseline']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  git(fixture.repo, ['fetch', 'origin', 'main']);

  for (const task of ['scan-bulk-a', 'scan-bulk-b']) {
    manager(fixture.repo, [
      'spawn', task, '--base', 'origin/main',
      '--agent', 'codex', '--agent-id', `${task}-thread`, '--purpose', '截断 fixture',
    ]);
    const worktree = worktreeFor(fixture, task);
    for (const path of paths) writeFileSync(join(worktree, path), `${task}\n`);
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-m', `feat: ${task}`]);
    git(worktree, ['push', '-u', 'origin', 'HEAD']);
    manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--no-watch']);
  }

  const plan = JSON.parse(manager(fixture.repo, [
    'plan-batch', 'scan-bulk-a', 'scan-bulk-b', '--target', 'origin/main', '--scan-conflicts', '--json',
  ]));
  const pair = plan.conflict_scan.pairs[0];
  assert.equal(pair.conflict_files, 61, '计数必须是全量，不受展示截断影响');
  assert.equal(pair.files.length, 50, '展示层仍按上限截断');
  assert.equal(pair.files_truncated, true);
  assert.equal(pair.files.some((file) => file.path === 'zzz/pnpm-lock.yaml'), false, 'lock 排在 50 项之后，确实被展示截断');
  // 关键：汇总跑在截断前的全量清单上。
  const regenerated = plan.conflict_scan.summary.regenerated_paths;
  assert.equal(regenerated.length, 1);
  assert.equal(regenerated[0].path, 'zzz/pnpm-lock.yaml');
  assert.equal(regenerated[0].kind, 'lockfile');
});

test('带冲突矩阵的计划仍是合法冻结契约：batch-integrate 照常合成，不受附加字段影响', (t) => {
  const fixture = makeConflictScanFixture(t);
  // 取正交的两支，验证的是「计划里多出 conflict_scan」这一点，而不是冲突处置。
  const plan = JSON.parse(manager(fixture.repo, [
    'plan-batch', 'scan-alpha', 'scan-gamma', '--target', 'origin/main', '--scan-conflicts', '--json',
  ]));
  assert.equal(plan.conflict_scan.summary.conflicting_pairs, 0);
  const planPath = join(fixture.sandbox, 'plan-with-scan.json');
  writeFileSync(planPath, JSON.stringify(plan));

  const result = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'scan-plan-integrator', '--json',
  ]));
  assert.equal(result.outcome, 'composed');
  assert.equal(result.fingerprint, plan.fingerprint, '扫描字段不得进入新鲜度比对或指纹');
  assert.equal(result.steps.length, 2);
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

/** 只判成败、不抛异常的 git 调用，用于 ancestor / config 探测。 */
function gitOk(cwd, args) {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/** 期望命令失败，返回其 stderr。 */
function managerStderr(cwd, args) {
  try {
    manager(cwd, args);
    assert.fail('command should exit non-zero');
  } catch (error) {
    if (error?.code === 'ERR_ASSERTION') throw error;
    return String(error.stderr ?? '').trim();
  }
}

/** 建立一个已 push、处于 ready_for_review 的批次输入 feature 树。 */
function prepareBatchInput(fixture, task, file, content) {
  manager(fixture.repo, [
    'spawn', task, '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', `batch-${task}`, '--purpose', `批次输入 ${task}`,
  ]);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, file), content);
  git(worktree, ['add', file]);
  git(worktree, ['commit', '-m', `feat: ${task}`]);
  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--no-watch']);
  return worktree;
}

function freezePlan(fixture, tasks) {
  const plan = JSON.parse(manager(fixture.repo, ['plan-batch', ...tasks, '--target', 'origin/main', '--json']));
  const planPath = join(fixture.sandbox, `plan-${tasks.join('-')}.json`);
  writeFileSync(planPath, JSON.stringify(plan));
  return { plan, planPath };
}

function batchEvidence(fixture, name = 'device-suite', outcome = 'passed', options = {}) {
  const path = join(fixture.sandbox, `evidence-${name}-${outcome}.json`);
  const manifest = {
    schema_version: 1,
    checks: [{
      name,
      environment: options.environment ?? { platform: 'ios', device: 'simulator', os_version: 'test' },
      argv: ['dart', 'test'],
      outcome,
      exit_code: outcome === 'passed' ? 0 : 1,
      evidence_refs: [{ kind: 'report', id: `MR !fixture/${name}`, digest: `sha256:${'b'.repeat(64)}` }],
    }],
  };
  if (!options.omitContract) {
    manifest.contract_digest = Object.hasOwn(options, 'contractDigest') ? options.contractDigest : `sha256:${'a'.repeat(64)}`;
  }
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

test('batch-integrate 按冻结顺序合成多分支，指纹与每步 merge commit 落账', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'compose-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'compose-beta', 'beta.txt', 'beta\n');
  const { plan, planPath } = freezePlan(fixture, ['compose-alpha', 'compose-beta']);

  const result = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'compose-integrator', '--json',
  ]));
  assert.equal(result.outcome, 'composed');
  assert.equal(result.fingerprint, plan.fingerprint);
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.steps.map((step) => step.input_sha), plan.included.map((item) => item.head));

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
  assert.equal(audit.events.some((event) => event.event_type === 'batch_candidate_composed'), true);

  // 幂等：同指纹重跑不再合成，直接返回既有候选。
  const again = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'compose-integrator', '--json',
  ]));
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
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'plain-integrator',
  ]);
  assert.match(output, /批次合成完成/);
  assert.match(output, /下一步由 controller 执行门禁/);

  const again = manager(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'plain-integrator',
  ]);
  assert.match(again, /同指纹候选已合成，幂等返回/);
});

test('batch-result 冻结终态证据，archive-evidence 保留精确候选后回收 done worktree', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'evidence-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'evidence-beta', 'beta.txt', 'beta\n');
  const { plan, planPath } = freezePlan(fixture, ['evidence-alpha', 'evidence-beta']);
  const composed = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'evidence-integrator', '--json',
  ]));
  manager(fixture.repo, ['touch', composed.candidate.task, '--status', 'done', '--note', '设备验收已结束，待冻结证据']);
  const unrecorded = JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings
    .find((item) => item.code === 'DONE_BATCH_CANDIDATE_RESULT_UNRECORDED' && item.worktree_id === composed.candidate.worktree_id);
  assert.equal(unrecorded.candidate_sha, composed.composed_sha);
  assert.match(managerStderr(fixture.repo, [
    'reclaim', composed.candidate.task, '--archive-evidence', composed.composed_sha, '--reason', '尚未冻结结果',
  ]), /尚未通过 batch-result/);
  const evidencePath = batchEvidence(fixture);
  const frozen = JSON.parse(manager(fixture.repo, [
    'batch-result', composed.candidate.task, '--state', 'passed',
    '--candidate', composed.composed_sha, '--evidence', evidencePath, '--json',
  ]));
  assert.equal(frozen.outcome, 'passed');
  assert.equal(frozen.candidate_sha, composed.composed_sha);
  assert.match(frozen.result_digest, /^sha256:/);
  assert.equal(recordFor(fixture, composed.candidate.task).task_status, 'done');
  const frozenAgain = JSON.parse(manager(fixture.repo, [
    'batch-result', composed.candidate.task, '--state', 'passed',
    '--candidate', composed.composed_sha, '--evidence', evidencePath, '--json',
  ]));
  assert.equal(frozenAgain.result_digest, frozen.result_digest);

  const pendingFinding = JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings
    .find((item) => item.code === 'DONE_EVIDENCE_WORKTREE_RECLAIM_PENDING' && item.worktree_id === composed.candidate.worktree_id);
  assert.equal(pendingFinding.candidate_sha, composed.composed_sha);

  // dirty、错误 SHA 都不得提前创建 archive ref。
  const archiveRef = `refs/worktree-archive/evidence/${composed.candidate.worktree_id}`;
  const candidateTree = git(composed.candidate.path, ['rev-parse', 'HEAD^{tree}']);
  const mergeSide = git(composed.candidate.path, ['commit-tree', candidateTree, '-p', composed.composed_sha, '-m', 'test: pending merge']);
  git(composed.candidate.path, ['merge', '--no-commit', '--no-ff', mergeSide]);
  assert.match(managerStderr(fixture.repo, [
    'reclaim', composed.candidate.task, '--archive-evidence', composed.composed_sha, '--reason', '固定设备候选已验收',
  ]), /git operation in progress/);
  git(composed.candidate.path, ['merge', '--abort']);
  git(fixture.repo, ['update-ref', archiveRef, plan.target.sha]);
  assert.match(managerStderr(fixture.repo, [
    'reclaim', composed.candidate.task, '--archive-evidence', composed.composed_sha, '--reason', '固定设备候选已验收',
  ]), /归档 ref 已指向其他提交/);
  assert.equal(git(fixture.repo, ['rev-parse', `${archiveRef}^{commit}`]), plan.target.sha);
  git(fixture.repo, ['update-ref', '-d', archiveRef]);
  writeFileSync(join(composed.candidate.path, 'dirty.txt'), 'dirty\n');
  assert.match(managerStderr(fixture.repo, [
    'reclaim', composed.candidate.task, '--archive-evidence', composed.composed_sha, '--reason', '固定设备候选已验收',
  ]), /必须干净|归档前置条件/);
  assert.equal(gitOk(fixture.repo, ['show-ref', '--verify', archiveRef]), false);
  rmSync(join(composed.candidate.path, 'dirty.txt'));
  assert.match(managerStderr(fixture.repo, [
    'reclaim', composed.candidate.task, '--archive-evidence', planPath.length.toString(16).padStart(composed.composed_sha.length, '0'), '--reason', '固定设备候选已验收',
  ]), /完整 commit object ID/);

  const output = manager(fixture.repo, [
    'reclaim', composed.candidate.task, '--archive-evidence', composed.composed_sha,
    '--reason', '固定设备候选已完成验收，功能输入另行合入目标分支',
  ]);
  assert.match(output, /证据归档=refs\/worktree-archive\/evidence/);
  assert.equal(git(fixture.repo, ['rev-parse', `${archiveRef}^{commit}`]), composed.composed_sha);
  assert.equal(git(fixture.repo, ['show', `${archiveRef}:alpha.txt`]), 'alpha');
  assert.equal(existsSync(composed.candidate.path), false);
  const reclaimed = recordFor(fixture, composed.candidate.task, true);
  assert.equal(reclaimed.worktree_state, 'reclaimed');
  assert.equal(reclaimed.task_status, 'done');
  assert.equal(reclaimed.batch_result.outcome, 'passed');
  assert.equal(reclaimed.evidence_archive.batch_result_digest, frozen.result_digest);
  assert.equal(reclaimed.reclaim_summary.reclaim_evidence.kind, 'batch_evidence_archive');

  // 重跑同一归档回收保持幂等，恢复 ref 仍精确指向候选 SHA。
  manager(fixture.repo, [
    'reclaim', composed.candidate.task, '--archive-evidence', composed.composed_sha,
    '--reason', '固定设备候选已完成验收，功能输入另行合入目标分支',
  ]);
  assert.equal(git(fixture.repo, ['rev-parse', `${archiveRef}^{commit}`]), composed.composed_sha);
  assert.match(managerStderr(fixture.repo, [
    'reclaim', composed.candidate.task, '--archive-evidence', composed.composed_sha,
    '--reason', '试图改写已经冻结的归档原因',
  ]), /不同的证据归档/);
});

test('batch-result 拒绝覆盖终态，并在 passed 前要求合成后步骤全部成功或跳过', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.repo, '.worktree-trace.json'), `${JSON.stringify({
    schema_version: 1,
    default_base: 'origin/main',
    post_integrate_steps: [{ name: 'regenerate', hint: '重生成产物' }],
  }, null, 2)}\n`);
  publishProfile(fixture);
  prepareBatchInput(fixture, 'result-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'result-beta', 'beta.txt', 'beta\n');
  const { planPath } = freezePlan(fixture, ['result-alpha', 'result-beta']);
  const composed = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'result-integrator', '--json',
  ]));
  const missingContract = batchEvidence(fixture, 'missing-contract', 'passed', { omitContract: true });
  assert.match(managerStderr(fixture.repo, [
    'batch-result', composed.candidate.task, '--state', 'passed', '--candidate', composed.composed_sha,
    '--evidence', missingContract,
  ]), /非空 contract_digest/);
  const sensitiveEnvironment = batchEvidence(fixture, 'sensitive-environment', 'passed', { environment: { api_key: 'must-not-enter-trace' } });
  assert.match(managerStderr(fixture.repo, [
    'batch-result', composed.candidate.task, '--state', 'passed', '--candidate', composed.composed_sha,
    '--evidence', sensitiveEnvironment,
  ]), /不含敏感键/);
  const passedEvidence = batchEvidence(fixture, 'passed-suite', 'passed');
  assert.match(managerStderr(fixture.repo, [
    'batch-result', composed.candidate.task, '--state', 'passed', '--candidate', composed.composed_sha,
    '--evidence', passedEvidence,
  ]), /合成后步骤/);
  manager(fixture.repo, ['batch-step', composed.candidate.task, '--step', 'regenerate', '--state', 'done']);
  manager(fixture.repo, [
    'batch-result', composed.candidate.task, '--state', 'passed', '--candidate', composed.composed_sha,
    '--evidence', passedEvidence,
  ]);
  const failedEvidence = batchEvidence(fixture, 'failed-suite', 'failed');
  assert.match(managerStderr(fixture.repo, [
    'batch-result', composed.candidate.task, '--state', 'failed', '--candidate', composed.composed_sha,
    '--evidence', failedEvidence,
  ]), /不得覆盖终态结果/);
  assert.match(managerStderr(fixture.repo, [
    'batch-step', composed.candidate.task, '--step', 'regenerate', '--state', 'skipped',
  ]), /batch_result 已冻结/);
  assert.match(managerStderr(fixture.repo, [
    'batch-integrate', '--plan', planPath, '--agent', 'codex', '--agent-id', 'result-integrator',
    '--recompose', '--recompose-head', composed.composed_sha,
  ]), /batch_result 已冻结/);
});

test('batch-result stale 可用 null contract digest 表达尚未形成独立验收合同', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'stale-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'stale-beta', 'beta.txt', 'beta\n');
  const { planPath } = freezePlan(fixture, ['stale-alpha', 'stale-beta']);
  const composed = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'stale-integrator', '--json',
  ]));
  const evidence = batchEvidence(fixture, 'stale-observation', 'passed', { contractDigest: null });
  const result = JSON.parse(manager(fixture.repo, [
    'batch-result', composed.candidate.task, '--state', 'stale', '--candidate', composed.composed_sha,
    '--evidence', evidence, '--reason', '目标分支在验收合同冻结前已经前进', '--json',
  ]));
  assert.equal(result.outcome, 'stale');
  assert.equal(result.evidence_manifest.contract_digest, null);
  assert.equal(result.reason, '目标分支在验收合同冻结前已经前进');
});

test('reclaim --pushed 拒绝只由待删除分支引用的 SHA', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, ['spawn', 'unprotected-head', '--agent', 'codex', '--agent-id', 'push-proof', '--purpose', '验证持久 ref']);
  const tree = worktreeFor(fixture, 'unprotected-head');
  writeFileSync(join(tree, 'unique.txt'), 'unique\n');
  git(tree, ['add', 'unique.txt']);
  git(tree, ['commit', '-m', 'feat: unique candidate']);
  const head = git(tree, ['rev-parse', 'HEAD']);
  assert.match(managerStderr(fixture.repo, ['reclaim', 'unprotected-head', '--pushed', head]), /只由待删除候选分支保护/);
  assert.equal(existsSync(tree), true);
  git(fixture.repo, ['tag', 'durable-proof', head]);
  manager(fixture.repo, ['reclaim', 'unprotected-head', '--pushed', head]);
  assert.equal(git(fixture.repo, ['rev-parse', 'durable-proof^{commit}']), head);
  assert.equal(existsSync(tree), false);
});

test('reclaim --pushed 接受唯一短 SHA，并把完整 OID 写入证据', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn', 'short-pushed-proof', '--agent', 'codex', '--agent-id', 'short-pushed-thread', '--purpose', '短 SHA 回收',
  ]);
  const tree = worktreeFor(fixture, 'short-pushed-proof');
  writeFileSync(join(tree, 'short.txt'), 'short\n');
  git(tree, ['add', 'short.txt']);
  git(tree, ['commit', '-m', 'feat: short pushed proof']);
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, 'short-pushed-proof')]);
  const target = git(fixture.repo, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['reclaim', 'short-pushed-proof', '--pushed', target.slice(0, 12)]);
  const record = recordFor(fixture, 'short-pushed-proof', true);
  assert.equal(record.reclaim_summary.target_sha, target);
  assert.equal(record.reclaim_summary.reclaim_evidence.target_sha, target);
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
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'drift-integrator',
  ]);
  assert.match(stderr, /BATCH_PLAN_STALE/);
  assert.match(stderr, /target SHA/);
  assert.match(stderr, /重新执行 plan-batch/);
  // fail-closed：不得留下任何已合成候选。
  const listing = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  const allRecords = [...listing.worktrees.map((row) => row.record).filter(Boolean), ...listing.records];
  assert.equal(allRecords.some((record) => record.batch_integration), false);
});

test('batch-integrate 冲突时 fail-closed：停在冲突处、输出结构化报告、不自动解也不自动 abort', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  // 两个 feature 改同一文件同一行 → 合成必冲突。
  prepareBatchInput(fixture, 'conflict-alpha', 'shared.txt', 'alpha side\n');
  prepareBatchInput(fixture, 'conflict-beta', 'shared.txt', 'beta side\n');
  const { plan, planPath } = freezePlan(fixture, ['conflict-alpha', 'conflict-beta']);

  const stdout = managerKeep(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'conflict-integrator', '--json',
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
  assert.equal(audit.events.some((event) => event.event_type === 'batch_candidate_conflict'), true);
});

test('batch-integrate --abort-on-conflict 一键回滚到干净 target', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'abort-alpha', 'shared.txt', 'alpha side\n');
  prepareBatchInput(fixture, 'abort-beta', 'shared.txt', 'beta side\n');
  const { plan, planPath } = freezePlan(fixture, ['abort-alpha', 'abort-beta']);

  const result = JSON.parse(managerKeep(fixture.repo, [
    'batch-integrate', '--plan', planPath, '--abort-on-conflict',
    '--agent', 'codex', '--agent-id', 'abort-integrator', '--json',
  ]));
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

  const first = JSON.parse(managerKeep(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'rerere-integrator', '--json',
  ]));
  assert.equal(first.outcome, 'conflict');
  assert.equal(first.rerere.enabled, true, 'rerere 必须在候选树启用，否则解法无法被录下');
  const candidatePath = first.conflict.candidate_path;

  // controller 手工裁决并提交这次 merge —— rerere 在此录下解法。
  writeFileSync(join(candidatePath, 'shared.txt'), 'alpha side\nbeta side\n');
  git(candidatePath, ['add', 'shared.txt']);
  git(candidatePath, ['commit', '--no-edit']);

  // 第二轮：重置到 target 重新合成，同一冲突应被 rerere 自动重放，无需再次手解。
  const second = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'rerere-integrator', '--json',
  ]));
  assert.equal(second.outcome, 'composed', '第二轮应由 rerere 自动解出，不再冲突');
  assert.equal(second.steps.some((step) => step.rerere_replayed), true);
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
  const round1 = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', first.planPath,
    '--agent', 'codex', '--agent-id', 'supersede-integrator', '--json',
  ]));
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
    'batch-integrate', '--plan', second.planPath,
    '--agent', 'codex', '--agent-id', 'supersede-integrator',
  ]);
  assert.match(refused, /--candidate-task/);

  const round2 = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', second.planPath,
    '--candidate-task', 'batch-integration-second-candidate',
    '--agent', 'codex', '--agent-id', 'supersede-integrator', '--json',
  ]));
  assert.equal(round2.outcome, 'composed');
  assert.notEqual(round2.candidate.worktree_id, round1.candidate.worktree_id);

  const oldRecord = recordFor(fixture, round1.candidate.task, true);
  const newRecord = recordFor(fixture, round2.candidate.task);
  assert.equal(oldRecord.task_status, 'abandoned');
  assert.equal(oldRecord.superseded_by.worktree_id, newRecord.worktree_id);
  assert.equal(newRecord.delivery_relation.kind, 'supersedes');
  assert.equal(newRecord.delivery_relation.superseded_worktree_id, oldRecord.worktree_id);
});

test('Profile 声明的合成后步骤只回显并可登记结果，portable core 不代跑', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.repo, '.worktree-trace.json'), `${JSON.stringify({
    schema_version: 1,
    default_base: 'origin/main',
    post_integrate_steps: [
      { name: 'regenerate-golden', hint: '在候选树重跑 golden 生成命令后提交' },
      { name: 'recompute-lock', hint: '重算依赖锁文件' },
    ],
  }, null, 2)}\n`);
  publishProfile(fixture);
  prepareBatchInput(fixture, 'declared-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'declared-beta', 'beta.txt', 'beta\n');
  const { planPath } = freezePlan(fixture, ['declared-alpha', 'declared-beta']);

  const result = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'declared-integrator', '--json',
  ]));
  assert.equal(result.outcome, 'composed');
  assert.deepEqual(result.post_integrate_steps.map((step) => step.name), ['regenerate-golden', 'recompute-lock']);
  assert.equal(result.post_integrate_steps.every((step) => step.state === 'pending'), true);
  // 只声明不执行：候选树里不会凭空出现声明步骤的产物。
  assert.equal(existsSync(join(result.candidate.path, 'golden')), false);

  const recorded = JSON.parse(manager(fixture.repo, [
    'batch-step', result.candidate.task, '--step', 'regenerate-golden',
    '--state', 'done', '--note', '已在候选树重烤并提交', '--json',
  ]));
  const done = recorded.post_integrate_steps.find((step) => step.name === 'regenerate-golden');
  assert.equal(done.state, 'done');
  assert.equal(done.note, '已在候选树重烤并提交');
  assert.equal(typeof done.recorded_at, 'string');

  const rejected = managerStderr(fixture.repo, [
    'batch-step', result.candidate.task, '--step', 'not-declared', '--state', 'done',
  ]);
  assert.match(rejected, /未声明的步骤名/);
});

test('touch ready_for_review 默认武装 watch，--no-watch 退出，HEAD 变化时重冻结', (t) => {
  const fixture = makeRemoteRepo();
  const task = 'auto-armed-review';
  t.after(() => {
    try { manager(fixture.repo, ['unwatch', task]); } catch {}
    try { manager(fixture.repo, ['unwatch', 'opted-out-review']); } catch {}
    try { manager(fixture.repo, ['unwatch', 'base-following-review']); } catch {}
    fixture.cleanup();
  });
  writeFileSync(join(fixture.repo, '.worktree-trace.json'), `${JSON.stringify({
    schema_version: 1,
    default_base: 'origin/main',
  }, null, 2)}\n`);
  publishProfile(fixture);
  git(fixture.repo, ['branch', 'review-target']);
  git(fixture.repo, ['push', 'origin', 'review-target']);

  // --no-watch：显式退出默认武装。
  manager(fixture.repo, [
    'spawn', 'opted-out-review', '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'opted-out-thread', '--purpose', '退出自动武装',
  ]);
  const optedOutTree = worktreeFor(fixture, 'opted-out-review');
  writeFileSync(join(optedOutTree, 'f.txt'), 'x\n');
  git(optedOutTree, ['add', 'f.txt']);
  git(optedOutTree, ['commit', '-m', 'feat: opted out']);
  git(optedOutTree, ['push', '-u', 'origin', 'HEAD']);
  const optedOut = manager(fixture.repo, ['touch', 'opted-out-review', '--status', 'ready_for_review', '--no-watch']);
  assert.match(optedOut, /--no-watch/);
  assert.equal(recordFor(fixture, 'opted-out-review').auto_reclaim ?? null, null);

  // 人工 watch 的 target 属于显式指令，touch 不得静默改指。
  manager(fixture.repo, ['watch', 'opted-out-review', '--target', 'origin/main']);
  assert.equal(recordFor(fixture, 'opted-out-review').auto_reclaim.armed_by, 'explicit');
  const protectedTarget = manager(fixture.repo, [
    'touch', 'opted-out-review', '--status', 'ready_for_review', '--target', 'origin/review-target',
  ]);
  assert.match(protectedTarget, /换目标请先 unwatch/);
  assert.equal(recordFor(fixture, 'opted-out-review').auto_reclaim.target_ref, 'origin/main');

  // 非默认 base 是该树登记的评审目标；自动武装不得被 Profile default_base 改回 main。
  manager(fixture.repo, [
    'spawn', 'base-following-review', '--base', 'origin/review-target', '--base-reason', '版本分支目标',
    '--agent', 'codex', '--agent-id', 'base-following-thread', '--purpose', '跟随登记 base',
  ]);
  const baseFollowingTree = worktreeFor(fixture, 'base-following-review');
  writeFileSync(join(baseFollowingTree, 'base-following.txt'), 'base\n');
  git(baseFollowingTree, ['add', 'base-following.txt']);
  git(baseFollowingTree, ['commit', '-m', 'feat: follow managed base']);
  git(baseFollowingTree, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'base-following-review', '--status', 'ready_for_review']);
  const baseFollowingRecord = recordFor(fixture, 'base-following-review');
  assert.equal(baseFollowingRecord.auto_reclaim.target_ref, 'origin/review-target');
  assert.equal(baseFollowingRecord.auto_reclaim.target_base_sha, git(fixture.repo, ['rev-parse', 'origin/review-target']));

  // 默认：进入 ready_for_review 即自动武装，target 取 Profile default_base。
  manager(fixture.repo, [
    'spawn', task, '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'auto-armed-thread', '--purpose', '默认自动武装',
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
    'touch', task, '--status', 'ready_for_review', '--target', 'origin/review-target',
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
  assert.equal(audit.events.some((event) => event.event_type === 'auto_reclaim_rearmed'), true);
});

test('未推送或无远端主干时自动武装 fail-soft，touch 本身仍然成功', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn', 'unpushed-review', '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'unpushed-thread', '--purpose', '未推送即进入验收',
  ]);
  const worktree = worktreeFor(fixture, 'unpushed-review');
  writeFileSync(join(worktree, 'feature.txt'), 'not pushed\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: not pushed']);

  const output = manager(fixture.repo, ['touch', 'unpushed-review', '--status', 'ready_for_review']);
  assert.match(output, /已更新/);
  assert.match(output, /watch 未武装/);
  assert.match(output, /尚未完整 push/);
  assert.equal(recordFor(fixture, 'unpushed-review').task_status, 'ready_for_review');
  assert.equal(recordFor(fixture, 'unpushed-review').auto_reclaim ?? null, null);
});

test('watcher 区分 target 前进的干净预判，refresh-review 可暂停门禁后精确 push 并重冻结', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'review-refresh-clean';
  t.after(() => {
    try { manager(fixture.repo, ['unwatch', task]); } catch {}
    fixture.cleanup();
  });
  manager(fixture.repo, [
    'spawn', task, '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'review-refresh-clean-thread', '--purpose', '刷新无冲突评审',
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
  assert.equal(JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.some((item) => item.code === 'TARGET_ADVANCED_REFRESH_CLEAN'), true);

  const paused = manager(fixture.repo, ['refresh-review', task, '--pause-before-push']);
  assert.match(paused, /暂停在 push 前/);
  record = recordFor(fixture, task);
  assert.equal(record.review_refresh.state, 'rebased');
  assert.equal(record.task_status, 'active');
  const rebasedHead = git(worktree, ['rev-parse', 'HEAD']);
  assert.notEqual(rebasedHead, oldHead);
  assert.equal(git(fixture.remote, ['rev-parse', `refs/heads/${record.branch}`]), oldHead, '暂停阶段不得提前改写远端');
  assert.equal(JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.some((item) => item.code === 'REVIEW_REFRESH_PENDING'), true);

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
    try { manager(fixture.repo, ['unwatch', task]); } catch {}
    fixture.cleanup();
  });
  const initialBase = git(fixture.repo, ['rev-parse', 'origin/main']);
  manager(fixture.repo, [
    'spawn', task, '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'review-refresh-abort-thread', '--purpose', '门禁失败放弃刷新',
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
  assert.throws(
    () => manager(fixture.repo, ['refresh-review', task, '--continue']),
    /upstream 分支 .* 已不存在/,
  );
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
    try { manager(fixture.repo, ['unwatch', task]); } catch {}
    fixture.cleanup();
  });
  writeFileSync(join(fixture.repo, 'abort-conflict.txt'), 'base\n');
  git(fixture.repo, ['add', 'abort-conflict.txt']);
  git(fixture.repo, ['commit', '-m', 'feat: conflict abort base']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  const initialBase = git(fixture.repo, ['rev-parse', 'HEAD']);
  manager(fixture.repo, [
    'spawn', task, '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'review-refresh-conflict-abort-thread', '--purpose', '冲突态放弃刷新',
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
    try { manager(fixture.repo, ['unwatch', task]); } catch {}
    fixture.cleanup();
  });
  writeFileSync(join(fixture.repo, 'shared-refresh.txt'), 'base\n');
  git(fixture.repo, ['add', 'shared-refresh.txt']);
  git(fixture.repo, ['commit', '-m', 'feat: shared refresh base']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);

  manager(fixture.repo, [
    'spawn', task, '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'review-refresh-conflict-thread', '--purpose', '刷新冲突评审',
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
  assert.equal(JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.some((item) => item.code === 'REBASE_NEEDED'), true);

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

test('[P1-1] 被折叠的输入随后前进时，冻结计划必须判定为 stale 而不是静默漏合成', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  // 父 → 子链：plan-batch 会折叠父分支，included 只留子分支。
  manager(fixture.repo, [
    'spawn', 'fold-parent', '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'fold-parent-thread', '--purpose', '父输入',
  ]);
  const parent = worktreeFor(fixture, 'fold-parent');
  writeFileSync(join(parent, 'parent.txt'), 'p1\n');
  git(parent, ['add', 'parent.txt']);
  git(parent, ['commit', '-m', 'feat: parent v1']);
  git(parent, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'fold-parent', '--status', 'ready_for_review', '--no-watch']);

  manager(fixture.repo, [
    'spawn', 'fold-child', '--base', 'origin/codex/fold-parent',
    '--base-reason', '依赖父输入', '--agent', 'codex', '--agent-id', 'fold-child-thread', '--purpose', '子输入',
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
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'fold-integrator',
  ]);
  assert.match(stderr, /BATCH_PLAN_STALE/);
  assert.match(stderr, /重新执行 plan-batch/);
  // 关键：不得留下任何按旧计划合成出来的候选。
  const listing = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  const allRecords = [...listing.worktrees.map((row) => row.record).filter(Boolean), ...listing.records];
  assert.equal(allRecords.some((record) => record.batch_integration), false);
});

test('[P1-2] 冻结 head 过期且无法重冻结时解除旧 watcher，不让它用过期证据推进终态', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'stale-freeze-review';
  t.after(() => {
    try { manager(fixture.repo, ['unwatch', task]); } catch {}
    fixture.cleanup();
  });
  writeFileSync(join(fixture.repo, '.worktree-trace.json'), `${JSON.stringify({
    schema_version: 1,
    default_base: 'origin/main',
  }, null, 2)}\n`);
  publishProfile(fixture);

  manager(fixture.repo, [
    'spawn', task, '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'stale-freeze-thread', '--purpose', '过期冻结',
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
  const audit = JSON.parse(manager(fixture.repo, ['audit', task, '--json']));
  assert.equal(audit.events.length, auditBefore.events.length + 1, '状态更新与 watcher 失效必须由同一条原子 event 完成');
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
  writeFileSync(join(fixture.repo, '.worktree-trace.json'), `${JSON.stringify({
    schema_version: 1,
    default_base: 'origin/main',
    post_integrate_steps: [{ name: 'regenerate-golden', hint: '重烤 golden 后提交' }],
  }, null, 2)}\n`);
  publishProfile(fixture);
  prepareBatchInput(fixture, 'postgen-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'postgen-beta', 'beta.txt', 'beta\n');
  const { planPath } = freezePlan(fixture, ['postgen-alpha', 'postgen-beta']);

  const first = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'postgen-integrator', '--json',
  ]));
  assert.equal(first.outcome, 'composed');
  const candidatePath = first.candidate.path;

  // controller 执行声明的合成后步骤并提交 —— 候选 HEAD 从此不等于 composed_sha。
  writeFileSync(join(candidatePath, 'golden.txt'), 'regenerated\n');
  git(candidatePath, ['add', 'golden.txt']);
  git(candidatePath, ['commit', '-m', 'chore: regenerate golden']);
  const afterGolden = git(candidatePath, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['batch-step', first.candidate.task, '--step', 'regenerate-golden', '--state', 'done']);

  const second = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'postgen-integrator', '--json',
  ]));
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
  assert.match(managerStderr(fixture.repo, [
    'batch-integrate', '--plan', planPath, '--recompose',
    '--agent', 'codex', '--agent-id', 'postgen-integrator', '--json',
  ]), /必须同时提供 --recompose-head/);
  assert.match(managerStderr(fixture.repo, [
    'batch-integrate', '--plan', planPath, '--recompose', '--recompose-head', first.composed_sha,
    '--agent', 'codex', '--agent-id', 'postgen-integrator', '--json',
  ]), /RECOMPOSE_HEAD_STALE/);
  assert.equal(git(candidatePath, ['rev-parse', 'HEAD']), afterGolden);
  assert.equal(existsSync(join(candidatePath, 'golden.txt')), true);

  // 完整 HEAD 明示授权后，才回到冻结 target 重新合成。
  const recomposed = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', planPath, '--recompose', '--recompose-head', afterGolden,
    '--agent', 'codex', '--agent-id', 'postgen-integrator', '--json',
  ]));
  assert.equal(recomposed.outcome, 'composed');
  assert.equal(recomposed.recompose.authorized_head_sha, afterGolden);
  assert.equal(recomposed.recompose.discarded_head_sha, afterGolden);
  assert.equal(recomposed.recompose.previous_composed_sha, first.composed_sha);
  assert.equal(existsSync(join(candidatePath, 'golden.txt')), false, '--recompose 明示丢弃合成后的提交');
  assert.equal(
    recomposed.post_integrate_steps.find((step) => step.name === 'regenerate-golden').state,
    'pending',
  );
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

  const first = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'owner-a', '--json',
  ]));
  const candidatePath = first.candidate.path;
  writeFileSync(join(candidatePath, 'owner-a-result.txt'), 'must survive\n');
  git(candidatePath, ['add', 'owner-a-result.txt']);
  git(candidatePath, ['commit', '-m', 'chore: owner A post-step']);
  const ownerAHead = git(candidatePath, ['rev-parse', 'HEAD']);

  const readOnly = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'owner-b', '--json',
  ]));
  assert.equal(readOnly.outcome, 'already_composed');
  assert.equal(readOnly.head_sha, ownerAHead);

  const denied = managerStderr(fixture.repo, [
    'batch-integrate', '--plan', planPath, '--recompose', '--recompose-head', ownerAHead,
    '--agent', 'codex', '--agent-id', 'owner-b', '--json',
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

  const first = JSON.parse(managerKeep(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'inherit-integrator', '--json',
  ]));
  assert.equal(first.outcome, 'conflict');
  assert.equal(first.rerere.enabled, true);
  assert.equal(first.rerere.auto_update, true, '继承 enabled 也必须补齐 autoUpdate');
  const candidatePath = first.conflict.candidate_path;
  assert.equal(git(candidatePath, ['config', '--get', 'rerere.autoUpdate']), 'true');

  writeFileSync(join(candidatePath, 'shared.txt'), 'alpha side\nbeta side\n');
  git(candidatePath, ['add', 'shared.txt']);
  git(candidatePath, ['commit', '--no-edit']);

  const second = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', planPath,
    '--agent', 'codex', '--agent-id', 'inherit-integrator', '--json',
  ]));
  assert.equal(second.outcome, 'composed', '补齐 autoUpdate 后第二轮应自动重放解法');
  assert.equal(second.steps.some((step) => step.rerere_replayed), true);
});

test('[P2-2] 自动写共享 extensions.worktreeConfig 留独立审计事件，并如实记录覆盖前值', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  git(fixture.repo, ['config', 'extensions.worktreeConfig', 'false']);
  assert.equal(git(fixture.repo, ['config', '--get', 'extensions.worktreeConfig']), 'false', '前置：扩展显式关闭');
  prepareBatchInput(fixture, 'audit-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'audit-beta', 'beta.txt', 'beta\n');
  const first = freezePlan(fixture, ['audit-alpha', 'audit-beta']);

  const round1 = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', first.planPath,
    '--agent', 'codex', '--agent-id', 'audit-integrator', '--json',
  ]));
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
  const round2 = JSON.parse(manager(fixture.repo, [
    'batch-integrate', '--plan', second.planPath,
    '--candidate-task', 'batch-integration-audit-second',
    '--agent', 'codex', '--agent-id', 'audit-integrator', '--json',
  ]));
  assert.notEqual(round2.rerere.worktree_config_extension, 'enabled_by_this_command');
  const audit2 = JSON.parse(manager(fixture.repo, ['audit', round2.candidate.task, '--json']));
  assert.equal(
    audit2.events.some((event) => event.event_type === 'repository_config_extension_enabled'),
    false,
    '扩展原本已启用时不得伪造写入事件',
  );
});

test('managed rebase 原子刷新堆叠父关系、base 与 ownership，并使旧 Artifact 失效', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);

  manager(fixture.repo, [
    'spawn', 'stack-parent-managed', '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'stack-parent-thread', '--purpose', '堆叠父任务',
  ]);
  const parent = worktreeFor(fixture, 'stack-parent-managed');
  writeFileSync(join(parent, 'parent.txt'), 'parent v1\n');
  git(parent, ['add', 'parent.txt']);
  git(parent, ['commit', '-m', 'feat: parent v1']);
  git(parent, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'stack-parent-managed']);
  const parentBranch = branchFor(fixture, 'stack-parent-managed');

  manager(fixture.repo, [
    'spawn', 'stack-child-managed', '--base', `origin/${parentBranch}`, '--base-reason', '依赖父任务',
    '--agent', 'codex', '--agent-id', 'stack-child-thread', '--purpose', '堆叠子任务',
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
  assert.match(managerStderr(fixture.repo, [
    'rebase', 'stack-child-managed', '--onto', branchFor(fixture, 'stack-child-managed'),
    '--expected-head', oldHead, '--reason', '非法自引用',
  ]), /stack parent 环/);

  writeFileSync(join(parent, 'parent-next.txt'), 'parent v2\n');
  git(parent, ['add', 'parent-next.txt']);
  git(parent, ['commit', '-m', 'feat: parent v2']);
  git(parent, ['push', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'stack-parent-managed']);
  const parentV2 = git(parent, ['rev-parse', 'HEAD']);

  const output = manager(fixture.repo, [
    'rebase', 'stack-child-managed', '--onto', `origin/${parentBranch}`,
    '--expected-head', oldHead, '--reason', '吸收父任务 v2',
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
  assert.match(managerStderr(fixture.repo, [
    'rebase', 'stack-child-managed', '--onto', 'origin/main',
    '--expected-head', oldHead, '--reason', 'stale CAS',
  ]), /CAS/);

  const retargeted = manager(fixture.repo, [
    'retarget', 'stack-child-managed', '--base', 'origin/main',
    '--expected-head', childV2, '--reason', 'MR 改为直接合入 main',
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
    'spawn', 'conflict-parent-managed', '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'conflict-parent-thread', '--purpose', '冲突父任务',
  ]);
  const parent = worktreeFor(fixture, 'conflict-parent-managed');
  writeFileSync(join(parent, 'shared.txt'), 'base\n');
  git(parent, ['add', 'shared.txt']);
  git(parent, ['commit', '-m', 'feat: shared base']);
  git(parent, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'conflict-parent-managed']);
  const parentBranch = branchFor(fixture, 'conflict-parent-managed');

  manager(fixture.repo, [
    'spawn', 'conflict-child-managed', '--base', `origin/${parentBranch}`, '--base-reason', '依赖父任务',
    '--agent', 'codex', '--agent-id', 'conflict-child-thread', '--purpose', '冲突子任务',
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
    'rebase', 'conflict-child-managed', '--onto', `origin/${parentBranch}`,
    '--expected-head', oldHead, '--reason', '吸收冲突父任务',
  ];
  assert.match(managerStderr(fixture.repo, baseArgs), /发生冲突/);
  const pending = recordFor(fixture, 'conflict-child-managed');
  assert.equal(pending.history_operation.state, 'conflicted');
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctor.findings.some((finding) => finding.code === 'MANAGED_HISTORY_OPERATION_PENDING'), true);
  assert.match(managerStderr(fixture.repo, ['artifact', 'conflict-child-managed', '--json']), /未完成/);

  writeFileSync(join(child, 'shared.txt'), 'resolved\n');
  git(child, ['add', 'shared.txt']);
  assert.match(managerStderr(fixture.repo, [
    'rebase', 'conflict-child-managed', '--onto', 'origin/main', '--continue',
  ]), /参数不一致/);
  assert.match(manager(fixture.repo, ['rebase', 'conflict-child-managed', '--continue']), /finalize rebase/);
  const completed = recordFor(fixture, 'conflict-child-managed');
  assert.equal(completed.history_operation, null);
  assert.equal(completed.history_rewrites.length, 1);
  assert.equal(readFileSync(join(child, 'shared.txt'), 'utf8'), 'resolved\n');
});

test('touch 可一次登记 MR URL、评审状态与 watcher target，并拒绝非 HTTP URL', (t) => {
  const fixture = makeRemoteRepo();
  const task = 'structured-mr-touch';
  t.after(() => {
    try { manager(fixture.repo, ['unwatch', task]); } catch {}
    fixture.cleanup();
  });
  manager(fixture.repo, [
    'spawn', task, '--base', 'origin/main',
    '--agent', 'codex', '--agent-id', 'structured-mr-thread', '--purpose', '一次登记 MR',
  ]);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, 'mr.txt'), 'mr\n');
  git(worktree, ['add', 'mr.txt']);
  git(worktree, ['commit', '-m', 'feat: structured MR']);
  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  const mrUrl = 'https://gitlab.example.invalid/group/project/-/merge_requests/42';
  const output = manager(fixture.repo, [
    'touch', task, '--status', 'ready_for_review', '--mr', mrUrl,
    '--watch-target', 'origin/main', '--interval-ms', '100', '--notify', 'off',
  ]);
  assert.match(output, /watch 已武装/);
  const record = recordFor(fixture, task);
  assert.equal(record.task_status, 'ready_for_review');
  assert.equal(record.change_request.url, mrUrl);
  assert.equal(record.change_request.target_ref, 'origin/main');
  assert.equal(record.auto_reclaim.target_ref, 'origin/main');
  assert.equal(record.auto_reclaim.change_ref, mrUrl);
  assert.match(managerStderr(fixture.repo, [
    'touch', task, '--status', 'ready_for_review', '--mr', 'javascript:alert(1)', '--no-watch',
  ]), /http/iu);
});

test('list --present 只显示目录仍存在的 record，既有 TRACKED/UNTRACKED/MAIN 分类与默认行为不变', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, ['spawn', 'present-noise-task', '--agent', 'codex', '--agent-id', 'present-noise-1', '--purpose', 'stays present']);
  manager(fixture.repo, ['spawn', 'gone-noise-task', '--agent', 'codex', '--agent-id', 'gone-noise-1', '--purpose', 'directory disappears']);
  const goneWorktree = worktreeFor(fixture, 'gone-noise-task');
  git(fixture.repo, ['worktree', 'remove', goneWorktree]);

  const defaultListing = JSON.parse(manager(fixture.repo, ['list', '--json']));
  assert.equal(defaultListing.summary.historical, 1);
  assert.equal(defaultListing.records.some((record) => record.task === 'gone-noise-task'), true);
  assert.match(manager(fixture.repo, ['list']), /\[MISSING\][^\n]*gone-noise-task/);

  const presentListing = JSON.parse(manager(fixture.repo, ['list', '--present', '--json']));
  assert.equal(presentListing.summary.historical, 0);
  assert.deepEqual(presentListing.records, []);
  // --present 只隐藏 historical 区块；TRACKED/UNTRACKED/MAIN 分类和 rows 完全不变。
  assert.deepEqual(
    presentListing.worktrees.map((row) => ({ kind: row.kind, path: row.path })),
    defaultListing.worktrees.map((row) => ({ kind: row.kind, path: row.path })),
  );
  assert.equal(presentListing.worktrees.some((row) => row.kind === 'TRACKED' && row.record?.task === 'present-noise-task'), true);

  const presentText = manager(fixture.repo, ['list', '--present']);
  assert.equal(presentText.includes('gone-noise-task'), false);
  assert.match(presentText, /present-noise-task/);
});

test('doctor 默认折叠目录已消失 record 的 WORKTREE_MISSING/BASE_OVERRIDE/EPHEMERAL_WORKTREE 噪声，--verbose 展开且 --json 完整不受影响', (t) => {
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

  const missingTasks = ['missing-noise-one', 'missing-noise-two'];
  const missingPaths = [];
  for (const task of missingTasks) {
    manager(fixture.repo, [
      'spawn', task, '--base', 'HEAD', '--base-reason', '依赖链噪声 fixture',
      '--agent', 'codex', '--agent-id', `noise-${task}`, '--purpose', 'noise fixture',
    ]);
    const record = recordFor(fixture, task);
    missingPaths.push(record.path);
    git(fixture.repo, ['worktree', 'remove', record.path]);
  }

  manager(fixture.repo, ['spawn', 'real-issue', '--agent', 'codex', '--agent-id', 'real-issue-1', '--purpose', 'must stay visible']);
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
  assert.equal(jsonDoctor.findings.some((finding) => finding.code === 'REVIEW_STATE_DIRTY' && finding.path === realWorktree), true);

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
  manager(fixture.repo, ['spawn', 'archive-present', '--agent', 'codex', '--agent-id', 'archive-present-1', '--purpose', 'still present']);
  assert.match(managerKeep(fixture.repo, ['archive', 'archive-present', '--reason', 'noise cleanup']), /目录仍然存在/);

  // (2) 目录已消失但分支未合入任何已知 base -> KEEP
  manager(fixture.repo, ['spawn', 'archive-unmerged', '--agent', 'codex', '--agent-id', 'archive-unmerged-1', '--purpose', 'unmerged branch']);
  const unmergedWorktree = worktreeFor(fixture, 'archive-unmerged');
  writeFileSync(join(unmergedWorktree, 'wip.txt'), 'wip\n');
  git(unmergedWorktree, ['add', 'wip.txt']);
  git(unmergedWorktree, ['commit', '-m', 'feat: unmerged wip']);
  git(fixture.repo, ['worktree', 'remove', unmergedWorktree]);
  assert.match(managerKeep(fixture.repo, ['archive', 'archive-unmerged', '--reason', 'noise cleanup']), /未合入/);

  // (3) 目录已消失、分支已合入，但 watcher 仍武装 -> KEEP；unwatch 后才允许归档（basis=branch_merged）
  manager(fixture.repo, ['spawn', 'archive-watched', '--agent', 'codex', '--agent-id', 'archive-watched-1', '--purpose', 'watched then archived']);
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
    mutate(current) { return { ...current, auto_reclaim: { state: 'watching', token: 'fixture-archive-token' } }; },
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
  assert.equal(defaultListing.records.some((record) => record.worktree_id === watchedRecord.worktree_id), false);
  const archivedListing = JSON.parse(manager(fixture.repo, ['list', '--archived', '--json']));
  const archivedRecord = archivedListing.records.find((record) => record.worktree_id === watchedRecord.worktree_id);
  assert.ok(archivedRecord, 'list --archived 必须能看到已归档 record');
  assert.equal(archivedRecord.worktree_state, 'archived');
  assert.equal(archivedRecord.archive.basis, 'branch_merged');
  assert.match(manager(fixture.repo, ['list', '--archived']), /\[ARCHIVED\][^\n]*archive-watched/);

  const doctorAfter = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(doctorAfter.findings.some((finding) => finding.worktree_id === watchedRecord.worktree_id), false);
  assert.equal(manager(fixture.repo, ['doctor', '--verbose']).includes(watchedRecord.worktree_id), false);

  const audit = JSON.parse(manager(fixture.repo, ['audit', 'archive-watched', '--json']));
  assert.equal(audit.record.worktree_state, 'archived');
  const archivedEvent = audit.events.find((event) => event.event_type === 'archived');
  assert.ok(archivedEvent, 'audit 必须仍能看到 archived event');
  assert.equal(archivedEvent.details.reason, 'confirmed merged noise');
  assert.equal(archivedEvent.details.basis, 'branch_merged');

  // (4) 分支已经不存在的成功路径（basis=branch_absent），覆盖前置条件 2 的另一半 OR 分支
  manager(fixture.repo, ['spawn', 'archive-branch-absent', '--agent', 'codex', '--agent-id', 'archive-absent-1', '--purpose', 'branch already deleted']);
  const absentRecord = recordFor(fixture, 'archive-branch-absent');
  git(fixture.repo, ['worktree', 'remove', absentRecord.path]);
  git(fixture.repo, ['branch', '-D', absentRecord.branch]);
  const absentOutput = manager(fixture.repo, ['archive', 'archive-branch-absent', '--reason', 'branch already deleted']);
  assert.match(absentOutput, /basis=branch_absent/);
});
