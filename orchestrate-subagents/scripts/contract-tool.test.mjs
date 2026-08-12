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
