import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  git,
  manager,
  managerAsync,
  makeRemoteRepo,
  waitFor,
  processGroupIsAlive,
  prepareReviewTask,
  prepareWatchedTask,
  recordFor,
  worktreeFor,
  branchFor,
} from '../../tests/helpers/worktree-mgr-fixture.mjs';

test('MR head 进入目标 ref 后 detached watcher 自动流转状态并回收', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'auto-merge';
  t.after(() => {
    try {
      manager(fixture.repo, ['unwatch', task]);
    } catch {}
    fixture.cleanup();
  });
  const { worktree } = prepareWatchedTask(fixture, task);
  const armed = recordFor(fixture, task);
  assert.equal(armed.task_status, 'ready_for_review');
  assert.equal(armed.auto_reclaim.target_ref, 'origin/main');

  git(fixture.repo, ['merge', '--no-ff', '--no-edit', branchFor(fixture, task)]);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  await waitFor(() => !existsSync(worktree), 'watcher 未在 MR head 合入后自动回收 worktree');
  // 目录删除先于 reclaimed 事件落盘；只等目录消失会读到中间态 reclaim_ready。
  await waitFor(
    () => recordFor(fixture, task, true).worktree_state === 'reclaimed',
    'record 未在目录回收后进入 reclaimed',
  );

  const reclaimed = recordFor(fixture, task, true);
  assert.equal(reclaimed.task_status, 'done');
  assert.equal(reclaimed.worktree_state, 'reclaimed');
  assert.equal(reclaimed.auto_reclaim.state, 'reclaimed');
  const audit = JSON.parse(manager(fixture.repo, ['audit', task, '--json']));
  const eventTypes = audit.events.map((event) => event.event_type);
  for (const expected of [
    'auto_reclaim_armed',
    'auto_reclaim_watcher_started',
    'merge_detected',
    'auto_integrating',
    'auto_done',
    'final_snapshot',
    'reclaim_ready',
    'reclaimed',
  ]) {
    assert.equal(eventTypes.includes(expected), true, `缺少 event: ${expected}`);
  }
  const heartbeat = join(fixture.repo, '.git', 'worktree-trace', 'v1', 'watchers', `${reclaimed.worktree_id}.json`);
  assert.equal(existsSync(heartbeat), false);
});

test('watch 首次 arm 要求 MR head 已完整 push 到 upstream', (t) => {
  const fixture = makeRemoteRepo();
  const task = 'auto-unpushed';
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    task,
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'watch-unpushed',
    '--purpose',
    'reject unpushed watcher',
  ]);
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
    try {
      manager(fixture.repo, ['unwatch', task]);
    } catch {}
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
  assert.equal(
    audit.events.some((event) => event.event_type === 'merge_detected'),
    false,
  );
});

test('unwatch 返回时 watcher 进程组必须已退出，之后没有后台写入者碰 worktree', (t) => {
  const fixture = makeRemoteRepo();
  const task = 'auto-unwatch-quiesce';
  t.after(() => {
    try {
      manager(fixture.repo, ['unwatch', task]);
    } catch {}
    fixture.cleanup();
  });
  prepareWatchedTask(fixture, task);
  const pid = recordFor(fixture, task).auto_reclaim.pid;
  assert.equal(processGroupIsAlive(pid), true, 'watcher 进程组应在 unwatch 前存活');

  // terminated 是被信号收尾，not-running 是 worker 恰好在解除事件落盘的间隙自行退出；两者都
  // 表示这次租约再无进程。
  assert.match(manager(fixture.repo, ['unwatch', task]), /watcher=(terminated|not-running)/);
  // 不轮询等待：unwatch 是同步契约，返回即代表 worker 连同在途 git 子进程都已收尾，
  // 调用方可以立刻删除 worktree 而不会与后台写入相撞。
  assert.equal(processGroupIsAlive(pid), false, 'unwatch 返回后 watcher 进程组仍在运行');

  const heartbeat = join(
    fixture.repo,
    '.git',
    'worktree-trace',
    'v1',
    'watchers',
    `${recordFor(fixture, task).worktree_id}.json`,
  );
  assert.equal(existsSync(heartbeat), false);
});

test('心跳过期时 unwatch 不按组发信号，避免打到复用了旧 pid 的无关进程', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'auto-unwatch-stale-pid';
  let pid = 0;
  t.after(() => {
    if (pid) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
    try {
      manager(fixture.repo, ['unwatch', task]);
    } catch {}
    fixture.cleanup();
  });
  prepareWatchedTask(fixture, task);
  const armed = recordFor(fixture, task);
  pid = armed.auto_reclaim.pid;
  // record 是 event chain 上的缓存，pid 改不动；所以用真 worker 本身构造「只有新鲜度不成立」：
  // SIGSTOP 让它活着但不再刷心跳，再把心跳拨老。此时 token、两处 pid、存活全部对得上，
  // 和「陈旧 pid 被复用成别的进程组 leader」在守卫眼里是同一个形状。
  process.kill(pid, 'SIGSTOP');
  const heartbeatPath = join(fixture.repo, '.git', 'worktree-trace', 'v1', 'watchers', `${armed.worktree_id}.json`);
  const heartbeat = JSON.parse(readFileSync(heartbeatPath, 'utf8'));
  assert.equal(heartbeat.pid, pid);
  heartbeat.heartbeat_at = new Date(Date.now() - 600_000).toISOString();
  writeFileSync(heartbeatPath, `${JSON.stringify(heartbeat, null, 2)}\n`);

  // unverified 是「登记的 pid 还活着、但没进发信号那条路径」的终态。守卫一旦失效，SIGTERM 会挂在
  // 被停住的进程上，unwatch 等满超时后报 timeout。
  const output = manager(fixture.repo, ['unwatch', task]);
  assert.match(output, /watcher=unverified/);
  assert.match(output, /WARN .*没有向它发信号/);
  assert.equal(processGroupIsAlive(pid), true);
  assert.equal(recordFor(fixture, task).auto_reclaim.state, 'disarmed');
});

test('MR 已合入但 stash/dirty 时 watcher 保留并在阻塞清除后自动重试', async (t) => {
  const fixture = makeRemoteRepo();
  const task = 'auto-blocked';
  t.after(() => {
    try {
      manager(fixture.repo, ['unwatch', task]);
    } catch {}
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
    try {
      manager(fixture.repo, ['unwatch', task]);
    } catch {}
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
    try {
      manager(fixture.repo, ['unwatch', task]);
    } catch {}
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
    try {
      manager(fixture.repo, ['unwatch', task]);
    } catch {}
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
  await waitFor(
    () => recordFor(fixture, task).auto_reclaim.state === 'disarmed',
    '并发 unwatch 后 record 被旧 resume 快照复活',
  );
  const audit = JSON.parse(manager(fixture.repo, ['audit', task, '--json']));
  const lifecycle = audit.events.filter((event) =>
    ['auto_reclaim_rearmed', 'auto_reclaim_disarmed'].includes(event.event_type),
  );
  assert.equal(lifecycle.at(-1).event_type, 'auto_reclaim_disarmed');
  const doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'AUTO_RECLAIM_WATCHER_STALE'),
    false,
  );
});

test('两个真实 watcher 监听同一 target 时通过 common-dir cache 合并 fetch', async (t) => {
  const fixture = makeRemoteRepo();
  const tasks = ['cache-one', 'cache-two', 'cache-other'];
  t.after(() => {
    for (const task of tasks)
      try {
        manager(fixture.repo, ['unwatch', task]);
      } catch {}
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
    manager(fixture.repo, [
      'watch',
      task,
      '--target',
      'origin/main',
      '--interval-ms',
      '5000',
      '--change-ref',
      `MR !${task}`,
      '--notify',
      'off',
    ]);
  }
  manager(fixture.repo, [
    'watch',
    'cache-other',
    '--target',
    'origin/other',
    '--interval-ms',
    '5000',
    '--change-ref',
    'MR !cache-other',
    '--notify',
    'off',
  ]);

  const records = tasks.map((task) => recordFor(fixture, task));
  const heartbeatPaths = records.map((record) =>
    join(fixture.repo, '.git', 'worktree-trace', 'v1', 'watchers', `${record.worktree_id}.json`),
  );
  let heartbeats;
  await waitFor(() => {
    if (!heartbeatPaths.every(existsSync)) return false;
    heartbeats = heartbeatPaths.map((path) => JSON.parse(readFileSync(path, 'utf8')));
    return heartbeats.every((heartbeat) => Object.hasOwn(heartbeat, 'fetch_cache_hit'));
  }, '两个 watcher 未完成首轮共享 target 检查');
  assert.equal(
    heartbeats.slice(0, 2).some((heartbeat) => heartbeat.fetch_cache_hit === true),
    true,
  );

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
