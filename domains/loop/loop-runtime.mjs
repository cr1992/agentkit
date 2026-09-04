#!/usr/bin/env node
// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createReflectionKit } from '../../core/reflection.mjs';
import { validateJsonSchema } from '../../core/json-schema-lite.mjs';
import { atomicWriteJson, atomicWriteText, writeNewJson } from '../../core/atomic-fs.mjs';
import { createDigestKit } from '../../core/digest.mjs';
import { distributionDigest, skillDistributionRoots } from '../../core/content-digest.mjs';

export const RUNTIME_VERSION = '1.0.0';
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'run-agent-verify-loop');
// 摘要覆盖 Skill 目录 + 共享 core + canonical schemas：执行真正依赖的全部分发内容。
// PACKAGE_ROOT 是模块常量，传入自定义 root 只替换 Skill 目录那一段，便于测试摘要与安装路径无关。
const PACKAGE_ROOT = resolve(SKILL_ROOT, '..');
const DOMAIN_ROOT = dirname(fileURLToPath(import.meta.url));
export function skillContentDigest(root = SKILL_ROOT) {
  return distributionDigest(skillDistributionRoots({ packageRoot: PACKAGE_ROOT, skillRoot: root, domainRoot: DOMAIN_ROOT, docsRoot: join(PACKAGE_ROOT, 'docs', 'loop') }));
}

const schema = (name) => parseJsonStrict(readFileSync(join(SKILL_ROOT, '..', 'schemas', name), 'utf8'));
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FINDING_CLASSES = new Set(['functional', 'scope', 'verification_definition', 'safety']);
const PROVIDERS = new Set(['verify-agent-output', 'embedded']);

export class LoopValidationError extends Error {}

// strict=true 保留本 Skill 既有的代理对与非有限 number 校验；错误类仍是本地的 LoopValidationError。
const digestKit = createDigestKit({ ValidationError: LoopValidationError, strict: true });
// 严格度保持本 Skill 现状（宽松版），不随 core 合并而收紧。
const { buildProposal, buildReflection, readAndValidateReflection, verifyEvidenceRefs } = createReflectionKit({ strict: false });
export const { canonicalJson, envelopeDigest } = digestKit;
const { sha256, assertValidUnicode: validUnicode } = digestKit;
export class LoopOperationalAbort extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class StrictParser {
  constructor(text) { this.text = text; this.index = 0; }
  space() { while (/\s/u.test(this.text[this.index] ?? '')) this.index += 1; }
  parse() {
    const value = this.value();
    this.space();
    if (this.index !== this.text.length) throw new LoopValidationError(`JSON 尾部非法，位置 ${this.index}`);
    return value;
  }
  value() {
    this.space();
    const char = this.text[this.index];
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"') return this.string();
    if (char === '-' || /[0-9]/u.test(char ?? '')) return this.number();
    for (const [token, value] of [['true', true], ['false', false], ['null', null]]) {
      if (this.text.startsWith(token, this.index)) { this.index += token.length; return value; }
    }
    throw new LoopValidationError(`JSON 值非法，位置 ${this.index}`);
  }
  object() {
    this.index += 1;
    this.space();
    const value = Object.create(null);
    const keys = new Set();
    if (this.text[this.index] === '}') { this.index += 1; return value; }
    while (true) {
      this.space();
      if (this.text[this.index] !== '"') throw new LoopValidationError(`JSON key 非字符串，位置 ${this.index}`);
      const key = this.string();
      if (keys.has(key)) throw new LoopValidationError(`JSON object 存在重复 key: ${key}`);
      keys.add(key);
      this.space();
      if (this.text[this.index] !== ':') throw new LoopValidationError(`JSON object 缺少冒号，位置 ${this.index}`);
      this.index += 1;
      value[key] = this.value();
      this.space();
      if (this.text[this.index] === '}') { this.index += 1; return value; }
      if (this.text[this.index] !== ',') throw new LoopValidationError(`JSON object 缺少逗号，位置 ${this.index}`);
      this.index += 1;
    }
  }
  array() {
    this.index += 1;
    this.space();
    const value = [];
    if (this.text[this.index] === ']') { this.index += 1; return value; }
    while (true) {
      value.push(this.value());
      this.space();
      if (this.text[this.index] === ']') { this.index += 1; return value; }
      if (this.text[this.index] !== ',') throw new LoopValidationError(`JSON array 缺少逗号，位置 ${this.index}`);
      this.index += 1;
    }
  }
  string() {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (!escaped && char === '"') {
        this.index += 1;
        const value = JSON.parse(this.text.slice(start, this.index));
        validUnicode(value);
        return value;
      }
      if (!escaped && char === '\\') escaped = true;
      else escaped = false;
      this.index += 1;
    }
    throw new LoopValidationError(`JSON string 未闭合，位置 ${start}`);
  }
  number() {
    const match = this.text.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) throw new LoopValidationError(`JSON number 非法，位置 ${this.index}`);
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new LoopValidationError('JSON number 必须有限');
    return value;
  }
}

export function parseJsonStrict(text) { return new StrictParser(text).parse(); }

function readJson(path) { return parseJsonStrict(readFileSync(path, 'utf8')); }
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return Boolean(error && typeof error === 'object' && error.code === 'EPERM'); }
}
function recoverOrphanReclaim(path) {
  const reclaimPath = `${path}.reclaim`;
  if (!existsSync(reclaimPath)) return;
  let owner;
  try { owner = parseJsonStrict(readFileSync(reclaimPath, 'utf8')); } catch { throw new LoopValidationError('state-root lock reclaim 内容损坏；拒绝自动接管'); }
  if (!Number.isInteger(Number(owner.pid)) || Number(owner.pid) <= 0 || typeof owner.token !== 'string' || !owner.token) throw new LoopValidationError('state-root lock reclaim owner 无效；拒绝自动接管');
  if (processIsAlive(Number(owner.pid))) throw new LoopValidationError('state-root lock 正在执行 stale recovery');
  let latest;
  try { latest = parseJsonStrict(readFileSync(reclaimPath, 'utf8')); } catch (error) { if (error && typeof error === 'object' && error.code === 'ENOENT') return; throw new LoopValidationError('state-root lock reclaim 内容损坏；拒绝自动接管'); }
  if (Number(latest.pid) !== Number(owner.pid) || latest.token !== owner.token) return;
  try { unlinkSync(reclaimPath); } catch (error) { if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error; }
}
export function acquireLock(path) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    recoverOrphanReclaim(path);
    const owner = { pid: process.pid, token: randomUUID(), acquired_at: new Date().toISOString() };
    const candidate = `${path}.${owner.pid}.${owner.token}.candidate`;
    const fd = openSync(candidate, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(owner)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      if (existsSync(`${path}.reclaim`)) throw new LoopValidationError('state-root lock 正在执行 stale recovery');
      linkSync(candidate, path); unlinkSync(candidate); return owner;
    }
    catch (error) {
      try { unlinkSync(candidate); } catch {}
      if (error instanceof LoopValidationError) throw error;
      if (!error || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
      let current;
      try { current = parseJsonStrict(readFileSync(path, 'utf8')); } catch { throw new LoopValidationError('state-root lock 内容损坏；拒绝自动接管'); }
      if (!Number.isInteger(Number(current.pid)) || Number(current.pid) <= 0) throw new LoopValidationError('state-root lock owner 无效；拒绝自动接管');
      if (processIsAlive(Number(current.pid))) throw new LoopValidationError(`state-root lock 正被 PID ${current.pid} 持有`);
      const reclaimPath = `${path}.reclaim`;
      const reclaimOwner = { pid: process.pid, token: randomUUID(), acquired_at: new Date().toISOString() };
      const reclaimCandidate = `${reclaimPath}.${reclaimOwner.pid}.${reclaimOwner.token}.candidate`;
      const reclaimFd = openSync(reclaimCandidate, 'wx', 0o600);
      try { writeFileSync(reclaimFd, `${JSON.stringify(reclaimOwner)}\n`); fsyncSync(reclaimFd); } finally { closeSync(reclaimFd); }
      try { linkSync(reclaimCandidate, reclaimPath); } catch (reclaimError) { if (!reclaimError || typeof reclaimError !== 'object' || reclaimError.code !== 'EEXIST') throw reclaimError; throw new LoopValidationError('state-root lock 正在执行 stale recovery'); }
      finally { try { unlinkSync(reclaimCandidate); } catch {} }
      try {
        let latest;
        try { latest = parseJsonStrict(readFileSync(path, 'utf8')); } catch (latestError) { if (latestError && typeof latestError === 'object' && latestError.code === 'ENOENT') continue; throw new LoopValidationError('state-root lock 内容损坏；拒绝自动接管'); }
        if (Number(latest.pid) !== Number(current.pid) || latest.token !== current.token) continue;
        if (processIsAlive(Number(latest.pid))) throw new LoopValidationError(`state-root lock 正被 PID ${latest.pid} 持有`);
        unlinkSync(path);
      } finally { releaseLock(reclaimPath, reclaimOwner); }
    }
  }
  throw new LoopValidationError('无法获取 state-root lock');
}
export function releaseLock(path, owner) {
  let current;
  try { current = parseJsonStrict(readFileSync(path, 'utf8')); } catch (error) { if (error && typeof error === 'object' && error.code === 'ENOENT') return false; throw new LoopValidationError('state-root lock 在持有期间损坏；拒绝删除未知 owner 的 lock'); }
  if (current.pid !== owner.pid || current.token !== owner.token) return false;
  unlinkSync(path);
  return true;
}

function git(args, cwd, encoding = 'utf8') {
  return execFileSync('git', args, { cwd, encoding, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}
function gitStatus(args, cwd) { return spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

function validateArtifact(artifact) {
  if (artifact?.schema_version !== 1) throw new LoopValidationError('Artifact schema_version 必须为 1');
  for (const field of ['provider', 'repository_id', 'object_format', 'base_sha', 'artifact_sha']) if (!artifact[field]) throw new LoopValidationError(`Artifact 缺少 ${field}`);
  if (!['manage-worktrees', 'caller-supplied'].includes(artifact.provider)) throw new LoopValidationError('Artifact provider 非法');
  const size = artifact.object_format === 'sha1' ? 40 : artifact.object_format === 'sha256' ? 64 : 0;
  if (!size || !new RegExp(`^[0-9a-f]{${size}}$`, 'u').test(artifact.base_sha) || !new RegExp(`^[0-9a-f]{${size}}$`, 'u').test(artifact.artifact_sha)) throw new LoopValidationError('Artifact object format 或 SHA 非法');
}

function validateProfilePath(path) {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('..') || path.includes(':(') || /[*?[\]]/u.test(path)) throw new LoopValidationError(`非法 verifier path: ${path}`);
  const core = path.endsWith('/') ? path.slice(0, -1) : path;
  if (!core || core.split('/').some((part) => !part || part === '.' || part === '..')) throw new LoopValidationError(`非法 verifier path: ${path}`);
}

function profilePathMatches(path, rule) { return rule.endsWith('/') ? path.startsWith(rule) : path === rule; }

function verifyProtectedPaths(artifact, profile, workdir) {
  const protectedPaths = profile.protected_verifier_paths;
  const allowed = profile.allowed_validation_changes;
  const bytes = git(['diff', '--name-status', '-z', '--no-renames', artifact.base_sha, artifact.artifact_sha], workdir, 'buffer');
  const tokens = bytes.toString('utf8').split('\0').filter(Boolean);
  const changed = [];
  for (let index = 0; index < tokens.length; index += 2) if (tokens[index + 1]) changed.push(tokens[index + 1]);
  const violations = changed.filter((path) => protectedPaths.some((rule) => profilePathMatches(path, rule)) && !allowed.some((rule) => profilePathMatches(path, rule)));
  if (violations.length > 0) throw new LoopOperationalAbort('protected_path_violation', `未授权修改 verifier path: ${violations.join(', ')}`);
}

function verifyGitArtifact(artifact, workdir, frozenIdentity = null) {
  validateArtifact(artifact);
  const root = realpathSync(String(git(['rev-parse', '--show-toplevel'], workdir)).trim());
  if (root !== realpathSync(workdir)) throw new LoopOperationalAbort('stale_precondition', 'workdir 必须是 worktree 根目录');
  const objectFormat = String(git(['rev-parse', '--show-object-format'], root)).trim();
  if (objectFormat !== artifact.object_format) throw new LoopOperationalAbort('stale_precondition', 'object format 已变化');
  for (const field of ['base_sha', 'artifact_sha']) if (String(git(['cat-file', '-t', artifact[field]], root)).trim() !== 'commit') throw new LoopValidationError(`${field} 不是 commit`);
  if (gitStatus(['merge-base', '--is-ancestor', artifact.base_sha, artifact.artifact_sha], root).status !== 0) throw new LoopValidationError('base_sha 不是 artifact ancestor');
  if (String(git(['rev-parse', 'HEAD'], root)).trim() !== artifact.artifact_sha) throw new LoopOperationalAbort('stale_precondition', 'HEAD 偏离 Artifact');
  if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root, 'buffer').length > 0) throw new LoopOperationalAbort('stale_precondition', 'embedded workdir 不干净');
  const roots = String(git(['rev-list', '--max-parents=0', artifact.artifact_sha], root)).trim().split('\n').filter(Boolean).sort();
  const identity = `git:${objectFormat}:${sha256(Buffer.from(canonicalJson(roots), 'utf8'))}`;
  if (frozenIdentity && frozenIdentity !== identity) throw new LoopOperationalAbort('stale_precondition', 'repository identity 已变化');
  return identity;
}

function validateContract(contract) {
  if (contract?.schema_version !== 1 || !contract.contract_id || !contract.objective) throw new LoopValidationError('Task Contract schema/id/objective 无效');
  if (!contract.scope || !Array.isArray(contract.scope.include) || !Array.isArray(contract.scope.exclude) || [...contract.scope.include, ...contract.scope.exclude].some((item) => typeof item !== 'string' || !item)) throw new LoopValidationError('Task Contract scope 无效');
  if (!contract.permissions || !['read_only', 'write'].includes(contract.permissions.mode) || !Array.isArray(contract.permissions.writable_paths) || contract.permissions.writable_paths.some((item) => typeof item !== 'string' || !item) || contract.permissions.mode === 'read_only' && contract.permissions.writable_paths.length) throw new LoopValidationError('Task Contract permissions 无效');
  if (!contract.environment || typeof contract.environment.repository !== 'string' || !contract.environment.repository || !['shared_tree', 'worktree', 'caller_supplied'].includes(contract.environment.isolation)) throw new LoopValidationError('Task Contract environment 无效');
  if (!Array.isArray(contract.stop_conditions) || !contract.extensions || typeof contract.extensions !== 'object' || Array.isArray(contract.extensions)) throw new LoopValidationError('Task Contract stop_conditions/extensions 无效');
  if (!Array.isArray(contract.acceptance) || contract.acceptance.length === 0) throw new LoopValidationError('acceptance 不能为空');
  const ids = new Set();
  for (const item of contract.acceptance) {
    if (!item?.contract_item_id || !item?.requirement || ids.has(item.contract_item_id)) throw new LoopValidationError('acceptance ID 缺失或重复');
    ids.add(item.contract_item_id);
  }
  if (!Array.isArray(contract.skill_set)) throw new LoopValidationError('skill_set 必须是数组');
  if (!DIGEST_PATTERN.test(contract.contract_digest) || envelopeDigest(contract, 'contract_digest') !== contract.contract_digest) throw new LoopValidationError('Task Contract digest 无效');
  return ids;
}

function validateProfile(profile, ids) {
  try { validateJsonSchema(profile, schema('verification-profile-v1.schema.json'), 'Verification Profile'); } catch (error) { throw new LoopValidationError(error instanceof Error ? error.message : String(error)); }
  if (profile?.schema_version !== 1 || !profile.profile_id || !Array.isArray(profile.l0_checks) || profile.l0_checks.length === 0 || !Array.isArray(profile.l1_review) || profile.l1_review.length === 0) throw new LoopValidationError('Verification Profile 无效');
  const checks = new Set();
  for (const check of profile.l0_checks) {
    if (!check?.check_id || checks.has(check.check_id) || !Array.isArray(check.argv) || check.argv.length === 0 || check.argv.some((item) => typeof item !== 'string')) throw new LoopValidationError('L0 check 无效或重复');
    checks.add(check.check_id);
    if (!['smoke', 'final', 'both'].includes(check.stage) || !Number.isInteger(check.timeout_ms) || check.timeout_ms <= 0 || !Array.isArray(check.expected_exit_codes) || check.expected_exit_codes.length === 0 || check.expected_exit_codes.some((code) => !Number.isInteger(code))) throw new LoopValidationError(`${check.check_id} 配置无效`);
    if (!check.cwd_rel || isAbsolute(check.cwd_rel) || check.cwd_rel.includes('\\') || check.cwd_rel.split('/').some((part) => part === '..')) throw new LoopValidationError(`${check.check_id} cwd_rel 非法`);
  }
  if (!profile.l0_checks.some((check) => ['smoke', 'both'].includes(check.stage)) || !profile.l0_checks.some((check) => ['final', 'both'].includes(check.stage))) throw new LoopValidationError('Verification Profile 必须覆盖 smoke 与 final L0');
  for (const review of profile.l1_review) if (!ids.has(review?.contract_item_id)) throw new LoopValidationError(`L1 引用未知 acceptance: ${review?.contract_item_id}`);
  if (!Array.isArray(profile.protected_verifier_paths) || !Array.isArray(profile.allowed_validation_changes)) throw new LoopValidationError('Profile path 字段必须是数组');
  for (const path of [...profile.protected_verifier_paths, ...profile.allowed_validation_changes]) validateProfilePath(path);
  if (!profile.runtime || !Array.isArray(profile.runtime.env_allowlist) || profile.runtime.env_allowlist.some((name) => typeof name !== 'string' || !name) || typeof profile.runtime.executable_paths !== 'object' || !Number.isInteger(profile.runtime.max_log_bytes) || profile.runtime.max_log_bytes <= 0) throw new LoopValidationError('Profile runtime 无效');
  if (!['disabled', 'isolated', 'trusted_identity'].includes(profile.runtime.cache_policy) || !['denied', 'contract_authorized'].includes(profile.runtime.network_policy)) throw new LoopValidationError('Profile cache/network policy 无效');
  if (!['none', 'release', 'destructive', 'external_side_effect'].includes(profile.human_gate)) throw new LoopValidationError('human_gate 非法');
  for (const check of profile.l0_checks) {
    const executable = profile.runtime.executable_paths[check.argv[0]];
    if (!executable || !isAbsolute(executable) || !statSync(executable).isFile()) throw new LoopValidationError(`未冻结 executable: ${check.argv[0]}`);
  }
  if (!DIGEST_PATTERN.test(profile.verification_profile_digest) || envelopeDigest(profile, 'verification_profile_digest') !== profile.verification_profile_digest) throw new LoopValidationError('Profile digest 无效');
}

function validateSkillBinding(contract, contentDigest) {
  const entry = contract.skill_set.find((item) => item?.name === 'run-agent-verify-loop');
  if (!entry || entry.content_digest !== contentDigest) throw new LoopValidationError('Task Contract 未绑定当前 run-agent-verify-loop 内容摘要');
}

function validateReview(review, snapshot, ids) {
  try { validateJsonSchema(review, schema('review-result-v1.schema.json'), 'Review Result'); } catch (error) { throw new LoopValidationError(error instanceof Error ? error.message : String(error)); }
  if (review?.schema_version !== 1 || !review.review_result_id || !['fail', 'no_defect_found', 'undecidable'].includes(review.verdict)) throw new LoopValidationError('Review Result schema/id/verdict 无效');
  if (review.contract_digest !== snapshot.contract_digest || review.verification_profile_digest !== snapshot.verification_profile_digest || canonicalJson(review.artifact_ref) !== canonicalJson(snapshot.current_iteration.artifact_ref)) throw new LoopValidationError('Review Result binding 不匹配');
  if (review.challenge_nonce !== snapshot.current_iteration.review_challenge_nonce) throw new LoopValidationError('Review Result challenge nonce 不匹配或已重放');
  if (!Array.isArray(review.findings) || !Array.isArray(review.forensics)) throw new LoopValidationError('Review Result findings/forensics 无效');
  for (const finding of review.findings) {
    if (!ids.has(finding?.contract_item_id) || !FINDING_CLASSES.has(finding?.class)) throw new LoopValidationError('finding ID/class 无效');
    for (const field of ['evidence', 'expected', 'actual']) if (typeof finding[field] !== 'string' || !finding[field].trim()) throw new LoopValidationError(`finding ${field} 必须是非空字符串`);
  }
  if (review.forensics.some((item) => typeof item !== 'string' || !item.trim())) throw new LoopValidationError('forensics 必须是非空字符串数组');
  if (review.verdict === 'fail' && review.findings.length === 0) throw new LoopValidationError('fail 必须有 finding');
  if (review.verdict === 'no_defect_found' && (review.findings.length > 0 || review.forensics.length === 0)) throw new LoopValidationError('no_defect_found 必须无 finding 且有 forensics');
  if (review.verdict === 'undecidable' && review.findings.length === 0) throw new LoopValidationError('undecidable 必须说明证据缺口');
  if (!DIGEST_PATTERN.test(review.review_result_digest) || envelopeDigest(review, 'review_result_digest') !== review.review_result_digest) throw new LoopValidationError('Review Result digest 无效');
}

function validateEvidence(evidence, snapshot) {
  if (evidence?.schema_version !== 1 || evidence.protocol_version !== 1 || evidence.provenance?.provider !== 'verify-agent-output') throw new LoopValidationError('Evidence schema/protocol/provider 无效');
  if (typeof evidence.runtime_version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(evidence.runtime_version)) throw new LoopValidationError('Evidence runtime_version 非法');
  if (!['pass', 'fail', 'undecidable', 'blocked_safety'].includes(evidence.terminal_outcome) || evidence.completion_scope !== 'verification_only') throw new LoopValidationError('Evidence outcome/scope 无效');
  if (evidence.contract_digest !== snapshot.contract_digest || evidence.verification_profile_digest !== snapshot.verification_profile_digest || canonicalJson(evidence.artifact_ref) !== canonicalJson(snapshot.current_iteration.artifact_ref)) throw new LoopValidationError('Evidence binding 不匹配');
  if (evidence.run_id !== snapshot.current_iteration.verification_run_id) throw new LoopValidationError('Evidence run_id 与 iteration 不一致');
  if (evidence.terminal_outcome === 'fail') {
    const checks = [...(evidence.stages?.smoke_l0?.checks ?? []), ...(evidence.stages?.final_l0?.checks ?? [])];
    const findings = evidence.stages?.l1_review?.findings ?? [];
    if (!checks.some((item) => item?.passed === false) && findings.length === 0) throw new LoopValidationError('fail Evidence 缺少稳定失败依据');
  }
  if (!DIGEST_PATTERN.test(evidence.evidence_digest) || envelopeDigest(evidence, 'evidence_digest') !== evidence.evidence_digest) throw new LoopValidationError('Evidence digest 无效');
}

function sanitize(text, environment, maxBytes) {
  let output = text;
  for (const [name, value] of Object.entries(environment)) if (value && /(token|secret|password|credential|api[_-]?key)/iu.test(name)) output = output.split(value).join('[REDACTED]');
  output = output.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]').replace(/\b(?:ghp|glpat|sk)-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED]');
  const bytes = Buffer.from(output, 'utf8');
  return bytes.length <= maxBytes ? output : `${bytes.subarray(0, maxBytes).toString('utf8')}\n[TRUNCATED]\n`;
}

function persistLog(loopDir, text) {
  const digest = sha256(Buffer.from(text, 'utf8'));
  const directory = join(loopDir, 'logs');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `${digest.slice(7)}.log`;
  if (!existsSync(join(directory, name))) writeFileSync(join(directory, name), text, { flag: 'wx', mode: 0o600 });
  return { log_digest: digest, log_ref: `logs/${name}` };
}

function canonicalFuturePath(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(cursor.slice(parent.length + 1));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}
function pathInside(candidate, parent) {
  const rel = relative(realpathSync(parent), canonicalFuturePath(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function fileIdentity(path) {
  const absolute = realpathSync(path);
  const stat = statSync(absolute);
  return { path: absolute, size: stat.size, mode: stat.mode, digest: sha256(readFileSync(absolute)) };
}

function freezeArgvFiles(profile, workdir) {
  if (!workdir) return {};
  const frozen = {};
  for (const check of profile.l0_checks) {
    const cwd = resolve(workdir, check.cwd_rel);
    for (let index = 1; index < check.argv.length; index += 1) {
      const argument = check.argv[index];
      if (argument.startsWith('-')) continue;
      const candidate = isAbsolute(argument) ? argument : resolve(cwd, argument);
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      const absolute = realpathSync(candidate);
      frozen[`${check.check_id}:${index}`] = { argument_path: resolve(candidate), ...fileIdentity(absolute) };
    }
  }
  return frozen;
}

function executeEmbeddedChecks(snapshot, loopDir) {
  if (!snapshot.workdir) throw new LoopValidationError('embedded provider 必须在 init 提供 --workdir');
  verifyGitArtifact(snapshot.current_iteration.artifact_ref, snapshot.workdir, snapshot.runtime_repository_identity);
  const profile = readJson(join(loopDir, 'profile.json'));
  const environment = {};
  for (const name of profile.runtime.env_allowlist) if (process.env[name] !== undefined) environment[name] = String(process.env[name]);
  const results = [];
  for (const check of profile.l0_checks) {
    verifyGitArtifact(snapshot.current_iteration.artifact_ref, snapshot.workdir, snapshot.runtime_repository_identity);
    const cwd = resolve(snapshot.workdir, check.cwd_rel);
    if (!pathInside(cwd, snapshot.workdir)) throw new LoopValidationError(`${check.check_id} cwd_rel 越界`);
    const executable = profile.runtime.executable_paths[check.argv[0]];
    let live;
    try { const absolute = realpathSync(executable); const stat = statSync(absolute); live = { path: absolute, size: stat.size, mode: stat.mode, digest: sha256(readFileSync(absolute)) }; }
    catch (error) { throw new LoopOperationalAbort('check_runtime_failure', `${check.check_id} executable 无法执行: ${error instanceof Error ? error.message : String(error)}`); }
    if (!snapshot.executable_identities?.[check.argv[0]] || canonicalJson(live) !== canonicalJson(snapshot.executable_identities[check.argv[0]])) throw new LoopOperationalAbort('check_runtime_failure', `冻结 executable 已变化: ${check.argv[0]}`);
    for (const [key, identity] of Object.entries(snapshot.argv_file_identities ?? {})) {
      const [checkId, rawIndex] = key.split(':');
      if (checkId !== check.check_id) continue;
      const argument = check.argv[Number(rawIndex)];
      const candidate = isAbsolute(argument) ? argument : resolve(cwd, argument);
      let argumentLive;
      try { argumentLive = { argument_path: resolve(candidate), ...fileIdentity(candidate) }; }
      catch (error) { throw new LoopOperationalAbort('check_runtime_failure', `冻结 argv 文件不可用: ${key}: ${error instanceof Error ? error.message : String(error)}`); }
      if (canonicalJson(argumentLive) !== canonicalJson(identity)) throw new LoopOperationalAbort('check_runtime_failure', `冻结 argv 文件已变化: ${key}`);
    }
    const result = spawnSync(executable, check.argv.slice(1), { cwd, env: environment, encoding: 'utf8', timeout: check.timeout_ms, maxBuffer: Math.max(profile.runtime.max_log_bytes * 4, 1024 * 1024), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const timedOut = result.error?.code === 'ETIMEDOUT';
    const exitCode = Number.isInteger(result.status) ? result.status : null;
    const log = sanitize([result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n'), environment, profile.runtime.max_log_bytes);
    const persisted = persistLog(loopDir, log);
    if (result.error && !timedOut) throw new LoopOperationalAbort('check_runtime_failure', `${check.check_id} 无法执行，诊断 ${persisted.log_ref}: ${result.error.message}`);
    if (exitCode === null && !timedOut) throw new LoopOperationalAbort('check_runtime_failure', `${check.check_id} 未产生退出码，诊断 ${persisted.log_ref}`);
    results.push({ check_id: check.check_id, exit_code: exitCode, expected_exit_codes: check.expected_exit_codes, timed_out: timedOut, passed: !timedOut && check.expected_exit_codes.includes(exitCode), ...persisted });
    verifyGitArtifact(snapshot.current_iteration.artifact_ref, snapshot.workdir, snapshot.runtime_repository_identity);
  }
  return { checks: results, passed: results.every((item) => item.passed) };
}

function readJournal(loopDir) {
  const path = join(loopDir, 'events.ndjson');
  if (!existsSync(path)) throw new LoopValidationError('loop 缺少 event journal');
  const text = readFileSync(path, 'utf8');
  const lastNewline = text.lastIndexOf('\n');
  const complete = lastNewline < 0 ? '' : text.slice(0, lastNewline + 1);
  const trailing = lastNewline === text.length - 1 ? '' : text.slice(lastNewline + 1);
  const events = complete.split('\n').filter(Boolean).map((line) => parseJsonStrict(line));
  let previous = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.revision !== index || event.previous_event_digest !== previous || !DIGEST_PATTERN.test(event.event_digest ?? '') || envelopeDigest(event, 'event_digest') !== event.event_digest) throw new LoopValidationError(`event journal 链在 revision ${index} 无效`);
    previous = event.event_digest;
  }
  return { events, complete, trailing };
}
function loadLoop(loopDir) {
  const journal = readJournal(loopDir);
  const { events } = journal;
  if (events.length === 0) throw new LoopValidationError('loop journal 为空');
  const latest = events.at(-1).snapshot;
  const path = join(loopDir, 'snapshot.json');
  if (!existsSync(path)) return { snapshot: latest, needsRepair: true, events, journal };
  const file = readJson(path);
  const snapshotDrift = file.revision !== latest.revision || canonicalJson(file) !== canonicalJson(latest);
  const needsRepair = snapshotDrift || Boolean(journal.trailing);
  return { snapshot: snapshotDrift ? latest : file, needsRepair, events, journal };
}
function ensureConvergenceReport(loopDir, snapshot) {
  if (!['completed', 'stopped'].includes(snapshot.state) || snapshot.convergence_report_ref) return snapshot;
  const contract = readJson(join(loopDir, 'contract.json'));
  const report = {
    schema_version: 1,
    report_id: randomUUID(),
    loop_id: snapshot.loop_id,
    contract_digest: snapshot.contract_digest,
    skill_set: contract.skill_set,
    outcome: snapshot.state,
    iterations: snapshot.iterations.length,
    failure_signatures: [...new Set(snapshot.iterations.map((item) => item.failure_signature).filter(Boolean))],
    strategy_changes: snapshot.iterations.filter((item) => item.next_action).map((item) => ({ iteration: item.index, action: item.next_action })),
    verification_aborts: snapshot.current_iteration?.verification_abort ? [snapshot.current_iteration.verification_abort] : snapshot.terminal?.kind === 'verification_abort' ? [snapshot.terminal] : [],
    verification_gaps: snapshot.iterations.filter((item) => item.outcome === 'undecidable').map((item) => ({ iteration: item.index, outcome: item.outcome })),
    reflection_refs: snapshot.reflection_refs ?? [],
    improvement_proposal_refs: snapshot.improvement_proposal_refs ?? [],
    generated_at: new Date().toISOString(),
  };
  report.report_digest = envelopeDigest(report, 'report_digest');
  const ref = `convergence-report-${report.report_id}.json`;
  if (existsSync(join(loopDir, ref))) {
    const existing = readJson(join(loopDir, ref));
    if (envelopeDigest(existing, 'report_digest') !== existing.report_digest || existing.loop_id !== snapshot.loop_id) throw new LoopValidationError('已有 Convergence Report 无效');
    return { ...snapshot, convergence_report_ref: { ref, report_id: existing.report_id, report_digest: existing.report_digest } };
  }
  writeNewJson(join(loopDir, ref), report);
  return { ...snapshot, convergence_report_ref: { ref, report_id: report.report_id, report_digest: report.report_digest } };
}

function persistTransition(loopDir, snapshot, kind) {
  const terminalized = ensureConvergenceReport(loopDir, snapshot);
  const next = { ...terminalized, revision: terminalized.revision + 1, updated_at: new Date().toISOString() };
  const previous = readJournal(loopDir).events.at(-1)?.event_digest ?? null;
  const event = { schema_version: 1, revision: next.revision, kind, recorded_at: next.updated_at, previous_event_digest: previous, snapshot: next };
  event.event_digest = envelopeDigest(event, 'event_digest');
  const fd = openSync(join(loopDir, 'events.ndjson'), 'a', 0o600);
  try { appendFileSync(fd, `${canonicalJson(event)}\n`, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
  atomicWriteJson(join(loopDir, 'snapshot.json'), next);
  return next;
}

function withRootLock(stateRoot, callback) {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const path = join(stateRoot, '.loop-runtime.lock');
  const owner = acquireLock(path);
  try { return callback(); } finally { releaseLock(path, owner); }
}

function stateRootForLoop(loopDir) {
  const stateRoot = realpathSync(resolve(loopDir, '..', '..'));
  const identityPath = join(stateRoot, '.state-root-identity.json');
  if (!existsSync(identityPath)) throw new LoopValidationError('state root identity 缺失，疑似复制或越权移动');
  const identity = readJson(identityPath);
  if (identity.schema_version !== 1 || identity.canonical_path !== stateRoot || !DIGEST_PATTERN.test(identity.identity_digest ?? '') || envelopeDigest(identity, 'identity_digest') !== identity.identity_digest) throw new LoopValidationError('state root identity 与当前位置不匹配，拒绝复制态重放');
  return stateRoot;
}

function initializeStateRootIdentity(stateRoot) {
  const canonical = realpathSync(stateRoot);
  const path = join(canonical, '.state-root-identity.json');
  if (existsSync(path)) {
    const identity = readJson(path);
    if (identity.canonical_path !== canonical || envelopeDigest(identity, 'identity_digest') !== identity.identity_digest) throw new LoopValidationError('state root identity 无效');
    return;
  }
  const identity = { schema_version: 1, state_root_id: randomUUID(), canonical_path: canonical };
  identity.identity_digest = envelopeDigest(identity, 'identity_digest');
  writeNewJson(path, identity);
}

function adoptStateRoot(options) {
  const stateRoot = realpathSync(required(options, 'state-root'));
  const loopsDir = join(stateRoot, 'loops');
  if (!existsSync(loopsDir) || !lstatSync(loopsDir).isDirectory()) throw new LoopValidationError('adopt-root 只接受已有 loops/ 的 state root');
  return withRootLock(stateRoot, () => {
    const loopNames = readdirSync(loopsDir).sort();
    if (loopNames.length === 0) throw new LoopValidationError('adopt-root 不用于初始化空 state root；请使用 init');
    for (const name of loopNames) {
      const loopDir = join(loopsDir, name);
      if (!lstatSync(loopDir).isDirectory() || lstatSync(loopDir).isSymbolicLink()) throw new LoopValidationError(`非法 Loop 目录: ${name}`);
      const loaded = loadLoop(loopDir);
      const contract = readJson(join(loopDir, 'contract.json'));
      const profile = readJson(join(loopDir, 'profile.json'));
      const ids = validateContract(contract);
      validateProfile(profile, ids);
      if (loaded.snapshot.loop_id !== name || loaded.snapshot.contract_digest !== contract.contract_digest || loaded.snapshot.verification_profile_digest !== profile.verification_profile_digest) throw new LoopValidationError(`Loop ${name} 的冻结 envelope 与 journal 不一致`);
      const repository = contract.environment?.repository;
      if (typeof repository === 'string' && repository !== 'none' && existsSync(repository) && pathInside(stateRoot, realpathSync(repository))) throw new LoopValidationError(`state root 位于 Loop ${name} 的业务仓库内，拒绝接管`);
    }
    const identityPath = join(stateRoot, '.state-root-identity.json');
    let previous = null;
    if (existsSync(identityPath)) {
      try {
        const value = readJson(identityPath);
        previous = { state_root_id: value.state_root_id ?? null, canonical_path: value.canonical_path ?? null, identity_digest: value.identity_digest ?? null };
      } catch { previous = { state_root_id: null, canonical_path: null, identity_digest: null }; }
    }
    const identity = { schema_version: 1, state_root_id: randomUUID(), canonical_path: stateRoot, adopted_at: new Date().toISOString(), adopted_from: previous };
    identity.identity_digest = envelopeDigest(identity, 'identity_digest');
    atomicWriteJson(identityPath, identity);
    return { adopted: true, state_root: stateRoot, state_root_id: identity.state_root_id, loops: loopNames.length, previous_identity: previous };
  });
}

function mutateLoop(loopDir, expectedRevision, callback) {
  const stateRoot = stateRootForLoop(loopDir);
  return withRootLock(stateRoot, () => {
    const loaded = loadLoop(loopDir);
    let snapshot = loaded.snapshot;
    if (loaded.journal.trailing) atomicWriteText(join(loopDir, 'events.ndjson'), loaded.journal.complete);
    if (loaded.needsRepair) atomicWriteJson(join(loopDir, 'snapshot.json'), snapshot);
    if (expectedRevision !== null && snapshot.revision !== expectedRevision) throw new LoopValidationError(`revision 冲突：expected ${expectedRevision}, actual ${snapshot.revision}`);
    if (snapshot.skill_provenance.content_digest !== skillContentDigest()) {
      if (!['completed', 'stopped'].includes(snapshot.state)) {
        snapshot = persistTransition(loopDir, { ...snapshot, state: 'stopped', terminal: { kind: 'operational_abort', code: 'skill_drift', diagnostics: 'Skill 内容摘要发生变化' } }, 'skill_drift');
        throw new LoopOperationalAbort('skill_drift', `Loop 已停止 at revision ${snapshot.revision}`);
      }
      throw new LoopOperationalAbort('skill_drift', '终态 Loop 的冻结 Skill 已变化，不能恢复或改写');
    }
    try {
      const result = callback(snapshot, stateRoot);
      return persistTransition(loopDir, result.snapshot, result.kind);
    } catch (error) {
      if (error instanceof LoopOperationalAbort && !['completed', 'stopped'].includes(snapshot.state)) persistTransition(loopDir, { ...snapshot, state: 'stopped', terminal: { kind: 'operational_abort', code: error.code, diagnostics: error.message } }, 'operational_abort');
      throw error;
    }
  });
}

function consumedRunIds(stateRoot) {
  const loopsDir = join(stateRoot, 'loops');
  const ids = new Set();
  if (!existsSync(loopsDir)) return ids;
  for (const name of readdirSync(loopsDir)) {
    const loopDir = join(loopsDir, name);
    if (!existsSync(join(loopDir, 'events.ndjson'))) continue;
    for (const event of readJournal(loopDir).events) {
      for (const id of event.snapshot?.consumed_verification_run_ids ?? []) ids.add(id);
    }
  }
  return ids;
}

export function failureSignature(l0Result, reviewResult) {
  const keys = [];
  for (const check of l0Result?.checks ?? []) if (!check.passed) keys.push({ kind: 'l0', check_id: check.check_id });
  for (const finding of reviewResult?.findings ?? []) keys.push({ kind: 'l1', contract_item_id: finding.contract_item_id, class: finding.class });
  const unique = [...new Map(keys.map((item) => [canonicalJson(item), item])).values()].sort((left, right) => {
    const a = canonicalJson(left);
    const b = canonicalJson(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return unique.length === 0 ? null : sha256(Buffer.from(canonicalJson(unique), 'utf8'));
}

function evidenceFailureInputs(evidence) {
  const smoke = evidence.stages?.smoke_l0?.checks ?? [];
  const final = evidence.stages?.final_l0?.checks ?? [];
  const review = evidence.stages?.l1_review?.findings ? evidence.stages.l1_review : null;
  return { l0: { checks: [...smoke, ...final] }, review };
}

function applyOutcome(snapshot, outcome, source) {
  const index = snapshot.current_iteration.index;
  let signature = null;
  if (outcome === 'fail') {
    const inputs = source.kind === 'evidence' ? evidenceFailureInputs(source.value) : { l0: source.value.l0_result, review: source.value.l1_result };
    signature = failureSignature(inputs.l0, inputs.review);
  }
  const iteration = {
    index,
    artifact_ref: snapshot.current_iteration.artifact_ref,
    verification_run_id: snapshot.current_iteration.verification_run_id ?? null,
    outcome,
    failure_signature: signature,
    evidence_digest: source.kind === 'evidence' ? source.value.evidence_digest : null,
    embedded_record_digest: source.kind === 'embedded' ? source.value.record_digest : null,
    completed_at: new Date().toISOString(),
  };
  const iterations = [...snapshot.iterations, iteration];
  if (outcome === 'pass') {
    if (snapshot.human_gate.required) return { ...snapshot, iterations, current_iteration: null, state: 'waiting_human', human_gate: { ...snapshot.human_gate, status: 'pending' }, terminal: null };
    return { ...snapshot, iterations, current_iteration: null, state: 'completed', terminal: { kind: 'completed', outcome: 'pass' } };
  }
  if (outcome === 'blocked_safety' || outcome === 'undecidable') return { ...snapshot, iterations, current_iteration: null, state: 'stopped', terminal: { kind: outcome, outcome } };
  const consecutive = signature ? [...iterations].reverse().findIndex((item) => item.failure_signature !== signature) : 0;
  const count = consecutive === -1 ? iterations.length : consecutive;
  if (index >= snapshot.limits.max_iterations) return { ...snapshot, iterations, current_iteration: null, state: 'stopped', terminal: { kind: 'max_iterations', failure_signature: signature } };
  if (signature && count >= snapshot.limits.consecutive_identical_signature) return { ...snapshot, iterations, current_iteration: null, state: 'stopped', terminal: { kind: 'identical_failure_fuse', failure_signature: signature, consecutive: count } };
  if (snapshot.policy.on_failure === 'stop') return { ...snapshot, iterations, current_iteration: null, state: 'stopped', terminal: { kind: 'policy_stop', failure_signature: signature } };
  return { ...snapshot, iterations, current_iteration: null, state: 'active', terminal: null, next_action: snapshot.policy.on_failure };
}

const CLI_SPEC = {
  capabilities: { values: [], flags: ['json'] },
  'adopt-root': { values: ['state-root'], flags: [] },
  init: { values: ['contract', 'profile', 'provider', 'state-root', 'loop-id', 'workdir', 'max-iterations', 'consecutive-identical-signature', 'on-failure', 'goal-ref'], flags: ['allow-repository-state', 'network-isolated'] },
  'record-artifact': { values: ['loop', 'artifact', 'verification-run-id', 'expected-revision'], flags: [] },
  'run-embedded-l0': { values: ['loop', 'expected-revision'], flags: [] },
  'record-embedded-review': { values: ['loop', 'review', 'assurance', 'reviewer-run-id', 'expected-revision'], flags: [] },
  'record-evidence': { values: ['loop', 'evidence', 'expected-revision'], flags: [] },
  'record-verification-abort': { values: ['loop', 'run-id', 'code', 'diagnostics-ref', 'expected-revision'], flags: [] },
  next: { values: ['loop', 'expected-revision'], flags: [] }, resume: { values: ['loop', 'verification-run-id', 'expected-revision'], flags: [] },
  stop: { values: ['loop', 'reason', 'expected-revision'], flags: [] }, 'human-gate': { values: ['loop', 'decision', 'expected-revision'], flags: [] },
  'record-reflection': { values: ['loop', 'input', 'expected-revision'], flags: [] }, 'convergence-report': { values: ['loop'], flags: [] },
  'propose-improvement': { values: ['loop', 'reflection', 'input', 'expected-revision'], flags: [] },
  status: { values: ['loop'], flags: [] }, inspect: { values: ['loop'], flags: [] }, validate: { values: ['loop'], flags: [] }, doctor: { values: ['loop'], flags: [] },
};

function parseCli(argv) {
  const command = argv[0] ?? '';
  const spec = CLI_SPEC[command];
  if (!spec) throw new LoopValidationError('命令必须是 capabilities/adopt-root/init/record-artifact/run-embedded-l0/record-embedded-review/record-evidence/record-verification-abort/next/resume/stop/human-gate/record-reflection/convergence-report/propose-improvement/status/inspect/validate/doctor');
  const options = {};
  const flags = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new LoopValidationError(`未知位置参数: ${token}`);
    const name = token.slice(2);
    if (spec.flags.includes(name)) {
      if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) throw new LoopValidationError(`--${name} 不接受值`);
      flags.add(name);
    } else if (spec.values.includes(name)) {
      if (argv[index + 1] === undefined || argv[index + 1].startsWith('--')) throw new LoopValidationError(`--${name} 缺少值`);
      options[name] = argv[index + 1]; index += 1;
    } else throw new LoopValidationError(`未知选项: --${name}`);
  }
  return { command, options, flags };
}
function required(options, name) { if (!options[name]) throw new LoopValidationError(`缺少 --${name}`); return options[name]; }
function expectedRevision(options) {
  if (options['expected-revision'] === undefined) return null;
  const value = Number(options['expected-revision']);
  if (!Number.isInteger(value) || value < 0) throw new LoopValidationError('--expected-revision 必须是非负整数');
  return value;
}
function positiveInteger(options, name, fallback) {
  const value = options[name] === undefined ? fallback : Number(options[name]);
  if (!Number.isInteger(value) || value <= 0) throw new LoopValidationError(`--${name} 必须是正整数`);
  return value;
}

function capabilities() {
  return {
    skill: 'run-agent-verify-loop',
    runtime_version: RUNTIME_VERSION,
    providers: ['verify-agent-output', 'embedded'],
    contracts: { task_contract: [1], verification_profile: [1], artifact_ref: [1], review_result: [1], evidence_package: [1], embedded_verification_record: [1], loop_state: [1], reflection_record: [1], convergence_report: [1], improvement_proposal: [1] },
    features: ['journal-recovery', 'revision-lock', 'failure-fuse', 'state-root-unmodified-copy-detection', 'state-root-explicit-adoption', 'skill-drift', 'human-gate', 'terminal-convergence-report', 'evidence-bound-reflection', 'proposed-only-improvement'],
    content_digest: skillContentDigest(),
  };
}

function initialize(options, flags) {
  const contract = readJson(required(options, 'contract'));
  const profile = readJson(required(options, 'profile'));
  const ids = validateContract(contract);
  validateProfile(profile, ids);
  const contentDigest = skillContentDigest();
  validateSkillBinding(contract, contentDigest);
  const provider = required(options, 'provider');
  if (!PROVIDERS.has(provider)) throw new LoopValidationError('provider 必须是 verify-agent-output 或 embedded');
  const stateRoot = resolve(options['state-root'] ?? join(tmpdir(), 'run-agent-verify-loop-state'));
  const loopId = options['loop-id'] ?? randomUUID();
  if (!/^[A-Za-z0-9._-]+$/u.test(loopId)) throw new LoopValidationError('loop-id 非法');
  const workdir = options.workdir ? realpathSync(options.workdir) : null;
  if (provider === 'embedded' && !workdir) throw new LoopValidationError('embedded provider 必须提供 --workdir');
  const contractRepository = typeof contract.environment?.repository === 'string' && contract.environment.repository !== 'none' && existsSync(contract.environment.repository)
    ? realpathSync(contract.environment.repository)
    : null;
  if ((workdir && pathInside(stateRoot, workdir) || contractRepository && pathInside(stateRoot, contractRepository)) && !flags.has('allow-repository-state')) throw new LoopValidationError('state root 位于仓库内；需显式授权');
  if (provider === 'embedded' && profile.runtime.network_policy === 'denied' && !flags.has('network-isolated')) throw new LoopValidationError('embedded network_policy=denied 时必须提供 --network-isolated assurance');
  const maxIterations = positiveInteger(options, 'max-iterations', 3);
  const fuse = positiveInteger(options, 'consecutive-identical-signature', 2);
  const onFailure = options['on-failure'] ?? 'retry';
  if (!['retry', 'rollback', 'change_strategy', 'stop'].includes(onFailure)) throw new LoopValidationError('on-failure 非法');
  return withRootLock(stateRoot, () => {
    initializeStateRootIdentity(stateRoot);
    mkdirSync(join(stateRoot, 'loops'), { recursive: true, mode: 0o700 });
    const loopDir = join(stateRoot, 'loops', loopId);
    mkdirSync(loopDir, { recursive: false, mode: 0o700 });
    const now = new Date().toISOString();
    const snapshot = {
      schema_version: 1,
      runtime_version: RUNTIME_VERSION,
      loop_id: loopId,
      goal_ref: options['goal-ref'] ?? null,
      revision: 0,
      state: 'active',
      contract_digest: contract.contract_digest,
      verification_profile_digest: profile.verification_profile_digest,
      provider,
      limits: { max_iterations: maxIterations, consecutive_identical_signature: fuse },
      policy: { on_failure: onFailure, escalation: [] },
      workdir,
      network_isolation_assurance: flags.has('network-isolated') ? 'host_reported' : 'not_required',
      runtime_repository_identity: null,
      executable_identities: Object.fromEntries(Object.entries(profile.runtime.executable_paths).map(([name, path]) => [name, fileIdentity(path)])),
      argv_file_identities: freezeArgvFiles(profile, workdir),
      current_iteration: null,
      iterations: [],
      consumed_verification_run_ids: [],
      human_gate: { required: profile.human_gate !== 'none', status: profile.human_gate === 'none' ? 'not_required' : 'pending' },
      skill_provenance: { name: 'run-agent-verify-loop', version: RUNTIME_VERSION, content_digest: contentDigest },
      reflection_refs: [],
      improvement_proposal_refs: [],
      convergence_report_ref: null,
      terminal: null,
      created_at: now,
      updated_at: now,
    };
    writeNewJson(join(loopDir, 'contract.json'), contract);
    writeNewJson(join(loopDir, 'profile.json'), profile);
    const initialEvent = { schema_version: 1, revision: 0, kind: 'initialized', recorded_at: now, previous_event_digest: null, snapshot };
    initialEvent.event_digest = envelopeDigest(initialEvent, 'event_digest');
    writeFileSync(join(loopDir, 'events.ndjson'), `${canonicalJson(initialEvent)}\n`, { flag: 'wx', mode: 0o600 });
    atomicWriteJson(join(loopDir, 'snapshot.json'), snapshot);
    return { loop_id: loopId, loop_dir: loopDir, revision: 0, state: 'active', provider };
  });
}

function recordReflection(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  const input = readJson(required(options, 'input'));
  return mutateLoop(loopDir, expectedRevision(options), (snapshot) => {
    const record = buildReflection({ input, runDir: loopDir, scope: { contract_digest: snapshot.contract_digest, loop_id: snapshot.loop_id, iteration: snapshot.current_iteration?.index ?? snapshot.iterations.at(-1)?.index ?? null }, skill: snapshot.skill_provenance, parseJsonStrict, canonicalJson, envelopeDigest });
    mkdirSync(join(loopDir, 'reflections'), { recursive: true, mode: 0o700 });
    const ref = `reflections/${record.reflection_id}.json`;
    writeNewJson(join(loopDir, ref), record);
    return { snapshot: { ...snapshot, reflection_refs: [...snapshot.reflection_refs, { reflection_id: record.reflection_id, reflection_digest: record.reflection_digest, ref }] }, kind: 'reflection_recorded' };
  });
}

function convergenceReport(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  stateRootForLoop(loopDir);
  const snapshot = loadLoop(loopDir).snapshot;
  if (!['completed', 'stopped'].includes(snapshot.state) || !snapshot.convergence_report_ref) throw new LoopValidationError('只有 completed/stopped Loop 才有 Convergence Report');
  const report = readJson(join(loopDir, snapshot.convergence_report_ref.ref));
  if (envelopeDigest(report, 'report_digest') !== report.report_digest || report.report_digest !== snapshot.convergence_report_ref.report_digest) throw new LoopValidationError('Convergence Report digest 无效');
  return report;
}

function proposeImprovement(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  const input = readJson(required(options, 'input'));
  const reflectionPath = resolve(loopDir, required(options, 'reflection'));
  if (!pathInside(reflectionPath, loopDir)) throw new LoopValidationError('Reflection 路径越出 loop 目录');
  return mutateLoop(loopDir, expectedRevision(options), (snapshot) => {
    const reflection = readAndValidateReflection(reflectionPath, 'run-agent-verify-loop', parseJsonStrict, envelopeDigest);
    if (!snapshot.reflection_refs.some((item) => item.reflection_digest === reflection.reflection_digest)) throw new LoopValidationError('Reflection 未登记到当前 Loop');
    const proposal = buildProposal({ input, reflections: [reflection], skill: snapshot.skill_provenance, envelopeDigest });
    mkdirSync(join(loopDir, 'proposals'), { recursive: true, mode: 0o700 });
    const ref = `proposals/${proposal.proposal_id}.json`;
    writeNewJson(join(loopDir, ref), proposal);
    return { snapshot: { ...snapshot, improvement_proposal_refs: [...snapshot.improvement_proposal_refs, { proposal_id: proposal.proposal_id, proposal_digest: proposal.proposal_digest, ref }] }, kind: 'improvement_proposed' };
  });
}

function recordArtifact(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  const artifact = readJson(required(options, 'artifact'));
  validateArtifact(artifact);
  return mutateLoop(loopDir, expectedRevision(options), (snapshot) => {
    if (snapshot.state !== 'active' || snapshot.current_iteration) throw new LoopValidationError('当前 Loop 不能登记新 Artifact');
    const index = snapshot.iterations.length + 1;
    if (index > snapshot.limits.max_iterations) throw new LoopValidationError('已达到 max_iterations');
    const verificationRunId = snapshot.provider === 'verify-agent-output' ? required(options, 'verification-run-id') : null;
    let identity = snapshot.runtime_repository_identity;
    if (snapshot.workdir) {
      identity = verifyGitArtifact(artifact, snapshot.workdir, identity);
      verifyProtectedPaths(artifact, readJson(join(loopDir, 'profile.json')), snapshot.workdir);
    }
    return { snapshot: { ...snapshot, runtime_repository_identity: identity, current_iteration: { index, artifact_ref: artifact, verification_run_id: verificationRunId, review_challenge_nonce: randomUUID(), embedded_l0: null, verification_abort: null }, next_action: 'verify' }, kind: 'artifact_recorded' };
  });
}

function runEmbeddedL0(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  return mutateLoop(loopDir, expectedRevision(options), (snapshot) => {
    if (snapshot.provider !== 'embedded' || snapshot.state !== 'active' || !snapshot.current_iteration || snapshot.current_iteration.embedded_l0) throw new LoopValidationError('当前状态不能运行 embedded L0');
    const result = executeEmbeddedChecks(snapshot, loopDir);
    return { snapshot: { ...snapshot, current_iteration: { ...snapshot.current_iteration, embedded_l0: result } }, kind: 'embedded_l0_recorded' };
  });
}

function recordEmbeddedReview(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  const review = readJson(required(options, 'review'));
  const assurance = required(options, 'assurance');
  const reviewerRunId = required(options, 'reviewer-run-id');
  if (!['host_reported', 'user_relayed'].includes(assurance)) throw new LoopValidationError('assurance 非法');
  return mutateLoop(loopDir, expectedRevision(options), (snapshot) => {
    if (snapshot.provider !== 'embedded' || snapshot.state !== 'active' || !snapshot.current_iteration?.embedded_l0) throw new LoopValidationError('当前状态不能登记 embedded review');
    if (reviewerRunId === snapshot.loop_id || reviewerRunId === snapshot.current_iteration.verification_run_id) throw new LoopValidationError('reviewer-run-id 必须与 controller/verification run 隔离');
    const contract = readJson(join(loopDir, 'contract.json'));
    const ids = validateContract(contract);
    validateReview(review, snapshot, ids);
    const safety = review.findings.some((finding) => finding.class === 'safety');
    const outcome = safety ? 'blocked_safety' : review.verdict === 'undecidable' ? 'undecidable' : !snapshot.current_iteration.embedded_l0.passed || review.verdict === 'fail' ? 'fail' : 'pass';
    const record = {
      schema_version: 1,
      record_type: 'embedded_verification_record',
      record_id: randomUUID(),
      loop_id: snapshot.loop_id,
      iteration: snapshot.current_iteration.index,
      contract_digest: snapshot.contract_digest,
      verification_profile_digest: snapshot.verification_profile_digest,
      artifact_ref: snapshot.current_iteration.artifact_ref,
      l0_result: snapshot.current_iteration.embedded_l0,
      l1_result: review,
      independent_context: { assurance, reviewer_run_id: reviewerRunId },
      outcome,
    };
    record.record_digest = envelopeDigest(record, 'record_digest');
    const path = join(loopDir, `embedded-${snapshot.current_iteration.index}.json`);
    let persisted = record;
    if (existsSync(path)) {
      persisted = readJson(path);
      if (envelopeDigest(persisted, 'record_digest') !== persisted.record_digest
        || persisted.loop_id !== snapshot.loop_id
        || persisted.iteration !== snapshot.current_iteration.index
        || canonicalJson(persisted.artifact_ref) !== canonicalJson(snapshot.current_iteration.artifact_ref)
        || canonicalJson(persisted.l0_result) !== canonicalJson(snapshot.current_iteration.embedded_l0)
        || canonicalJson(persisted.l1_result) !== canonicalJson(review)) {
        throw new LoopValidationError('已存在的 orphan embedded record 与当前 transition 不兼容');
      }
    } else writeNewJson(path, record);
    return { snapshot: applyOutcome(snapshot, persisted.outcome, { kind: 'embedded', value: persisted }), kind: `embedded_${persisted.outcome}` };
  });
}

function recordEvidence(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  const evidence = readJson(required(options, 'evidence'));
  return mutateLoop(loopDir, expectedRevision(options), (snapshot, stateRoot) => {
    if (snapshot.provider !== 'verify-agent-output' || snapshot.state !== 'active' || !snapshot.current_iteration) throw new LoopValidationError('当前状态不能消费 Evidence');
    validateEvidence(evidence, snapshot);
    if (consumedRunIds(stateRoot).has(evidence.run_id)) throw new LoopValidationError(`Evidence run_id 已被消费: ${evidence.run_id}`);
    const path = join(loopDir, `evidence-${snapshot.current_iteration.index}.json`);
    if (existsSync(path)) {
      if (canonicalJson(readJson(path)) !== canonicalJson(evidence)) throw new LoopValidationError('iteration Evidence 文件已存在且内容不同');
    } else writeNewJson(path, evidence);
    const next = applyOutcome({ ...snapshot, consumed_verification_run_ids: [...snapshot.consumed_verification_run_ids, evidence.run_id] }, evidence.terminal_outcome, { kind: 'evidence', value: evidence });
    return { snapshot: next, kind: `evidence_${evidence.terminal_outcome}` };
  });
}

function recordVerificationAbort(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  const runId = required(options, 'run-id');
  const code = required(options, 'code');
  const diagnosticsRef = required(options, 'diagnostics-ref');
  return mutateLoop(loopDir, expectedRevision(options), (snapshot) => {
    if (snapshot.provider !== 'verify-agent-output' || snapshot.state !== 'active' || snapshot.current_iteration?.verification_run_id !== runId) throw new LoopValidationError('verification abort 与当前 iteration 不匹配');
    return { snapshot: { ...snapshot, state: 'stopped', current_iteration: { ...snapshot.current_iteration, verification_abort: { run_id: runId, code, diagnostics_ref: diagnosticsRef } }, terminal: { kind: 'verification_abort', run_id: runId, code, diagnostics_ref: diagnosticsRef } }, kind: 'verification_abort' };
  });
}

function nextIteration(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  return mutateLoop(loopDir, expectedRevision(options), (snapshot) => {
    if (snapshot.state !== 'active' || snapshot.current_iteration || snapshot.iterations.at(-1)?.outcome !== 'fail') throw new LoopValidationError('当前状态不需要 next');
    return { snapshot: { ...snapshot, next_action: 'record_artifact' }, kind: 'next_iteration_ready' };
  });
}

function resume(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  return mutateLoop(loopDir, expectedRevision(options), (snapshot) => {
    if (snapshot.state !== 'stopped' || snapshot.terminal?.kind !== 'verification_abort' || !snapshot.current_iteration) throw new LoopValidationError('只允许恢复 verification_abort');
    const runId = required(options, 'verification-run-id');
    if (runId === snapshot.current_iteration.verification_run_id) throw new LoopValidationError('resume 必须绑定新的 verification run ID');
    return { snapshot: { ...snapshot, state: 'active', terminal: null, convergence_report_ref: null, current_iteration: { ...snapshot.current_iteration, verification_run_id: runId, verification_abort: null }, next_action: 'verify' }, kind: 'verification_resumed' };
  });
}

function stop(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  return mutateLoop(loopDir, expectedRevision(options), (snapshot) => {
    if (!['active', 'waiting_human'].includes(snapshot.state)) throw new LoopValidationError(`不能停止状态 ${snapshot.state}`);
    return { snapshot: { ...snapshot, state: 'stopped', terminal: { kind: 'controller_stop', reason: options.reason ?? 'explicit stop' } }, kind: 'stopped' };
  });
}

function humanGate(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  const decision = required(options, 'decision');
  if (!['approved', 'rejected'].includes(decision)) throw new LoopValidationError('decision 必须 approved/rejected');
  return mutateLoop(loopDir, expectedRevision(options), (snapshot) => {
    if (snapshot.state !== 'waiting_human' || !snapshot.human_gate.required) throw new LoopValidationError('当前没有 pending H gate');
    if (decision === 'approved') return { snapshot: { ...snapshot, state: 'completed', human_gate: { ...snapshot.human_gate, status: 'approved' }, terminal: { kind: 'completed', outcome: 'pass' } }, kind: 'human_gate_approved' };
    return { snapshot: { ...snapshot, state: 'stopped', human_gate: { ...snapshot.human_gate, status: 'rejected' }, terminal: { kind: 'human_gate_rejected' } }, kind: 'human_gate_rejected' };
  });
}

function status(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  stateRootForLoop(loopDir);
  const loaded = loadLoop(loopDir);
  return { ...loaded.snapshot, recovery_needed: loaded.needsRepair };
}

function validateLoop(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  stateRootForLoop(loopDir);
  const loaded = loadLoop(loopDir);
  const snapshot = loaded.snapshot;
  const contract = readJson(join(loopDir, 'contract.json'));
  const profile = readJson(join(loopDir, 'profile.json'));
  const ids = validateContract(contract);
  validateProfile(profile, ids);
  if (contract.contract_digest !== snapshot.contract_digest || profile.verification_profile_digest !== snapshot.verification_profile_digest) throw new LoopValidationError('冻结 envelope 与 snapshot 不一致');
  for (const iteration of snapshot.iterations) {
    const path = iteration.evidence_digest ? join(loopDir, `evidence-${iteration.index}.json`) : join(loopDir, `embedded-${iteration.index}.json`);
    const value = readJson(path);
    const field = iteration.evidence_digest ? 'evidence_digest' : 'record_digest';
    if (envelopeDigest(value, field) !== value[field] || value[field] !== (iteration.evidence_digest ?? iteration.embedded_record_digest)) throw new LoopValidationError(`iteration ${iteration.index} 摘要无效`);
    if (!iteration.evidence_digest) {
      for (const check of value.l0_result?.checks ?? []) {
        const logPath = join(loopDir, check.log_ref);
        if (!existsSync(logPath) || sha256(readFileSync(logPath)) !== check.log_digest) throw new LoopValidationError(`iteration ${iteration.index} 日志摘要无效: ${check.check_id}`);
      }
    }
  }
  for (const ref of snapshot.reflection_refs ?? []) {
    const value = readAndValidateReflection(join(loopDir, ref.ref), 'run-agent-verify-loop', parseJsonStrict, envelopeDigest);
    if (value.reflection_digest !== ref.reflection_digest) throw new LoopValidationError(`Reflection digest 无效: ${ref.ref}`);
    verifyEvidenceRefs(loopDir, value.evidence_refs, parseJsonStrict, canonicalJson);
  }
  for (const ref of snapshot.improvement_proposal_refs ?? []) {
    const value = readJson(join(loopDir, ref.ref));
    if (value.lifecycle !== 'proposed' || value.target_skill?.name !== 'run-agent-verify-loop' || envelopeDigest(value, 'proposal_digest') !== value.proposal_digest || value.proposal_digest !== ref.proposal_digest) throw new LoopValidationError(`Proposal 无效: ${ref.ref}`);
  }
  if (snapshot.convergence_report_ref) convergenceReport({ loop: loopDir });
  return { valid: true, loop_id: snapshot.loop_id, revision: snapshot.revision, state: snapshot.state, iterations: snapshot.iterations.length, recovery_needed: loaded.needsRepair };
}

function doctor(options) {
  const loopDir = realpathSync(required(options, 'loop'));
  const loaded = loadLoop(loopDir);
  const stateRoot = realpathSync(resolve(loopDir, '..', '..'));
  let identityError = null;
  try { stateRootForLoop(loopDir); } catch (error) { identityError = error instanceof Error ? error.message : String(error); }
  const currentDigest = skillContentDigest();
  const drift = currentDigest !== loaded.snapshot.skill_provenance.content_digest;
  const lockPresent = existsSync(join(stateRoot, '.loop-runtime.lock'));
  const findings = identityError ? ['state_root_identity_invalid'] : [];
  return { healthy: !loaded.needsRepair && !lockPresent && !drift && !identityError, loop_id: loaded.snapshot.loop_id, revision: loaded.snapshot.revision, snapshot_matches_journal: !loaded.needsRepair, lock_present: lockPresent, skill_drift: drift, frozen_content_digest: loaded.snapshot.skill_provenance.content_digest, current_content_digest: currentDigest, state_root_identity_valid: !identityError, findings, diagnostics: identityError, recovery_command: identityError ? `adopt-root --state-root ${stateRoot}` : null };
}

export function main(argv = process.argv.slice(2)) {
  const { command, options, flags } = parseCli(argv);
  switch (command) {
    case 'capabilities': return capabilities();
    case 'adopt-root': return adoptStateRoot(options);
    case 'init': return initialize(options, flags);
    case 'record-artifact': return recordArtifact(options);
    case 'run-embedded-l0': return runEmbeddedL0(options);
    case 'record-embedded-review': return recordEmbeddedReview(options);
    case 'record-evidence': return recordEvidence(options);
    case 'record-verification-abort': return recordVerificationAbort(options);
    case 'next': return nextIteration(options);
    case 'resume': return resume(options);
    case 'stop': return stop(options);
    case 'human-gate': return humanGate(options);
    case 'record-reflection': return recordReflection(options);
    case 'convergence-report': return convergenceReport(options);
    case 'propose-improvement': return proposeImprovement(options);
    case 'status': return status(options);
    case 'inspect': return status(options);
    case 'validate': return validateLoop(options);
    case 'doctor': return doctor(options);
    default: throw new LoopValidationError('命令必须是 capabilities/adopt-root/init/record-artifact/run-embedded-l0/record-embedded-review/record-evidence/record-verification-abort/next/resume/stop/human-gate/record-reflection/convergence-report/propose-improvement/status/inspect/validate/doctor');
  }
}

export function isCliEntry(metaUrl, argv1) {
  if (!argv1) return false;
  try { return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1); }
  catch { return pathToFileURL(resolve(argv1)).href === metaUrl; }
}

export function runCli(argv = process.argv.slice(2)) {
  try {
    process.stdout.write(`${JSON.stringify(main(argv), null, 2)}\n`);
    return 0;
  }
  catch (error) {
    const code = error instanceof LoopOperationalAbort ? error.code : error instanceof LoopValidationError ? 'invalid_input' : 'runtime_error';
    process.stderr.write(`${JSON.stringify({ error: code, message: error instanceof Error ? error.message : String(error) })}\n`);
    return error instanceof LoopValidationError ? 2 : 3;
  }
}


if (isCliEntry(import.meta.url, process.argv[1])) process.exitCode = runCli();
