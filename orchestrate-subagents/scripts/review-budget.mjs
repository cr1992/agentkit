#!/usr/bin/env node
// @ts-check

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseJsonStrict } from './contract-tool.mjs';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const REVIEW_KINDS = new Set(['primary', 'escalation']);
const REVIEW_OUTCOMES = new Set(['pass', 'fail', 'undecidable', 'blocked_safety']);
const ESCALATION_TRIGGERS = new Set(['undecidable', 'evidence_conflict', 'protocol_ambiguity']);

export class ReviewBudgetError extends Error {}

/** @param {string} path */
function readJson(path) {
  return parseJsonStrict(readFileSync(resolve(path), 'utf8'));
}

/** @param {unknown} value @param {string} label @param {number} minimum */
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new ReviewBudgetError(`${label} 必须是 >= ${minimum} 的安全整数`);
  return Number(value);
}

/** @param {Record<string,any>} policy */
export function validateReviewPolicy(policy) {
  const keys = [
    'schema_version',
    'max_primary_reviews_per_artifact',
    'max_escalation_reviews_per_artifact',
    'require_distinct_lens',
    'review_only_after_smoke_pass',
    'max_review_input_tokens',
  ];
  if (!policy || policy.schema_version !== 1 || Object.keys(policy).some((key) => !keys.includes(key))) throw new ReviewBudgetError('review policy schema/字段无效');
  const normalized = {
    schema_version: 1,
    max_primary_reviews_per_artifact: integer(policy.max_primary_reviews_per_artifact, 'max_primary_reviews_per_artifact'),
    max_escalation_reviews_per_artifact: integer(policy.max_escalation_reviews_per_artifact, 'max_escalation_reviews_per_artifact'),
    require_distinct_lens: policy.require_distinct_lens,
    review_only_after_smoke_pass: policy.review_only_after_smoke_pass,
    max_review_input_tokens: integer(policy.max_review_input_tokens, 'max_review_input_tokens', 1),
  };
  if (typeof normalized.require_distinct_lens !== 'boolean' || typeof normalized.review_only_after_smoke_pass !== 'boolean') throw new ReviewBudgetError('review policy boolean 字段无效');
  return normalized;
}

/** @param {unknown} value */
function validateHistory(value) {
  if (!Array.isArray(value)) throw new ReviewBudgetError('history 必须是数组');
  const ids = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ReviewBudgetError('history item 无效');
    if (typeof item.review_id !== 'string' || !item.review_id || ids.has(item.review_id)) throw new ReviewBudgetError('history review_id 缺失或重复');
    ids.add(item.review_id);
    if (!DIGEST.test(String(item.artifact_digest ?? '')) || typeof item.lens !== 'string' || !item.lens || !REVIEW_KINDS.has(item.kind) || !REVIEW_OUTCOMES.has(item.outcome)) throw new ReviewBudgetError(`history item 无效: ${item.review_id}`);
    return item;
  });
}

/** @param {Record<string,any>} request */
function validateRequest(request) {
  if (!request || request.schema_version !== 1 || !DIGEST.test(String(request.artifact_digest ?? ''))) throw new ReviewBudgetError('review request schema/artifact_digest 无效');
  if (typeof request.lens !== 'string' || !request.lens.trim() || !REVIEW_KINDS.has(request.kind)) throw new ReviewBudgetError('review request lens/kind 无效');
  if (typeof request.decision_impact !== 'string' || !request.decision_impact.trim()) throw new ReviewBudgetError('review request 必须说明 decision_impact');
  if (typeof request.smoke_passed !== 'boolean') throw new ReviewBudgetError('review request smoke_passed 必须是 boolean');
  integer(request.estimated_input_tokens, 'estimated_input_tokens');
  if (request.kind === 'escalation' && !ESCALATION_TRIGGERS.has(request.escalation_trigger)) throw new ReviewBudgetError('escalation review 必须给出 undecidable/evidence_conflict/protocol_ambiguity trigger');
  if (request.kind === 'primary' && request.escalation_trigger != null) throw new ReviewBudgetError('primary review 不接受 escalation_trigger');
  return request;
}

/**
 * 在派 reviewer 前执行的纯函数门禁；不自行派发、不改写历史。
 * @param {Record<string,any>} rawPolicy @param {unknown} rawHistory @param {Record<string,any>} rawRequest
 */
export function evaluateReviewBudget(rawPolicy, rawHistory, rawRequest) {
  const policy = validateReviewPolicy(rawPolicy);
  const history = validateHistory(rawHistory);
  const request = validateRequest(rawRequest);
  const sameArtifact = history.filter((item) => item.artifact_digest === request.artifact_digest);
  const primaryCount = sameArtifact.filter((item) => item.kind === 'primary').length;
  const escalationCount = sameArtifact.filter((item) => item.kind === 'escalation').length;
  const result = (allowed, code, nextAction) => ({
    allowed,
    code,
    next_action: nextAction,
    artifact_digest: request.artifact_digest,
    counts: { primary: primaryCount, escalation: escalationCount, total: sameArtifact.length },
    remaining: {
      primary: Math.max(0, policy.max_primary_reviews_per_artifact - primaryCount),
      escalation: Math.max(0, policy.max_escalation_reviews_per_artifact - escalationCount),
    },
  });

  if (policy.review_only_after_smoke_pass && !request.smoke_passed) return result(false, 'SMOKE_REQUIRED', 'run_smoke_first');
  if (request.estimated_input_tokens > policy.max_review_input_tokens) return result(false, 'REVIEW_INPUT_BUDGET_EXCEEDED', 'project_contract_or_reduce_scope');
  if (sameArtifact.some((item) => item.outcome === 'blocked_safety')) return result(false, 'SAFETY_STOP', 'escalate_to_human');
  if (policy.require_distinct_lens && sameArtifact.some((item) => item.lens === request.lens)) return result(false, 'DUPLICATE_REVIEW_LENS', 'reuse_existing_review_or_choose_decision_changing_lens');

  if (request.kind === 'primary') {
    if (primaryCount >= policy.max_primary_reviews_per_artifact) return result(false, 'PRIMARY_REVIEW_LIMIT', 'reuse_existing_review');
    return result(true, 'ALLOWED_PRIMARY', 'dispatch_one_reviewer');
  }
  if (primaryCount === 0) return result(false, 'PRIMARY_REVIEW_MISSING', 'run_primary_review_first');
  if (escalationCount >= policy.max_escalation_reviews_per_artifact) return result(false, 'ESCALATION_REVIEW_LIMIT', 'stop_or_escalate_to_human');
  if (request.escalation_trigger === 'undecidable' && !sameArtifact.some((item) => item.outcome === 'undecidable')) return result(false, 'UNDECIDABLE_EVIDENCE_MISSING', 'reuse_primary_result');
  return result(true, 'ALLOWED_ESCALATION', 'dispatch_distinct_escalation_reviewer');
}

function usage() {
  return '用法: review-budget.mjs capabilities | evaluate --policy <json> --history <json> --request <json>\n';
}

/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) {
  if (['--help', '-h', 'help'].includes(argv[0] ?? '')) return { help: usage() };
  if (argv[0] === 'capabilities') return { runtime: 'review-budget', runtime_version: '1.0.0', contracts: { review_policy: [1], review_budget_request: [1] }, features: ['per-artifact-review-limit', 'distinct-lens-gate', 'smoke-first-gate', 'review-input-token-limit', 'safety-stop'] };
  if (argv[0] !== 'evaluate') throw new ReviewBudgetError(usage().trim());
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!['--policy', '--history', '--request'].includes(token) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new ReviewBudgetError(usage().trim());
    options[token.slice(2)] = argv[++index];
  }
  for (const key of ['policy', 'history', 'request']) if (!options[key]) throw new ReviewBudgetError(`缺少 --${key}`);
  return evaluateReviewBudget(readJson(options.policy), readJson(options.history), readJson(options.request));
}

export function isCliEntry(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1); }
  catch { return pathToFileURL(resolve(argv1)).href === metaUrl; }
}

if (isCliEntry()) {
  try {
    const result = main();
    if (result.help) process.stdout.write(result.help);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.allowed === false) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: 'invalid_input', message: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 2;
  }
}
