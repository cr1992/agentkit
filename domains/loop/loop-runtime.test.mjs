import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  LoopValidationError,
  acquireLock,
  envelopeDigest,
  failureSignature,
  main as loopMain,
  releaseLock,
  skillContentDigest as loopSkillDigest,
} from './loop-runtime.mjs';

const LOOP_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'loop-runtime.mjs');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeFixture({ humanGate = 'none', protectedPaths = [], allowedPaths = [] } = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), 'loop-runtime-test-'));
  const repo = join(sandbox, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Loop Test']);
  git(repo, ['config', 'user.email', 'loop@example.invalid']);
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'chore: base']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'README.md'), 'artifact\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'feat: artifact']);
  const artifactSha = git(repo, ['rev-parse', 'HEAD']);
  const contract = {
    schema_version: 1,
    contract_id: 'loop-contract',
    objective: '让 Artifact 有界收敛',
    scope: { include: ['README.md'], exclude: [] },
    acceptance: [{ contract_item_id: 'content', requirement: 'README 满足目标' }],
    permissions: { mode: 'write', writable_paths: ['README.md'] },
    environment: { repository: repo, isolation: 'caller_supplied' },
    skill_set: [
      { name: 'verify-agent-output', version: '1.0.0', content_digest: `sha256:${'0'.repeat(64)}`, provider_mode: 'optional' },
      { name: 'run-agent-verify-loop', version: '1.0.0', content_digest: loopSkillDigest(), provider_mode: 'primary' },
    ],
    stop_conditions: [],
    extensions: {},
  };
  contract.contract_digest = envelopeDigest(contract, 'contract_digest');
  const profile = {
    schema_version: 1,
    profile_id: 'loop-profile',
    l0_checks: [{ check_id: 'unit', argv: ['node', '-e', 'process.stdout.write("ok\\n")'], cwd_rel: '.', stage: 'both', timeout_ms: 10_000, expected_exit_codes: [0] }],
    l1_review: [{ contract_item_id: 'content', lenses: ['functional', 'safety'] }],
    protected_verifier_paths: protectedPaths,
    allowed_validation_changes: allowedPaths,
    runtime: { env_allowlist: ['PATH'], executable_paths: { node: process.execPath }, cache_policy: 'trusted_identity', network_policy: 'contract_authorized', max_log_bytes: 64 * 1024 },
    human_gate: humanGate,
  };
  profile.verification_profile_digest = envelopeDigest(profile, 'verification_profile_digest');
  const artifact = { schema_version: 1, provider: 'caller-supplied', repository_id: 'loop-fixture', object_format: 'sha1', base_sha: baseSha, artifact_sha: artifactSha };
  for (const [name, value] of Object.entries({ contract, profile, artifact })) writeFileSync(join(sandbox, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  return { sandbox, repo, contract, profile, artifact, contractPath: join(sandbox, 'contract.json'), profilePath: join(sandbox, 'profile.json'), artifactPath: join(sandbox, 'artifact.json'), loopState: join(sandbox, 'loop-state'), verifyState: join(sandbox, 'verify-state'), cleanup: () => rmSync(sandbox, { recursive: true, force: true }) };
}

function reviewFor(fixture, verdict, id = 'review-1') {
  const challengeNonce = fixture.loopDir ? loopMain(['status', '--loop', fixture.loopDir]).current_iteration?.review_challenge_nonce : 'external-review-nonce';
  const review = {
    schema_version: 1,
    review_result_id: id,
    contract_digest: fixture.contract.contract_digest,
    verification_profile_digest: fixture.profile.verification_profile_digest,
    artifact_ref: fixture.artifact,
    challenge_nonce: challengeNonce,
    verdict,
    findings: verdict === 'no_defect_found' ? [] : [{ contract_item_id: 'content', class: 'functional', evidence: 'README 可复现偏差', expected: '符合合同', actual: '不符合合同' }],
    forensics: verdict === 'no_defect_found' ? ['读取 README 并对照合同'] : [],
  };
  review.review_result_digest = envelopeDigest(review, 'review_result_digest');
  return review;
}

function writeReview(fixture, review, name = 'review.json') {
  const path = join(fixture.sandbox, name);
  writeFileSync(path, `${JSON.stringify(review, null, 2)}\n`);
  return path;
}

function initLoop(fixture, provider, extra = []) {
  const args = ['init', '--contract', fixture.contractPath, '--profile', fixture.profilePath, '--provider', provider, '--state-root', fixture.loopState, ...extra];
  if (provider === 'embedded') args.push('--workdir', fixture.repo);
  const initialized = loopMain(args);
  fixture.loopDir = initialized.loop_dir;
  return initialized;
}

function makeEvidence(fixture, runId = `verification-${fixture.artifact.artifact_sha.slice(0, 12)}`, name = 'evidence.json') {
  const run = { run_id: runId };
  const evidence = {
    schema_version: 1,
    run_id: run.run_id,
    protocol_version: 1,
    runtime_version: '1.0.0',
    contract_digest: fixture.contract.contract_digest,
    verification_profile_digest: fixture.profile.verification_profile_digest,
    artifact_ref: fixture.artifact,
    stages: {
      smoke_l0: { passed: true, checks: [{ check_id: 'unit', passed: true }] },
      l1_review: reviewFor(fixture, 'no_defect_found'),
      final_l0: { passed: true, checks: [{ check_id: 'unit', passed: true }] },
    },
    terminal_outcome: 'pass',
    completion_scope: 'verification_only',
    human_gate_required: false,
    provenance: { provider: 'verify-agent-output', verified_at: new Date(0).toISOString(), verifier_run_id: 'fixture-verifier', isolation_assurance: 'host_reported', limitations: [] },
  };
  evidence.evidence_digest = envelopeDigest(evidence, 'evidence_digest');
  const evidencePath = join(fixture.sandbox, name);
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { run, evidencePath, evidence };
}

test('failure signature 只使用稳定 check/item/class ID', () => {
  const first = failureSignature({ checks: [{ check_id: 'unit', passed: false }] }, { findings: [{ contract_item_id: 'content', class: 'functional', evidence: 'one' }] });
  const second = failureSignature({ checks: [{ check_id: 'unit', passed: false }] }, { findings: [{ contract_item_id: 'content', class: 'functional', evidence: 'different prose' }] });
  assert.equal(first, second);
});

test('标准 Evidence 推进 Loop，且同一 state root 全局防重放', () => {
  const fixture = makeFixture();
  try {
    const verification = makeEvidence(fixture);
    const first = initLoop(fixture, 'verify-agent-output');
    loopMain(['record-artifact', '--loop', first.loop_dir, '--artifact', fixture.artifactPath, '--verification-run-id', verification.run.run_id]);
    const completed = loopMain(['record-evidence', '--loop', first.loop_dir, '--evidence', verification.evidencePath]);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.iterations[0].evidence_digest, verification.evidence.evidence_digest);
    const report = loopMain(['convergence-report', '--loop', first.loop_dir]);
    assert.equal(report.outcome, 'completed');
    assert.equal(report.iterations, 1);

    const second = initLoop(fixture, 'verify-agent-output');
    loopMain(['record-artifact', '--loop', second.loop_dir, '--artifact', fixture.artifactPath, '--verification-run-id', verification.run.run_id]);
    assert.throws(() => loopMain(['record-evidence', '--loop', second.loop_dir, '--evidence', verification.evidencePath]), /已被消费/);
    assert.equal(loopMain(['status', '--loop', second.loop_dir]).revision, 1);
  } finally {
    fixture.cleanup();
  }
});

test('Loop terminal 自动生成不可变报告，反思与 proposal 不改写终态', () => {
  const fixture = makeFixture();
  try {
    const verification = makeEvidence(fixture);
    const loop = initLoop(fixture, 'verify-agent-output');
    loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath, '--verification-run-id', verification.run.run_id]);
    const completed = loopMain(['record-evidence', '--loop', loop.loop_dir, '--evidence', verification.evidencePath]);
    const terminalBefore = JSON.stringify(completed.terminal);
    const reportPath = join(loop.loop_dir, completed.convergence_report_ref.ref);
    const reportDigest = `sha256:${createHash('sha256').update(readFileSync(reportPath)).digest('hex')}`;
    const reflectionInput = join(fixture.sandbox, 'loop-reflection.json');
    writeFileSync(reflectionInput, JSON.stringify({ trigger: 'terminal_retrospective', classification: 'inefficiency', observation: '终态路径可进一步精简', evidence_refs: [{ type: 'diagnostic', id: completed.convergence_report_ref.ref, digest: reportDigest }], impact: 'low', confidence: 'high', recommended_disposition: 'continue' }));
    const reflected = loopMain(['record-reflection', '--loop', loop.loop_dir, '--input', reflectionInput]);
    assert.equal(JSON.stringify(reflected.terminal), terminalBefore);
    const proposalInput = join(fixture.sandbox, 'loop-proposal.json');
    writeFileSync(proposalInput, JSON.stringify({ problem_type: 'inefficiency', proposed_change: '减少无效重试但保持熔断语义', affected_scope: ['retry policy'], counterexamples: [], validation_plan: { replay_cases: ['terminal-pass'], regression_suites: ['loop-runtime'], independent_review: 'required' } }));
    const proposed = loopMain(['propose-improvement', '--loop', loop.loop_dir, '--reflection', reflected.reflection_refs[0].ref, '--input', proposalInput]);
    assert.equal(JSON.stringify(proposed.terminal), terminalBefore);
    const proposal = JSON.parse(readFileSync(join(loop.loop_dir, proposed.improvement_proposal_refs[0].ref), 'utf8'));
    assert.equal(proposal.lifecycle, 'proposed');
    assert.equal(loopMain(['validate', '--loop', loop.loop_dir]).valid, true);
  } finally { fixture.cleanup(); }
});

test('embedded record 不能冒充 Evidence，连续相同失败触发确定性熔断', () => {
  const fixture = makeFixture();
  try {
    const loop = initLoop(fixture, 'embedded', ['--max-iterations', '4', '--consecutive-identical-signature', '2']);
    for (let iteration = 1; iteration <= 2; iteration += 1) {
      loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath]);
      loopMain(['run-embedded-l0', '--loop', loop.loop_dir]);
      const reviewPath = writeReview(fixture, reviewFor(fixture, 'fail', `review-${iteration}`), `review-${iteration}.json`);
      const result = loopMain(['record-embedded-review', '--loop', loop.loop_dir, '--review', reviewPath, '--assurance', 'host_reported', '--reviewer-run-id', `reviewer-${iteration}`]);
      if (iteration === 1) {
        assert.equal(result.state, 'active');
        loopMain(['next', '--loop', loop.loop_dir]);
      } else {
        assert.equal(result.state, 'stopped');
        assert.equal(result.terminal.kind, 'identical_failure_fuse');
      }
    }
    const record = JSON.parse(readFileSync(join(loop.loop_dir, 'embedded-1.json'), 'utf8'));
    assert.equal(record.record_type, 'embedded_verification_record');
    assert.equal('evidence_digest' in record, false);
    assert.equal(existsSync(join(loop.loop_dir, 'evidence-1.json')), false);
  } finally {
    fixture.cleanup();
  }
});

test('verification abort 不增加 iteration，resume 为同一 Artifact 绑定新 run', () => {
  const fixture = makeFixture();
  try {
    const loop = initLoop(fixture, 'verify-agent-output');
    loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath, '--verification-run-id', 'run-old']);
    const stopped = loopMain(['record-verification-abort', '--loop', loop.loop_dir, '--run-id', 'run-old', '--code', 'stale_precondition', '--diagnostics-ref', 'diag:1']);
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.iterations.length, 0);
    const stoppedReport = stopped.convergence_report_ref;
    const resumed = loopMain(['resume', '--loop', loop.loop_dir, '--verification-run-id', 'run-new']);
    assert.equal(resumed.state, 'active');
    assert.equal(resumed.current_iteration.verification_run_id, 'run-new');
    assert.equal(resumed.current_iteration.artifact_ref.artifact_sha, fixture.artifact.artifact_sha);
    assert.equal(resumed.convergence_report_ref, null);
    const verification = makeEvidence(fixture, 'run-new', 'evidence-resumed.json');
    const completed = loopMain(['record-evidence', '--loop', loop.loop_dir, '--evidence', verification.evidencePath]);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.iterations.length, 1);
    assert.notEqual(completed.convergence_report_ref.report_id, stoppedReport.report_id);
    assert.equal(loopMain(['convergence-report', '--loop', loop.loop_dir]).outcome, 'completed');
    assert.equal(JSON.parse(readFileSync(join(loop.loop_dir, stoppedReport.ref), 'utf8')).outcome, 'stopped');
  } finally {
    fixture.cleanup();
  }
});

test('pass 遇到 H gate 只能 waiting_human，人工批准后 completed', () => {
  const fixture = makeFixture({ humanGate: 'release' });
  try {
    const loop = initLoop(fixture, 'embedded');
    loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath]);
    loopMain(['run-embedded-l0', '--loop', loop.loop_dir]);
    const reviewPath = writeReview(fixture, reviewFor(fixture, 'no_defect_found'));
    const waiting = loopMain(['record-embedded-review', '--loop', loop.loop_dir, '--review', reviewPath, '--assurance', 'user_relayed', '--reviewer-run-id', 'second-session']);
    assert.equal(waiting.state, 'waiting_human');
    const completed = loopMain(['human-gate', '--loop', loop.loop_dir, '--decision', 'approved']);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.human_gate.status, 'approved');
  } finally {
    fixture.cleanup();
  }
});

test('snapshot 丢失时从 event journal 恢复', () => {
  const fixture = makeFixture();
  try {
    const loop = initLoop(fixture, 'embedded');
    unlinkSync(join(loop.loop_dir, 'snapshot.json'));
    assert.equal(loopMain(['status', '--loop', loop.loop_dir]).recovery_needed, true);
    const recorded = loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath]);
    assert.equal(recorded.revision, 1);
    assert.equal(loopMain(['doctor', '--loop', loop.loop_dir]).snapshot_matches_journal, true);
  } finally {
    fixture.cleanup();
  }
});

test('journal 尾部半条 event 恢复后仍可登记 Artifact', () => {
  const fixture = makeFixture();
  try {
    const loop = initLoop(fixture, 'embedded');
    appendFileSync(join(loop.loop_dir, 'events.ndjson'), '{"partial":');
    assert.equal(loopMain(['status', '--loop', loop.loop_dir]).recovery_needed, true);
    const recorded = loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath]);
    assert.equal(recorded.revision, 1);
    assert.doesNotThrow(() => loopMain(['validate', '--loop', loop.loop_dir]));
  } finally {
    fixture.cleanup();
  }
});

test('确认 owner PID 不存在时自动回收 stale state-root lock', () => {
  const fixture = makeFixture();
  try {
    const loop = initLoop(fixture, 'embedded');
    writeFileSync(join(fixture.loopState, '.loop-runtime.lock'), '{"pid":99999999,"acquired_at":"stale"}\n');
    const recorded = loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath]);
    assert.equal(recorded.revision, 1);
  } finally {
    fixture.cleanup();
  }
});

test('并发 stale recovery 不会让两个 Loop writer 同时进入临界区', async () => {
  const fixture = makeFixture();
  try {
    const loop = initLoop(fixture, 'embedded');
    writeFileSync(join(fixture.loopState, '.loop-runtime.lock'), '{"pid":99999999,"acquired_at":"legacy-stale"}\n');
    const run = () => new Promise((resolvePromise) => execFile(process.execPath, [LOOP_SCRIPT, 'record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath, '--expected-revision', '0'], { encoding: 'utf8' }, (error, stdout, stderr) => resolvePromise({ error, stdout, stderr })));
    const results = await Promise.all([run(), run()]);
    assert.equal(results.filter((item) => !item.error).length, 1);
    assert.equal(loopMain(['status', '--loop', loop.loop_dir]).revision, 1);
    assert.equal(loopMain(['validate', '--loop', loop.loop_dir]).valid, true);
  } finally { fixture.cleanup(); }
});

test('dead owner 遗留的 state-root reclaim 子锁可自愈', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'loop-reclaim-test-'));
  const lockPath = join(sandbox, '.lock');
  try {
    writeFileSync(lockPath, '{"pid":99999999,"token":"dead-main"}\n');
    writeFileSync(`${lockPath}.reclaim`, '{"pid":99999998,"token":"dead-reclaimer"}\n');
    const owner = acquireLock(lockPath);
    assert.equal(releaseLock(lockPath, owner), true);
    assert.equal(existsSync(`${lockPath}.reclaim`), false);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test('malformed state-root lock fail closed', () => {
  const fixture = makeFixture();
  try {
    const loop = initLoop(fixture, 'embedded');
    writeFileSync(join(fixture.loopState, '.loop-runtime.lock'), '{');
    assert.throws(() => loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath]), /拒绝自动接管/);
    assert.equal(readFileSync(join(fixture.loopState, '.loop-runtime.lock'), 'utf8'), '{');
  } finally {
    fixture.cleanup();
  }
});

test('state-root lock 只由匹配 token 的 owner 释放', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'loop-lock-test-'));
  const lockPath = join(sandbox, '.lock');
  try {
    const owner = acquireLock(lockPath);
    writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: 'replacement-owner', acquired_at: new Date().toISOString() })}\n`);
    assert.equal(releaseLock(lockPath, owner), false);
    assert.match(readFileSync(lockPath, 'utf8'), /replacement-owner/);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test('embedded state root 通过祖先 symlink 指回仓库时仍拒绝', () => {
  const fixture = makeFixture();
  try {
    const link = join(fixture.sandbox, 'loop-link');
    symlinkSync(fixture.repo, link, 'dir');
    fixture.loopState = join(link, 'loop-state');
    assert.throws(() => initLoop(fixture, 'embedded'), /state root 位于仓库内/);
  } finally {
    fixture.cleanup();
  }
});

test('embedded record 已 write-new 但 event 丢失时验证并复用原记录', () => {
  const fixture = makeFixture();
  try {
    const loop = initLoop(fixture, 'embedded');
    loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath]);
    loopMain(['run-embedded-l0', '--loop', loop.loop_dir]);
    const reviewPath = writeReview(fixture, reviewFor(fixture, 'no_defect_found'));
    const beforeEvents = readFileSync(join(loop.loop_dir, 'events.ndjson'));
    const beforeSnapshot = readFileSync(join(loop.loop_dir, 'snapshot.json'));
    const first = loopMain(['record-embedded-review', '--loop', loop.loop_dir, '--review', reviewPath, '--assurance', 'host_reported', '--reviewer-run-id', 'reviewer']);
    const digest = first.iterations[0].embedded_record_digest;
    writeFileSync(join(loop.loop_dir, 'events.ndjson'), beforeEvents);
    writeFileSync(join(loop.loop_dir, 'snapshot.json'), beforeSnapshot);
    const recovered = loopMain(['record-embedded-review', '--loop', loop.loop_dir, '--review', reviewPath, '--assurance', 'host_reported', '--reviewer-run-id', 'reviewer']);
    assert.equal(recovered.iterations[0].embedded_record_digest, digest);
    assert.equal(loopMain(['validate', '--loop', loop.loop_dir]).valid, true);
  } finally {
    fixture.cleanup();
  }
});

test('embedded provider 在 L1 前拒绝未授权 verifier path 变化', () => {
  const fixture = makeFixture({ protectedPaths: ['README.md'] });
  try {
    const loop = initLoop(fixture, 'embedded');
    assert.throws(() => loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath]), /未授权修改 verifier path/);
    const stopped = loopMain(['status', '--loop', loop.loop_dir]);
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.terminal.code, 'protected_path_violation');
  } finally {
    fixture.cleanup();
  }
});

test('Evidence digest 或 binding 不匹配时拒绝且不消费 run ID', () => {
  const fixture = makeFixture();
  try {
    const verification = makeEvidence(fixture);
    const loop = initLoop(fixture, 'verify-agent-output');
    loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath, '--verification-run-id', verification.run.run_id]);
    const tampered = { ...verification.evidence, contract_digest: 'sha256:'.padEnd(71, '0') };
    tampered.evidence_digest = envelopeDigest(tampered, 'evidence_digest');
    const path = join(fixture.sandbox, 'tampered-evidence.json');
    writeFileSync(path, JSON.stringify(tampered));
    assert.throws(() => loopMain(['record-evidence', '--loop', loop.loop_dir, '--evidence', path]), LoopValidationError);
    assert.deepEqual(loopMain(['status', '--loop', loop.loop_dir]).consumed_verification_run_ids, []);
  } finally {
    fixture.cleanup();
  }
});

test('full provider 也拒绝把 state root 放进 Contract repository', () => {
  const fixture = makeFixture();
  try {
    fixture.loopState = join(fixture.repo, '.loop-state');
    assert.throws(() => initLoop(fixture, 'verify-agent-output'), /state root 位于仓库内/);
  } finally {
    fixture.cleanup();
  }
});

test('embedded executable 消失时 operational stop，不生成失败指纹', () => {
  const fixture = makeFixture();
  try {
    const executable = join(fixture.sandbox, 'ephemeral-node');
    symlinkSync(process.execPath, executable, 'file');
    fixture.profile.runtime.executable_paths.node = executable;
    fixture.profile.verification_profile_digest = envelopeDigest(fixture.profile, 'verification_profile_digest');
    writeFileSync(fixture.profilePath, JSON.stringify(fixture.profile));
    const loop = initLoop(fixture, 'embedded');
    loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath]);
    unlinkSync(executable);
    assert.throws(() => loopMain(['run-embedded-l0', '--loop', loop.loop_dir]), /无法执行/);
    const stopped = loopMain(['status', '--loop', loop.loop_dir]);
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.terminal.code, 'check_runtime_failure');
    assert.equal(stopped.iterations.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('embedded provider 冻结 workdir 外 argv 文件', () => {
  const fixture = makeFixture();
  try {
    const runner = join(fixture.sandbox, 'external-runner.mjs');
    writeFileSync(runner, 'process.exit(0)\n');
    fixture.profile.l0_checks[0].argv = ['node', runner];
    fixture.profile.verification_profile_digest = envelopeDigest(fixture.profile, 'verification_profile_digest');
    writeFileSync(fixture.profilePath, JSON.stringify(fixture.profile));
    const loop = initLoop(fixture, 'embedded');
    loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath]);
    writeFileSync(runner, 'process.exit(1)\n');
    assert.throws(() => loopMain(['run-embedded-l0', '--loop', loop.loop_dir]), /冻结 argv 文件已变化/);
  } finally { fixture.cleanup(); }
});

test('embedded provider 冻结 workdir 内被 gitignore 的 argv 文件', () => {
  const fixture = makeFixture();
  try {
    writeFileSync(join(fixture.repo, '.gitignore'), 'ignored-runner.mjs\n');
    git(fixture.repo, ['add', '.gitignore']);
    git(fixture.repo, ['commit', '-m', 'test: ignore runner']);
    fixture.artifact.artifact_sha = git(fixture.repo, ['rev-parse', 'HEAD']);
    writeFileSync(fixture.artifactPath, JSON.stringify(fixture.artifact));
    const runner = join(fixture.repo, 'ignored-runner.mjs');
    writeFileSync(runner, 'process.exit(0)\n');
    fixture.profile.l0_checks[0].argv = ['node', 'ignored-runner.mjs'];
    fixture.profile.verification_profile_digest = envelopeDigest(fixture.profile, 'verification_profile_digest');
    writeFileSync(fixture.profilePath, JSON.stringify(fixture.profile));
    const loop = initLoop(fixture, 'embedded');
    loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath]);
    writeFileSync(runner, 'process.exit(1)\n');
    assert.throws(() => loopMain(['run-embedded-l0', '--loop', loop.loop_dir]), /冻结 argv 文件已变化/);
  } finally { fixture.cleanup(); }
});

test('undecidable 优先于 L0 fail，且无依据 fail Evidence 被拒绝', () => {
  const fixture = makeFixture();
  try {
    fixture.profile.l0_checks[0].argv = ['node', '-e', 'process.exit(2)'];
    fixture.profile.verification_profile_digest = envelopeDigest(fixture.profile, 'verification_profile_digest');
    writeFileSync(fixture.profilePath, JSON.stringify(fixture.profile));
    const loop = initLoop(fixture, 'embedded');
    loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath]);
    loopMain(['run-embedded-l0', '--loop', loop.loop_dir]);
    const reviewPath = writeReview(fixture, reviewFor(fixture, 'undecidable'));
    const stopped = loopMain(['record-embedded-review', '--loop', loop.loop_dir, '--review', reviewPath, '--assurance', 'host_reported', '--reviewer-run-id', 'independent-reviewer']);
    assert.equal(stopped.terminal.kind, 'undecidable');
  } finally { fixture.cleanup(); }

  const full = makeFixture();
  try {
    const evidence = makeEvidence(full, 'fail-without-basis', 'fail-without-basis.json');
    evidence.evidence.terminal_outcome = 'fail';
    evidence.evidence.evidence_digest = envelopeDigest(evidence.evidence, 'evidence_digest');
    writeFileSync(evidence.evidencePath, JSON.stringify(evidence.evidence));
    const loop = initLoop(full, 'verify-agent-output');
    loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', full.artifactPath, '--verification-run-id', evidence.run.run_id]);
    assert.throws(() => loopMain(['record-evidence', '--loop', loop.loop_dir, '--evidence', evidence.evidencePath]), /缺少稳定失败依据/);
  } finally { full.cleanup(); }
});

test('复制 state root、CLI typo 与伪造 journal 都 fail closed', () => {
  const fixture = makeFixture();
  try {
    const loop = initLoop(fixture, 'embedded');
    assert.throws(() => loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', fixture.artifactPath, '--expected-revison', '0']), /未知选项/);
    const copiedRoot = join(fixture.sandbox, 'copied-state');
    execFileSync('cp', ['-R', fixture.loopState, copiedRoot]);
    assert.throws(() => loopMain(['status', '--loop', join(copiedRoot, 'loops', loop.loop_id)]), /identity 与当前位置不匹配/);
    const diagnosis = loopMain(['doctor', '--loop', join(copiedRoot, 'loops', loop.loop_id)]);
    assert.equal(diagnosis.healthy, false);
    assert.deepEqual(diagnosis.findings, ['state_root_identity_invalid']);
    assert.equal(loopMain(['adopt-root', '--state-root', copiedRoot]).adopted, true);
    assert.equal(loopMain(['status', '--loop', join(copiedRoot, 'loops', loop.loop_id)]).loop_id, loop.loop_id);
    const snapshot = loopMain(['status', '--loop', loop.loop_dir]);
    const forged = { schema_version: 1, revision: 1, kind: 'forged', recorded_at: new Date().toISOString(), previous_event_digest: 'sha256:'.concat('0'.repeat(64)), snapshot: { ...snapshot, revision: 1 } };
    forged.event_digest = envelopeDigest(forged, 'event_digest');
    appendFileSync(join(loop.loop_dir, 'events.ndjson'), `${JSON.stringify(forged)}\n`);
    assert.throws(() => loopMain(['validate', '--loop', loop.loop_dir]), /journal 链/);
  } finally { fixture.cleanup(); }
});

test('capabilities --json 保持统一能力发现兼容', () => {
  const output = execFileSync(process.execPath, [LOOP_SCRIPT, 'capabilities', '--json'], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).skill, 'run-agent-verify-loop');
});
