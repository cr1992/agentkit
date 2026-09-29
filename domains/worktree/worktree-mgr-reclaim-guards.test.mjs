import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  git,
  gitOk,
  manager,
  managerResult,
  makeRepo,
  recordFor,
  worktreeFor,
  contentSha,
  recordFilePath,
} from '../../tests/helpers/worktree-mgr-fixture.mjs';

// reclaim 的破坏性守卫：这些分支防的正是「删错树 / 写错归档 ref / 丢掉可恢复的旧 HEAD」。
// 每条拒绝用例断言三件事：退出码 2、该守卫专属文案、以及状态未被改动（record 字节不变、
// 旧树目录仍在、归档 ref 未被创建/改写）。构造统一走公开 CLI（spawn/touch/supersede），
// 只经 managerResult 触发 reclaim，不 import 内部函数。

/** 造一棵旧树：spawn 后可选提交一个独有文件，返回路径与（可选）HEAD。 */
function spawnTree(fixture, task, { agentId = 'sess', owner = null, unique = null } = {}) {
  const argv = ['spawn', task, '--agent', 'codex', '--agent-id', agentId, '--purpose', `guard ${task}`];
  if (owner) argv.push('--owner', owner);
  manager(fixture.repo, argv);
  const path = worktreeFor(fixture, task);
  let head = null;
  if (unique) {
    writeFileSync(join(path, `${task}.txt`), unique);
    git(path, ['add', `${task}.txt`]);
    git(path, ['commit', '-m', `feat: ${task}`]);
    head = git(path, ['rev-parse', 'HEAD']);
  }
  return { path, head };
}

/** 在快照后运行被测 reclaim，逐项断言退出码 / 专属文案 / 状态未变。 */
function assertGuardRejects(fixture, { argv, exit, message, records = [], worktrees = [], absentRefs = [], keptRefs = {} }) {
  const before = {
    records: records.map((id) => contentSha(recordFilePath(fixture, id))),
    worktrees: worktrees.map((path) => existsSync(path)),
    keptRefs: Object.fromEntries(Object.keys(keptRefs).map((ref) => [ref, git(fixture.repo, ['rev-parse', ref])])),
  };
  for (const path of worktrees) assert.equal(existsSync(path), true, `前置：${path} 应存在`);
  for (const ref of absentRefs) assert.equal(gitOk(fixture.repo, ['show-ref', '--verify', ref]), false, `前置：${ref} 应不存在`);

  const result = managerResult(fixture.repo, argv);
  assert.equal(result.status, exit, `退出码应为 ${exit}，实际 ${result.status}；stderr=${result.stderr}`);
  assert.match(result.stderr, message);

  records.forEach((id, index) => {
    assert.equal(contentSha(recordFilePath(fixture, id)), before.records[index], `record ${id} 字节应不变`);
  });
  worktrees.forEach((path, index) => {
    assert.equal(existsSync(path), before.worktrees[index], `worktree ${path} 存在性应不变`);
  });
  for (const ref of absentRefs) {
    assert.equal(gitOk(fixture.repo, ['show-ref', '--verify', ref]), false, `归档 ref ${ref} 不得被创建`);
  }
  for (const [ref, expected] of Object.entries(before.keptRefs)) {
    assert.equal(git(fixture.repo, ['rev-parse', ref]), expected, `ref ${ref} 不得被改写`);
  }
}

// 建立一对「旧树 abandoned + 替代树双向登记」，供多个不改状态的守卫共享同一构造。
function supersededPair(fixture, { old = 'old-tree', rep = 'rep-tree', freeze = true } = {}) {
  spawnTree(fixture, old, { unique: `${old}\n` });
  if (freeze) manager(fixture.repo, ['touch', old, '--status', 'abandoned', '--note', 'freeze old tree']);
  manager(fixture.repo, [
    'spawn',
    rep,
    '--agent',
    'codex',
    '--agent-id',
    'sess',
    '--purpose',
    `guard ${rep}`,
    '--supersedes',
    old,
    '--replacement-reason',
    'migrate to replacement',
  ]);
  const oldRecord = recordFor(fixture, old);
  const repRecord = recordFor(fixture, rep);
  return {
    old,
    rep,
    oldRecord,
    repRecord,
    oldPath: oldRecord.path,
    repPath: repRecord.path,
    oldHead: oldRecord.last_head,
    archiveRef: `refs/worktree-archive/superseded/${oldRecord.worktree_id}`,
  };
}

test('reclaim --superseded-by 拒绝非 abandoned 旧树，不动旧树与归档 ref', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const oldTree = spawnTree(fixture, 'active-old', { agentId: 'sess', unique: 'active-old\n' });
  spawnTree(fixture, 'plain-rep', { agentId: 'other-sess' });
  const oldRecord = recordFor(fixture, 'active-old');
  assertGuardRejects(fixture, {
    argv: ['reclaim', 'active-old', '--superseded-by', 'plain-rep'],
    exit: 2,
    message: /只接受 abandoned 旧树；当前 active/,
    records: [oldRecord.worktree_id],
    worktrees: [oldTree.path],
    absentRefs: [`refs/worktree-archive/superseded/${oldRecord.worktree_id}`],
  });
});

test('reclaim --superseded-by 拒绝跨 Agent 会话的替代树', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  spawnTree(fixture, 'session-old', { agentId: 'sess-a', unique: 'session-old\n' });
  manager(fixture.repo, ['touch', 'session-old', '--status', 'abandoned', '--note', 'freeze']);
  spawnTree(fixture, 'session-rep', { agentId: 'sess-b' });
  const oldRecord = recordFor(fixture, 'session-old');
  assertGuardRejects(fixture, {
    argv: ['reclaim', 'session-old', '--superseded-by', 'session-rep'],
    exit: 2,
    message: /不属于同一 Agent 会话/,
    records: [oldRecord.worktree_id],
    worktrees: [oldRecord.path],
    absentRefs: [`refs/worktree-archive/superseded/${oldRecord.worktree_id}`],
  });
});

test('reclaim --superseded-by 拒绝 owner 不一致的替代树', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  spawnTree(fixture, 'owner-old', { agentId: 'sess', owner: 'alice', unique: 'owner-old\n' });
  manager(fixture.repo, ['touch', 'owner-old', '--status', 'abandoned', '--note', 'freeze']);
  // 同会话但不同 owner：只能经 --parallel-reason 声明并存（--supersedes 会先因 owner 不一致被拒），
  // 因此这条 reclaim 命中的是 reclaim 自己的 owner 守卫。
  manager(fixture.repo, [
    'spawn',
    'owner-rep',
    '--agent',
    'codex',
    '--agent-id',
    'sess',
    '--owner',
    'bob',
    '--purpose',
    'guard owner-rep',
    '--parallel-reason',
    'independent parallel tree',
  ]);
  const oldRecord = recordFor(fixture, 'owner-old');
  assertGuardRejects(fixture, {
    argv: ['reclaim', 'owner-old', '--superseded-by', 'owner-rep'],
    exit: 2,
    message: /owner 不一致：alice != bob/,
    records: [oldRecord.worktree_id],
    worktrees: [oldRecord.path],
    absentRefs: [`refs/worktree-archive/superseded/${oldRecord.worktree_id}`],
  });
});

test('reclaim --superseded-by 拒绝未双向登记的替代关系', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  spawnTree(fixture, 'rel-old', { agentId: 'sess', unique: 'rel-old\n' });
  manager(fixture.repo, ['touch', 'rel-old', '--status', 'abandoned', '--note', 'freeze']);
  // parallel 关系而非 supersedes：owner 均为空可越过 owner 守卫，命中双向登记守卫。
  manager(fixture.repo, [
    'spawn',
    'rel-rep',
    '--agent',
    'codex',
    '--agent-id',
    'sess',
    '--purpose',
    'guard rel-rep',
    '--parallel-reason',
    'independent parallel tree',
  ]);
  const oldRecord = recordFor(fixture, 'rel-old');
  assertGuardRejects(fixture, {
    argv: ['reclaim', 'rel-old', '--superseded-by', 'rel-rep'],
    exit: 2,
    message: /替代关系未双向登记/,
    records: [oldRecord.worktree_id],
    worktrees: [oldRecord.path],
    absentRefs: [`refs/worktree-archive/superseded/${oldRecord.worktree_id}`],
  });
});

test('reclaim --superseded-by 在替代树目录缺失时拒绝，不删旧树', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const pair = supersededPair(fixture, { old: 'miss-old', rep: 'miss-rep' });
  // 让替代树彻底脱离 Git 登记：present 变 false，命中「替代 worktree missing」而非 dirty 守卫。
  git(fixture.repo, ['worktree', 'remove', pair.repPath]);
  assert.equal(existsSync(pair.repPath), false, '前置：替代树目录已移除');
  assertGuardRejects(fixture, {
    argv: ['reclaim', 'miss-old', '--superseded-by', 'miss-rep'],
    exit: 2,
    message: /替代 worktree missing/,
    records: [pair.oldRecord.worktree_id],
    worktrees: [pair.oldPath],
    absentRefs: [pair.archiveRef],
  });
});

test('reclaim --superseded-by 在替代树脏时拒绝，不删旧树也不建归档 ref', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const pair = supersededPair(fixture, { old: 'dirty-old', rep: 'dirty-rep' });
  writeFileSync(join(pair.repPath, 'uncommitted.txt'), 'work in progress\n');
  assertGuardRejects(fixture, {
    argv: ['reclaim', 'dirty-old', '--superseded-by', 'dirty-rep'],
    exit: 2,
    message: /替代 worktree 必须干净/,
    records: [pair.oldRecord.worktree_id],
    worktrees: [pair.oldPath, pair.repPath],
    absentRefs: [pair.archiveRef],
  });
});

test('reclaim --superseded-by --discard 拒绝长度不对的 SHA', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const pair = supersededPair(fixture, { old: 'len-old', rep: 'len-rep' });
  assertGuardRejects(fixture, {
    argv: ['reclaim', 'len-old', '--superseded-by', 'len-rep', '--discard', 'abcdef'],
    exit: 2,
    message: /--discard 必须填写 40 位旧树精确 HEAD/,
    records: [pair.oldRecord.worktree_id],
    worktrees: [pair.oldPath],
    absentRefs: [pair.archiveRef],
  });
});

test('reclaim --superseded-by --discard 拒绝与旧树 HEAD 不一致的 SHA', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const pair = supersededPair(fixture, { old: 'sha-old', rep: 'sha-rep' });
  assertGuardRejects(fixture, {
    argv: ['reclaim', 'sha-old', '--superseded-by', 'sha-rep', '--discard', '0'.repeat(40)],
    exit: 2,
    message: /--discard SHA 与旧树 HEAD 不一致/,
    records: [pair.oldRecord.worktree_id],
    worktrees: [pair.oldPath],
    absentRefs: [pair.archiveRef],
  });
});

test('reclaim 已归档旧树后拒绝改用 --discard 覆盖恢复策略，归档 ref 与终态不变', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const pair = supersededPair(fixture, { old: 'recov-old', rep: 'recov-rep' });
  // 先完成一次归档式回收：旧 HEAD 落到归档 ref，superseded_recovery.mode=archive_ref。
  const first = manager(fixture.repo, ['reclaim', 'recov-old', '--superseded-by', 'recov-rep']);
  assert.match(first, /归档=refs\/worktree-archive\/superseded/);
  const oldHead = git(fixture.repo, ['rev-parse', `${pair.archiveRef}^{commit}`]);
  const reclaimed = recordFor(fixture, 'recov-old', true);
  assert.equal(reclaimed.superseded_recovery.mode, 'archive_ref');
  // 再尝试用 --discard 改写恢复策略：必须拒绝且不动已冻结的归档证据与 record。
  assertGuardRejects(fixture, {
    argv: ['reclaim', 'recov-old', '--superseded-by', 'recov-rep', '--discard', oldHead],
    exit: 2,
    message: /已经登记不同的恢复策略，拒绝改写/,
    records: [reclaimed.worktree_id],
    worktrees: [],
    keptRefs: { [pair.archiveRef]: oldHead },
  });
  assert.equal(existsSync(pair.oldPath), false, '旧树目录仍应保持已回收');
});

// 前置参数守卫：纯格式校验，死在加载 records 之前，因此不触碰任何状态。用最小构造覆盖，
// 主要断言退出码与专属文案能区分是哪条参数守卫。
test('reclaim 参数组合守卫在触碰状态前拒绝', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const tree = spawnTree(fixture, 'fd-tree', { agentId: 'sess', unique: 'fd-tree\n' });
  const head = git(fixture.repo, ['rev-parse', 'HEAD']);
  const record = recordFor(fixture, 'fd-tree');
  const cases = [
    {
      name: '同时指定 --pushed 与 --superseded-by',
      argv: ['reclaim', 'fd-tree', '--pushed', head, '--superseded-by', 'fd-tree'],
      message: /必须且只能选择 --pushed、--superseded-by 或 --archive-evidence 之一/,
    },
    {
      name: '--discard 脱离 --superseded-by',
      argv: ['reclaim', 'fd-tree', '--pushed', head, '--discard', head],
      message: /--discard 只能与 --superseded-by 一起使用/,
    },
    {
      name: '--reason 脱离 --archive-evidence',
      argv: ['reclaim', 'fd-tree', '--pushed', head, '--reason', 'why'],
      message: /--reason 仅用于 --archive-evidence/,
    },
    {
      name: '--archive-evidence 缺 --reason',
      argv: ['reclaim', 'fd-tree', '--archive-evidence', head],
      message: /--archive-evidence 需要 --reason/,
    },
  ];
  for (const testCase of cases) {
    assertGuardRejects(fixture, {
      argv: testCase.argv,
      exit: 2,
      message: testCase.message,
      records: [record.worktree_id],
      worktrees: [tree.path],
      absentRefs: [`refs/worktree-archive/superseded/${record.worktree_id}`],
    });
  }
});
