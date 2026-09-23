import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { appendTraceEvent } from './worktree-trace.mjs';
import {
  git,
  manager,
  managerAsync,
  makeRepo,
  recordFor,
  worktreeFor,
} from '../../tests/helpers/worktree-mgr-fixture.mjs';

test('spawn 替代树要求旧树先冻结且干净，并双向登记关系', async (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'ios-old-baseline',
    '--agent',
    'codex',
    '--agent-id',
    'replacement-thread',
    '--purpose',
    '旧 iOS 基线',
  ]);

  const activeBlocked = await managerAsync(fixture.repo, [
    'spawn',
    'ios-current-baseline',
    '--agent',
    'codex',
    '--agent-id',
    'replacement-thread',
    '--purpose',
    '新 iOS 基线',
    '--supersedes',
    'ios-old-baseline',
    '--replacement-reason',
    '旧基线无法继续',
  ]);
  assert.ok(activeBlocked.error);
  assert.match(activeBlocked.stderr, /替代前必须先冻结旧树/);

  manager(fixture.repo, ['touch', 'ios-old-baseline', '--status', 'abandoned', '--note', '冻结旧树，迁移到新基线']);
  manager(fixture.repo, [
    'spawn',
    'ios-current-baseline',
    '--agent',
    'codex',
    '--agent-id',
    'replacement-thread',
    '--purpose',
    '新 iOS 基线',
    '--supersedes',
    'ios-old-baseline',
    '--replacement-reason',
    '旧基线无法继续且迁移边界已冻结',
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
    'spawn',
    'legacy-old-baseline',
    '--agent',
    'codex',
    '--agent-id',
    'legacy-replacement-thread',
    '--purpose',
    '旧基线',
  ]);
  manager(fixture.repo, ['touch', 'legacy-old-baseline', '--status', 'abandoned', '--note', '冻结旧基线']);
  manager(fixture.repo, [
    'spawn',
    'legacy-current-baseline',
    '--agent',
    'codex',
    '--agent-id',
    'legacy-replacement-thread',
    '--purpose',
    '新基线',
    '--supersedes',
    'legacy-old-baseline',
    '--replacement-reason',
    '旧基线已被替代',
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
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'UNDECLARED_SESSION_WORKTREE_MULTIPLICITY'),
    true,
  );
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'ABANDONED_WORKTREE_RECLAIM_PENDING'),
    true,
  );

  assert.match(
    manager(fixture.repo, [
      'supersede',
      'legacy-old-baseline',
      '--by',
      'legacy-current-baseline',
      '--reason',
      '旧基线已被替代',
    ]),
    /替代关系已登记/,
  );
  const oldAfter = recordFor(fixture, 'legacy-old-baseline');
  const replacementAfter = recordFor(fixture, 'legacy-current-baseline');
  assert.equal(oldAfter.superseded_by.worktree_id, replacementAfter.worktree_id);
  assert.equal(replacementAfter.delivery_relation.superseded_worktree_id, oldAfter.worktree_id);
  assert.doesNotThrow(
    () =>
      manager(fixture.repo, [
        'supersede',
        'legacy-old-baseline',
        '--by',
        'legacy-current-baseline',
        '--reason',
        '旧基线已被替代',
      ]),
    '同一关系应可幂等重跑',
  );

  doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'UNDECLARED_SESSION_WORKTREE_MULTIPLICITY'),
    false,
  );
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'SUPERSESSION_RELATION_BROKEN'),
    false,
  );
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'SUPERSEDED_WORKTREE_RECLAIM_PENDING'),
    true,
  );
});

test('superseded reclaim 默认归档未推送旧 HEAD 后回收目录和分支', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'archived-old-baseline',
    '--agent',
    'codex',
    '--agent-id',
    'archive-replacement-thread',
    '--purpose',
    '待归档旧基线',
  ]);
  const oldWorktree = worktreeFor(fixture, 'archived-old-baseline');
  writeFileSync(join(oldWorktree, 'unique-old.txt'), 'recoverable old work\n');
  git(oldWorktree, ['add', 'unique-old.txt']);
  git(oldWorktree, ['commit', '-m', 'feat: unique old work']);
  const oldHead = git(oldWorktree, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['touch', 'archived-old-baseline', '--status', 'abandoned', '--note', '独有提交待归档']);
  manager(fixture.repo, [
    'spawn',
    'archived-current-baseline',
    '--agent',
    'codex',
    '--agent-id',
    'archive-replacement-thread',
    '--purpose',
    '替代基线',
    '--supersedes',
    'archived-old-baseline',
    '--replacement-reason',
    '旧提交语义已迁移',
  ]);
  const oldRecord = recordFor(fixture, 'archived-old-baseline');
  const replacement = recordFor(fixture, 'archived-current-baseline');
  const archiveRef = `refs/worktree-archive/superseded/${oldRecord.worktree_id}`;

  writeFileSync(join(oldWorktree, 'unsaved.txt'), 'must block archive\n');
  assert.throws(() =>
    manager(fixture.repo, ['reclaim', 'archived-old-baseline', '--superseded-by', 'archived-current-baseline']),
  );
  assert.throws(() => git(fixture.repo, ['show-ref', '--verify', archiveRef]), 'dirty 旧树不得提前创建归档证据');
  rmSync(join(oldWorktree, 'unsaved.txt'));

  const output = manager(fixture.repo, [
    'reclaim',
    'archived-old-baseline',
    '--superseded-by',
    'archived-current-baseline',
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
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'SUPERSEDED_WORKTREE_RECLAIM_PENDING'),
    false,
  );
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'UNDECLARED_SESSION_WORKTREE_MULTIPLICITY'),
    false,
  );
});

test('superseded reclaim 只有精确 --discard SHA 才允许无归档回收', async (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  manager(fixture.repo, [
    'spawn',
    'discarded-old-baseline',
    '--agent',
    'codex',
    '--agent-id',
    'discard-replacement-thread',
    '--purpose',
    '待丢弃旧基线',
  ]);
  const oldWorktree = worktreeFor(fixture, 'discarded-old-baseline');
  writeFileSync(join(oldWorktree, 'obsolete.txt'), 'obsolete work\n');
  git(oldWorktree, ['add', 'obsolete.txt']);
  git(oldWorktree, ['commit', '-m', 'feat: obsolete work']);
  const oldHead = git(oldWorktree, ['rev-parse', 'HEAD']);
  manager(fixture.repo, ['touch', 'discarded-old-baseline', '--status', 'abandoned', '--note', '明确废弃']);
  manager(fixture.repo, [
    'spawn',
    'discarded-current-baseline',
    '--agent',
    'codex',
    '--agent-id',
    'discard-replacement-thread',
    '--purpose',
    '替代基线',
    '--supersedes',
    'discarded-old-baseline',
    '--replacement-reason',
    '旧实现无需保留',
  ]);
  const oldRecord = recordFor(fixture, 'discarded-old-baseline');
  const archiveRef = `refs/worktree-archive/superseded/${oldRecord.worktree_id}`;

  const wrong = await managerAsync(fixture.repo, [
    'reclaim',
    'discarded-old-baseline',
    '--superseded-by',
    'discarded-current-baseline',
    '--discard',
    '0'.repeat(40),
  ]);
  assert.ok(wrong.error);
  assert.match(wrong.stderr, /SHA 与旧树 HEAD 不一致/);
  assert.equal(existsSync(oldWorktree), true);

  assert.match(
    manager(fixture.repo, [
      'reclaim',
      'discarded-old-baseline',
      '--superseded-by',
      'discarded-current-baseline',
      '--discard',
      oldHead,
    ]),
    /精确 SHA 授权丢弃/,
  );
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
    'spawn',
    'first-delivery-tree',
    '--agent',
    'codex',
    '--agent-id',
    'doctor-thread',
    '--purpose',
    'first tree',
  ]);
  manager(fixture.repo, [
    'spawn',
    'second-delivery-tree',
    '--agent',
    'codex',
    '--agent-id',
    'doctor-thread',
    '--purpose',
    'second tree',
    '--parallel-reason',
    'fixture needs a declared second tree',
  ]);

  let doctor = JSON.parse(manager(fixture.repo, ['doctor', '--json']));
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'UNDECLARED_SESSION_WORKTREE_MULTIPLICITY'),
    false,
  );

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
  assert.equal(
    doctor.findings.some((finding) => finding.code === 'UNDECLARED_SESSION_WORKTREE_MULTIPLICITY'),
    true,
  );
});
