import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { appendTraceEvent } from './worktree-trace.mjs';
import {
  git,
  manager,
  managerKeep,
  makeRepo,
  recordFor,
  worktreeFor,
  branchFor,
  addSubmoduleFixture,
  initSubmoduleInWorktree,
  submodulesModulesDir,
  managerStderr,
} from '../../tests/helpers/worktree-mgr-fixture.mjs';

test('touch 拒绝已回收 record 且不改写物理终态', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'immutable-history',
    '--agent',
    'codex',
    '--agent-id',
    'history-1',
    '--purpose',
    'protect reclaimed history',
  ]);
  const record = JSON.parse(manager(fixture.repo, ['list', '--json'])).worktrees.find(
    (row) => row.kind === 'TRACKED',
  ).record;
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['reclaim', 'immutable-history', '--pushed', pushed]);

  assert.throws(
    () => manager(fixture.repo, ['touch', 'immutable-history', '--status', 'done']),
    /status 1|Command failed/,
  );
  const all = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  assert.equal(all.records.find((item) => item.worktree_id === record.worktree_id).worktree_state, 'reclaimed');
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctor.findings.some(
      (finding) => finding.worktree_id === record.worktree_id && finding.code === 'WORKTREE_MISSING',
    ),
    false,
  );
});

test('reclaim_ready 后目录和分支已消失仍可幂等收尾', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'crash-task',
    '--agent',
    'codex',
    '--agent-id',
    'crash-1',
    '--purpose',
    'reclaim crash recovery',
  ]);
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
  assert.equal(
    doctor.findings.find(
      (finding) => finding.worktree_id === record.worktree_id && finding.code === 'RECLAIM_INTERRUPTED',
    ).phase,
    'before_remove',
  );
  git(fixture.repo, ['worktree', 'remove', worktree]);
  git(fixture.repo, ['branch', '-D', record.branch]);
  doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctor.findings.find(
      (finding) => finding.worktree_id === record.worktree_id && finding.code === 'RECLAIM_INTERRUPTED',
    ).phase,
    'after_remove',
  );
  manager(fixture.repo, ['reclaim', 'crash-task', '--pushed', pushed]);
  const all = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  const reclaimed = all.records.find((item) => item.worktree_id === record.worktree_id);
  assert.equal(reclaimed.worktree_state, 'reclaimed');
  assert.equal(reclaimed.branch_cleanup.status, 'absent');
});

test('从目标 worktree 自身执行 reclaim 仍使用 primary cwd 清理分支并验证后置条件', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'self-cwd-cleanup',
    '--agent',
    'codex',
    '--agent-id',
    'self-cwd-1',
    '--purpose',
    'reclaim from target worktree',
  ]);
  const record = recordFor(fixture, 'self-cwd-cleanup');
  const worktree = record.path;
  writeFileSync(join(worktree, 'self-cwd.txt'), 'self cwd cleanup\n');
  git(worktree, ['add', 'self-cwd.txt']);
  git(worktree, ['commit', '-m', 'feat: self cwd cleanup fixture']);
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', record.branch]);
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);

  const output = manager(worktree, ['reclaim', 'self-cwd-cleanup', '--pushed', pushed]);
  assert.match(output, /已回收.*branch=deleted/);
  assert.equal(existsSync(worktree), false);
  assert.throws(() => git(fixture.repo, ['show-ref', '--verify', `refs/heads/${record.branch}`]));

  const listed = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  const reclaimed = listed.records.find((item) => item.worktree_id === record.worktree_id);
  assert.equal(reclaimed.worktree_state, 'reclaimed');
  assert.equal(reclaimed.branch_cleanup.status, 'deleted');
  assert.equal(reclaimed.branch_cleanup.attempts, 1);
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctor.findings.some(
      (item) => item.worktree_id === record.worktree_id && item.code === 'LOCAL_BRANCH_CLEANUP_FAILED',
    ),
    false,
  );
});

test('本地分支删除失败不伪装完整收尾，doctor/list 持续可见且 reclaim 可幂等重试', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'branch-cleanup',
    '--agent',
    'codex',
    '--agent-id',
    'cleanup-1',
    '--purpose',
    'branch cleanup audit',
  ]);
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
  const firstOutput = managerKeep(fixture.repo, ['reclaim', 'branch-cleanup', '--pushed', pushed]);
  assert.match(firstOutput, /目录已回收.*本地分支.*清理待重试/);

  let listed = JSON.parse(manager(fixture.repo, ['list', '--all', '--json']));
  let reclaimed = listed.records.find((item) => item.worktree_id === record.worktree_id);
  assert.equal(reclaimed.worktree_state, 'reclaimed');
  assert.equal(reclaimed.branch_cleanup.status, 'failed');
  assert.equal(reclaimed.branch_cleanup.attempts, 1);
  assert.match(reclaimed.branch_cleanup.reason, /checked out|used by worktree/i);
  assert.equal(reclaimed.reclaim_summary.branch_cleanup.status, 'failed');

  const defaultList = JSON.parse(manager(fixture.repo, ['list', '--json']));
  assert.equal(
    defaultList.records.find((item) => item.worktree_id === record.worktree_id).branch_cleanup_pending,
    true,
  );
  assert.match(manager(fixture.repo, ['list']), /\[BRANCH_PENDING\].*branch=failed/);
  let doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  const finding = doctor.findings.find(
    (item) => item.worktree_id === record.worktree_id && item.code === 'LOCAL_BRANCH_CLEANUP_FAILED',
  );
  assert.equal(finding.branch, record.branch);
  assert.equal(finding.branch_exists, true);

  writeFileSync(join(holder, 'late-work.txt'), 'must not be deleted\n');
  git(holder, ['add', 'late-work.txt']);
  git(holder, ['commit', '-m', 'feat: late branch work']);
  git(holder, ['switch', '--detach']);
  const refusedRetry = managerKeep(fixture.repo, ['reclaim', 'branch-cleanup', '--pushed', pushed]);
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
  assert.equal(
    doctor.findings.some(
      (item) => item.worktree_id === record.worktree_id && item.code === 'LOCAL_BRANCH_CLEANUP_FAILED',
    ),
    false,
  );
  const audit = JSON.parse(manager(fixture.repo, ['audit', 'branch-cleanup', '--json']));
  assert.equal(audit.events.filter((event) => event.event_type === 'branch_cleanup_retried').length, 2);
});

test('旧 reclaimed record 无 branch_cleanup 字段时按本地 ref 对账并可补齐', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'legacy-cleanup',
    '--agent',
    'codex',
    '--agent-id',
    'legacy-1',
    '--purpose',
    'legacy branch cleanup',
  ]);
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
  const finding = doctor.findings.find(
    (item) => item.worktree_id === record.worktree_id && item.code === 'LOCAL_BRANCH_CLEANUP_FAILED',
  );
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
  assert.equal(
    doctor.findings.some(
      (item) => item.worktree_id === record.worktree_id && item.code === 'LOCAL_BRANCH_CLEANUP_FAILED',
    ),
    false,
  );
});

test('reclaim 对 dirty、未合入和 stash 分别 KEEP，条件清空后才回收', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'safety-task',
    '--agent',
    'codex',
    '--agent-id',
    'safe-1',
    '--purpose',
    'reclaim safety',
  ]);
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
  manager(fixture.repo, [
    'spawn',
    'permission-denied-task',
    '--agent',
    'codex',
    '--agent-id',
    'permission-denied-1',
    '--purpose',
    'permission denied reclaim',
  ]);
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
  const finding = doctor.findings.find(
    (item) => item.worktree_id === record.worktree_id && item.code === 'RECLAIM_INTERRUPTED',
  );
  assert.match(finding.last_reclaim_error.reason, /Permission denied|Operation not permitted/i);
  const audit = JSON.parse(manager(fixture.repo, ['audit', 'permission-denied-task', '--json']));
  assert.equal(audit.events.at(-1).event_type, 'reclaim_failed');
});

test('reclaim 不把已失去 Git 登记但物理目录仍在的树标成 reclaimed', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'orphan-directory-task',
    '--agent',
    'codex',
    '--agent-id',
    'orphan-directory-1',
    '--purpose',
    'orphan directory recovery',
  ]);
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
  assert.doesNotMatch(
    git(fixture.repo, ['worktree', 'list', '--porcelain']),
    new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );

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
  manager(fixture.repo, [
    'spawn',
    'submodule-clean-task',
    '--agent',
    'codex',
    '--agent-id',
    'submod-clean-1',
    '--purpose',
    'submodule reclaim clean',
  ]);
  const worktree = worktreeFor(fixture, 'submodule-clean-task');
  initSubmoduleInWorktree(worktree);
  writeFileSync(join(worktree, 'feature.txt'), 'submodule-clean-task\n');
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', 'feat: submodule-clean-task']);
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, 'submodule-clean-task')]);
  const pushed = git(fixture.repo, ['rev-parse', 'HEAD']);

  const modulesDir = submodulesModulesDir(worktree);
  assert.equal(existsSync(modulesDir), true, '初始化过的 submodule 应留下树私有元数据目录');
  assert.throws(
    () => git(fixture.repo, ['worktree', 'remove', worktree]),
    /submodule/,
    '非 force remove 应先被 git 自身拒绝',
  );

  assert.match(manager(fixture.repo, ['reclaim', 'submodule-clean-task', '--pushed', pushed]), /已回收/);
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(modulesDir), false, 'reclaim 应清理树私有 submodule 元数据');
});

test('reclaim submodule 脏时 KEEP，不 deinit 也不删目录', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  addSubmoduleFixture(fixture, { ignoreAll: true });
  manager(fixture.repo, [
    'spawn',
    'submodule-dirty-task',
    '--agent',
    'codex',
    '--agent-id',
    'submod-dirty-1',
    '--purpose',
    'submodule reclaim dirty',
  ]);
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
  manager(fixture.repo, [
    'spawn',
    'submodule-deinit-task',
    '--agent',
    'codex',
    '--agent-id',
    'submod-deinit-1',
    '--purpose',
    'submodule reclaim deinit residue',
  ]);
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
  assert.throws(
    () => git(fixture.repo, ['worktree', 'remove', worktree]),
    /submodule/,
    '元数据残留时非 force remove 仍应先被 git 自身拒绝',
  );

  assert.match(manager(fixture.repo, ['reclaim', 'submodule-deinit-task', '--pushed', pushed]), /已回收/);
  assert.equal(existsSync(worktree), false, '未初始化但元数据残留的树应可回收');
  assert.equal(existsSync(modulesDir), false, '残留元数据应被清理');
});

test('reclaim submodule 工作目录残留悬空 .git 指针时 KEEP 且保留不可审计内容', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  addSubmoduleFixture(fixture);
  manager(fixture.repo, [
    'spawn',
    'submodule-pointer-task',
    '--agent',
    'codex',
    '--agent-id',
    'submod-pointer-1',
    '--purpose',
    'submodule reclaim dangling pointer',
  ]);
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
  assert.throws(
    () => git(fixture.repo, ['worktree', 'remove', worktree]),
    /not a git repository/,
    '悬空指针应让非 force remove 直接 fatal（边界前提）',
  );

  const output = managerKeep(fixture.repo, ['reclaim', 'submodule-pointer-task', '--pushed', pushed]);
  assert.match(output, /KEEP.*dangling.*vendor\/sub/);
  assert.equal(existsSync(worktree), true, '无法审计的 submodule 必须保留工作树');
  assert.equal(readFileSync(preserved, 'utf8'), 'must not delete\n', '不可审计内容不得被回收流程删除');
});

test('CLI rebuild 可在 record cache 已损坏时直接按 event-chain UUID 恢复', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'rebuild-task',
    '--agent',
    'kiro',
    '--agent-id',
    'rebuild-1',
    '--purpose',
    'cache rebuild',
  ]);
  const listed = JSON.parse(manager(fixture.repo, ['list', '--json']));
  const id = listed.worktrees.find((row) => row.kind === 'TRACKED').record.worktree_id;
  writeFileSync(join(fixture.repo, '.git', 'worktree-trace', 'v1', 'records', `${id}.json`), '{broken');
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'RECORD_CACHE_INVALID'),
    true,
  );
  manager(fixture.repo, ['rebuild', '--id', id.slice(0, 8)]);
  const recovered = JSON.parse(manager(fixture.repo, ['list', '--json']));
  assert.equal(recovered.worktrees.find((row) => row.kind === 'TRACKED').record.worktree_id, id);
});

test('reclaim --pushed 拒绝只由待删除分支引用的 SHA', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'unprotected-head',
    '--agent',
    'codex',
    '--agent-id',
    'push-proof',
    '--purpose',
    '验证持久 ref',
  ]);
  const tree = worktreeFor(fixture, 'unprotected-head');
  writeFileSync(join(tree, 'unique.txt'), 'unique\n');
  git(tree, ['add', 'unique.txt']);
  git(tree, ['commit', '-m', 'feat: unique candidate']);
  const head = git(tree, ['rev-parse', 'HEAD']);
  assert.match(
    managerStderr(fixture.repo, ['reclaim', 'unprotected-head', '--pushed', head]),
    /只由待删除候选分支保护/,
  );
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
    'spawn',
    'short-pushed-proof',
    '--agent',
    'codex',
    '--agent-id',
    'short-pushed-thread',
    '--purpose',
    '短 SHA 回收',
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
