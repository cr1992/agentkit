import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ReviewBudgetError, evaluateReviewBudget } from './review-budget.mjs';

const ARTIFACT = `sha256:${'a'.repeat(64)}`;
const POLICY = {
  schema_version: 1,
  max_primary_reviews_per_artifact: 1,
  max_escalation_reviews_per_artifact: 1,
  require_distinct_lens: true,
  review_only_after_smoke_pass: true,
  max_review_input_tokens: 12_000,
};
const request = (overrides = {}) => ({
  schema_version: 1,
  artifact_digest: ARTIFACT,
  lens: 'protocol_semantics',
  kind: 'primary',
  decision_impact: '可能改变 direct response lifecycle 是否可接受的裁决',
  smoke_passed: true,
  estimated_input_tokens: 4_000,
  escalation_trigger: null,
  ...overrides,
});
const review = (overrides = {}) => ({
  review_id: 'review-1',
  artifact_digest: ARTIFACT,
  lens: 'protocol_semantics',
  kind: 'primary',
  outcome: 'undecidable',
  ...overrides,
});

test('同一 Artifact 默认只允许一次 primary review，并拒绝重复 lens', () => {
  assert.equal(evaluateReviewBudget(POLICY, [], request()).code, 'ALLOWED_PRIMARY');
  assert.equal(evaluateReviewBudget(POLICY, [review({ outcome: 'pass' })], request({ lens: 'runtime_safety' })).code, 'PRIMARY_REVIEW_LIMIT');
  assert.equal(evaluateReviewBudget(POLICY, [review()], request()).code, 'DUPLICATE_REVIEW_LENS');
});

test('第二 reviewer 必须是有证据触发的不同 lens escalation，第三个被预算拒绝', () => {
  const first = review();
  const escalation = request({ lens: 'verification_definition', kind: 'escalation', escalation_trigger: 'undecidable' });
  assert.equal(evaluateReviewBudget(POLICY, [first], escalation).code, 'ALLOWED_ESCALATION');
  const history = [first, review({ review_id: 'review-2', lens: 'verification_definition', kind: 'escalation', outcome: 'pass' })];
  assert.equal(evaluateReviewBudget(POLICY, history, request({ lens: 'runtime_safety', kind: 'escalation', escalation_trigger: 'protocol_ambiguity' })).code, 'ESCALATION_REVIEW_LIMIT');
  assert.equal(evaluateReviewBudget(POLICY, [review({ outcome: 'fail' })], escalation).code, 'UNDECIDABLE_EVIDENCE_MISSING');
});

test('smoke、输入 token 与 safety 都是 reviewer 派发前的硬门禁', () => {
  assert.equal(evaluateReviewBudget(POLICY, [], request({ smoke_passed: false })).code, 'SMOKE_REQUIRED');
  assert.equal(evaluateReviewBudget(POLICY, [], request({ estimated_input_tokens: 12_001 })).code, 'REVIEW_INPUT_BUDGET_EXCEEDED');
  assert.equal(evaluateReviewBudget(POLICY, [review({ outcome: 'blocked_safety' })], request({ lens: 'safety_confirmation', kind: 'escalation', escalation_trigger: 'protocol_ambiguity' })).code, 'SAFETY_STOP');
  assert.throws(() => evaluateReviewBudget(POLICY, [], request({ decision_impact: '' })), ReviewBudgetError);
});

test('CLI 对拒绝返回结构化结果与 exit 2，并支持 --help', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-budget-test-'));
  try {
    const write = (name, value) => { const path = join(root, name); writeFileSync(path, JSON.stringify(value)); return path; };
    const script = join(dirname(fileURLToPath(import.meta.url)), 'review-budget.mjs');
    const denied = spawnSync(process.execPath, [script, 'evaluate', '--policy', write('policy.json', POLICY), '--history', write('history.json', []), '--request', write('request.json', request({ smoke_passed: false }))], { encoding: 'utf8' });
    assert.equal(denied.status, 2);
    assert.equal(JSON.parse(denied.stdout).code, 'SMOKE_REQUIRED');
    const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /evaluate --policy/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
