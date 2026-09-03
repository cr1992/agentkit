#!/usr/bin/env node
// @ts-check

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isHelpRequest, renderCliHelp } from './cli-help.mjs';

export class ContractError extends Error {}

class Parser {
  constructor(text) { this.text = text; this.index = 0; }
  ws() { while (/\s/u.test(this.text[this.index] ?? '')) this.index += 1; }
  parse() { const value = this.value(); this.ws(); if (this.index !== this.text.length) throw new ContractError(`JSON 尾部非法 at ${this.index}`); return value; }
  value() {
    this.ws(); const char = this.text[this.index];
    if (char === '{') return this.object(); if (char === '[') return this.array(); if (char === '"') return this.string();
    if (char === '-' || /[0-9]/u.test(char ?? '')) return this.number();
    for (const [token, value] of [['true', true], ['false', false], ['null', null]]) if (this.text.startsWith(token, this.index)) { this.index += token.length; return value; }
    throw new ContractError(`JSON 值非法 at ${this.index}`);
  }
  object() {
    this.index += 1; this.ws(); const value = Object.create(null); const keys = new Set();
    if (this.text[this.index] === '}') { this.index += 1; return value; }
    for (;;) {
      this.ws(); if (this.text[this.index] !== '"') throw new ContractError(`JSON key 非字符串 at ${this.index}`);
      const key = this.string(); if (keys.has(key)) throw new ContractError(`JSON duplicate key: ${key}`); keys.add(key);
      this.ws(); if (this.text[this.index] !== ':') throw new ContractError(`JSON 缺冒号 at ${this.index}`); this.index += 1; value[key] = this.value(); this.ws();
      if (this.text[this.index] === '}') { this.index += 1; return value; } if (this.text[this.index] !== ',') throw new ContractError(`JSON 缺逗号 at ${this.index}`); this.index += 1;
    }
  }
  array() {
    this.index += 1; this.ws(); const value = []; if (this.text[this.index] === ']') { this.index += 1; return value; }
    for (;;) { value.push(this.value()); this.ws(); if (this.text[this.index] === ']') { this.index += 1; return value; } if (this.text[this.index] !== ',') throw new ContractError(`JSON array 缺逗号 at ${this.index}`); this.index += 1; }
  }
  string() { const start = this.index++; let escaped = false; while (this.index < this.text.length) { const char = this.text[this.index]; if (!escaped && char === '"') { this.index += 1; const value = JSON.parse(this.text.slice(start, this.index)); if (/\p{Surrogate}/u.test(value)) throw new ContractError('JSON string 含未配对 surrogate'); return value; } escaped = !escaped && char === '\\'; this.index += 1; } throw new ContractError('JSON string 未闭合'); }
  number() { const match = this.text.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u); if (!match) throw new ContractError('JSON number 非法'); this.index += match[0].length; const value = Number(match[0]); if (!Number.isFinite(value)) throw new ContractError('JSON number 必须有限'); return value; }
}

export function parseJsonStrict(text) { return new Parser(text).parse(); }
export function canonicalJson(value) {
  if (value === null) return 'null'; if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new ContractError(`canonical JSON 不支持 ${typeof value}`);
}
export function sha256(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
export function envelopeDigest(value, field = 'contract_digest') { const clone = { ...value }; delete clone[field]; return sha256(Buffer.from(canonicalJson(clone), 'utf8')); }

export function validateContract(contract, { requireDigest = true } = {}) {
  const required = ['schema_version', 'contract_id', 'objective', 'scope', 'acceptance', 'permissions', 'environment', 'skill_set', 'stop_conditions', 'extensions'];
  if (contract?.schema_version !== 1) throw new ContractError('Task Contract schema_version 必须为 1');
  for (const field of required) if (!Object.hasOwn(contract, field)) throw new ContractError(`Task Contract 缺少 ${field}`);
  if (!contract.contract_id || !contract.objective || !Array.isArray(contract.scope?.include) || !Array.isArray(contract.scope?.exclude) || [...contract.scope.include, ...contract.scope.exclude].some((item) => typeof item !== 'string' || !item)) throw new ContractError('Task Contract identity/scope 无效');
  if (!Array.isArray(contract.acceptance) || !contract.acceptance.length) throw new ContractError('acceptance 不能为空');
  const ids = new Set();
  for (const item of contract.acceptance) { if (!item?.contract_item_id || !item?.requirement || ids.has(item.contract_item_id)) throw new ContractError('acceptance ID 缺失或重复'); ids.add(item.contract_item_id); }
  if (!['read_only', 'write'].includes(contract.permissions?.mode) || !Array.isArray(contract.permissions?.writable_paths) || contract.permissions.writable_paths.some((item) => typeof item !== 'string' || !item)) throw new ContractError('permissions 无效');
  if (contract.permissions.mode === 'read_only' && contract.permissions.writable_paths.length) throw new ContractError('read_only 合同不能声明 writable_paths');
  if (typeof contract.environment?.repository !== 'string' || !contract.environment.repository || !['shared_tree', 'worktree', 'caller_supplied'].includes(contract.environment?.isolation)) throw new ContractError('environment 无效');
  if (!Array.isArray(contract.stop_conditions) || !contract.extensions || typeof contract.extensions !== 'object' || Array.isArray(contract.extensions)) throw new ContractError('stop_conditions/extensions 无效');
  const verification = contract.extensions.verification;
  if (verification !== undefined && (
    !verification || typeof verification !== 'object' || Array.isArray(verification)
    || !['none', 'verify-agent-output', 'run-agent-verify-loop'].includes(verification.provider)
  )) throw new ContractError('extensions.verification 无效');
  const reviewPolicy = contract.extensions.review_policy;
  if (reviewPolicy !== undefined) {
    const expected = ['max_escalation_reviews_per_artifact', 'max_primary_reviews_per_artifact', 'max_review_input_tokens', 'require_distinct_lens', 'review_only_after_smoke_pass', 'schema_version'];
    const keys = reviewPolicy && typeof reviewPolicy === 'object' && !Array.isArray(reviewPolicy) ? Object.keys(reviewPolicy).sort() : [];
    if (
      reviewPolicy?.schema_version !== 1
      || JSON.stringify(keys) !== JSON.stringify(expected)
      || !Number.isSafeInteger(reviewPolicy.max_primary_reviews_per_artifact) || reviewPolicy.max_primary_reviews_per_artifact < 0
      || !Number.isSafeInteger(reviewPolicy.max_escalation_reviews_per_artifact) || reviewPolicy.max_escalation_reviews_per_artifact < 0
      || !Number.isSafeInteger(reviewPolicy.max_review_input_tokens) || reviewPolicy.max_review_input_tokens < 1
      || typeof reviewPolicy.require_distinct_lens !== 'boolean'
      || typeof reviewPolicy.review_only_after_smoke_pass !== 'boolean'
    ) throw new ContractError('extensions.review_policy 无效');
  }
  if (!Array.isArray(contract.skill_set)) throw new ContractError('skill_set 必须是数组');
  const skills = new Set();
  for (const skill of contract.skill_set) {
    if (!skill?.name || skills.has(skill.name) || !/^sha256:[0-9a-f]{64}$/u.test(String(skill.content_digest ?? '')) || !['primary', 'optional'].includes(skill.provider_mode)) throw new ContractError('skill_set entry 无效或重复');
    skills.add(skill.name);
  }
  const common = new Set(required.concat('contract_digest'));
  for (const key of Object.keys(contract.extensions)) if (common.has(key)) throw new ContractError(`extension 覆盖公共字段: ${key}`);
  if (requireDigest && (!/^sha256:[0-9a-f]{64}$/u.test(String(contract.contract_digest ?? '')) || envelopeDigest(contract) !== contract.contract_digest)) throw new ContractError('contract_digest 无效');
  return contract;
}

export function normalizeContract(contract) {
  const normalized = structuredClone(contract);
  delete normalized.contract_digest;
  validateContract(normalized, { requireDigest: false });
  normalized.contract_digest = envelopeDigest(normalized);
  return normalized;
}

export function acceptanceItemDigest(item) { return sha256(Buffer.from(canonicalJson(item), 'utf8')); }

// 合同投影：从公共父合同切出节点级、产物专属的验证合同。acceptance 条目逐字节 verbatim 拷贝，
// 其余公共字段原样继承，血缘写入 extensions.projection 供 ledger 校验。
export function projectContract(parent, itemIds, { contractId = null } = {}) {
  validateContract(parent);
  if (!Array.isArray(itemIds) || !itemIds.length) throw new ContractError('projection items 不能为空');
  if (itemIds.some((id) => typeof id !== 'string' || !id)) throw new ContractError('projection item id 无效');
  if (new Set(itemIds).size !== itemIds.length) throw new ContractError('projection items 重复');
  const byId = new Map(parent.acceptance.map((item) => [item.contract_item_id, item]));
  const acceptance = itemIds.map((id) => { const item = byId.get(id); if (!item) throw new ContractError(`projection item 不在 parent acceptance 中: ${id}`); return structuredClone(item); });
  if (contractId !== null && (typeof contractId !== 'string' || !contractId)) throw new ContractError('contract-id 无效');
  // 以 parent 展开为基底：只有 contract_id / acceptance / extensions / contract_digest 允许改动，
  // 其余顶层字段（含 parent 自带的扩展字段）原样继承，ledger 侧会逐字段核对全等。
  const projected = {
    ...structuredClone(parent),
    contract_id: contractId ?? `${parent.contract_id}--proj-${randomBytes(4).toString('hex')}`,
    acceptance,
    extensions: { ...structuredClone(parent.extensions), projection: { parent_contract_digest: parent.contract_digest, projected_item_ids: [...itemIds] } },
  };
  projected.contract_digest = envelopeDigest(projected);
  return validateContract(projected);
}

export function contractDiff(left, right) {
  const changed = [];
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) if (canonicalJson(left[key]) !== canonicalJson(right[key])) changed.push(key);
  const resign = changed.some((key) => key !== 'contract_digest');
  return { changed_fields: changed, requires_resign: resign, old_digest: left.contract_digest ?? null, new_digest: right.contract_digest ?? null };
}

// CLI 命令与参数的唯一真源：`--help` 清单和未知命令错误信息都从这里推导。
const CLI_SPEC = {
  normalize: { required: ['input'] },
  validate: { required: ['input'] },
  digest: { required: ['input'] },
  'review-view': { required: ['input'] },
  diff: { required: ['left', 'right'] },
  project: { required: ['input', 'items'], optional: ['contract-id'] },
  capabilities: {},
};
const CLI_NOTES = ['--items 是逗号分隔的 acceptance contract_item_id 列表，投影合同只能收窄这些条目。'];
function parseCli(argv) { const command = argv[0]; const options = {}; for (let i = 1; i < argv.length; i += 2) { if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new ContractError('参数必须是 --name value'); options[argv[i].slice(2)] = argv[i + 1]; } return { command, options }; }
function read(path) { return parseJsonStrict(readFileSync(resolve(path), 'utf8')); }
export function main(argv = process.argv.slice(2)) {
  if (isHelpRequest(argv)) return { help: renderCliHelp('contract-tool.mjs', CLI_SPEC, CLI_NOTES) };
  const { command, options } = parseCli(argv);
  if (command === 'normalize') return normalizeContract(read(options.input));
  if (command === 'validate') { const value = validateContract(read(options.input)); return { valid: true, contract_id: value.contract_id, contract_digest: value.contract_digest }; }
  if (command === 'digest') return { contract_digest: envelopeDigest(read(options.input)) };
  if (command === 'review-view') { const value = validateContract(read(options.input)); return { schema_version: 1, contract_id: value.contract_id, objective: value.objective, scope: value.scope, acceptance: value.acceptance, contract_permissions: value.permissions, reviewer_permissions: { mode: 'read_only', writable_paths: [] }, environment: value.environment, contract_digest: value.contract_digest }; }
  if (command === 'diff') return contractDiff(read(options.left), read(options.right));
  if (command === 'project') return projectContract(read(options.input), String(options.items ?? '').split(',').map((item) => item.trim()).filter(Boolean), { contractId: options['contract-id'] ?? null });
  if (command === 'capabilities') return { tool: 'contract-tool', runtime_version: '1.1.0', task_contract_versions: [1], features: ['strict-json', 'canonical-digest', 'review-view', 'resign-diff', 'contract-projection'] };
  throw new ContractError(`命令必须是 ${Object.keys(CLI_SPEC).join('/')}`);
}

function isEntry() { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url; } }
if (isEntry()) { try { const result = main(); process.stdout.write(typeof result?.help === 'string' ? result.help : `${JSON.stringify(result, null, 2)}\n`); } catch (error) { process.stderr.write(`${JSON.stringify({ error: 'invalid_contract', message: error.message })}\n`); process.exit(2); } }
