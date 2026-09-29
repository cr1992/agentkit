import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  git,
  manager,
  managerResult,
  makeRepo,
  recordFor,
  contentSha,
  recordFilePath,
} from '../../tests/helpers/worktree-mgr-fixture.mjs';

// review-refresh / history / review-watch 的破坏性守卫：这些命令做 managed rebase、retarget、
// force-with-lease push、重置 HEAD 和武装 reaper。拒绝用例断言退出码、专属文案，以及状态未变
// （record 字节不变、branch/HEAD 未改、无 history_operation / review_refresh / watcher）。

/** 一棵普通 active 树，供不改状态的守卫共享。plain spawn 不武装 watcher，避免留下后台进程。 */
function spawnActive(fixture, task) {
  manager(fixture.repo, ['spawn', task, '--agent', 'codex', '--agent-id', `sess-${task}`, '--purpose', `guard ${task}`]);
  return recordFor(fixture, task);
}

test('refresh-review 的前置守卫拒绝且不落 review_refresh 标记', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const record = spawnActive(fixture, 'refresh-guard');
  const recordPath = recordFilePath(fixture, record.worktree_id);
  const before = contentSha(recordPath);
  const cases = [
    {
      name: '--abort 与 --continue 互斥',
      argv: ['refresh-review', 'refresh-guard', '--abort', '--continue'],
      message: /refresh-review --abort 与 --continue 互斥/,
    },
    {
      name: '--continue 无进行中的 refresh',
      argv: ['refresh-review', 'refresh-guard', '--continue'],
      message: /当前没有可恢复的 review refresh/,
    },
    {
      name: '--abort 无进行中的 refresh',
      argv: ['refresh-review', 'refresh-guard', '--abort'],
      message: /当前没有可 abort 的 review refresh/,
    },
    {
      name: 'active 树不满足 ready_for_review/present',
      argv: ['refresh-review', 'refresh-guard'],
      message: /refresh-review 要求 ready_for_review\/present，当前 active\/present/,
    },
  ];
  for (const testCase of cases) {
    const result = managerResult(fixture.repo, testCase.argv);
    assert.equal(result.status, 2, `${testCase.name} 退出码；stderr=${result.stderr}`);
    assert.match(result.stderr, testCase.message, testCase.name);
    assert.equal(contentSha(recordPath), before, `${testCase.name}: record 字节应不变`);
    assert.equal(recordFor(fixture, 'refresh-guard').review_refresh, undefined, `${testCase.name}: 不得落 review_refresh`);
  }
  assert.equal(existsSync(record.path), true);
});

test('history rebase 的授权/CAS 守卫拒绝改写历史，且不落 history_operation', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const record = spawnActive(fixture, 'history-rebase');
  const head = git(record.path, ['rev-parse', 'HEAD']);
  const branch = record.branch;
  const recordPath = recordFilePath(fixture, record.worktree_id);
  const before = contentSha(recordPath);
  const cases = [
    {
      name: 'rebase --abort 与 --continue 互斥',
      argv: ['rebase', 'history-rebase', '--abort', '--continue'],
      message: /rebase --abort 与 --continue 互斥/,
    },
    {
      name: '新建 rebase 缺 --onto/--expected-head/--reason',
      argv: ['rebase', 'history-rebase', '--onto', 'trunk'],
      message: /新建 managed rebase 需要 --onto、--expected-head 与 --reason/,
    },
    {
      name: 'rebase HEAD CAS 失败',
      argv: ['rebase', 'history-rebase', '--onto', 'trunk', '--expected-head', '0'.repeat(40), '--reason', 'guard'],
      message: /rebase HEAD CAS 失败/,
    },
    {
      name: 'retarget HEAD CAS 失败',
      argv: ['retarget', 'history-rebase', '--base', 'trunk', '--expected-head', '0'.repeat(40), '--reason', 'guard'],
      message: /retarget HEAD CAS 失败/,
    },
  ];
  for (const testCase of cases) {
    const result = managerResult(fixture.repo, testCase.argv);
    assert.equal(result.status, 2, `${testCase.name} 退出码；stderr=${result.stderr}`);
    assert.match(result.stderr, testCase.message, testCase.name);
    assert.equal(contentSha(recordPath), before, `${testCase.name}: record 字节应不变`);
    assert.equal(recordFor(fixture, 'history-rebase').history_operation, undefined, `${testCase.name}: 无 history_operation`);
  }
  // HEAD 与登记 branch 均未被改写。
  assert.equal(git(record.path, ['rev-parse', 'HEAD']), head);
  assert.equal(git(record.path, ['branch', '--show-current']), branch);
});

test('history retarget 拒绝脏工作树，不改写 base 也不清理未提交改动', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const record = spawnActive(fixture, 'history-dirty');
  const head = git(record.path, ['rev-parse', 'HEAD']);
  writeFileSync(join(record.path, 'uncommitted.txt'), 'wip\n');
  const recordPath = recordFilePath(fixture, record.worktree_id);
  const before = contentSha(recordPath);
  const result = managerResult(fixture.repo, [
    'retarget',
    'history-dirty',
    '--base',
    'trunk',
    '--expected-head',
    head,
    '--reason',
    'guard',
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /retarget 要求工作树干净（含 untracked）/);
  assert.equal(contentSha(recordPath), before, 'record 字节应不变');
  assert.equal(recordFor(fixture, 'history-dirty').base_sha, record.base_sha, 'base_sha 不得被改写');
  assert.equal(existsSync(join(record.path, 'uncommitted.txt')), true, '不得清理未提交改动');
});

test('watch 首次武装要求 ready_for_review，否则拒绝且不武装 reaper（exit 1）', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const record = spawnActive(fixture, 'watch-arm');
  const recordPath = recordFilePath(fixture, record.worktree_id);
  const before = contentSha(recordPath);
  const result = managerResult(fixture.repo, ['watch', 'watch-arm']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /首次 watch 要求 task_status=ready_for_review，当前为 active/);
  assert.equal(contentSha(recordPath), before, 'record 字节应不变');
  assert.equal(recordFor(fixture, 'watch-arm').auto_reclaim, undefined, '不得武装 auto_reclaim watcher');
});

test('resume-all 拒绝 selector，watch-worker 缺 --id/--token 时拒绝', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const record = spawnActive(fixture, 'resume-guard');
  const recordPath = recordFilePath(fixture, record.worktree_id);
  const before = contentSha(recordPath);
  const resumeAll = managerResult(fixture.repo, ['resume-all', 'resume-guard']);
  assert.equal(resumeAll.status, 2, resumeAll.stderr);
  assert.match(resumeAll.stderr, /resume-all 不接受 selector；它只扫描已 arm record/);
  const worker = managerResult(fixture.repo, ['watch-worker']);
  assert.equal(worker.status, 2, worker.stderr);
  assert.match(worker.stderr, /watch-worker 需要 --id 与 --token/);
  assert.equal(contentSha(recordPath), before, 'record 字节应不变');
});
