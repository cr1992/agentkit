import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { envelopeDigest, projectContract } from './contract-tool.mjs';
import { LedgerError, main, skillContentDigest } from './orchestration-ledger.mjs';

const LEDGER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'orchestration-ledger.mjs');

const SELF_CHECK = { requirement: 'worker_self_check', provider: 'none', artifact_scope: 'node_output' };
const CONTROLLER_RECHECK = { requirement: 'controller_recheck', provider: 'none', artifact_scope: 'node_output' };
const INDEPENDENT_EVIDENCE = { requirement: 'independent_evidence', provider: 'verify-agent-output', artifact_scope: 'integration_candidate' };
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function node(value, verification = SELF_CHECK) { return { ...value, verification }; }
function dispatch(workerId, overrides = {}) {
  return {
    schema_version: 2,
    worker_id: workerId,
    orchestration_mode: 'full',
    attempt_id: `attempt-${workerId}`,
    attempt: 1,
    previous_attempt_id: null,
    tier: 'primary',
    model: 'provider-primary-current',
    reasoning_effort: 'medium',
    adjustment_action: 'initial',
    failure_kind: null,
    failure_ref: null,
    selection_reason: '明确实现任务，使用已确认的常规执行配置',
    config_source: ['global:/config/hosts/test.json'],
    configuration_state: 'persisted-config',
    model_resolution_state: 'discovered-and-validated',
    capability_source: 'cache:/config/capabilities/test.json+live-validation',
    capability_fingerprint: `sha256:${'e'.repeat(64)}`,
    dispatch_provenance: 'explicit',
    token_budget: 'unsupported',
    max_attempts: 2,
    ...overrides,
  };
}
function artifactRef(overrides = {}) { return { schema_version: 1, provider: 'caller-supplied', repository_id: 'git:sha1:test', object_format: 'sha1', base_sha: SHA_A, artifact_sha: SHA_B, ...overrides }; }
function evidencePackage(contract, artifact, overrides = {}) {
  const evidence = {
    schema_version: 1,
    run_id: 'reviewer-run',
    protocol_version: 1,
    runtime_version: '1.1.0',
    contract_digest: contract.contract_digest,
    verification_profile_digest: `sha256:${'c'.repeat(64)}`,
    artifact_ref: artifact,
    stages: { smoke_l0: { passed: true }, l1_review: { verdict: 'pass' }, final_l0: { passed: true } },
    terminal_outcome: 'pass',
    completion_scope: 'verification_only',
    human_gate_required: false,
    provenance: { provider: 'verify-agent-output', verified_at: '2026-08-12T00:00:00.000Z', verifier_run_id: 'reviewer-run', isolation_assurance: 'host_reported', limitations: [] },
    ...overrides,
  };
  evidence.evidence_digest = envelopeDigest(evidence, 'evidence_digest');
  return evidence;
}

function makeFixture({ independent = false, acceptance = [{ contract_item_id: 'done', requirement: '必要节点均有稳定产物' }], extraFields = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  const skillSet = [{ name: 'orchestrate-subagents', version: '1.1.0', content_digest: skillContentDigest(), provider_mode: 'primary' }];
  if (independent) skillSet.push({ name: 'verify-agent-output', version: '1.1.0', content_digest: `sha256:${'d'.repeat(64)}`, provider_mode: 'optional' });
  const contract = { schema_version: 1, contract_id: 'ledger-contract', objective: '编排两个依赖节点', scope: { include: [], exclude: [] }, acceptance, permissions: { mode: 'read_only', writable_paths: [] }, environment: { repository: 'none', isolation: 'caller_supplied' }, skill_set: skillSet, stop_conditions: [], extensions: independent ? { verification: { provider: 'verify-agent-output' } } : {}, ...extraFields };
  contract.contract_digest = envelopeDigest(contract);
  const contractPath = join(root, 'contract.json'); writeFileSync(contractPath, JSON.stringify(contract));
  const input = (name, value) => { const path = join(root, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const initialized = main(['init', '--contract', contractPath, '--state-root', join(root, 'state'), '--ledger-id', 'ledger']);
  return { root, contract, input, ...initialized, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('任务图 barrier、派发回执、稳定产物和终态由 ledger 机械约束', () => {
  const f = makeFixture();
  try {
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('a.json', node({ node_id: 'a', objective: '先完成 A' }))]);
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('b.json', node({ node_id: 'b', objective: '再完成 B' }))]);
    main(['add-edge', '--ledger', f.ledger_dir, '--input', f.input('edge.json', { from: 'a', to: 'b', kind: 'barrier' })]);
    assert.throws(() => main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'b', '--input', f.input('dispatch-b-early.json', dispatch('b1'))]), /依赖/);
    main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'a', '--input', f.input('dispatch-a.json', dispatch('a1'))]);
    assert.throws(() => main(['update', '--ledger', f.ledger_dir, '--node', 'a', '--input', f.input('pass-a-early.json', { state: 'passed' })]), /稳定交付物/);
    main(['attach', '--ledger', f.ledger_dir, '--node', 'a', '--type', 'worktree', '--input', f.input('worktree.json', { worktree_id: 'wt-a' })]);
    assert.throws(() => main(['update', '--ledger', f.ledger_dir, '--node', 'a', '--input', f.input('pass-a-worktree-only.json', { state: 'passed' })]), /稳定交付物/);
    assert.throws(() => main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'b', '--input', f.input('dispatch-b-still-blocked.json', dispatch('b1'))]), /依赖/);
    main(['attach', '--ledger', f.ledger_dir, '--node', 'a', '--type', 'artifact', '--input', f.input('artifact.json', artifactRef())]);
    main(['update', '--ledger', f.ledger_dir, '--node', 'a', '--input', f.input('pass-a.json', { state: 'passed' })]);
    main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'b', '--input', f.input('dispatch-b.json', dispatch('b1'))]);
    main(['attach', '--ledger', f.ledger_dir, '--node', 'b', '--type', 'report', '--input', f.input('report.json', { report_id: 'report-b' })]);
    main(['update', '--ledger', f.ledger_dir, '--node', 'b', '--input', f.input('pass-b.json', { state: 'passed' })]);
    assert.equal(main(['status', '--ledger', f.ledger_dir]).summary.completion_ready, true);
    assert.equal(main(['doctor', '--ledger', f.ledger_dir]).healthy, true);
  } finally { f.cleanup(); }
});

test('派发记录必须完整绑定模型、强度、配置状态与能力证据', () => {
  const f = makeFixture();
  try {
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('node.json', node({ node_id: 'n', objective: 'audit dispatch' }))]);
    assert.throws(() => main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'n', '--input', f.input('minimal.json', { schema_version: 1, worker_id: 'w', model: 'provider-primary-current', reasoning_effort: 'medium' })]), /字段不完整/);
    assert.throws(() => main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'n', '--input', f.input('unknown.json', dispatch('w', { unexpected: true }))]), /未知字段/);
    assert.throws(() => main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'n', '--input', f.input('state.json', dispatch('w', { configuration_state: 'auto-guessed' }))]), /configuration_state/);
    assert.throws(() => main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'n', '--input', f.input('model-state.json', dispatch('w', { model_resolution_state: 'user-explicit-unverifiable' }))]), /用户当轮显式模型/);
    assert.throws(() => main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'n', '--input', f.input('host-default-state.json', dispatch('w', { model_resolution_state: 'host-default-unexposed' }))]), /宿主默认派发/);
    assert.throws(() => main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'n', '--input', f.input('fingerprint.json', dispatch('w', { capability_fingerprint: null }))]), /capability_fingerprint/);
    const recorded = main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'n', '--input', f.input('valid.json', dispatch('w', { configuration_state: 'session-confirmed', token_budget: 12000, max_attempts: 3 }))]);
    assert.equal(recorded.nodes.n.dispatch.model, 'provider-primary-current');
    assert.equal(recorded.nodes.n.dispatch.reasoning_effort, 'medium');
    assert.equal(recorded.nodes.n.dispatch.configuration_state, 'session-confirmed');
    assert.equal(main(['doctor', '--ledger', f.ledger_dir]).healthy, true);
  } finally { f.cleanup(); }
});

test('验收失败后的动态重派必须创建新节点并绑定前序失败证据', () => {
  const f = makeFixture();
  try {
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('attempt-1-node.json', node({ node_id: 'work.attempt-1', objective: '完成实现第一次尝试', required: false }))]);
    main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'work.attempt-1', '--input', f.input('attempt-1-dispatch.json', dispatch('worker-1', { attempt_id: 'work-attempt-1' }))]);
    const withFailure = main(['attach', '--ledger', f.ledger_dir, '--node', 'work.attempt-1', '--type', 'report', '--input', f.input('failure-report.json', { report_type: 'acceptance_failure', failure_kind: 'reasoning_gap', summary: '跨模块约束遗漏' })]);
    const failureRef = withFailure.attachments.at(-1).digest;
    main(['update', '--ledger', f.ledger_dir, '--node', 'work.attempt-1', '--input', f.input('attempt-1-failed.json', { state: 'failed', reason: '验收未通过' })]);

    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('attempt-2-node.json', node({ node_id: 'work.attempt-2', objective: '根据失败证据重新实现' }))]);
    const rerouted = dispatch('worker-2', {
      attempt_id: 'work-attempt-2', attempt: 2, previous_attempt_id: 'work-attempt-1',
      tier: 'frontier', model: 'provider-frontier-current', reasoning_effort: 'high',
      adjustment_action: 'promote_tier', failure_kind: 'reasoning_gap', failure_ref: failureRef,
      selection_reason: '验收证据显示跨模块推理缺口，提升到本地更高 tier',
    });
    const result = main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'work.attempt-2', '--input', f.input('attempt-2-dispatch.json', rerouted)]);
    assert.equal(result.nodes['work.attempt-2'].dispatch.previous_attempt_id, 'work-attempt-1');
    assert.equal(result.nodes['work.attempt-2'].dispatch.failure_ref, failureRef);

    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('bad-retry-node.json', node({ node_id: 'work.bad', objective: '错误重派', required: false }))]);
    assert.throws(() => main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'work.bad', '--input', f.input('bad-retry.json', { ...rerouted, attempt_id: 'work-attempt-bad', failure_ref: `sha256:${'f'.repeat(64)}` })]), /failure_ref/);
  } finally { f.cleanup(); }
});

test('批级连续相同失败由 orchestrator 熔断，单 Loop 不拥有批队列', () => {
  const f = makeFixture();
  try {
    main(['batch-init', '--ledger', f.ledger_dir, '--input', f.input('batch.json', { batch_id: 'batch', loop_ids: ['l1', 'l2', 'l3', 'l4'], limits: { max_failures: 4, consecutive_identical_signature: 3 } })]);
    for (const loop of ['l1', 'l2', 'l3']) main(['batch-record', '--ledger', f.ledger_dir, '--batch', 'batch', '--input', f.input(`${loop}.json`, { loop_id: loop, state: 'stopped', failure_key: 'sha256:same' })]);
    const batch = main(['batch-status', '--ledger', f.ledger_dir, '--batch', 'batch']);
    assert.equal(batch.state, 'fused');
    assert.equal(batch.fuse.kind, 'identical_failure_fuse');
    assert.throws(() => main(['batch-record', '--ledger', f.ledger_dir, '--batch', 'batch', '--input', f.input('l4.json', { loop_id: 'l4', state: 'completed' })]), /无效或重放/);
  } finally { f.cleanup(); }
});

test('journal 截断和 snapshot 丢失可重建，revision 冲突 fail closed', () => {
  const f = makeFixture();
  try {
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('node.json', node({ node_id: 'n', objective: 'recover' })), '--expected-revision', '0']);
    assert.throws(() => main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('stale.json', node({ node_id: 'stale', objective: 'stale' })), '--expected-revision', '0']), LedgerError);
    appendFileSync(join(f.ledger_dir, 'events.ndjson'), '{"partial":'); unlinkSync(join(f.ledger_dir, 'snapshot.json'));
    assert.equal(main(['status', '--ledger', f.ledger_dir]).recovery_needed, true);
    assert.equal(main(['rebuild', '--ledger', f.ledger_dir]).rebuilt, true);
    assert.equal(main(['doctor', '--ledger', f.ledger_dir]).healthy, true);
  } finally { f.cleanup(); }
});

test('跨节点 Reflection 与 Proposal 只追加，不改变节点状态', () => {
  const f = makeFixture();
  try {
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('node.json', node({ node_id: 'n', objective: 'reflect' }))]);
    const reflected = main(['record-reflection', '--ledger', f.ledger_dir, '--input', f.input('reflection.json', { classification: 'inefficiency', observation: '并行没有降低关键路径', impact: 'medium', recommended_disposition: 'continue' })]);
    const proposal = main(['propose-improvement', '--ledger', f.ledger_dir, '--reflection', reflected.reflection_refs[0].reflection_id, '--input', f.input('proposal.json', { problem_type: 'inefficiency', proposed_change: '缩小无效并行范围', affected_scope: ['routing'], validation_plan: { replay_cases: ['graph'], regression_suites: ['ledger'] } })]);
    assert.equal(proposal.nodes.n.state, 'pending');
    const value = JSON.parse(readFileSync(join(f.ledger_dir, proposal.improvement_proposal_refs[0].ref), 'utf8'));
    assert.equal(value.lifecycle, 'proposed');
    value.lifecycle = 'accepted';
    writeFileSync(join(f.ledger_dir, proposal.improvement_proposal_refs[0].ref), JSON.stringify(value));
    assert.equal(main(['doctor', '--ledger', f.ledger_dir]).findings.some((item) => item.startsWith('proposal_invalid:')), true);
  } finally { f.cleanup(); }
});

test('并发写同一 expected revision 时至多一个成功，journal 不分叉', async () => {
  const f = makeFixture();
  try {
    writeFileSync(join(f.ledger_dir, '.lock'), '{"pid":99999999,"acquired_at":"legacy-stale"}\n');
    const inputs = [f.input('concurrent-a.json', node({ node_id: 'a', objective: 'concurrent a' })), f.input('concurrent-b.json', node({ node_id: 'b', objective: 'concurrent b' }))];
    const run = (input) => new Promise((resolvePromise) => execFile(process.execPath, [LEDGER_SCRIPT, 'add-node', '--ledger', f.ledger_dir, '--input', input, '--expected-revision', '0'], { encoding: 'utf8' }, (error, stdout, stderr) => resolvePromise({ error, stdout, stderr })));
    const results = await Promise.all(inputs.map(run));
    assert.equal(results.filter((item) => !item.error).length, 1);
    const status = main(['status', '--ledger', f.ledger_dir]);
    assert.equal(status.revision, 1);
    assert.equal(Object.keys(status.nodes).length, 1);
    assert.equal(main(['doctor', '--ledger', f.ledger_dir]).healthy, true);
  } finally { f.cleanup(); }
});

test('node 权限、CLI typo、rebuild revision 与 journal 链均 fail closed', () => {
  const f = makeFixture();
  try {
    assert.throws(() => main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('escape.json', node({ node_id: 'escape', objective: 'escape', permissions: { mode: 'write', writable_paths: ['~/.ssh'] } }))]), /只读合同/);
    assert.throws(() => main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('typo.json', node({ node_id: 'typo', objective: 'typo' })), '--expected-revison', '0']), /未知选项/);
    assert.throws(() => main(['rebuild', '--ledger', f.ledger_dir, '--expected-revision', '1']), /revision conflict/);
    const snapshot = main(['status', '--ledger', f.ledger_dir]);
    const forged = { schema_version: 1, revision: 1, kind: 'forged', recorded_at: new Date().toISOString(), previous_event_digest: 'sha256:'.concat('0'.repeat(64)), snapshot: { ...snapshot, revision: 1 } };
    forged.event_digest = envelopeDigest(forged, 'event_digest');
    appendFileSync(join(f.ledger_dir, 'events.ndjson'), `${JSON.stringify(forged)}\n`);
    assert.throws(() => main(['doctor', '--ledger', f.ledger_dir]), /journal 链/);
  } finally { f.cleanup(); }
});

test('capabilities --json 保持统一能力发现兼容', () => {
  const output = execFileSync(process.execPath, [LEDGER_SCRIPT, 'capabilities', '--json'], { encoding: 'utf8' });
  const capabilities = JSON.parse(output);
  assert.equal(capabilities.skill, 'orchestrate-subagents');
  assert.equal(capabilities.protocol_version, '1.1.0');
  assert.equal(capabilities.runtime_version, '1.5.0');
  assert.ok(capabilities.features.includes('worker-capability-preflight'));
  assert.ok(capabilities.features.includes('lightweight-reflection'));
  assert.ok(capabilities.features.includes('evidence-bound-dynamic-reroute'));
});

test('dead owner 遗留的 ledger reclaim 子锁可自愈', () => {
  const f = makeFixture();
  try {
    writeFileSync(join(f.ledger_dir, '.lock'), '{"pid":99999999,"token":"dead-main"}\n');
    writeFileSync(join(f.ledger_dir, '.lock.reclaim'), '{"pid":99999998,"token":"dead-reclaimer"}\n');
    const result = main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('recovered.json', node({ node_id: 'recovered', objective: 'recover orphan reclaim' }))]);
    assert.equal(result.revision, 1);
  } finally { f.cleanup(); }
});

test('新节点必须显式声明验收档位，独立 Evidence 还必须在合同中冻结 provider', () => {
  const f = makeFixture();
  try {
    assert.throws(() => main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('missing.json', { node_id: 'missing', objective: 'missing policy' })]), /必须显式声明/);
    assert.throws(() => main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('undeclared.json', node({ node_id: 'undeclared', objective: 'undeclared provider' }, INDEPENDENT_EVIDENCE))]), /未声明 verify-agent-output/);
  } finally { f.cleanup(); }
});

test('controller_recheck 必须用复核记录完整绑定当前稳定输出', () => {
  const f = makeFixture();
  try {
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('node.json', node({ node_id: 'reviewed', objective: 'controller reviews output' }, CONTROLLER_RECHECK))]);
    main(['attach', '--ledger', f.ledger_dir, '--node', 'reviewed', '--type', 'artifact', '--input', f.input('artifact.json', artifactRef())]);
    assert.throws(() => main(['update', '--ledger', f.ledger_dir, '--node', 'reviewed', '--input', f.input('early.json', { state: 'passed' })]), /verification_ref/);
    const status = main(['status', '--ledger', f.ledger_dir]);
    const artifactDigest = status.nodes.reviewed.stable_outputs[0].digest;
    const report = { schema_version: 1, report_type: 'controller_recheck', contract_digest: f.contract.contract_digest, stable_output_digests: [artifactDigest], outcome: 'pass', checked_at: '2026-08-12T00:00:00.000Z' };
    const attached = main(['attach', '--ledger', f.ledger_dir, '--node', 'reviewed', '--type', 'report', '--input', f.input('controller-report.json', report)]);
    const reportDigest = attached.nodes.reviewed.stable_outputs.at(-1).digest;
    main(['attach', '--ledger', f.ledger_dir, '--node', 'reviewed', '--type', 'report', '--input', f.input('late-output.json', { report_id: 'new-output-after-review' })]);
    assert.throws(() => main(['update', '--ledger', f.ledger_dir, '--node', 'reviewed', '--input', f.input('stale-pass.json', { state: 'passed', verification_ref: reportDigest })]), /未覆盖当前稳定输出/);
    const refreshedStatus = main(['status', '--ledger', f.ledger_dir]);
    const refreshedReport = { ...report, stable_output_digests: refreshedStatus.nodes.reviewed.stable_outputs.filter((item) => item.digest !== reportDigest).map((item) => item.digest), checked_at: '2026-08-12T00:01:00.000Z' };
    const refreshed = main(['attach', '--ledger', f.ledger_dir, '--node', 'reviewed', '--type', 'report', '--input', f.input('refreshed-controller-report.json', refreshedReport)]);
    const refreshedDigest = refreshed.nodes.reviewed.stable_outputs.at(-1).digest;
    const passed = main(['update', '--ledger', f.ledger_dir, '--node', 'reviewed', '--input', f.input('pass.json', { state: 'passed', verification_ref: refreshedDigest })]);
    assert.equal(passed.nodes.reviewed.verification_assurance, 'controller_recheck');
    assert.equal(passed.nodes.reviewed.verification_ref, refreshedDigest);
    assert.equal(main(['status', '--ledger', f.ledger_dir]).summary.verification_assurance.controller_recheck, 1);
  } finally { f.cleanup(); }
});

test('independent_evidence 拒绝错绑、失败与 human gate，只接受同合同同 Artifact 的 pass Evidence', () => {
  const f = makeFixture({ independent: true });
  try {
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('node.json', node({ node_id: 'verified', objective: 'independently verify integration candidate' }, INDEPENDENT_EVIDENCE))]);
    const artifact = artifactRef();
    main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'artifact', '--input', f.input('artifact.json', artifact)]);
    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'artifact', '--input', f.input('artifact-drift.json', artifactRef({ artifact_sha: 'f'.repeat(40) }))]), /只能绑定一个/);
    const wrongArtifact = artifactRef({ artifact_sha: 'e'.repeat(40) });
    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'evidence', '--input', f.input('wrong-artifact.json', evidencePackage(f.contract, wrongArtifact))]), /Artifact binding/);
    const wrongContract = evidencePackage(f.contract, artifact, { contract_digest: `sha256:${'9'.repeat(64)}` });
    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'evidence', '--input', f.input('wrong-contract.json', wrongContract)]), /contract\/profile binding/);
    const wrongDigest = evidencePackage(f.contract, artifact);
    wrongDigest.evidence_digest = `sha256:${'0'.repeat(64)}`;
    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'evidence', '--input', f.input('wrong-digest.json', wrongDigest)]), /digest 无效/);
    const failed = evidencePackage(f.contract, artifact, { terminal_outcome: 'fail' });
    const failedAttached = main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'evidence', '--input', f.input('failed.json', failed)]);
    const failedRef = failedAttached.nodes.verified.evidence.at(-1).digest;
    assert.throws(() => main(['update', '--ledger', f.ledger_dir, '--node', 'verified', '--input', f.input('fail-pass.json', { state: 'passed', verification_ref: failedRef })]), /terminal_outcome=fail/);
    const gated = evidencePackage(f.contract, artifact, { run_id: 'gated-run', human_gate_required: true, provenance: { provider: 'verify-agent-output', verified_at: '2026-08-12T00:01:00.000Z', verifier_run_id: 'gated-run', isolation_assurance: 'host_reported', limitations: [] } });
    const gatedAttached = main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'evidence', '--input', f.input('gated.json', gated)]);
    const gatedRef = gatedAttached.nodes.verified.evidence.at(-1).digest;
    assert.throws(() => main(['update', '--ledger', f.ledger_dir, '--node', 'verified', '--input', f.input('gated-pass.json', { state: 'passed', verification_ref: gatedRef })]), /human gate/);
    const passedEvidence = evidencePackage(f.contract, artifact);
    const passedAttached = main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'evidence', '--input', f.input('passed.json', passedEvidence)]);
    const passedRef = passedAttached.nodes.verified.evidence.at(-1).digest;
    const artifactDigest = passedAttached.nodes.verified.stable_outputs.find((item) => item.type === 'artifact').digest;
    assert.throws(() => main(['update', '--ledger', f.ledger_dir, '--node', 'verified', '--input', f.input('wrong-ref-pass.json', { state: 'passed', verification_ref: artifactDigest })]), /未指向 Evidence/);
    const passed = main(['update', '--ledger', f.ledger_dir, '--node', 'verified', '--input', f.input('pass.json', { state: 'passed', verification_ref: passedRef })]);
    assert.equal(passed.nodes.verified.verification_assurance, 'independent_evidence');
    assert.equal(passed.nodes.verified.verification_ref, passedRef);
    assert.equal(main(['status', '--ledger', f.ledger_dir]).summary.verification_assurance.independent_evidence, 1);
    assert.equal(main(['doctor', '--ledger', f.ledger_dir]).healthy, true);
    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'report', '--input', f.input('late.json', { report_id: 'late' })]), /终态 node/);
  } finally { f.cleanup(); }
});

function resign(contract) { const value = structuredClone(contract); delete value.contract_digest; value.contract_digest = envelopeDigest(value); return value; }

test('投影合同以血缘 + 条目子集替代全等，反张冠李戴保证不削弱', () => {
  const acceptance = [
    { contract_item_id: 'alpha', requirement: 'alpha 产物门禁全绿' },
    { contract_item_id: 'beta', requirement: 'beta 产物门禁全绿' },
    { contract_item_id: 'gamma', requirement: 'gamma 产物门禁全绿' },
  ];
  const f = makeFixture({ independent: true, acceptance });
  try {
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('node.json', node({ node_id: 'verified', objective: '独立验收 alpha/beta 产物' }, INDEPENDENT_EVIDENCE))]);
    const projected = projectContract(f.contract, ['alpha', 'beta']);

    // ① 私造合同：血缘指向别的任务
    const forgedParent = structuredClone(projected);
    forgedParent.extensions.projection.parent_contract_digest = `sha256:${'9'.repeat(64)}`;
    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'contract', '--input', f.input('forged-parent.json', resign(forgedParent))]), /parent_contract_digest 与 ledger 公共合同不一致/u);

    // ② 条目措辞被改写
    const tampered = structuredClone(projected);
    tampered.acceptance[0].requirement = 'alpha 产物能跑起来即可';
    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'contract', '--input', f.input('tampered-item.json', resign(tampered))]), /acceptance 条目不属于公共合同: alpha/u);

    // ③ 夹带公共合同里没有的条目
    const smuggled = structuredClone(projected);
    smuggled.acceptance.push({ contract_item_id: 'delta', requirement: '自造的宽松条目' });
    smuggled.extensions.projection.projected_item_ids = ['alpha', 'beta', 'delta'];
    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'contract', '--input', f.input('smuggled.json', resign(smuggled))]), /acceptance 条目不属于公共合同: delta/u);

    // ④ 声明的 projected_item_ids 与实际 acceptance 不一致
    const mismatched = structuredClone(projected);
    mismatched.extensions.projection.projected_item_ids = ['alpha'];
    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'contract', '--input', f.input('mismatched.json', resign(mismatched))]), /id 集合与 projected_item_ids 不一致/u);

    // 摘要不自洽的子合同同样拒收
    const unsigned = structuredClone(projected);
    unsigned.contract_digest = `sha256:${'0'.repeat(64)}`;
    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'contract', '--input', f.input('unsigned.json', unsigned)]), /投影合同结构无效/u);

    main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'contract', '--input', f.input('projected.json', projected)]);

    // ⑤ 第二份投影合同
    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'contract', '--input', f.input('second.json', projectContract(f.contract, ['gamma']))]), /至多绑定一份投影合同/u);

    const artifact = artifactRef();
    main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'artifact', '--input', f.input('artifact.json', artifact)]);

    // ⑥ Evidence 绑定的既不是公共合同也不是这份投影合同
    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'evidence', '--input', f.input('wrong-contract.json', evidencePackage(f.contract, artifact, { contract_digest: `sha256:${'9'.repeat(64)}` }))]), /contract\/profile binding/u);

    // ⑦ 全等（legacy）路径在投影登记后依然合法
    main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'evidence', '--input', f.input('legacy-evidence.json', evidencePackage(f.contract, artifact, { run_id: 'legacy-run' }))]);

    const evidence = evidencePackage(projected, artifact, { run_id: 'projected-run' });
    assert.equal(evidence.contract_digest, projected.contract_digest);
    const attached = main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'evidence', '--input', f.input('projected-evidence.json', evidence)]);
    const evidenceRef = attached.nodes.verified.evidence.at(-1).digest;
    const passed = main(['update', '--ledger', f.ledger_dir, '--node', 'verified', '--input', f.input('pass.json', { state: 'passed', verification_ref: evidenceRef })]);
    assert.equal(passed.nodes.verified.verification_assurance, 'independent_evidence');
    assert.equal(main(['status', '--ledger', f.ledger_dir]).summary.verification_assurance.independent_evidence, 1);
    assert.equal(main(['doctor', '--ledger', f.ledger_dir]).healthy, true);

    // doctor 对 passed 节点复跑投影门禁：公共合同被抽走 beta 条目后立刻现形
    const shrunk = resign({ ...f.contract, acceptance: acceptance.filter((item) => item.contract_item_id !== 'beta') });
    writeFileSync(join(f.ledger_dir, 'contract.json'), JSON.stringify(shrunk));
    const doctored = main(['doctor', '--ledger', f.ledger_dir]);
    assert.equal(doctored.healthy, false);
    assert.deepEqual(doctored.findings, ['verification_gate_invalid:verified']);
  } finally { f.cleanup(); }
});

test('被换掉的 contract.json 不能给投影合同背书：条目集合与快照摘要先互锁', () => {
  const acceptance = [{ contract_item_id: 'alpha', requirement: 'alpha 产物门禁全绿' }];
  const f = makeFixture({ independent: true, acceptance });
  try {
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('node.json', node({ node_id: 'verified', objective: '独立验收 alpha 产物' }, INDEPENDENT_EVIDENCE))]);

    // 投影仍声明原血缘（parent_contract_digest = 快照摘要），但夹带一条私货
    const smuggled = structuredClone(projectContract(f.contract, ['alpha']));
    const extra = { contract_item_id: 'delta', requirement: '自造的宽松条目' };
    smuggled.acceptance.push(extra);
    smuggled.extensions.projection.projected_item_ids = ['alpha', 'delta'];
    const forgedProjection = resign(smuggled);
    assert.equal(forgedProjection.extensions.projection.parent_contract_digest, f.contract.contract_digest);

    // 把私货条目补进 contract.json 并重签文件内摘要，快照 contract_digest 保持不动
    const polluted = resign({ ...f.contract, acceptance: [...acceptance, extra] });
    writeFileSync(join(f.ledger_dir, 'contract.json'), JSON.stringify(polluted));
    assert.notEqual(polluted.contract_digest, main(['status', '--ledger', f.ledger_dir]).contract_digest);

    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'contract', '--input', f.input('forged-projection.json', forgedProjection)]), /ledger contract\.json 与快照合同摘要不一致/u);

    // 还原 contract.json 后，同一份投影改由条目子集校验拦下
    writeFileSync(join(f.ledger_dir, 'contract.json'), JSON.stringify(f.contract));
    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'contract', '--input', f.input('forged-projection-2.json', forgedProjection)]), /acceptance 条目不属于公共合同: delta/u);
  } finally { f.cleanup(); }
});

test('投影只放行 contract_id / acceptance 子集 / projection 三项，其余字段逐字段钉死', () => {
  const f = makeFixture({ independent: true });
  const attachContract = (name, value) => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'contract', '--input', f.input(name, value)]);
  try {
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('node.json', node({ node_id: 'verified', objective: '独立验收冻结产物' }, INDEPENDENT_EVIDENCE))]);
    const projected = projectContract(f.contract, ['done'], { contractId: 'node-scoped' });

    assert.throws(() => attachContract('objective.json', resign({ ...projected, objective: '把 README 错别字改掉' })), /投影合同字段 objective 必须与公共合同逐字节相同/u);
    assert.throws(() => attachContract('scope.json', resign({ ...projected, scope: { include: ['README.md'], exclude: ['src/**'] } })), /投影合同字段 scope 必须与公共合同逐字节相同/u);
    assert.throws(() => attachContract('permissions.json', resign({ ...projected, permissions: { mode: 'write', writable_paths: ['/', '../../etc'] } })), /投影合同字段 permissions 必须与公共合同逐字节相同/u);
    assert.throws(() => attachContract('environment.json', resign({ ...projected, environment: { repository: '/other/repo', isolation: 'shared_tree' } })), /投影合同字段 environment 必须与公共合同逐字节相同/u);
    assert.throws(() => attachContract('skill-set.json', resign({ ...projected, skill_set: [] })), /投影合同字段 skill_set 必须与公共合同逐字节相同/u);
    assert.throws(() => attachContract('stop.json', resign({ ...projected, stop_conditions: ['随时可以停'] })), /投影合同字段 stop_conditions 必须与公共合同逐字节相同/u);

    // extensions 里除 projection 外的键同样不能改（这里把已冻结的 verifier provider 摘掉）
    const strippedVerification = resign({ ...projected, extensions: { projection: structuredClone(projected.extensions.projection) } });
    assert.throws(() => attachContract('extensions.json', strippedVerification), /extensions 除 projection 外必须与公共合同逐字节相同/u);

    // repro 场景回归：一次性改掉 contract_id/objective/scope/permissions/environment/stop_conditions
    const repro = resign({ ...structuredClone(projected), contract_id: 'unrelated-task', objective: '把 README 错别字改掉', scope: { include: ['README.md'], exclude: ['src/**'] }, permissions: { mode: 'write', writable_paths: ['/', '../../etc'] }, environment: { repository: '/other/repo', isolation: 'shared_tree' }, stop_conditions: [] });
    assert.throws(() => attachContract('repro.json', repro), /投影合同字段 environment 必须与公共合同逐字节相同/u);

    // 换 contract_id 是被放行的身份改动；合法投影仍走得通，此前的拒收没有留下任何 attachment
    const good = attachContract('good.json', projected);
    const stored = good.attachments.filter((item) => item.type === 'contract');
    assert.equal(stored.length, 1);
    assert.equal(JSON.parse(readFileSync(join(f.ledger_dir, stored[0].ref), 'utf8')).contract_id, 'node-scoped');
    assert.notEqual(f.contract.contract_id, 'node-scoped');
  } finally { f.cleanup(); }
});

test('parent 的额外顶层字段被投影继承，并原样走完独立验收链路', () => {
  const extraFields = { owner_team: 'moii-app', custom_budget: { max_rounds: 3 } };
  const f = makeFixture({ independent: true, extraFields });
  try {
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('node.json', node({ node_id: 'verified', objective: '独立验收冻结产物' }, INDEPENDENT_EVIDENCE))]);
    const projected = projectContract(f.contract, ['done']);
    assert.equal(projected.owner_team, 'moii-app');
    assert.deepEqual(projected.custom_budget, extraFields.custom_budget);

    // 丢掉 parent 的额外字段同样算改写，逐字段拦下
    const dropped = structuredClone(projected); delete dropped.owner_team;
    assert.throws(() => main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'contract', '--input', f.input('dropped.json', resign(dropped))]), /投影合同字段 owner_team 必须与公共合同逐字节相同/u);

    main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'contract', '--input', f.input('projected.json', projected)]);
    const artifact = artifactRef();
    main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'artifact', '--input', f.input('artifact.json', artifact)]);
    const attached = main(['attach', '--ledger', f.ledger_dir, '--node', 'verified', '--type', 'evidence', '--input', f.input('evidence.json', evidencePackage(projected, artifact))]);
    const passed = main(['update', '--ledger', f.ledger_dir, '--node', 'verified', '--input', f.input('pass.json', { state: 'passed', verification_ref: attached.nodes.verified.evidence.at(-1).digest })]);
    assert.equal(passed.nodes.verified.verification_assurance, 'independent_evidence');
    assert.equal(main(['doctor', '--ledger', f.ledger_dir]).healthy, true);
  } finally { f.cleanup(); }
});

test("Token accounting tracks per-node usage and status aggregates summary", () => {
  const f = makeFixture();
  try {
    main(["add-node", "--ledger", f.ledger_dir, "--input", f.input("n1.json", node({ node_id: "n1", role: "scout", objective: "探索目录" }))]);
    main(["add-node", "--ledger", f.ledger_dir, "--input", f.input("n2.json", node({ node_id: "n2", role: "worker", objective: "实现功能" }))]);
    main(["dispatch-record", "--ledger", f.ledger_dir, "--node", "n1", "--input", f.input("d1.json", dispatch("w1"))]);
    main(["dispatch-record", "--ledger", f.ledger_dir, "--node", "n2", "--input", f.input("d2.json", dispatch("w2"))]);
    main(["attach", "--ledger", f.ledger_dir, "--node", "n1", "--type", "artifact", "--input", f.input("a1.json", artifactRef())]);
    main(["attach", "--ledger", f.ledger_dir, "--node", "n2", "--type", "artifact", "--input", f.input("a2.json", artifactRef())]);

    main(["update", "--ledger", f.ledger_dir, "--node", "n1", "--input", f.input("u1.json", { state: "passed", tokens: { input_tokens: 500, output_tokens: 1000, total_tokens: 1500 }, duration_ms: 1200 })]);
    main(["update", "--ledger", f.ledger_dir, "--node", "n2", "--input", f.input("u2.json", { state: "passed", tokens: 4200, duration_ms: 3500 })]);

    const status = main(["status", "--ledger", f.ledger_dir]);
    assert.equal(status.summary.token_accounting.total_tokens, 5700);
    assert.equal(status.summary.token_accounting.by_role.scout, 1500);
    assert.equal(status.summary.token_accounting.by_role.worker, 4200);
    assert.equal(status.nodes.n1.tokens.total_tokens, 1500);
    assert.equal(status.nodes.n1.duration_ms, 1200);
    assert.equal(status.nodes.n2.tokens, 4200);
    assert.equal(main(["doctor", "--ledger", f.ledger_dir]).healthy, true);
  } finally { f.cleanup(); }
});

test("Token and duration input validation rejects strings, negatives, invalid totals and unknown keys", () => {
  const f = makeFixture();
  try {
    main(["add-node", "--ledger", f.ledger_dir, "--input", f.input("n.json", node({ node_id: "n", role: "worker", objective: "测试校验" }))]);
    main(["dispatch-record", "--ledger", f.ledger_dir, "--node", "n", "--input", f.input("d.json", dispatch("w"))]);
    main(["attach", "--ledger", f.ledger_dir, "--node", "n", "--type", "artifact", "--input", f.input("a.json", artifactRef())]);

    // String tokens
    assert.throws(() => main(["update", "--ledger", f.ledger_dir, "--node", "n", "--input", f.input("bad1.json", { state: "passed", tokens: { input_tokens: 40, output_tokens: 60, total_tokens: "100" } })]), /必须为非负安全整数/);
    assert.throws(() => main(["update", "--ledger", f.ledger_dir, "--node", "n", "--input", f.input("bad2.json", { state: "passed", tokens: "100" })]), /必须为非负安全整数/);

    // Negative tokens or duration
    assert.throws(() => main(["update", "--ledger", f.ledger_dir, "--node", "n", "--input", f.input("bad3.json", { state: "passed", tokens: -50 })]), /必须为非负安全整数/);
    assert.throws(() => main(["update", "--ledger", f.ledger_dir, "--node", "n", "--input", f.input("bad4.json", { state: "passed", duration_ms: -100 })]), /duration_ms 必须为非负安全整数/);
    assert.throws(() => main(["update", "--ledger", f.ledger_dir, "--node", "n", "--input", f.input("bad5.json", { state: "passed", duration_ms: "1.5s" })]), /duration_ms 必须为非负安全整数/);

    // Total mismatch: input (100) + output (200) != total (500)
    assert.throws(() => main(["update", "--ledger", f.ledger_dir, "--node", "n", "--input", f.input("bad6.json", { state: "passed", tokens: { input_tokens: 100, output_tokens: 200, total_tokens: 500 } })]), /total_tokens 必须等于 input_tokens \+ output_tokens/);

    // Unknown keys in tokens
    assert.throws(() => main(["update", "--ledger", f.ledger_dir, "--node", "n", "--input", f.input("bad7.json", { state: "passed", tokens: { input_tokens: 40, output_tokens: 60, total_tokens: 100, cached_tokens: 50 } })]), /必须且只能包含/);

    // Partial objects would otherwise be accepted but contribute zero to status.
    assert.throws(() => main(["update", "--ledger", f.ledger_dir, "--node", "n", "--input", f.input("bad8.json", { state: "passed", tokens: { input_tokens: 100 } })]), /必须且只能包含/);
  } finally { f.cleanup(); }
});
