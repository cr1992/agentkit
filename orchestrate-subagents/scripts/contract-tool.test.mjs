import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ContractError, contractDiff, envelopeDigest, main, parseJsonStrict } from './contract-tool.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'contract-tool-test-'));
  const value = { schema_version: 1, contract_id: 'contract', objective: '完成可验收任务', scope: { include: ['src/'], exclude: [] }, acceptance: [{ contract_item_id: 'tests', requirement: '测试通过' }], permissions: { mode: 'write', writable_paths: ['src/'] }, environment: { repository: 'none', isolation: 'caller_supplied' }, skill_set: [{ name: 'orchestrate-subagents', version: '1.0.0', content_digest: `sha256:${'1'.repeat(64)}`, provider_mode: 'primary' }], stop_conditions: [], extensions: {} };
  const path = join(root, 'contract.json'); writeFileSync(path, JSON.stringify(value));
  return { root, value, path, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('normalize/validate/digest/review-view 共享同一 canonical contract', () => {
  const f = fixture();
  try {
    const normalized = main(['normalize', '--input', f.path]);
    writeFileSync(f.path, JSON.stringify(normalized));
    assert.equal(main(['validate', '--input', f.path]).valid, true);
    assert.equal(main(['digest', '--input', f.path]).contract_digest, normalized.contract_digest);
    const view = main(['review-view', '--input', f.path]);
    assert.equal(view.reviewer_permissions.mode, 'read_only');
    assert.equal(canonicalize(view.contract_permissions), canonicalize(normalized.permissions));
    assert.equal('extensions' in view, false);
  } finally { f.cleanup(); }
});

function canonicalize(value) { return JSON.stringify(value, Object.keys(value).sort()); }

test('strict parser 拒绝 duplicate key，diff 识别必须重签', () => {
  assert.throws(() => parseJsonStrict('{"a":1,"a":2}'), ContractError);
  const left = { objective: 'a', contract_digest: 'old' };
  const right = { objective: 'b', contract_digest: 'new' };
  assert.equal(contractDiff(left, right).requires_resign, true);
  assert.notEqual(envelopeDigest(left), envelopeDigest(right));
});

test('project 从父合同 verbatim 切出条目子集，并写入可校验血缘', () => {
  const f = fixture();
  try {
    f.value.acceptance = [{ contract_item_id: 'a', requirement: 'A 通过' }, { contract_item_id: 'b', requirement: 'B 通过' }, { contract_item_id: 'c', requirement: 'C 通过' }];
    writeFileSync(f.path, JSON.stringify(f.value));
    const parent = main(['normalize', '--input', f.path]);
    writeFileSync(f.path, JSON.stringify(parent));

    const projected = main(['project', '--input', f.path, '--items', 'a,c']);
    assert.deepEqual(projected.acceptance, [parent.acceptance[0], parent.acceptance[2]]);
    assert.equal(projected.extensions.projection.parent_contract_digest, parent.contract_digest);
    assert.deepEqual(projected.extensions.projection.projected_item_ids, ['a', 'c']);
    assert.notEqual(projected.contract_digest, parent.contract_digest);
    assert.equal(projected.contract_digest, envelopeDigest(projected));
    assert.match(projected.contract_id, /^contract--proj-[0-9a-f]{8}$/u);
    for (const field of ['objective', 'scope', 'permissions', 'environment', 'skill_set', 'stop_conditions']) assert.deepEqual(projected[field], parent[field]);

    // parent 的额外顶层字段原样继承，不被静默丢弃
    const withExtra = { ...parent, owner_team: 'moii-app', custom_budget: { max_rounds: 3 } };
    const extraPath = join(f.root, 'with-extra.json'); writeFileSync(extraPath, JSON.stringify(withExtra));
    const signedExtra = main(['normalize', '--input', extraPath]); writeFileSync(extraPath, JSON.stringify(signedExtra));
    const projectedExtra = main(['project', '--input', extraPath, '--items', 'b']);
    assert.equal(projectedExtra.owner_team, 'moii-app');
    assert.deepEqual(projectedExtra.custom_budget, { max_rounds: 3 });

    const projectedPath = join(f.root, 'projected.json');
    writeFileSync(projectedPath, JSON.stringify(projected));
    assert.equal(main(['validate', '--input', projectedPath]).valid, true);
    assert.equal(main(['project', '--input', f.path, '--items', 'b', '--contract-id', 'node-b']).contract_id, 'node-b');

    assert.throws(() => main(['project', '--input', f.path, '--items', 'a,zzz']), /不在 parent acceptance 中: zzz/u);
    assert.throws(() => main(['project', '--input', f.path, '--items', '']), /items 不能为空/u);
    assert.throws(() => main(['project', '--input', f.path]), /items 不能为空/u);
    assert.throws(() => main(['project', '--input', f.path, '--items', 'a,a']), /items 重复/u);

    const unsigned = { ...parent }; delete unsigned.contract_digest;
    const unsignedPath = join(f.root, 'unsigned.json'); writeFileSync(unsignedPath, JSON.stringify(unsigned));
    assert.throws(() => main(['project', '--input', unsignedPath, '--items', 'a']), /contract_digest 无效/u);
    const drifted = { ...parent, objective: '被改写的父合同目标' };
    const driftedPath = join(f.root, 'drifted.json'); writeFileSync(driftedPath, JSON.stringify(drifted));
    assert.throws(() => main(['project', '--input', driftedPath, '--items', 'a']), /contract_digest 无效/u);
  } finally { f.cleanup(); }
});

test('verification extension 只接受已知 provider', () => {
  const f = fixture();
  try {
    f.value.extensions = { verification: { provider: 'verify-agent-output' } };
    writeFileSync(f.path, JSON.stringify(f.value));
    assert.equal(main(['normalize', '--input', f.path]).extensions.verification.provider, 'verify-agent-output');
    f.value.extensions.verification.provider = 'local';
    writeFileSync(f.path, JSON.stringify(f.value));
    assert.throws(() => main(['normalize', '--input', f.path]), /extensions\.verification/);
  } finally { f.cleanup(); }
});
