import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
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
import { git, manager, makeRepo } from '../../tests/helpers/worktree-mgr-fixture.mjs';

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
  assert.equal(
    processIsAlive(123, () => {}),
    true,
  );
  assert.equal(
    processIsAlive(123, () => {
      const error = new Error('sandbox denied signal probe');
      error.code = 'EPERM';
      throw error;
    }),
    true,
  );
  assert.equal(
    processIsAlive(123, () => {
      const error = new Error('missing process');
      error.code = 'ESRCH';
      throw error;
    }),
    false,
  );
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
  manager(fixture.repo, [
    'spawn',
    'artifact-contract',
    '--agent',
    'codex',
    '--agent-id',
    'artifact-thread',
    '--purpose',
    'freeze artifact',
  ]);
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
    [
      'missing-worktree',
      (value) => {
        delete value.worktree_id;
      },
    ],
    [
      'missing-epoch',
      (value) => {
        delete value.ownership_epoch;
      },
    ],
    [
      'stale-epoch',
      (value) => {
        value.ownership_epoch += 1;
      },
    ],
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
  writeFileSync(
    incidentInput,
    JSON.stringify({
      contract_digest: `sha256:${'1'.repeat(64)}`,
      classification: 'tool_gap',
      observation: 'trace event 暴露了可复现边界',
      impact: 'medium',
      confidence: 'high',
      recommended_disposition: 'continue',
    }),
  );
  const incident = JSON.parse(manager(fixture.repo, ['incident', 'artifact-contract', '--input', incidentInput]));
  assert.equal(incident.reflection.evidence_refs.length, 1);
  const proposalInput = join(fixture.sandbox, 'worktree-proposal.json');
  writeFileSync(
    proposalInput,
    JSON.stringify({
      problem_type: 'skill_gap',
      proposed_change: '强化 owner epoch 校验',
      affected_scope: ['artifact'],
      counterexamples: [],
      validation_plan: { replay_cases: ['handoff'], regression_suites: ['worktree-mgr'] },
    }),
  );
  const proposed = JSON.parse(
    manager(fixture.repo, [
      'propose-improvement',
      '--reflection',
      incident.reflection.reflection_id,
      '--input',
      proposalInput,
    ]),
  );
  assert.equal(proposed.proposal.lifecycle, 'proposed');
  assert.equal(existsSync(proposed.ref), true);
  assert.equal(
    JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.some((item) => item.code.startsWith('LEARNING_')),
    false,
  );
  const tampered = JSON.parse(readFileSync(proposed.ref, 'utf8'));
  tampered.lifecycle = 'accepted';
  writeFileSync(proposed.ref, JSON.stringify(tampered));
  assert.equal(
    JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.some(
      (item) => item.code === 'LEARNING_PROPOSAL_INVALID',
    ),
    true,
  );
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
