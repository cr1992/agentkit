import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  git,
  contentSha,
  manager,
  managerKeep,
  makeRemoteRepo,
  worktreeFor,
  makeConflictScanFixture,
} from '../../tests/helpers/worktree-mgr-fixture.mjs';

test('plan-batch 固定 target 与已推送 HEAD，并折叠被子分支覆盖的输入', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);

  manager(fixture.repo, [
    'spawn',
    'batch-parent-feature',
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    'batch-parent-thread',
    '--purpose',
    '批次父 feature',
  ]);
  const parent = worktreeFor(fixture, 'batch-parent-feature');
  writeFileSync(join(parent, 'parent.txt'), 'parent\n');
  git(parent, ['add', 'parent.txt']);
  git(parent, ['commit', '-m', 'feat: parent']);
  git(parent, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'batch-parent-feature', '--status', 'ready_for_review']);

  manager(fixture.repo, [
    'spawn',
    'batch-child-feature',
    '--base',
    'origin/codex/batch-parent-feature',
    '--base-reason',
    '依赖父 feature 的已推送契约',
    '--agent',
    'codex',
    '--agent-id',
    'batch-child-thread',
    '--purpose',
    '批次子 feature',
  ]);
  const child = worktreeFor(fixture, 'batch-child-feature');
  writeFileSync(join(child, 'child.txt'), 'child\n');
  git(child, ['add', 'child.txt']);
  git(child, ['commit', '-m', 'feat: child']);
  git(child, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', 'batch-child-feature', '--status', 'ready_for_review']);

  const first = JSON.parse(
    manager(fixture.repo, [
      'plan-batch',
      'batch-parent-feature',
      'batch-child-feature',
      '--target',
      'origin/main',
      '--json',
    ]),
  );
  const second = JSON.parse(
    manager(fixture.repo, [
      'plan-batch',
      'batch-parent-feature',
      'batch-child-feature',
      '--target',
      'origin/main',
      '--json',
    ]),
  );
  assert.equal(first.ready, true);
  assert.equal(first.included.length, 1);
  assert.equal(first.included[0].task, 'batch-child-feature');
  assert.equal(first.excluded[0].task, 'batch-parent-feature');
  assert.equal(first.excluded[0].reasons[0].code, 'COVERED_BY_DESCENDANT');
  assert.match(first.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.fingerprint, second.fingerprint, '时间戳不得改变批次指纹');
  assert.equal(first.target.sha, git(fixture.repo, ['rev-parse', 'origin/main']));

  writeFileSync(join(child, 'dirty.txt'), 'not committed\n');
  const blocked = JSON.parse(
    managerKeep(fixture.repo, [
      'plan-batch',
      'batch-parent-feature',
      'batch-child-feature',
      '--target',
      'origin/main',
      '--json',
    ]),
  );
  assert.equal(blocked.ready, false);
  assert.equal(blocked.fingerprint, null);
  assert.equal(
    blocked.blockers.some((item) => item.task === 'batch-child-feature' && item.code === 'DIRTY_WORKTREE'),
    true,
  );

  rmSync(join(child, 'dirty.txt'));
  git(fixture.repo, ['merge', '--no-ff', '--no-edit', 'codex/batch-child-feature']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  const integratedSha = git(fixture.repo, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['reclaim', 'batch-child-feature', '--pushed', integratedSha]);
  const historical = JSON.parse(
    managerKeep(fixture.repo, [
      'plan-batch',
      'batch-parent-feature',
      'batch-child-feature',
      '--target',
      'origin/main',
      '--json',
    ]),
  );
  assert.equal(
    historical.excluded.every((item) => item.state === 'already_integrated'),
    true,
  );
  assert.equal(
    historical.blockers.some((item) => item.code === 'WORKTREE_NOT_PRESENT'),
    false,
  );
  assert.equal(
    historical.blockers.some((item) => item.code === 'NO_UNIQUE_INPUT'),
    true,
  );
});

test('plan-batch --scan-conflicts 在冻结前给出冲突矩阵，并区分同 hunk、结构性与同文件相邻', (t) => {
  const fixture = makeConflictScanFixture(t);
  const selectors = ['scan-alpha', 'scan-beta', 'scan-gamma', 'scan-delta'];
  const planned = JSON.parse(manager(fixture.repo, ['plan-batch', ...selectors, '--target', 'origin/main', '--json']));
  const scanned = JSON.parse(
    manager(fixture.repo, ['plan-batch', ...selectors, '--target', 'origin/main', '--scan-conflicts', '--json']),
  );

  assert.equal(planned.conflict_scan, undefined, '不加 flag 时不做扫描');
  assert.equal(scanned.fingerprint, planned.fingerprint, '扫描是附加输出，不得改变冻结指纹');
  const scan = scanned.conflict_scan;
  assert.equal(scan.supported, true, `merge-tree 干跑不可用: ${scan.reason}`);
  assert.equal(scan.summary.pair_count, 6);
  assert.equal(scan.summary.conflicting_pairs, 3);
  assert.equal(scan.summary.failed_pairs, 0);

  const pairOf = (left, right) =>
    scan.pairs.find(
      (pair) => (pair.a.task === left && pair.b.task === right) || (pair.a.task === right && pair.b.task === left),
    );
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

  for (const [left, right] of [
    ['scan-alpha', 'scan-gamma'],
    ['scan-beta', 'scan-gamma'],
    ['scan-gamma', 'scan-delta'],
  ]) {
    const pair = pairOf(left, right);
    assert.equal(pair.state, 'clean', `${left} × ${right} 应为正交`);
    assert.equal(pair.conflict_files, 0);
    assert.equal(pair.adjacent_files, 0);
  }

  // 各输入对 target 单独干跑：这批都是 target 的后代，逐支落地本身不冲突——
  // 说明冲突只在「合到一起」时出现，正是矩阵要提前暴露的信息。
  assert.equal(scan.against_target.length, 4);
  assert.equal(
    scan.against_target.every((row) => row.state === 'clean'),
    true,
  );

  // 冲突面排序：直接支撑「冲突面大的压轴」。
  assert.deepEqual(
    scan.summary.inputs.map((row) => row.task),
    ['scan-alpha', 'scan-beta', 'scan-delta', 'scan-gamma'],
  );
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
      operation: ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].filter((marker) =>
        existsSync(join(git(tree, ['rev-parse', '--absolute-git-dir']), marker)),
      ),
    })),
  });

  const before = snapshot();
  manager(fixture.repo, ['plan-batch', ...selectors, '--target', 'origin/main', '--scan-conflicts', '--json']);
  const after = snapshot();

  assert.deepEqual(after, before, 'merge-tree 干跑只应往对象库写游离对象，不得改动工作区、index 或 ref');
  assert.equal(
    after.trees.every((tree) => tree.status === '' && tree.operation.length === 0),
    true,
  );
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
      'spawn',
      task,
      '--base',
      'origin/main',
      '--agent',
      'codex',
      '--agent-id',
      `${task}-thread`,
      '--purpose',
      '目录重命名冲突 fixture',
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

  const plan = JSON.parse(
    manager(fixture.repo, [
      'plan-batch',
      'scan-split',
      'scan-addfile',
      '--target',
      'origin/main',
      '--scan-conflicts',
      '--json',
    ]),
  );
  const pair = plan.conflict_scan.pairs[0];
  assert.equal(pair.conflict_files, 0, '这类冲突本来就没有文件条目');
  assert.equal(pair.state, 'conflict', '退出码 1 即冲突，不得因为文件条目为空而判成 clean/adjacent');
  assert.equal(plan.conflict_scan.summary.conflicting_pairs, 1);
  // 没有文件条目时必须把信息性冲突记录亮出来，否则读者只看到 conflict=0 无从下手。
  assert.ok(pair.conflict_notes.length > 0, '缺少信息性冲突记录');
  assert.match(pair.conflict_notes[0].conflict_type, /directory rename/i);
  assert.deepEqual(pair.conflict_notes[0].paths, ['a']);

  const human = manager(fixture.repo, [
    'plan-batch',
    'scan-split',
    'scan-addfile',
    '--target',
    'origin/main',
    '--scan-conflicts',
  ]);
  assert.match(human, /\[NOTE\][\s\S]*directory rename/i, '人读输出必须显示无文件条目的冲突');
});

test('产物类汇总在截断前统计：排在 50 项之后的 lock 文件不得从 REGEN 汇总消失', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  const paths = [
    ...Array.from({ length: 60 }, (_, index) => `f-${String(index).padStart(2, '0')}.txt`),
    'zzz/pnpm-lock.yaml',
  ];
  mkdirSync(join(fixture.repo, 'zzz'));
  for (const path of paths) writeFileSync(join(fixture.repo, path), 'base\n');
  git(fixture.repo, ['add', '-A']);
  git(fixture.repo, ['commit', '-m', 'chore: truncation baseline']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  git(fixture.repo, ['fetch', 'origin', 'main']);

  for (const task of ['scan-bulk-a', 'scan-bulk-b']) {
    manager(fixture.repo, [
      'spawn',
      task,
      '--base',
      'origin/main',
      '--agent',
      'codex',
      '--agent-id',
      `${task}-thread`,
      '--purpose',
      '截断 fixture',
    ]);
    const worktree = worktreeFor(fixture, task);
    for (const path of paths) writeFileSync(join(worktree, path), `${task}\n`);
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-m', `feat: ${task}`]);
    git(worktree, ['push', '-u', 'origin', 'HEAD']);
    manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--no-watch']);
  }

  const plan = JSON.parse(
    manager(fixture.repo, [
      'plan-batch',
      'scan-bulk-a',
      'scan-bulk-b',
      '--target',
      'origin/main',
      '--scan-conflicts',
      '--json',
    ]),
  );
  const pair = plan.conflict_scan.pairs[0];
  assert.equal(pair.conflict_files, 61, '计数必须是全量，不受展示截断影响');
  assert.equal(pair.files.length, 50, '展示层仍按上限截断');
  assert.equal(pair.files_truncated, true);
  assert.equal(
    pair.files.some((file) => file.path === 'zzz/pnpm-lock.yaml'),
    false,
    'lock 排在 50 项之后，确实被展示截断',
  );
  // 关键：汇总跑在截断前的全量清单上。
  const regenerated = plan.conflict_scan.summary.regenerated_paths;
  assert.equal(regenerated.length, 1);
  assert.equal(regenerated[0].path, 'zzz/pnpm-lock.yaml');
  assert.equal(regenerated[0].kind, 'lockfile');
});

test('带冲突矩阵的计划仍是合法冻结契约：batch-integrate 照常合成，不受附加字段影响', (t) => {
  const fixture = makeConflictScanFixture(t);
  // 取正交的两支，验证的是「计划里多出 conflict_scan」这一点，而不是冲突处置。
  const plan = JSON.parse(
    manager(fixture.repo, [
      'plan-batch',
      'scan-alpha',
      'scan-gamma',
      '--target',
      'origin/main',
      '--scan-conflicts',
      '--json',
    ]),
  );
  assert.equal(plan.conflict_scan.summary.conflicting_pairs, 0);
  const planPath = join(fixture.sandbox, 'plan-with-scan.json');
  writeFileSync(planPath, JSON.stringify(plan));

  const result = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'scan-plan-integrator',
      '--json',
    ]),
  );
  assert.equal(result.outcome, 'composed');
  assert.equal(result.fingerprint, plan.fingerprint, '扫描字段不得进入新鲜度比对或指纹');
  assert.equal(result.steps.length, 2);
});
