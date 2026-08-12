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
import { buildProposal, buildReflection, readAndValidateReflection, verifyEvidenceRefs } from './reflection-support.mjs';
import { validateJsonSchema } from './json-schema-lite.mjs';

export const RUNTIME_VERSION = '1.0.0';
export const PROTOCOL_VERSION = 1;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FINDING_CLASSES = new Set(['functional', 'scope', 'verification_definition', 'safety']);
const REVIEW_VERDICTS = new Set(['fail', 'no_defect_found', 'undecidable']);
const STAGES = new Set(['smoke', 'final', 'both']);
const TERMINAL_OUTCOMES = new Set(['pass', 'fail', 'undecidable', 'blocked_safety']);
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = (name) => parseJsonStrict(readFileSync(join(SKILL_ROOT, 'references', 'schemas', name), 'utf8'));

export class ValidationError extends Error {}
export class OperationalAbort extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Strict JSON parser that rejects duplicate keys before materializing an object. */
class StrictJsonParser {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
    this.index = 0;
  }

  parse() {
    const value = this.value();
    this.space();
    if (this.index !== this.text.length) throw new ValidationError(`JSON 尾部存在非法内容，位置 ${this.index}`);
    return value;
  }

  space() {
    while (/\s/u.test(this.text[this.index] ?? '')) this.index += 1;
  }

  value() {
    this.space();
    const char = this.text[this.index];
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"') return this.string();
    if (char === '-' || /[0-9]/u.test(char ?? '')) return this.number();
    for (const [token, value] of [['true', true], ['false', false], ['null', null]]) {
      if (this.text.startsWith(token, this.index)) {
        this.index += token.length;
        return value;
      }
    }
    throw new ValidationError(`JSON 值非法，位置 ${this.index}`);
  }

  object() {
    this.index += 1;
    this.space();
    const output = Object.create(null);
    const keys = new Set();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return output;
    }
    while (true) {
      this.space();
      if (this.text[this.index] !== '"') throw new ValidationError(`JSON object key 非字符串，位置 ${this.index}`);
      const key = this.string();
      if (keys.has(key)) throw new ValidationError(`JSON object 存在重复 key: ${key}`);
      keys.add(key);
      this.space();
      if (this.text[this.index] !== ':') throw new ValidationError(`JSON object 缺少冒号，位置 ${this.index}`);
      this.index += 1;
      output[key] = this.value();
      this.space();
      if (this.text[this.index] === '}') {
        this.index += 1;
        return output;
      }
      if (this.text[this.index] !== ',') throw new ValidationError(`JSON object 缺少逗号，位置 ${this.index}`);
      this.index += 1;
    }
  }

  array() {
    this.index += 1;
    this.space();
    const output = [];
    if (this.text[this.index] === ']') {
      this.index += 1;
      return output;
    }
    while (true) {
      output.push(this.value());
      this.space();
      if (this.text[this.index] === ']') {
        this.index += 1;
        return output;
      }
      if (this.text[this.index] !== ',') throw new ValidationError(`JSON array 缺少逗号，位置 ${this.index}`);
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
        assertValidUnicode(value);
        return value;
      }
      if (!escaped && char === '\\') escaped = true;
      else escaped = false;
      this.index += 1;
    }
    throw new ValidationError(`JSON string 未闭合，位置 ${start}`);
  }

  number() {
    const match = this.text.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) throw new ValidationError(`JSON number 非法，位置 ${this.index}`);
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new ValidationError('JSON number 必须是有限数值');
    return value;
  }
}

/** @param {string} value */
function assertValidUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ValidationError('字符串含未配对 high surrogate');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new ValidationError('字符串含未配对 low surrogate');
    }
  }
}

/** @param {string} text */
export function parseJsonStrict(text) {
  return new StrictJsonParser(text).parse();
}

/** @param {unknown} value */
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError('canonical JSON 不接受非有限 number');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'string') {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(object).sort();
    return `{${keys.map((key) => `${canonicalJson(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new ValidationError(`canonical JSON 不支持 ${typeof value}`);
}

/** @param {string|Buffer} value */
function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** @param {Record<string, unknown>} object @param {string} digestField */
export function envelopeDigest(object, digestField) {
  const clone = { ...object };
  delete clone[digestField];
  return sha256(Buffer.from(canonicalJson(clone), 'utf8'));
}

/** @param {string} path */
function readJson(path) {
  return /** @type {Record<string, any>} */ (parseJsonStrict(readFileSync(path, 'utf8')));
}

/** @param {string} path @param {unknown} value */
function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

/** @param {string} path @param {string} value */
function atomicWriteText(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}

/** @param {string} path @param {unknown} value */
function writeNewJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return Boolean(error && typeof error === 'object' && error.code === 'EPERM'); }
}

function recoverOrphanReclaim(path) {
  const reclaimPath = `${path}.reclaim`;
  if (!existsSync(reclaimPath)) return;
  let owner;
  try { owner = parseJsonStrict(readFileSync(reclaimPath, 'utf8')); } catch { throw new ValidationError('run lock reclaim 内容损坏；拒绝自动接管'); }
  if (!Number.isInteger(Number(owner.pid)) || Number(owner.pid) <= 0 || typeof owner.token !== 'string' || !owner.token) throw new ValidationError('run lock reclaim owner 无效；拒绝自动接管');
  if (processIsAlive(Number(owner.pid))) throw new ValidationError('run lock 正在执行 stale recovery');
  let latest;
  try { latest = parseJsonStrict(readFileSync(reclaimPath, 'utf8')); } catch (error) { if (error && typeof error === 'object' && error.code === 'ENOENT') return; throw new ValidationError('run lock reclaim 内容损坏；拒绝自动接管'); }
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
      if (existsSync(`${path}.reclaim`)) throw new ValidationError('run lock 正在执行 stale recovery');
      linkSync(candidate, path); unlinkSync(candidate); return owner;
    }
    catch (error) {
      try { unlinkSync(candidate); } catch {}
      if (error instanceof ValidationError) throw error;
      if (!error || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
      let current;
      try { current = parseJsonStrict(readFileSync(path, 'utf8')); } catch { throw new ValidationError('run lock 内容损坏；拒绝自动接管'); }
      if (!Number.isInteger(Number(current.pid)) || Number(current.pid) <= 0) throw new ValidationError('run lock owner 无效；拒绝自动接管');
      if (processIsAlive(Number(current.pid))) throw new ValidationError(`run lock 正被 PID ${current.pid} 持有`);
      const reclaimPath = `${path}.reclaim`;
      const reclaimOwner = { pid: process.pid, token: randomUUID(), acquired_at: new Date().toISOString() };
      const reclaimCandidate = `${reclaimPath}.${reclaimOwner.pid}.${reclaimOwner.token}.candidate`;
      const reclaimFd = openSync(reclaimCandidate, 'wx', 0o600);
      try { writeFileSync(reclaimFd, `${JSON.stringify(reclaimOwner)}\n`); fsyncSync(reclaimFd); } finally { closeSync(reclaimFd); }
      try { linkSync(reclaimCandidate, reclaimPath); } catch (reclaimError) { if (!reclaimError || typeof reclaimError !== 'object' || reclaimError.code !== 'EEXIST') throw reclaimError; throw new ValidationError('run lock 正在执行 stale recovery'); }
      finally { try { unlinkSync(reclaimCandidate); } catch {} }
      try {
        let latest;
        try { latest = parseJsonStrict(readFileSync(path, 'utf8')); } catch (latestError) { if (latestError && typeof latestError === 'object' && latestError.code === 'ENOENT') continue; throw new ValidationError('run lock 内容损坏；拒绝自动接管'); }
        if (Number(latest.pid) !== Number(current.pid) || latest.token !== current.token) continue;
        if (processIsAlive(Number(latest.pid))) throw new ValidationError(`run lock 正被 PID ${latest.pid} 持有`);
        unlinkSync(path);
      } finally { releaseLock(reclaimPath, reclaimOwner); }
    }
  }
  throw new ValidationError('无法获取 run lock');
}

export function releaseLock(path, owner) {
  let current;
  try { current = parseJsonStrict(readFileSync(path, 'utf8')); } catch (error) { if (error && typeof error === 'object' && error.code === 'ENOENT') return false; throw new ValidationError('run lock 在持有期间损坏；拒绝删除未知 owner 的 lock'); }
  if (current.pid !== owner.pid || current.token !== owner.token) return false;
  unlinkSync(path);
  return true;
}

/** @param {string} root */
function manifestFiles(root) {
  const output = [];
  const visit = (absolute, relativePath) => {
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(join(absolute, name), relativePath ? `${relativePath}/${name}` : name);
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      const bytes = readFileSync(absolute);
      output.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) });
    }
  };
  for (const name of ['SKILL.md', 'agents', 'references', 'scripts']) {
    const absolute = join(root, name);
    if (existsSync(absolute)) visit(absolute, name);
  }
  return output.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/** @param {string} [root] */
export function skillContentDigest(root = SKILL_ROOT) {
  return sha256(Buffer.from(canonicalJson(manifestFiles(realpathSync(root))), 'utf8'));
}

/** @param {string[]} args @param {string} cwd @param {BufferEncoding} [encoding] */
function git(args, cwd, encoding = 'utf8') {
  return execFileSync('git', args, { cwd, encoding, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** @param {string[]} args @param {string} cwd */
function gitStatus(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** @param {Record<string, any>} artifact @param {string} workdir @param {string|null} frozenIdentity */
export function verifyGitArtifact(artifact, workdir, frozenIdentity = null) {
  const root = realpathSync(String(git(['rev-parse', '--show-toplevel'], workdir)).trim());
  if (root !== realpathSync(workdir)) throw new OperationalAbort('stale_precondition', 'workdir 必须是 Git worktree 根目录');
  const objectFormat = String(git(['rev-parse', '--show-object-format'], root)).trim();
  if (artifact.object_format !== objectFormat) throw new OperationalAbort('stale_precondition', 'Artifact object_format 与仓库不一致');
  const shaLength = objectFormat === 'sha256' ? 64 : objectFormat === 'sha1' ? 40 : 0;
  if (!shaLength) throw new OperationalAbort('stale_precondition', `不支持 Git object format: ${objectFormat}`);
  for (const field of ['base_sha', 'artifact_sha']) {
    const value = String(artifact[field] ?? '');
    if (!new RegExp(`^[0-9a-f]{${shaLength}}$`, 'u').test(value)) throw new ValidationError(`${field} 不是完整 ${objectFormat} object id`);
    if (String(git(['cat-file', '-t', value], root)).trim() !== 'commit') throw new ValidationError(`${field} 不是 commit object`);
  }
  if (gitStatus(['merge-base', '--is-ancestor', artifact.base_sha, artifact.artifact_sha], root).status !== 0) {
    throw new ValidationError('base_sha 不是 artifact_sha 的 ancestor');
  }
  const head = String(git(['rev-parse', 'HEAD'], root)).trim();
  if (head !== artifact.artifact_sha) throw new OperationalAbort('stale_precondition', 'HEAD 已偏离冻结 artifact_sha');
  const dirty = /** @type {Buffer} */ (git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root, 'buffer'));
  if (dirty.length > 0) throw new OperationalAbort('stale_precondition', '验证 workdir 不是 clean 状态');
  const roots = String(git(['rev-list', '--max-parents=0', artifact.artifact_sha], root)).trim().split('\n').filter(Boolean).sort();
  const runtimeIdentity = `git:${objectFormat}:${sha256(Buffer.from(canonicalJson(roots), 'utf8'))}`;
  if (frozenIdentity && runtimeIdentity !== frozenIdentity) throw new OperationalAbort('stale_precondition', 'repository identity 已变化');
  return { workdir: root, runtime_repository_identity: runtimeIdentity };
}

/** @param {string} path */
function validateProfilePath(path) {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('..') || path.includes(':(') || /[*?[\]]/u.test(path)) {
    throw new ValidationError(`非法 verifier path: ${path}`);
  }
  const core = path.endsWith('/') ? path.slice(0, -1) : path;
  if (!core || core.split('/').some((part) => !part || part === '.' || part === '..')) throw new ValidationError(`非法 verifier path: ${path}`);
}

/** @param {string} path @param {string} rule */
function pathMatches(path, rule) {
  return rule.endsWith('/') ? path.startsWith(rule) : path === rule;
}

/** @param {Record<string, any>} artifact @param {Record<string, any>} profile @param {string} workdir */
function verifyProtectedPaths(artifact, profile, workdir) {
  const protectedPaths = profile.protected_verifier_paths;
  const allowed = profile.allowed_validation_changes;
  for (const path of [...protectedPaths, ...allowed]) validateProfilePath(path);
  const bytes = /** @type {Buffer} */ (git(['diff', '--name-status', '-z', '--no-renames', artifact.base_sha, artifact.artifact_sha], workdir, 'buffer'));
  const tokens = bytes.toString('utf8').split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < tokens.length; index += 2) {
    if (tokens[index + 1]) paths.push(tokens[index + 1]);
  }
  const violations = paths.filter((path) => protectedPaths.some((rule) => pathMatches(path, rule)) && !allowed.some((rule) => pathMatches(path, rule)));
  if (violations.length > 0) throw new OperationalAbort('protected_path_violation', `未授权修改 verifier path: ${violations.join(', ')}`);
  return { changed_paths: paths, protected_path_violations: [] };
}

/** @param {Record<string, any>} contract */
function validateContract(contract) {
  if (contract.schema_version !== 1) throw new ValidationError('Task Contract schema_version 必须为 1');
  for (const field of ['contract_id', 'objective', 'contract_digest']) if (!contract[field]) throw new ValidationError(`Task Contract 缺少 ${field}`);
  if (!contract.scope || !Array.isArray(contract.scope.include) || !Array.isArray(contract.scope.exclude) || [...contract.scope.include, ...contract.scope.exclude].some((item) => typeof item !== 'string' || !item)) throw new ValidationError('Task Contract scope 无效');
  if (!contract.permissions || !['read_only', 'write'].includes(contract.permissions.mode) || !Array.isArray(contract.permissions.writable_paths) || contract.permissions.writable_paths.some((item) => typeof item !== 'string' || !item)) throw new ValidationError('Task Contract permissions 无效');
  if (contract.permissions.mode === 'read_only' && contract.permissions.writable_paths.length) throw new ValidationError('read_only 合同不能声明 writable_paths');
  if (!contract.environment || typeof contract.environment.repository !== 'string' || !contract.environment.repository || !['shared_tree', 'worktree', 'caller_supplied'].includes(contract.environment.isolation)) throw new ValidationError('Task Contract environment 无效');
  if (!Array.isArray(contract.stop_conditions) || !contract.extensions || typeof contract.extensions !== 'object' || Array.isArray(contract.extensions)) throw new ValidationError('Task Contract stop_conditions/extensions 无效');
  if (!Array.isArray(contract.acceptance) || contract.acceptance.length === 0) throw new ValidationError('Task Contract acceptance 不能为空');
  const ids = new Set();
  for (const item of contract.acceptance) {
    if (!item?.contract_item_id || !item?.requirement) throw new ValidationError('acceptance item 缺少稳定 ID 或 requirement');
    if (ids.has(item.contract_item_id)) throw new ValidationError(`重复 contract_item_id: ${item.contract_item_id}`);
    ids.add(item.contract_item_id);
  }
  if (!Array.isArray(contract.skill_set)) throw new ValidationError('Task Contract skill_set 必须是数组');
  if (!DIGEST_PATTERN.test(contract.contract_digest) || envelopeDigest(contract, 'contract_digest') !== contract.contract_digest) {
    throw new ValidationError('Task Contract digest 无效');
  }
  return ids;
}

/** @param {Record<string, any>} profile @param {Set<string>} acceptanceIds */
function validateProfile(profile, acceptanceIds) {
  try { validateJsonSchema(profile, schema('verification-profile-v1.schema.json'), 'Verification Profile'); } catch (error) { throw new ValidationError(error instanceof Error ? error.message : String(error)); }
  if (profile.schema_version !== 1 || !profile.profile_id) throw new ValidationError('Verification Profile schema/profile_id 无效');
  if (!Array.isArray(profile.l0_checks) || profile.l0_checks.length === 0 || !Array.isArray(profile.l1_review) || profile.l1_review.length === 0) throw new ValidationError('Verification Profile checks/review 必须是非空数组');
  const checkIds = new Set();
  for (const check of profile.l0_checks) {
    if (!check?.check_id || checkIds.has(check.check_id)) throw new ValidationError(`L0 check_id 缺失或重复: ${check?.check_id}`);
    checkIds.add(check.check_id);
    if (!Array.isArray(check.argv) || check.argv.length === 0 || check.argv.some((item) => typeof item !== 'string')) throw new ValidationError(`${check.check_id} argv 必须是非空字符串数组`);
    if (!STAGES.has(check.stage)) throw new ValidationError(`${check.check_id} stage 非法`);
    if (!Number.isInteger(check.timeout_ms) || check.timeout_ms <= 0) throw new ValidationError(`${check.check_id} timeout_ms 非法`);
    if (!Array.isArray(check.expected_exit_codes) || check.expected_exit_codes.length === 0 || check.expected_exit_codes.some((code) => !Number.isInteger(code))) throw new ValidationError(`${check.check_id} expected_exit_codes 非法`);
    if (!check.cwd_rel || isAbsolute(check.cwd_rel) || check.cwd_rel.includes('\\') || check.cwd_rel.split('/').some((part) => part === '..')) throw new ValidationError(`${check.check_id} cwd_rel 非法`);
  }
  if (![...profile.l0_checks].some((check) => ['smoke', 'both'].includes(check.stage)) || ![...profile.l0_checks].some((check) => ['final', 'both'].includes(check.stage))) throw new ValidationError('Verification Profile 必须覆盖 smoke 与 final L0');
  for (const review of profile.l1_review) {
    if (!acceptanceIds.has(review?.contract_item_id)) throw new ValidationError(`L1 引用未知 contract_item_id: ${review?.contract_item_id}`);
    if (!Array.isArray(review.lenses) || review.lenses.some((lens) => !FINDING_CLASSES.has(lens))) throw new ValidationError(`L1 lenses 非法: ${review?.contract_item_id}`);
  }
  if (!Array.isArray(profile.protected_verifier_paths) || !Array.isArray(profile.allowed_validation_changes)) throw new ValidationError('Profile path 字段必须是数组');
  if (!profile.runtime || !Array.isArray(profile.runtime.env_allowlist) || profile.runtime.env_allowlist.some((name) => typeof name !== 'string' || !name) || typeof profile.runtime.executable_paths !== 'object') throw new ValidationError('Profile runtime 无效');
  if (!['disabled', 'isolated', 'trusted_identity'].includes(profile.runtime.cache_policy)) throw new ValidationError('cache_policy 非法');
  if (!['denied', 'contract_authorized'].includes(profile.runtime.network_policy)) throw new ValidationError('network_policy 非法');
  if (!Number.isInteger(profile.runtime.max_log_bytes) || profile.runtime.max_log_bytes <= 0) throw new ValidationError('max_log_bytes 非法');
  if (!['none', 'release', 'destructive', 'external_side_effect'].includes(profile.human_gate)) throw new ValidationError('human_gate 非法');
  for (const check of profile.l0_checks) {
    const executable = profile.runtime.executable_paths[check.argv[0]];
    if (!executable || !isAbsolute(executable) || !statSync(executable).isFile()) throw new ValidationError(`未冻结绝对 executable: ${check.argv[0]}`);
  }
  if (!DIGEST_PATTERN.test(profile.verification_profile_digest) || envelopeDigest(profile, 'verification_profile_digest') !== profile.verification_profile_digest) {
    throw new ValidationError('Verification Profile digest 无效');
  }
}

/** @param {Record<string, any>} artifact */
function validateArtifact(artifact) {
  if (artifact.schema_version !== 1) throw new ValidationError('Artifact Ref schema_version 必须为 1');
  for (const field of ['provider', 'repository_id', 'object_format', 'base_sha', 'artifact_sha']) if (!artifact[field]) throw new ValidationError(`Artifact Ref 缺少 ${field}`);
  if (!['manage-worktrees', 'caller-supplied'].includes(artifact.provider)) throw new ValidationError('Artifact provider 非法');
  if (!['sha1', 'sha256'].includes(artifact.object_format)) throw new ValidationError('Artifact object_format 非法');
}

/** @param {Record<string, any>} contract @param {string} contentDigest */
function validateSkillBinding(contract, contentDigest) {
  const entry = contract.skill_set.find((item) => item?.name === 'verify-agent-output');
  if (!entry) throw new ValidationError('Task Contract skill_set 未冻结 verify-agent-output');
  if (entry.content_digest !== contentDigest) throw new ValidationError('Task Contract 中 verify-agent-output content_digest 与当前安装不一致');
}

/** @param {string} candidate @param {string} parent */
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

/** @param {string} text @param {Record<string,string>} environment @param {number} maxBytes */
function sanitizeLog(text, environment, maxBytes) {
  let sanitized = text;
  for (const [name, value] of Object.entries(environment)) {
    if (value && /(token|secret|password|credential|api[_-]?key)/iu.test(name)) sanitized = sanitized.split(value).join('[REDACTED]');
  }
  sanitized = sanitized
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:ghp|glpat|sk)-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED]');
  const bytes = Buffer.from(sanitized, 'utf8');
  if (bytes.length <= maxBytes) return sanitized;
  return `${bytes.subarray(0, maxBytes).toString('utf8')}\n[TRUNCATED]\n`;
}

/** @param {string} runDir @param {string} log */
function persistLog(runDir, log) {
  const digest = sha256(Buffer.from(log, 'utf8'));
  const name = `${digest.slice('sha256:'.length)}.log`;
  const directory = join(runDir, 'logs');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name);
  if (!existsSync(path)) writeFileSync(path, log, { flag: 'wx', mode: 0o600 });
  return { log_digest: digest, log_ref: `logs/${name}` };
}

function executableIdentity(path) {
  const absolute = realpathSync(path);
  const stat = statSync(absolute);
  if (!stat.isFile()) throw new ValidationError(`executable 不是文件: ${path}`);
  return { path: absolute, size: stat.size, mode: stat.mode, digest: sha256(readFileSync(absolute)) };
}

function verifyExecutable(snapshot, name, path) {
  const frozen = snapshot.executable_identities?.[name];
  let live;
  try { live = executableIdentity(path); } catch (error) { throw new OperationalAbort('check_runtime_failure', `冻结 executable 不可用: ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!frozen || canonicalJson(live) !== canonicalJson(frozen)) throw new OperationalAbort('check_runtime_failure', `冻结 executable 已变化: ${name}`);
}

function freezeArgvFiles(profile, workdir) {
  const frozen = {};
  for (const check of profile.l0_checks) {
    const cwd = resolve(workdir, check.cwd_rel);
    for (let index = 1; index < check.argv.length; index += 1) {
      const argument = check.argv[index];
      if (argument.startsWith('-')) continue;
      const candidate = isAbsolute(argument) ? argument : resolve(cwd, argument);
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      const absolute = realpathSync(candidate);
      frozen[`${check.check_id}:${index}`] = { argument_path: resolve(candidate), ...executableIdentity(absolute) };
    }
  }
  return frozen;
}

function verifyArgvFiles(snapshot, check) {
  for (const [key, identity] of Object.entries(snapshot.argv_file_identities ?? {})) {
    const [checkId, rawIndex] = key.split(':');
    if (checkId !== check.check_id) continue;
    const index = Number(rawIndex);
    const argument = check.argv[index];
    const cwd = resolve(snapshot.workdir, check.cwd_rel);
    const candidate = isAbsolute(argument) ? argument : resolve(cwd, argument);
    let live;
    try { live = { argument_path: resolve(candidate), ...executableIdentity(candidate) }; } catch (error) { throw new OperationalAbort('check_runtime_failure', `冻结 argv 文件不可用: ${key}: ${error instanceof Error ? error.message : String(error)}`); }
    if (canonicalJson(live) !== canonicalJson(identity)) throw new OperationalAbort('check_runtime_failure', `冻结 argv 文件已变化: ${key}`);
  }
}

/** @param {Record<string, any>} snapshot @param {'smoke'|'final'} stage @param {string} runDir */
function executeChecks(snapshot, stage, runDir) {
  verifyGitArtifact(snapshot.artifact_ref, snapshot.workdir, snapshot.runtime_repository_identity);
  const profile = readJson(join(runDir, 'profile.json'));
  const checks = profile.l0_checks.filter((check) => check.stage === stage || check.stage === 'both');
  const environment = {};
  for (const name of profile.runtime.env_allowlist) if (process.env[name] !== undefined) environment[name] = String(process.env[name]);
  const results = [];
  for (const check of checks) {
    verifyGitArtifact(snapshot.artifact_ref, snapshot.workdir, snapshot.runtime_repository_identity);
    const executable = profile.runtime.executable_paths[check.argv[0]];
    verifyExecutable(snapshot, check.argv[0], executable);
    verifyArgvFiles(snapshot, check);
    const cwd = resolve(snapshot.workdir, check.cwd_rel);
    if (!pathInside(cwd, snapshot.workdir)) throw new ValidationError(`${check.check_id} cwd_rel 越出 workdir`);
    const result = spawnSync(executable, check.argv.slice(1), {
      cwd,
      env: environment,
      encoding: 'utf8',
      timeout: check.timeout_ms,
      maxBuffer: Math.max(profile.runtime.max_log_bytes * 4, 1024 * 1024),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timedOut = result.error?.code === 'ETIMEDOUT';
    const exitCode = Number.isInteger(result.status) ? result.status : null;
    const log = sanitizeLog([result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n'), environment, profile.runtime.max_log_bytes);
    const persisted = persistLog(runDir, log);
    if (result.error && !timedOut) throw new OperationalAbort('check_runtime_failure', `${check.check_id} 无法执行，诊断 ${persisted.log_ref}: ${result.error.message}`);
    if (exitCode === null && !timedOut) throw new OperationalAbort('check_runtime_failure', `${check.check_id} 未产生退出码，诊断 ${persisted.log_ref}`);
    results.push({
      check_id: check.check_id,
      argv: check.argv,
      exit_code: exitCode,
      expected_exit_codes: check.expected_exit_codes,
      timed_out: timedOut,
      passed: !timedOut && check.expected_exit_codes.includes(exitCode),
      ...persisted,
    });
    verifyGitArtifact(snapshot.artifact_ref, snapshot.workdir, snapshot.runtime_repository_identity);
  }
  return { stage, checks: results, passed: results.every((item) => item.passed) };
}

/** @param {string} runDir */
function readJournal(runDir) {
  const path = join(runDir, 'events.ndjson');
  if (!existsSync(path)) throw new ValidationError('run 缺少 events.ndjson');
  const text = readFileSync(path, 'utf8');
  const lastNewline = text.lastIndexOf('\n');
  const complete = lastNewline < 0 ? '' : text.slice(0, lastNewline + 1);
  const trailing = lastNewline === text.length - 1 ? '' : text.slice(lastNewline + 1);
  const events = complete.split('\n').filter(Boolean).map((line) => parseJsonStrict(line));
  let previous = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.revision !== index || event.previous_event_digest !== previous || !DIGEST_PATTERN.test(event.event_digest ?? '') || envelopeDigest(event, 'event_digest') !== event.event_digest) throw new ValidationError(`event journal 链在 revision ${index} 无效`);
    previous = event.event_digest;
  }
  return { events, complete, trailing };
}

/** @param {string} runDir */
function loadSnapshot(runDir) {
  const journal = readJournal(runDir);
  const { events } = journal;
  if (events.length === 0) throw new ValidationError('event journal 为空');
  const latest = events.at(-1).snapshot;
  const snapshotPath = join(runDir, 'snapshot.json');
  if (!existsSync(snapshotPath)) return { snapshot: latest, needsRepair: true, events, journal };
  const snapshot = readJson(snapshotPath);
  const snapshotDrift = snapshot.revision !== latest.revision || canonicalJson(snapshot) !== canonicalJson(latest);
  const needsRepair = snapshotDrift || Boolean(journal.trailing);
  return { snapshot: snapshotDrift ? latest : snapshot, needsRepair, events, journal };
}

/** @param {string} runDir @param {Record<string, any>} snapshot @param {string} kind */
function persistTransition(runDir, snapshot, kind) {
  const next = { ...snapshot, revision: snapshot.revision + 1, updated_at: new Date().toISOString() };
  const previous = readJournal(runDir).events.at(-1)?.event_digest ?? null;
  const event = { schema_version: 1, revision: next.revision, kind, recorded_at: next.updated_at, previous_event_digest: previous, snapshot: next };
  event.event_digest = envelopeDigest(event, 'event_digest');
  const fd = openSync(join(runDir, 'events.ndjson'), 'a', 0o600);
  try {
    appendFileSync(fd, `${canonicalJson(event)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  atomicWriteJson(join(runDir, 'snapshot.json'), next);
  return next;
}

/** @param {string} runDir @param {() => any} callback */
function withLock(runDir, callback) {
  const path = join(runDir, '.lock');
  const owner = acquireLock(path);
  try { return callback(); } finally { releaseLock(path, owner); }
}

/** @param {string} runDir @param {number|null} expectedRevision @param {(snapshot:Record<string,any>)=>{snapshot:Record<string,any>,kind:string}} callback */
function mutateRun(runDir, expectedRevision, callback) {
  return withLock(runDir, () => {
    const loaded = loadSnapshot(runDir);
    let snapshot = loaded.snapshot;
    if (loaded.journal.trailing) atomicWriteText(join(runDir, 'events.ndjson'), loaded.journal.complete);
    if (loaded.needsRepair) atomicWriteJson(join(runDir, 'snapshot.json'), snapshot);
    if (expectedRevision !== null && snapshot.revision !== expectedRevision) throw new ValidationError(`revision 冲突：expected ${expectedRevision}, actual ${snapshot.revision}`);
    const currentDigest = skillContentDigest();
    if (!snapshot.terminal && snapshot.skill_provenance.content_digest !== currentDigest) {
      snapshot = persistTransition(runDir, {
        ...snapshot,
        status: 'aborted',
        terminal: null,
        operational_abort: { code: 'skill_drift', diagnostics: 'Skill 内容摘要与 init 时不一致' },
      }, 'operational_abort');
      throw new OperationalAbort('skill_drift', `run 已记录 abort at revision ${snapshot.revision}`);
    }
    try {
      const result = callback(snapshot);
      return persistTransition(runDir, result.snapshot, result.kind);
    } catch (error) {
      if (error instanceof OperationalAbort && !snapshot.terminal && snapshot.status !== 'aborted') {
        persistTransition(runDir, {
          ...snapshot,
          status: 'aborted',
          terminal: null,
          operational_abort: { code: error.code, diagnostics: error.message },
        }, 'operational_abort');
      }
      throw error;
    }
  });
}

/** @param {Record<string, any>} review @param {Record<string, any>} snapshot @param {Set<string>} acceptanceIds */
function validateReview(review, snapshot, acceptanceIds) {
  try { validateJsonSchema(review, schema('review-result-v1.schema.json'), 'Review Result'); } catch (error) { throw new ValidationError(error instanceof Error ? error.message : String(error)); }
  if (review.schema_version !== 1 || !review.review_result_id) throw new ValidationError('Review Result schema/id 无效');
  if (review.contract_digest !== snapshot.contract_digest || review.verification_profile_digest !== snapshot.verification_profile_digest) throw new ValidationError('Review Result contract/profile binding 不匹配');
  if (review.challenge_nonce !== snapshot.review_challenge_nonce) throw new ValidationError('Review Result challenge nonce 不匹配或已重放');
  if (canonicalJson(review.artifact_ref) !== canonicalJson(snapshot.artifact_ref)) throw new ValidationError('Review Result Artifact binding 不匹配');
  if (!REVIEW_VERDICTS.has(review.verdict) || !Array.isArray(review.findings) || !Array.isArray(review.forensics)) throw new ValidationError('Review Result verdict/findings/forensics 无效');
  for (const finding of review.findings) {
    if (!acceptanceIds.has(finding?.contract_item_id)) throw new ValidationError(`finding 引用未知 contract_item_id: ${finding?.contract_item_id}`);
    if (!FINDING_CLASSES.has(finding?.class)) throw new ValidationError(`finding class 非法: ${finding?.class}`);
    for (const field of ['evidence', 'expected', 'actual']) if (typeof finding[field] !== 'string' || !finding[field].trim()) throw new ValidationError(`finding ${field} 必须是非空字符串`);
  }
  if (review.forensics.some((item) => typeof item !== 'string' || !item.trim())) throw new ValidationError('forensics 必须是非空字符串数组');
  if (review.verdict === 'fail' && review.findings.length === 0) throw new ValidationError('fail 必须包含 finding');
  if (review.verdict === 'no_defect_found' && (review.findings.length > 0 || review.forensics.length === 0)) throw new ValidationError('no_defect_found 必须无 finding 且有 forensics');
  if (review.verdict === 'undecidable' && review.findings.length === 0) throw new ValidationError('undecidable 必须说明缺失证据');
  if (!DIGEST_PATTERN.test(review.review_result_digest) || envelopeDigest(review, 'review_result_digest') !== review.review_result_digest) throw new ValidationError('Review Result digest 无效');
}

/** @param {Record<string, any>} snapshot @param {string} runDir @param {string} outcome */
function terminalSnapshot(snapshot, runDir, outcome) {
  if (!TERMINAL_OUTCOMES.has(outcome)) throw new ValidationError(`非法 terminal outcome: ${outcome}`);
  const profile = readJson(join(runDir, 'profile.json'));
  const limitations = [];
  if (profile.runtime.network_policy === 'denied' && snapshot.network_isolation_assurance !== 'host_reported') limitations.push('network_policy_not_os_enforced');
  if (profile.runtime.cache_policy === 'disabled') limitations.push('generic_runtime_cannot_prove_all_tool_caches_disabled');
  if (!snapshot.review_result) limitations.push('l1_not_run');
  const evidence = {
    schema_version: 1,
    run_id: snapshot.run_id,
    protocol_version: PROTOCOL_VERSION,
    runtime_version: RUNTIME_VERSION,
    contract_digest: snapshot.contract_digest,
    verification_profile_digest: snapshot.verification_profile_digest,
    artifact_ref: snapshot.artifact_ref,
    stages: {
      smoke_l0: snapshot.stages.smoke_l0 ?? { status: 'not_run' },
      l1_review: snapshot.review_result ?? { status: 'not_run' },
      final_l0: snapshot.stages.final_l0 ?? { status: 'not_run' },
    },
    terminal_outcome: outcome,
    completion_scope: 'verification_only',
    human_gate_required: profile.human_gate !== 'none',
    provenance: {
      provider: 'verify-agent-output',
      verified_at: snapshot.created_at,
      verifier_run_id: snapshot.review_provenance?.verifier_run_id ?? 'not_run',
      isolation_assurance: snapshot.review_provenance?.isolation_assurance ?? snapshot.planned_isolation_assurance,
      skill: snapshot.skill_provenance,
      limitations,
    },
  };
  evidence.evidence_digest = envelopeDigest(evidence, 'evidence_digest');
  const evidencePath = join(runDir, 'evidence.json');
  let persisted = evidence;
  if (existsSync(evidencePath)) {
    persisted = readJson(evidencePath);
    if (canonicalJson(persisted) !== canonicalJson(evidence)) {
      throw new ValidationError('已存在的 orphan Evidence 与当前 terminal transition 不兼容');
    }
  } else writeNewJson(evidencePath, evidence);
  return {
    ...snapshot,
    status: 'terminal',
    stages: {
      ...snapshot.stages,
      smoke_l0: persisted.stages.smoke_l0?.status === 'not_run'
        ? (snapshot.stages.smoke_l0 ?? { status: 'not_run' })
        : persisted.stages.smoke_l0,
      final_l0: persisted.stages.final_l0?.status === 'not_run'
        ? (snapshot.stages.final_l0 ?? { status: 'not_run' })
        : persisted.stages.final_l0,
    },
    terminal: { outcome, evidence_ref: 'evidence.json', evidence_digest: persisted.evidence_digest },
  };
}

/** @param {string[]} argv */
const CLI_SPEC = {
  capabilities: { values: [], flags: ['json'] },
  init: { values: ['contract', 'profile', 'artifact', 'workdir', 'state-root', 'isolation-assurance', 'run-id'], flags: ['network-isolated', 'allow-repository-state'] },
  'run-smoke': { values: ['run', 'expected-revision'], flags: [] },
  'review-input': { values: ['run'], flags: [] },
  'record-review': { values: ['run', 'review', 'verifier-run-id', 'isolation-assurance', 'expected-revision'], flags: [] },
  'run-final': { values: ['run', 'expected-revision'], flags: [] },
  'record-reflection': { values: ['run', 'input', 'expected-revision'], flags: [] },
  'propose-improvement': { values: ['run', 'reflection', 'input', 'expected-revision'], flags: [] },
  status: { values: ['run'], flags: [] }, inspect: { values: ['run'], flags: [] }, validate: { values: ['run'], flags: [] }, doctor: { values: ['run'], flags: [] },
};

function parseCli(argv) {
  const command = argv[0] ?? '';
  const spec = CLI_SPEC[command];
  if (!spec) throw new ValidationError('命令必须是 capabilities/init/run-smoke/review-input/record-review/run-final/record-reflection/propose-improvement/status/inspect/validate/doctor');
  const options = {};
  const flags = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new ValidationError(`未知位置参数: ${token}`);
    const name = token.slice(2);
    if (spec.flags.includes(name)) {
      if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) throw new ValidationError(`--${name} 不接受值`);
      flags.add(name);
    } else if (spec.values.includes(name)) {
      if (argv[index + 1] === undefined || argv[index + 1].startsWith('--')) throw new ValidationError(`--${name} 缺少值`);
      options[name] = argv[index + 1];
      index += 1;
    } else throw new ValidationError(`未知选项: --${name}`);
  }
  return { command, options, flags };
}

/** @param {Record<string,string>} options @param {string} name */
function required(options, name) {
  if (!options[name]) throw new ValidationError(`缺少 --${name}`);
  return options[name];
}

/** @param {Record<string,string>} options */
function expectedRevision(options) {
  if (options['expected-revision'] === undefined) return null;
  const value = Number(options['expected-revision']);
  if (!Number.isInteger(value) || value < 0) throw new ValidationError('--expected-revision 必须是非负整数');
  return value;
}

function capabilities() {
  return {
    skill: 'verify-agent-output',
    runtime_version: RUNTIME_VERSION,
    protocol_versions: [PROTOCOL_VERSION],
    contracts: { task_contract: [1], verification_profile: [1], artifact_ref: [1], review_result: [1], evidence_package: [1], reflection_record: [1], improvement_proposal: [1] },
    features: ['git-artifact', 'strict-json', 'rfc8785-digest', 'argv-l0', 'immutable-evidence', 'journal-recovery', 'skill-drift', 'evidence-bound-reflection', 'proposed-only-improvement'],
    content_digest: skillContentDigest(),
  };
}

/** @param {Record<string,string>} options @param {Set<string>} flags */
function initialize(options, flags) {
  const contract = readJson(required(options, 'contract'));
  const profile = readJson(required(options, 'profile'));
  const artifact = readJson(required(options, 'artifact'));
  const workdir = realpathSync(required(options, 'workdir'));
  const plannedAssurance = required(options, 'isolation-assurance');
  if (!['host_reported', 'user_relayed'].includes(plannedAssurance)) throw new ValidationError('isolation-assurance 非法');
  const acceptanceIds = validateContract(contract);
  validateProfile(profile, acceptanceIds);
  validateArtifact(artifact);
  const contentDigest = skillContentDigest();
  validateSkillBinding(contract, contentDigest);
  const gitIdentity = verifyGitArtifact(artifact, workdir);
  verifyProtectedPaths(artifact, profile, workdir);
  if (profile.runtime.network_policy === 'denied' && !flags.has('network-isolated')) {
    throw new ValidationError('network_policy=denied 时必须由宿主提供 --network-isolated assurance');
  }
  const stateRoot = resolve(options['state-root'] ?? join(tmpdir(), 'verify-agent-output-state'));
  if (pathInside(stateRoot, workdir) && !flags.has('allow-repository-state')) throw new ValidationError('state root 位于仓库内；需显式 --allow-repository-state');
  mkdirSync(join(stateRoot, 'runs'), { recursive: true, mode: 0o700 });
  const runId = options['run-id'] ?? randomUUID();
  if (!/^[A-Za-z0-9._-]+$/u.test(runId)) throw new ValidationError('run-id 只允许字母、数字、点、下划线和连字符');
  const runDir = join(stateRoot, 'runs', runId);
  mkdirSync(runDir, { recursive: false, mode: 0o700 });
  const now = new Date().toISOString();
  const snapshot = {
    schema_version: 1,
    runtime_version: RUNTIME_VERSION,
    run_id: runId,
    revision: 0,
    status: 'initialized',
    contract_digest: contract.contract_digest,
    verification_profile_digest: profile.verification_profile_digest,
    artifact_ref: artifact,
    runtime_repository_identity: gitIdentity.runtime_repository_identity,
    executable_identities: Object.fromEntries(Object.entries(profile.runtime.executable_paths).map(([name, path]) => [name, executableIdentity(path)])),
    argv_file_identities: freezeArgvFiles(profile, workdir),
    workdir,
    network_isolation_assurance: flags.has('network-isolated') ? 'host_reported' : 'not_required',
    planned_isolation_assurance: plannedAssurance,
    review_challenge_nonce: randomUUID(),
    skill_provenance: { name: 'verify-agent-output', version: RUNTIME_VERSION, content_digest: contentDigest },
    stages: {},
    review_result: null,
    review_provenance: null,
    reflection_refs: [],
    improvement_proposal_refs: [],
    terminal: null,
    operational_abort: null,
    created_at: now,
    updated_at: now,
  };
  writeNewJson(join(runDir, 'contract.json'), contract);
  writeNewJson(join(runDir, 'profile.json'), profile);
  writeNewJson(join(runDir, 'artifact.json'), artifact);
  const initialEvent = { schema_version: 1, revision: 0, kind: 'initialized', recorded_at: now, previous_event_digest: null, snapshot };
  initialEvent.event_digest = envelopeDigest(initialEvent, 'event_digest');
  writeFileSync(join(runDir, 'events.ndjson'), `${canonicalJson(initialEvent)}\n`, { flag: 'wx', mode: 0o600 });
  atomicWriteJson(join(runDir, 'snapshot.json'), snapshot);
  return { run_id: runId, run_dir: runDir, revision: 0, status: snapshot.status, review_challenge_nonce: snapshot.review_challenge_nonce };
}

/** @param {Record<string,string>} options */
function recordReflection(options) {
  const runDir = realpathSync(required(options, 'run'));
  const input = readJson(required(options, 'input'));
  return mutateRun(runDir, expectedRevision(options), (snapshot) => {
    const record = buildReflection({
      input,
      runDir,
      scope: { contract_digest: snapshot.contract_digest, run_id: snapshot.run_id },
      skill: snapshot.skill_provenance,
      parseJsonStrict,
      canonicalJson,
      envelopeDigest,
    });
    mkdirSync(join(runDir, 'reflections'), { recursive: true, mode: 0o700 });
    const ref = `reflections/${record.reflection_id}.json`;
    writeNewJson(join(runDir, ref), record);
    return { snapshot: { ...snapshot, reflection_refs: [...(snapshot.reflection_refs ?? []), { reflection_id: record.reflection_id, reflection_digest: record.reflection_digest, ref }] }, kind: 'reflection_recorded' };
  });
}

/** @param {Record<string,string>} options */
function proposeImprovement(options) {
  const runDir = realpathSync(required(options, 'run'));
  const input = readJson(required(options, 'input'));
  const reflectionPath = resolve(runDir, required(options, 'reflection'));
  if (!pathInside(reflectionPath, runDir)) throw new ValidationError('Reflection 路径越出 run 目录');
  return mutateRun(runDir, expectedRevision(options), (snapshot) => {
    const reflection = readAndValidateReflection(reflectionPath, 'verify-agent-output', parseJsonStrict, envelopeDigest);
    if (!(snapshot.reflection_refs ?? []).some((item) => item.reflection_digest === reflection.reflection_digest)) throw new ValidationError('Reflection 未登记到当前 run');
    const proposal = buildProposal({ input, reflections: [reflection], skill: snapshot.skill_provenance, envelopeDigest });
    mkdirSync(join(runDir, 'proposals'), { recursive: true, mode: 0o700 });
    const ref = `proposals/${proposal.proposal_id}.json`;
    writeNewJson(join(runDir, ref), proposal);
    return { snapshot: { ...snapshot, improvement_proposal_refs: [...(snapshot.improvement_proposal_refs ?? []), { proposal_id: proposal.proposal_id, proposal_digest: proposal.proposal_digest, ref }] }, kind: 'improvement_proposed' };
  });
}

/** @param {Record<string,string>} options */
function runSmoke(options) {
  const runDir = realpathSync(required(options, 'run'));
  return mutateRun(runDir, expectedRevision(options), (snapshot) => {
    if (snapshot.status !== 'initialized') throw new ValidationError(`run-smoke 不接受状态 ${snapshot.status}`);
    const result = executeChecks(snapshot, 'smoke', runDir);
    let next = { ...snapshot, stages: { ...snapshot.stages, smoke_l0: result }, status: result.passed ? 'smoke_passed' : 'terminal' };
    if (!result.passed) next = terminalSnapshot(next, runDir, 'fail');
    return { snapshot: next, kind: result.passed ? 'smoke_passed' : 'smoke_failed' };
  });
}

/** @param {Record<string,string>} options */
function reviewInput(options) {
  const runDir = realpathSync(required(options, 'run'));
  const { snapshot } = loadSnapshot(runDir);
  if (snapshot.status !== 'smoke_passed') throw new ValidationError(`review-input 不接受状态 ${snapshot.status}`);
  verifyGitArtifact(snapshot.artifact_ref, snapshot.workdir, snapshot.runtime_repository_identity);
  const contract = readJson(join(runDir, 'contract.json'));
  const profile = readJson(join(runDir, 'profile.json'));
  const byId = new Map(contract.acceptance.map((item) => [item.contract_item_id, item]));
  return {
    schema_version: 1,
    run_id: snapshot.run_id,
    contract: { contract_id: contract.contract_id, objective: contract.objective, scope: contract.scope, acceptance: contract.acceptance, permissions: contract.permissions, contract_digest: contract.contract_digest },
    artifact_ref: snapshot.artifact_ref,
    verification_entry: {
      l0_checks: profile.l0_checks.map(({ check_id, argv, cwd_rel, stage, timeout_ms, expected_exit_codes }) => ({ check_id, argv, cwd_rel, stage, timeout_ms, expected_exit_codes })),
      protected_verifier_paths: profile.protected_verifier_paths,
      allowed_validation_changes: profile.allowed_validation_changes,
    },
    reviewer_view: profile.l1_review.map((item) => ({ ...item, requirement: byId.get(item.contract_item_id).requirement })),
    required_output: 'Review Result v1',
    challenge_nonce: snapshot.review_challenge_nonce,
  };
}

/** @param {Record<string,string>} options */
function recordReview(options) {
  const runDir = realpathSync(required(options, 'run'));
  const review = readJson(required(options, 'review'));
  const verifierRunId = required(options, 'verifier-run-id');
  const assurance = required(options, 'isolation-assurance');
  if (!['host_reported', 'user_relayed'].includes(assurance)) throw new ValidationError('isolation-assurance 非法');
  return mutateRun(runDir, expectedRevision(options), (snapshot) => {
    if (snapshot.status !== 'smoke_passed') throw new ValidationError(`record-review 不接受状态 ${snapshot.status}`);
    if (verifierRunId === snapshot.run_id) throw new ValidationError('verifier-run-id 必须与被验收 run 隔离');
    if (assurance !== snapshot.planned_isolation_assurance) throw new ValidationError('isolation-assurance 与 init 冻结值不一致');
    verifyGitArtifact(snapshot.artifact_ref, snapshot.workdir, snapshot.runtime_repository_identity);
    const contract = readJson(join(runDir, 'contract.json'));
    const acceptanceIds = validateContract(contract);
    validateReview(review, snapshot, acceptanceIds);
    writeNewJson(join(runDir, 'review-result.json'), review);
    let next = { ...snapshot, status: 'review_recorded', review_result: review, review_provenance: { verifier_run_id: verifierRunId, isolation_assurance: assurance, challenge_nonce: snapshot.review_challenge_nonce } };
    const safety = review.findings.some((finding) => finding.class === 'safety');
    if (safety) next = terminalSnapshot(next, runDir, 'blocked_safety');
    else if (review.verdict === 'fail') next = terminalSnapshot(next, runDir, 'fail');
    else if (review.verdict === 'undecidable') next = terminalSnapshot(next, runDir, 'undecidable');
    return { snapshot: next, kind: next.status === 'terminal' ? `review_${next.terminal.outcome}` : 'review_recorded' };
  });
}

/** @param {Record<string,string>} options */
function runFinal(options) {
  const runDir = realpathSync(required(options, 'run'));
  return mutateRun(runDir, expectedRevision(options), (snapshot) => {
    if (snapshot.status !== 'review_recorded' || snapshot.review_result?.verdict !== 'no_defect_found') throw new ValidationError(`run-final 不接受状态 ${snapshot.status}`);
    const result = executeChecks(snapshot, 'final', runDir);
    let next = { ...snapshot, stages: { ...snapshot.stages, final_l0: result } };
    next = terminalSnapshot(next, runDir, result.passed ? 'pass' : 'fail');
    return { snapshot: next, kind: result.passed ? 'final_passed' : 'final_failed' };
  });
}

/** @param {Record<string,string>} options */
function status(options) {
  const runDir = realpathSync(required(options, 'run'));
  const loaded = loadSnapshot(runDir);
  return { ...loaded.snapshot, recovery_needed: loaded.needsRepair };
}

/** @param {Record<string,string>} options */
function validateRun(options) {
  const runDir = realpathSync(required(options, 'run'));
  const loaded = loadSnapshot(runDir);
  const snapshot = loaded.snapshot;
  const contract = readJson(join(runDir, 'contract.json'));
  const profile = readJson(join(runDir, 'profile.json'));
  const artifact = readJson(join(runDir, 'artifact.json'));
  const ids = validateContract(contract);
  validateProfile(profile, ids);
  validateArtifact(artifact);
  if (contract.contract_digest !== snapshot.contract_digest || profile.verification_profile_digest !== snapshot.verification_profile_digest || canonicalJson(artifact) !== canonicalJson(snapshot.artifact_ref)) throw new ValidationError('冻结 envelope 与 snapshot 不一致');
  const logProblems = [];
  for (const stage of Object.values(snapshot.stages)) {
    for (const check of stage?.checks ?? []) {
      const path = join(runDir, check.log_ref);
      if (!existsSync(path) || sha256(readFileSync(path)) !== check.log_digest) logProblems.push(check.check_id);
    }
  }
  let evidence = null;
  if (snapshot.terminal?.evidence_ref) {
    evidence = readJson(join(runDir, snapshot.terminal.evidence_ref));
    if (envelopeDigest(evidence, 'evidence_digest') !== evidence.evidence_digest || evidence.evidence_digest !== snapshot.terminal.evidence_digest) throw new ValidationError('Evidence digest 无效');
    if (evidence.run_id !== snapshot.run_id || evidence.terminal_outcome !== snapshot.terminal.outcome || evidence.contract_digest !== snapshot.contract_digest || evidence.verification_profile_digest !== snapshot.verification_profile_digest || canonicalJson(evidence.artifact_ref) !== canonicalJson(snapshot.artifact_ref) || canonicalJson(evidence.stages) !== canonicalJson({ smoke_l0: snapshot.stages.smoke_l0 ?? { status: 'not_run' }, l1_review: snapshot.review_result ?? { status: 'not_run' }, final_l0: snapshot.stages.final_l0 ?? { status: 'not_run' } })) throw new ValidationError('Evidence 与 terminal snapshot 不一致');
  }
  for (const ref of snapshot.reflection_refs ?? []) {
    const value = readAndValidateReflection(join(runDir, ref.ref), 'verify-agent-output', parseJsonStrict, envelopeDigest);
    if (value.reflection_digest !== ref.reflection_digest) throw new ValidationError(`Reflection digest 无效: ${ref.ref}`);
    verifyEvidenceRefs(runDir, value.evidence_refs, parseJsonStrict, canonicalJson);
  }
  for (const ref of snapshot.improvement_proposal_refs ?? []) {
    const value = readJson(join(runDir, ref.ref));
    if (value.lifecycle !== 'proposed' || value.target_skill?.name !== 'verify-agent-output' || envelopeDigest(value, 'proposal_digest') !== value.proposal_digest || value.proposal_digest !== ref.proposal_digest) throw new ValidationError(`Proposal digest/lifecycle 无效: ${ref.ref}`);
  }
  if (logProblems.length > 0) throw new ValidationError(`日志摘要无效: ${logProblems.join(', ')}`);
  return { valid: true, run_id: snapshot.run_id, revision: snapshot.revision, status: snapshot.status, evidence_digest: evidence?.evidence_digest ?? null, recovery_needed: loaded.needsRepair };
}

/** @param {Record<string,string>} options */
function doctor(options) {
  const runDir = realpathSync(required(options, 'run'));
  const loaded = loadSnapshot(runDir);
  const currentDigest = skillContentDigest();
  return {
    healthy: !loaded.needsRepair && !existsSync(join(runDir, '.lock')) && currentDigest === loaded.snapshot.skill_provenance.content_digest,
    run_id: loaded.snapshot.run_id,
    revision: loaded.snapshot.revision,
    snapshot_matches_journal: !loaded.needsRepair,
    lock_present: existsSync(join(runDir, '.lock')),
    skill_drift: currentDigest !== loaded.snapshot.skill_provenance.content_digest,
  };
}

/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) {
  const { command, options, flags } = parseCli(argv);
  switch (command) {
    case 'capabilities': return capabilities();
    case 'init': return initialize(options, flags);
    case 'run-smoke': return runSmoke(options);
    case 'review-input': return reviewInput(options);
    case 'record-review': return recordReview(options);
    case 'run-final': return runFinal(options);
    case 'record-reflection': return recordReflection(options);
    case 'propose-improvement': return proposeImprovement(options);
    case 'status':
    case 'inspect': return status(options);
    case 'validate': return validateRun(options);
    case 'doctor': return doctor(options);
    default: throw new ValidationError('命令必须是 capabilities/init/run-smoke/review-input/record-review/run-final/record-reflection/propose-improvement/status/inspect/validate/doctor');
  }
}

/** @param {string} metaUrl @param {string} argv1 */
export function isCliEntry(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return pathToFileURL(resolve(argv1)).href === metaUrl;
  }
}

if (isCliEntry(import.meta.url, process.argv[1])) {
  try {
    process.stdout.write(`${JSON.stringify(main(), null, 2)}\n`);
  } catch (error) {
    const code = error instanceof OperationalAbort ? error.code : error instanceof ValidationError ? 'invalid_input' : 'runtime_error';
    process.stderr.write(`${JSON.stringify({ error: code, message: error instanceof Error ? error.message : String(error) })}\n`);
    process.exit(error instanceof ValidationError ? 2 : 3);
  }
}
