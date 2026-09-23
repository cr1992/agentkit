import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  git,
  manager,
  makeRemoteRepo,
  publishProfile,
  recordFor,
  gitOk,
  managerStderr,
  prepareBatchInput,
  freezePlan,
  batchEvidence,
} from '../../tests/helpers/worktree-mgr-fixture.mjs';

test('batch-result 冻结终态证据，archive-evidence 保留精确候选后回收 done worktree', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'evidence-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'evidence-beta', 'beta.txt', 'beta\n');
  const { plan, planPath } = freezePlan(fixture, ['evidence-alpha', 'evidence-beta']);
  const composed = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'evidence-integrator',
      '--json',
    ]),
  );
  manager(fixture.repo, ['touch', composed.candidate.task, '--status', 'done', '--note', '设备验收已结束，待冻结证据']);
  const unrecorded = JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.find(
    (item) =>
      item.code === 'DONE_BATCH_CANDIDATE_RESULT_UNRECORDED' && item.worktree_id === composed.candidate.worktree_id,
  );
  assert.equal(unrecorded.candidate_sha, composed.composed_sha);
  assert.match(
    managerStderr(fixture.repo, [
      'reclaim',
      composed.candidate.task,
      '--archive-evidence',
      composed.composed_sha,
      '--reason',
      '尚未冻结结果',
    ]),
    /尚未通过 batch-result/,
  );
  const evidencePath = batchEvidence(fixture);
  const frozen = JSON.parse(
    manager(fixture.repo, [
      'batch-result',
      composed.candidate.task,
      '--state',
      'passed',
      '--candidate',
      composed.composed_sha,
      '--evidence',
      evidencePath,
      '--json',
    ]),
  );
  assert.equal(frozen.outcome, 'passed');
  assert.equal(frozen.candidate_sha, composed.composed_sha);
  assert.match(frozen.result_digest, /^sha256:/);
  assert.equal(recordFor(fixture, composed.candidate.task).task_status, 'done');
  const frozenAgain = JSON.parse(
    manager(fixture.repo, [
      'batch-result',
      composed.candidate.task,
      '--state',
      'passed',
      '--candidate',
      composed.composed_sha,
      '--evidence',
      evidencePath,
      '--json',
    ]),
  );
  assert.equal(frozenAgain.result_digest, frozen.result_digest);

  const pendingFinding = JSON.parse(manager(fixture.repo, ['doctor', '--json'])).findings.find(
    (item) =>
      item.code === 'DONE_EVIDENCE_WORKTREE_RECLAIM_PENDING' && item.worktree_id === composed.candidate.worktree_id,
  );
  assert.equal(pendingFinding.candidate_sha, composed.composed_sha);

  // dirty、错误 SHA 都不得提前创建 archive ref。
  const archiveRef = `refs/worktree-archive/evidence/${composed.candidate.worktree_id}`;
  const candidateTree = git(composed.candidate.path, ['rev-parse', 'HEAD^{tree}']);
  const mergeSide = git(composed.candidate.path, [
    'commit-tree',
    candidateTree,
    '-p',
    composed.composed_sha,
    '-m',
    'test: pending merge',
  ]);
  git(composed.candidate.path, ['merge', '--no-commit', '--no-ff', mergeSide]);
  assert.match(
    managerStderr(fixture.repo, [
      'reclaim',
      composed.candidate.task,
      '--archive-evidence',
      composed.composed_sha,
      '--reason',
      '固定设备候选已验收',
    ]),
    /git operation in progress/,
  );
  git(composed.candidate.path, ['merge', '--abort']);
  git(fixture.repo, ['update-ref', archiveRef, plan.target.sha]);
  assert.match(
    managerStderr(fixture.repo, [
      'reclaim',
      composed.candidate.task,
      '--archive-evidence',
      composed.composed_sha,
      '--reason',
      '固定设备候选已验收',
    ]),
    /归档 ref 已指向其他提交/,
  );
  assert.equal(git(fixture.repo, ['rev-parse', `${archiveRef}^{commit}`]), plan.target.sha);
  git(fixture.repo, ['update-ref', '-d', archiveRef]);
  writeFileSync(join(composed.candidate.path, 'dirty.txt'), 'dirty\n');
  assert.match(
    managerStderr(fixture.repo, [
      'reclaim',
      composed.candidate.task,
      '--archive-evidence',
      composed.composed_sha,
      '--reason',
      '固定设备候选已验收',
    ]),
    /必须干净|归档前置条件/,
  );
  assert.equal(gitOk(fixture.repo, ['show-ref', '--verify', archiveRef]), false);
  rmSync(join(composed.candidate.path, 'dirty.txt'));
  assert.match(
    managerStderr(fixture.repo, [
      'reclaim',
      composed.candidate.task,
      '--archive-evidence',
      planPath.length.toString(16).padStart(composed.composed_sha.length, '0'),
      '--reason',
      '固定设备候选已验收',
    ]),
    /完整 commit object ID/,
  );

  const output = manager(fixture.repo, [
    'reclaim',
    composed.candidate.task,
    '--archive-evidence',
    composed.composed_sha,
    '--reason',
    '固定设备候选已完成验收，功能输入另行合入目标分支',
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
    'reclaim',
    composed.candidate.task,
    '--archive-evidence',
    composed.composed_sha,
    '--reason',
    '固定设备候选已完成验收，功能输入另行合入目标分支',
  ]);
  assert.equal(git(fixture.repo, ['rev-parse', `${archiveRef}^{commit}`]), composed.composed_sha);
  assert.match(
    managerStderr(fixture.repo, [
      'reclaim',
      composed.candidate.task,
      '--archive-evidence',
      composed.composed_sha,
      '--reason',
      '试图改写已经冻结的归档原因',
    ]),
    /不同的证据归档/,
  );
});

test('batch-result 拒绝覆盖终态，并在 passed 前要求合成后步骤全部成功或跳过', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  writeFileSync(
    join(fixture.repo, '.worktree-trace.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        default_base: 'origin/main',
        post_integrate_steps: [{ name: 'regenerate', hint: '重生成产物' }],
      },
      null,
      2,
    )}\n`,
  );
  publishProfile(fixture);
  prepareBatchInput(fixture, 'result-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'result-beta', 'beta.txt', 'beta\n');
  const { planPath } = freezePlan(fixture, ['result-alpha', 'result-beta']);
  const composed = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'result-integrator',
      '--json',
    ]),
  );
  const missingContract = batchEvidence(fixture, 'missing-contract', 'passed', { omitContract: true });
  assert.match(
    managerStderr(fixture.repo, [
      'batch-result',
      composed.candidate.task,
      '--state',
      'passed',
      '--candidate',
      composed.composed_sha,
      '--evidence',
      missingContract,
    ]),
    /非空 contract_digest/,
  );
  const sensitiveEnvironment = batchEvidence(fixture, 'sensitive-environment', 'passed', {
    environment: { api_key: 'must-not-enter-trace' },
  });
  assert.match(
    managerStderr(fixture.repo, [
      'batch-result',
      composed.candidate.task,
      '--state',
      'passed',
      '--candidate',
      composed.composed_sha,
      '--evidence',
      sensitiveEnvironment,
    ]),
    /不含敏感键/,
  );
  const passedEvidence = batchEvidence(fixture, 'passed-suite', 'passed');
  assert.match(
    managerStderr(fixture.repo, [
      'batch-result',
      composed.candidate.task,
      '--state',
      'passed',
      '--candidate',
      composed.composed_sha,
      '--evidence',
      passedEvidence,
    ]),
    /合成后步骤/,
  );
  manager(fixture.repo, ['batch-step', composed.candidate.task, '--step', 'regenerate', '--state', 'done']);
  manager(fixture.repo, [
    'batch-result',
    composed.candidate.task,
    '--state',
    'passed',
    '--candidate',
    composed.composed_sha,
    '--evidence',
    passedEvidence,
  ]);
  const failedEvidence = batchEvidence(fixture, 'failed-suite', 'failed');
  assert.match(
    managerStderr(fixture.repo, [
      'batch-result',
      composed.candidate.task,
      '--state',
      'failed',
      '--candidate',
      composed.composed_sha,
      '--evidence',
      failedEvidence,
    ]),
    /不得覆盖终态结果/,
  );
  assert.match(
    managerStderr(fixture.repo, ['batch-step', composed.candidate.task, '--step', 'regenerate', '--state', 'skipped']),
    /batch_result 已冻结/,
  );
  assert.match(
    managerStderr(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'result-integrator',
      '--recompose',
      '--recompose-head',
      composed.composed_sha,
    ]),
    /batch_result 已冻结/,
  );
});

test('batch-result stale 可用 null contract digest 表达尚未形成独立验收合同', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  prepareBatchInput(fixture, 'stale-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'stale-beta', 'beta.txt', 'beta\n');
  const { planPath } = freezePlan(fixture, ['stale-alpha', 'stale-beta']);
  const composed = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'stale-integrator',
      '--json',
    ]),
  );
  const evidence = batchEvidence(fixture, 'stale-observation', 'passed', { contractDigest: null });
  const result = JSON.parse(
    manager(fixture.repo, [
      'batch-result',
      composed.candidate.task,
      '--state',
      'stale',
      '--candidate',
      composed.composed_sha,
      '--evidence',
      evidence,
      '--reason',
      '目标分支在验收合同冻结前已经前进',
      '--json',
    ]),
  );
  assert.equal(result.outcome, 'stale');
  assert.equal(result.evidence_manifest.contract_digest, null);
  assert.equal(result.reason, '目标分支在验收合同冻结前已经前进');
});

test('Profile 声明的合成后步骤只回显并可登记结果，portable core 不代跑', (t) => {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  writeFileSync(
    join(fixture.repo, '.worktree-trace.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        default_base: 'origin/main',
        post_integrate_steps: [
          { name: 'regenerate-golden', hint: '在候选树重跑 golden 生成命令后提交' },
          { name: 'recompute-lock', hint: '重算依赖锁文件' },
        ],
      },
      null,
      2,
    )}\n`,
  );
  publishProfile(fixture);
  prepareBatchInput(fixture, 'declared-alpha', 'alpha.txt', 'alpha\n');
  prepareBatchInput(fixture, 'declared-beta', 'beta.txt', 'beta\n');
  const { planPath } = freezePlan(fixture, ['declared-alpha', 'declared-beta']);

  const result = JSON.parse(
    manager(fixture.repo, [
      'batch-integrate',
      '--plan',
      planPath,
      '--agent',
      'codex',
      '--agent-id',
      'declared-integrator',
      '--json',
    ]),
  );
  assert.equal(result.outcome, 'composed');
  assert.deepEqual(
    result.post_integrate_steps.map((step) => step.name),
    ['regenerate-golden', 'recompute-lock'],
  );
  assert.equal(
    result.post_integrate_steps.every((step) => step.state === 'pending'),
    true,
  );
  // 只声明不执行：候选树里不会凭空出现声明步骤的产物。
  assert.equal(existsSync(join(result.candidate.path, 'golden')), false);

  const recorded = JSON.parse(
    manager(fixture.repo, [
      'batch-step',
      result.candidate.task,
      '--step',
      'regenerate-golden',
      '--state',
      'done',
      '--note',
      '已在候选树重烤并提交',
      '--json',
    ]),
  );
  const done = recorded.post_integrate_steps.find((step) => step.name === 'regenerate-golden');
  assert.equal(done.state, 'done');
  assert.equal(done.note, '已在候选树重烤并提交');
  assert.equal(typeof done.recorded_at, 'string');

  const rejected = managerStderr(fixture.repo, [
    'batch-step',
    result.candidate.task,
    '--step',
    'not-declared',
    '--state',
    'done',
  ]);
  assert.match(rejected, /未声明的步骤名/);
});
