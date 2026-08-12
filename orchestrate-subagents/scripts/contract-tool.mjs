#!/usr/bin/env node
// @ts-check

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

export function contractDiff(left, right) {
  const changed = [];
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) if (canonicalJson(left[key]) !== canonicalJson(right[key])) changed.push(key);
  const resign = changed.some((key) => key !== 'contract_digest');
  return { changed_fields: changed, requires_resign: resign, old_digest: left.contract_digest ?? null, new_digest: right.contract_digest ?? null };
}

function parseCli(argv) { const command = argv[0]; const options = {}; for (let i = 1; i < argv.length; i += 2) { if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new ContractError('参数必须是 --name value'); options[argv[i].slice(2)] = argv[i + 1]; } return { command, options }; }
function read(path) { return parseJsonStrict(readFileSync(resolve(path), 'utf8')); }
export function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  if (command === 'normalize') return normalizeContract(read(options.input));
  if (command === 'validate') { const value = validateContract(read(options.input)); return { valid: true, contract_id: value.contract_id, contract_digest: value.contract_digest }; }
  if (command === 'digest') return { contract_digest: envelopeDigest(read(options.input)) };
  if (command === 'review-view') { const value = validateContract(read(options.input)); return { schema_version: 1, contract_id: value.contract_id, objective: value.objective, scope: value.scope, acceptance: value.acceptance, contract_permissions: value.permissions, reviewer_permissions: { mode: 'read_only', writable_paths: [] }, environment: value.environment, contract_digest: value.contract_digest }; }
  if (command === 'diff') return contractDiff(read(options.left), read(options.right));
  if (command === 'capabilities') return { tool: 'contract-tool', runtime_version: '1.0.0', task_contract_versions: [1], features: ['strict-json', 'canonical-digest', 'review-view', 'resign-diff'] };
  throw new ContractError('命令必须是 normalize/validate/digest/review-view/diff/capabilities');
}

function isEntry() { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url; } }
if (isEntry()) { try { process.stdout.write(`${JSON.stringify(main(), null, 2)}\n`); } catch (error) { process.stderr.write(`${JSON.stringify({ error: 'invalid_contract', message: error.message })}\n`); process.exit(2); } }
