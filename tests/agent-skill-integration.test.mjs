import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  envelopeDigest as verifierDigest,
  canonicalJson as verifierCanonicalJson,
  main as verifierMain,
  skillContentDigest as verifierSkillDigest,
} from '../domains/verify/verification-runtime.mjs';
import {
  main as loopMain,
  skillContentDigest as loopSkillDigest,
} from '../domains/loop/loop-runtime.mjs';
import { canonicalJson as worktreeCanonicalJson, worktreeSkillDigest } from '../domains/worktree/worktree-mgr.mjs';
import { main as ledgerMain, skillContentDigest as orchestratorSkillDigest } from '../domains/orchestrate/orchestration-ledger.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKTREE_MANAGER = join(ROOT, 'manage-worktrees', 'scripts', 'worktree-mgr.mjs');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture() {
  const sandbox = mkdtempSync(join(tmpdir(), 'agent-skill-integration-'));
  const repo = join(sandbox, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Integration Test']);
  git(repo, ['config', 'user.email', 'integration@example.invalid']);
  writeFileSync(join(repo, 'result.txt'), 'base\n');
  git(repo, ['add', 'result.txt']);
  git(repo, ['commit', '-m', 'chore: base']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'result.txt'), 'verified artifact\n');
  git(repo, ['add', 'result.txt']);
  git(repo, ['commit', '-m', 'feat: artifact']);
  const artifactSha = git(repo, ['rev-parse', 'HEAD']);
  const contract = {
    schema_version: 1,
    contract_id: 'integration-contract',
    objective: '产出并独立验证固定 Artifact',
    scope: { include: ['result.txt'], exclude: [] },
    acceptance: [{ contract_item_id: 'result-content', requirement: 'result.txt 包含 verified artifact' }],
    permissions: { mode: 'write', writable_paths: ['result.txt'] },
    environment: { repository: repo, isolation: 'caller_supplied' },
    skill_set: [
      { name: 'verify-agent-output', version: '1.0.0', content_digest: verifierSkillDigest(), provider_mode: 'primary' },
      { name: 'run-agent-verify-loop', version: '1.0.0', content_digest: loopSkillDigest(), provider_mode: 'primary' },
      { name: 'orchestrate-subagents', version: '1.0.0', content_digest: orchestratorSkillDigest(), provider_mode: 'primary' },
    ],
    stop_conditions: [],
    extensions: { verification: { provider: 'verify-agent-output' } },
  };
  contract.contract_digest = verifierDigest(contract, 'contract_digest');
  const profile = {
    schema_version: 1,
    profile_id: 'integration-profile',
    l0_checks: [{ check_id: 'content', argv: ['node', '-e', 'const s=require("node:fs").readFileSync("result.txt","utf8");process.exit(s.includes("verified artifact")?0:1)'], cwd_rel: '.', stage: 'both', timeout_ms: 10_000, expected_exit_codes: [0] }],
    l1_review: [{ contract_item_id: 'result-content', lenses: ['functional', 'scope', 'safety'] }],
    protected_verifier_paths: [],
    allowed_validation_changes: [],
    runtime: { env_allowlist: ['PATH'], executable_paths: { node: process.execPath }, cache_policy: 'trusted_identity', network_policy: 'contract_authorized', max_log_bytes: 64 * 1024 },
    human_gate: 'none',
  };
  profile.verification_profile_digest = verifierDigest(profile, 'verification_profile_digest');
  const artifact = { schema_version: 1, provider: 'caller-supplied', repository_id: 'integration-repository', object_format: 'sha1', base_sha: baseSha, artifact_sha: artifactSha };
  for (const [name, value] of Object.entries({ contract, profile, artifact })) writeFileSync(join(sandbox, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  return { sandbox, repo, contract, profile, artifact, cleanup: () => rmSync(sandbox, { recursive: true, force: true }) };
}

test('verifier 真实 Evidence 可被 Loop 消费并推进 orchestration 独立验收门禁', () => {
  const value = fixture();
  try {
    const contractPath = join(value.sandbox, 'contract.json');
    const profilePath = join(value.sandbox, 'profile.json');
    const artifactPath = join(value.sandbox, 'artifact.json');
    const verification = verifierMain(['init', '--contract', contractPath, '--profile', profilePath, '--artifact', artifactPath, '--workdir', value.repo, '--state-root', join(value.sandbox, 'verify-state'), '--isolation-assurance', 'host_reported']);
    verifierMain(['run-smoke', '--run', verification.run_dir]);
    const review = {
      schema_version: 1,
      review_result_id: 'integration-review',
      contract_digest: value.contract.contract_digest,
      verification_profile_digest: value.profile.verification_profile_digest,
      artifact_ref: value.artifact,
      challenge_nonce: verification.review_challenge_nonce,
      verdict: 'no_defect_found',
      findings: [],
      forensics: ['读取 result.txt 并与 acceptance 对照'],
    };
    review.review_result_digest = verifierDigest(review, 'review_result_digest');
    const reviewPath = join(value.sandbox, 'review.json');
    writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    verifierMain(['record-review', '--run', verification.run_dir, '--review', reviewPath, '--verifier-run-id', 'integration-verifier', '--isolation-assurance', 'host_reported']);
    const verified = verifierMain(['run-final', '--run', verification.run_dir]);
    assert.equal(verified.terminal.outcome, 'pass');

    const loop = loopMain(['init', '--contract', contractPath, '--profile', profilePath, '--provider', 'verify-agent-output', '--state-root', join(value.sandbox, 'loop-state')]);
    loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', artifactPath, '--verification-run-id', verification.run_id]);
    const completed = loopMain(['record-evidence', '--loop', loop.loop_dir, '--evidence', join(verification.run_dir, 'evidence.json')]);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.iterations[0].evidence_digest, verified.terminal.evidence_digest);

    const ledger = ledgerMain(['init', '--contract', contractPath, '--state-root', join(value.sandbox, 'ledger-state')]);
    const nodePath = join(value.sandbox, 'verified-node.json');
    writeFileSync(nodePath, JSON.stringify({ node_id: 'integration-candidate', objective: '验收最终集成候选', verification: { requirement: 'independent_evidence', provider: 'verify-agent-output', artifact_scope: 'integration_candidate' } }));
    ledgerMain(['add-node', '--ledger', ledger.ledger_dir, '--input', nodePath]);
    ledgerMain(['attach', '--ledger', ledger.ledger_dir, '--node', 'integration-candidate', '--type', 'artifact', '--input', artifactPath]);
    const attached = ledgerMain(['attach', '--ledger', ledger.ledger_dir, '--node', 'integration-candidate', '--type', 'evidence', '--input', join(verification.run_dir, 'evidence.json')]);
    const evidenceRef = attached.nodes['integration-candidate'].evidence[0].digest;
    const passPath = join(value.sandbox, 'verified-pass.json');
    writeFileSync(passPath, JSON.stringify({ state: 'passed', verification_ref: evidenceRef }));
    const passed = ledgerMain(['update', '--ledger', ledger.ledger_dir, '--node', 'integration-candidate', '--input', passPath]);
    assert.equal(passed.nodes['integration-candidate'].verification_assurance, 'independent_evidence');
    assert.equal(ledgerMain(['doctor', '--ledger', ledger.ledger_dir]).healthy, true);
  } finally {
    value.cleanup();
  }
});

test('Review Result v1 只有一份 canonical schema，Skill 目录不再各自携带副本', () => {
  // 原断言比较 verifier 与 loop 各自携带的副本是否一致；schema 收敛后同一份文件不可能不一致，
  // 真正需要守住的是「副本不会重新长回 Skill 目录」，否则漂移会以另一种形式回来。
  const canonical = readFileSync(join(ROOT, 'schemas', 'review-result-v1.schema.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(canonical));
  for (const skill of ['verify-agent-output', 'run-agent-verify-loop', 'orchestrate-subagents', 'manage-worktrees']) {
    assert.equal(existsSync(join(ROOT, skill, 'references', 'schemas')), false, `${skill} 重新携带了 schema 副本`);
  }
});

test('跨 runtime canonical key 顺序对非 ASCII 键保持一致', () => {
  const value = { '\u{1f600}': 1, '\ufffd': 2, A: 3, a: 4, '\u0080': 5 };
  assert.equal(JSON.stringify(worktreeCanonicalJson(value)), verifierCanonicalJson(value));
});

test('manage-worktrees 产出的 Artifact Ref 可直接进入一次性 Verification', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'artifact-verification-integration-'));
  const repo = join(sandbox, 'repo');
  try {
    mkdirSync(repo);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Artifact Integration']);
    git(repo, ['config', 'user.email', 'artifact@example.invalid']);
    writeFileSync(join(repo, 'result.txt'), 'base\n');
    git(repo, ['add', 'result.txt']); git(repo, ['commit', '-m', 'chore: base']);
    const manager = (args) => execFileSync(process.execPath, [WORKTREE_MANAGER, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, WORKTREE_ROOT: join(sandbox, '.worktrees') } }).trim();
    manager(['spawn', 'verified-artifact', '--agent', 'codex', '--agent-id', 'integration-thread', '--purpose', 'artifact producer']);
    const listing = JSON.parse(manager(['list', '--json']));
    const workdir = listing.worktrees.find((item) => item.kind === 'TRACKED').path;
    writeFileSync(join(workdir, 'result.txt'), 'verified artifact\n');
    git(workdir, ['add', 'result.txt']); git(workdir, ['commit', '-m', 'feat: artifact']);
    const artifact = JSON.parse(manager(['artifact', 'verified-artifact', '--json']));
    const contract = { schema_version: 1, contract_id: 'managed-artifact-contract', objective: '验证 worktree Artifact', scope: { include: ['result.txt'], exclude: [] }, acceptance: [{ contract_item_id: 'content', requirement: 'result.txt 包含 verified artifact' }], permissions: { mode: 'read_only', writable_paths: [] }, environment: { repository: workdir, isolation: 'worktree' }, skill_set: [{ name: 'manage-worktrees', version: 'unversioned', content_digest: worktreeSkillDigest(), provider_mode: 'primary' }, { name: 'verify-agent-output', version: '1.0.0', content_digest: verifierSkillDigest(), provider_mode: 'primary' }], stop_conditions: [], extensions: {} };
    contract.contract_digest = verifierDigest(contract, 'contract_digest');
    const profile = { schema_version: 1, profile_id: 'managed-profile', l0_checks: [{ check_id: 'content', argv: ['node', '-e', 'process.exit(require("node:fs").readFileSync("result.txt","utf8").includes("verified artifact")?0:1)'], cwd_rel: '.', stage: 'both', timeout_ms: 10000, expected_exit_codes: [0] }], l1_review: [{ contract_item_id: 'content', lenses: ['functional'] }], protected_verifier_paths: [], allowed_validation_changes: [], runtime: { env_allowlist: ['PATH'], executable_paths: { node: process.execPath }, cache_policy: 'trusted_identity', network_policy: 'contract_authorized', max_log_bytes: 65536 }, human_gate: 'none' };
    profile.verification_profile_digest = verifierDigest(profile, 'verification_profile_digest');
    for (const [name, value] of Object.entries({ contract, profile, artifact })) writeFileSync(join(sandbox, `${name}.json`), JSON.stringify(value));
    const run = verifierMain(['init', '--contract', join(sandbox, 'contract.json'), '--profile', join(sandbox, 'profile.json'), '--artifact', join(sandbox, 'artifact.json'), '--workdir', workdir, '--state-root', join(sandbox, 'verify'), '--isolation-assurance', 'host_reported']);
    verifierMain(['run-smoke', '--run', run.run_dir]);
    const review = { schema_version: 1, review_result_id: 'managed-review', contract_digest: contract.contract_digest, verification_profile_digest: profile.verification_profile_digest, artifact_ref: artifact, challenge_nonce: run.review_challenge_nonce, verdict: 'no_defect_found', findings: [], forensics: ['读取冻结 worktree 中的 result.txt'] };
    review.review_result_digest = verifierDigest(review, 'review_result_digest');
    writeFileSync(join(sandbox, 'review.json'), JSON.stringify(review));
    verifierMain(['record-review', '--run', run.run_dir, '--review', join(sandbox, 'review.json'), '--verifier-run-id', 'managed-reviewer', '--isolation-assurance', 'host_reported']);
    assert.equal(verifierMain(['run-final', '--run', run.run_dir]).terminal.outcome, 'pass');
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test('多个真实 Loop 的稳定失败指纹由 orchestration batch ledger 连续熔断', () => {
  const value = fixture();
  try {
    const contractPath = join(value.sandbox, 'contract.json');
    const profilePath = join(value.sandbox, 'profile.json');
    const artifactPath = join(value.sandbox, 'artifact.json');
    const loopResults = [];
    for (let index = 1; index <= 3; index += 1) {
      const runId = `batch-verification-${index}`;
      const loop = loopMain(['init', '--contract', contractPath, '--profile', profilePath, '--provider', 'verify-agent-output', '--state-root', join(value.sandbox, 'batch-loop-state'), '--on-failure', 'stop']);
      loopMain(['record-artifact', '--loop', loop.loop_dir, '--artifact', artifactPath, '--verification-run-id', runId]);
      const evidence = { schema_version: 1, run_id: runId, protocol_version: 1, runtime_version: '1.0.0', contract_digest: value.contract.contract_digest, verification_profile_digest: value.profile.verification_profile_digest, artifact_ref: value.artifact, stages: { smoke_l0: { passed: false, checks: [{ check_id: 'content', passed: false }] }, l1_review: { status: 'not_run' }, final_l0: { status: 'not_run' } }, terminal_outcome: 'fail', completion_scope: 'verification_only', human_gate_required: false, provenance: { provider: 'verify-agent-output', verified_at: new Date().toISOString(), verifier_run_id: 'not_run', isolation_assurance: 'host_reported', limitations: ['l1_not_run'] } };
      evidence.evidence_digest = verifierDigest(evidence, 'evidence_digest');
      const evidencePath = join(value.sandbox, `batch-evidence-${index}.json`); writeFileSync(evidencePath, JSON.stringify(evidence));
      const stopped = loopMain(['record-evidence', '--loop', loop.loop_dir, '--evidence', evidencePath]);
      assert.equal(stopped.state, 'stopped');
      loopResults.push({ loop_id: stopped.loop_id, failure_key: stopped.iterations[0].failure_signature, result_ref: join(loop.loop_dir, stopped.convergence_report_ref.ref) });
    }
    assert.equal(new Set(loopResults.map((item) => item.failure_key)).size, 1);
    const ledger = ledgerMain(['init', '--contract', contractPath, '--state-root', join(value.sandbox, 'ledger-state')]);
    const batchInput = join(value.sandbox, 'batch.json');
    writeFileSync(batchInput, JSON.stringify({ batch_id: 'verification-batch', loop_ids: loopResults.map((item) => item.loop_id), limits: { max_failures: 4, consecutive_identical_signature: 3 } }));
    ledgerMain(['batch-init', '--ledger', ledger.ledger_dir, '--input', batchInput]);
    for (const [index, item] of loopResults.entries()) {
      const path = join(value.sandbox, `batch-record-${index}.json`); writeFileSync(path, JSON.stringify({ ...item, state: 'stopped' }));
      ledgerMain(['batch-record', '--ledger', ledger.ledger_dir, '--batch', 'verification-batch', '--input', path]);
    }
    const batch = ledgerMain(['batch-status', '--ledger', ledger.ledger_dir, '--batch', 'verification-batch']);
    assert.equal(batch.state, 'fused');
    assert.equal(batch.fuse.kind, 'identical_failure_fuse');
  } finally { value.cleanup(); }
});
