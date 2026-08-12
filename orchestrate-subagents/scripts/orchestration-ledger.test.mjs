import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { envelopeDigest } from './contract-tool.mjs';
import { LedgerError, main, skillContentDigest } from './orchestration-ledger.mjs';

const LEDGER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'orchestration-ledger.mjs');

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  const contract = { schema_version: 1, contract_id: 'ledger-contract', objective: '编排两个依赖节点', scope: { include: [], exclude: [] }, acceptance: [{ contract_item_id: 'done', requirement: '必要节点均有稳定产物' }], permissions: { mode: 'read_only', writable_paths: [] }, environment: { repository: 'none', isolation: 'caller_supplied' }, skill_set: [{ name: 'orchestrate-subagents', version: '1.0.0', content_digest: skillContentDigest(), provider_mode: 'primary' }], stop_conditions: [], extensions: {} };
  contract.contract_digest = envelopeDigest(contract);
  const contractPath = join(root, 'contract.json'); writeFileSync(contractPath, JSON.stringify(contract));
  const input = (name, value) => { const path = join(root, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const initialized = main(['init', '--contract', contractPath, '--state-root', join(root, 'state'), '--ledger-id', 'ledger']);
  return { root, contract, input, ...initialized, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('任务图 barrier、派发回执、稳定产物和终态由 ledger 机械约束', () => {
  const f = makeFixture();
  try {
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('a.json', { node_id: 'a', objective: '先完成 A' })]);
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('b.json', { node_id: 'b', objective: '再完成 B' })]);
    main(['add-edge', '--ledger', f.ledger_dir, '--input', f.input('edge.json', { from: 'a', to: 'b', kind: 'barrier' })]);
    assert.throws(() => main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'b', '--input', f.input('dispatch-b-early.json', { worker_id: 'b1', model: 'inherited', reasoning_effort: 'inherited' })]), /依赖/);
    main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'a', '--input', f.input('dispatch-a.json', { worker_id: 'a1', model: 'inherited', reasoning_effort: 'inherited' })]);
    assert.throws(() => main(['update', '--ledger', f.ledger_dir, '--node', 'a', '--input', f.input('pass-a-early.json', { state: 'passed' })]), /稳定交付物/);
    main(['attach', '--ledger', f.ledger_dir, '--node', 'a', '--type', 'worktree', '--input', f.input('worktree.json', { worktree_id: 'wt-a' })]);
    assert.throws(() => main(['update', '--ledger', f.ledger_dir, '--node', 'a', '--input', f.input('pass-a-worktree-only.json', { state: 'passed' })]), /稳定交付物/);
    assert.throws(() => main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'b', '--input', f.input('dispatch-b-still-blocked.json', { worker_id: 'b1', model: 'inherited', reasoning_effort: 'inherited' })]), /依赖/);
    main(['attach', '--ledger', f.ledger_dir, '--node', 'a', '--type', 'artifact', '--input', f.input('artifact.json', { artifact_sha: 'abc', digest: 'stable' })]);
    main(['update', '--ledger', f.ledger_dir, '--node', 'a', '--input', f.input('pass-a.json', { state: 'passed' })]);
    main(['dispatch-record', '--ledger', f.ledger_dir, '--node', 'b', '--input', f.input('dispatch-b.json', { worker_id: 'b1', model: 'inherited', reasoning_effort: 'inherited' })]);
    main(['attach', '--ledger', f.ledger_dir, '--node', 'b', '--type', 'report', '--input', f.input('report.json', { report_id: 'report-b' })]);
    main(['update', '--ledger', f.ledger_dir, '--node', 'b', '--input', f.input('pass-b.json', { state: 'passed' })]);
    assert.equal(main(['status', '--ledger', f.ledger_dir]).summary.completion_ready, true);
    assert.equal(main(['doctor', '--ledger', f.ledger_dir]).healthy, true);
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
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('node.json', { node_id: 'n', objective: 'recover' }), '--expected-revision', '0']);
    assert.throws(() => main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('stale.json', { node_id: 'stale', objective: 'stale' }), '--expected-revision', '0']), LedgerError);
    appendFileSync(join(f.ledger_dir, 'events.ndjson'), '{"partial":'); unlinkSync(join(f.ledger_dir, 'snapshot.json'));
    assert.equal(main(['status', '--ledger', f.ledger_dir]).recovery_needed, true);
    assert.equal(main(['rebuild', '--ledger', f.ledger_dir]).rebuilt, true);
    assert.equal(main(['doctor', '--ledger', f.ledger_dir]).healthy, true);
  } finally { f.cleanup(); }
});

test('跨节点 Reflection 与 Proposal 只追加，不改变节点状态', () => {
  const f = makeFixture();
  try {
    main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('node.json', { node_id: 'n', objective: 'reflect' })]);
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
    const inputs = [f.input('concurrent-a.json', { node_id: 'a', objective: 'concurrent a' }), f.input('concurrent-b.json', { node_id: 'b', objective: 'concurrent b' })];
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
    assert.throws(() => main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('escape.json', { node_id: 'escape', objective: 'escape', permissions: { mode: 'write', writable_paths: ['~/.ssh'] } })]), /只读合同/);
    assert.throws(() => main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('typo.json', { node_id: 'typo', objective: 'typo' }), '--expected-revison', '0']), /未知选项/);
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
  assert.equal(JSON.parse(output).skill, 'orchestrate-subagents');
});

test('dead owner 遗留的 ledger reclaim 子锁可自愈', () => {
  const f = makeFixture();
  try {
    writeFileSync(join(f.ledger_dir, '.lock'), '{"pid":99999999,"token":"dead-main"}\n');
    writeFileSync(join(f.ledger_dir, '.lock.reclaim'), '{"pid":99999998,"token":"dead-reclaimer"}\n');
    const result = main(['add-node', '--ledger', f.ledger_dir, '--input', f.input('recovered.json', { node_id: 'recovered', objective: 'recover orphan reclaim' })]);
    assert.equal(result.revision, 1);
  } finally { f.cleanup(); }
});
