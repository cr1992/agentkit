#!/usr/bin/env node
// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createReflectionKit } from '../../core/reflection.mjs';
import { collectJsonSchemaErrors, validateJsonSchema } from '../../core/json-schema-lite.mjs';
import { atomicWriteJson, atomicWriteText, writeNewJson } from '../../core/atomic-fs.mjs';
import { createDigestKit } from '../../core/digest.mjs';
import { distributionDigest, skillDistributionRoots } from '../../core/content-digest.mjs';

export const RUNTIME_VERSION = '1.3.0';
export const PROTOCOL_VERSION = 1;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FINDING_CLASSES = new Set(['functional', 'scope', 'verification_definition', 'safety']);
const REVIEW_FINDING_FIELDS = ['contract_item_id', 'class', 'evidence', 'expected', 'actual'];
const REVIEW_VERDICTS = new Set(['fail', 'no_defect_found', 'undecidable']);
const STAGES = new Set(['smoke', 'final', 'both']);
const TERMINAL_OUTCOMES = new Set(['pass', 'fail', 'undecidable', 'blocked_safety']);
const REVIEW_STDIN_MAX_BYTES = 1024 * 1024;
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'verify-agent-output');
// 摘要覆盖 Skill 目录 + 共享 core + canonical schemas：执行真正依赖的全部分发内容。
// PACKAGE_ROOT 是模块常量，传入自定义 root 只替换 Skill 目录那一段，便于测试摘要与安装路径无关。
const PACKAGE_ROOT = resolve(SKILL_ROOT, '..');
const DOMAIN_ROOT = dirname(fileURLToPath(import.meta.url));
export function skillContentDigest(root = SKILL_ROOT) {
  return distributionDigest(skillDistributionRoots({ packageRoot: PACKAGE_ROOT, skillRoot: root, domainRoot: DOMAIN_ROOT, docsRoot: join(PACKAGE_ROOT, 'docs', 'verify') }));
}

const schema = (name) => parseJsonStrict(readFileSync(join(SKILL_ROOT, '..', 'schemas', name), 'utf8'));

export class ValidationError extends Error {}

// strict=true 保留本 Skill 既有的代理对与非有限 number 校验；错误类仍是本地的 ValidationError。
const digestKit = createDigestKit({ ValidationError, strict: true });
// 严格度保持本 Skill 现状（宽松版），不随 core 合并而收紧。
const { buildProposal, buildReflection, readAndValidateReflection, verifyEvidenceRefs } = createReflectionKit({ strict: false });
export const { canonicalJson, envelopeDigest } = digestKit;
const { sha256, assertValidUnicode } = digestKit;
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
/** @param {string} text */
export function parseJsonStrict(text) {
  return new StrictJsonParser(text).parse();
}

/** @param {unknown} value */
/** @param {string|Buffer} value */
/** @param {Record<string, unknown>} object @param {string} digestField */
/** @param {string} path */
function readJson(path) {
  return /** @type {Record<string, any>} */ (parseJsonStrict(readFileSync(path, 'utf8')));
}

/** @param {string} path @param {unknown} value */
/** @param {string} path @param {string} value */
/** @param {string} path @param {unknown} value */
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
/** @param {string} [root] */
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

/** @param {string} label @param {string[]} issues */
function throwIssues(label, issues) {
  if (issues.length > 0) throw new ValidationError(`${label} 校验失败（${issues.length} 项）:\n- ${issues.join('\n- ')}`);
}

/** @param {Record<string, any>} object @param {string} field @param {string} label */
function digestIssues(object, field, label) {
  if (!DIGEST_PATTERN.test(object?.[field] ?? '')) return [`${label}.${field} 格式不匹配`];
  try { return envelopeDigest(object, field) === object[field] ? [] : [`${label}.${field} 与内容不匹配`]; }
  catch (error) { return [`${label}.${field} 无法计算: ${error instanceof Error ? error.message : String(error)}`]; }
}

/** @param {Record<string, any>} contract */
function collectContractIssues(contract) {
  const issues = collectJsonSchemaErrors(contract, schema('task-contract-v1.schema.json'), 'Task Contract');
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return issues;
  if (!contract.scope || !Array.isArray(contract.scope.include) || !Array.isArray(contract.scope.exclude) || [...(contract.scope?.include ?? []), ...(contract.scope?.exclude ?? [])].some((item) => typeof item !== 'string' || !item)) issues.push('Task Contract.scope 必须包含非空字符串数组 include/exclude');
  if (!contract.permissions || !['read_only', 'write'].includes(contract.permissions.mode) || !Array.isArray(contract.permissions.writable_paths) || contract.permissions.writable_paths.some((item) => typeof item !== 'string' || !item)) issues.push('Task Contract.permissions 无效');
  if (contract.permissions?.mode === 'read_only' && contract.permissions.writable_paths?.length) issues.push('read_only 合同不能声明 writable_paths');
  if (!contract.environment || typeof contract.environment.repository !== 'string' || !contract.environment.repository || !['shared_tree', 'worktree', 'caller_supplied'].includes(contract.environment.isolation)) issues.push('Task Contract.environment 无效');
  if (!Array.isArray(contract.stop_conditions) || !contract.extensions || typeof contract.extensions !== 'object' || Array.isArray(contract.extensions)) issues.push('Task Contract.stop_conditions/extensions 无效');
  const ids = new Set();
  if (Array.isArray(contract.acceptance)) for (const item of contract.acceptance) {
    if (item?.contract_item_id && ids.has(item.contract_item_id)) issues.push(`重复 contract_item_id: ${item.contract_item_id}`);
    if (item?.contract_item_id) ids.add(item.contract_item_id);
  }
  issues.push(...digestIssues(contract, 'contract_digest', 'Task Contract'));
  return [...new Set(issues)];
}

/** @param {Record<string, any>} contract */
function validateContract(contract) {
  const issues = collectContractIssues(contract);
  throwIssues('Task Contract', issues);
  return new Set(contract.acceptance.map((item) => item.contract_item_id));
}

/** @param {Record<string, any>} profile @param {Set<string>} acceptanceIds */
function collectProfileIssues(profile, acceptanceIds) {
  const issues = collectJsonSchemaErrors(profile, schema('verification-profile-v1.schema.json'), 'Verification Profile');
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return issues;
  const checkIds = new Set();
  if (Array.isArray(profile.l0_checks)) for (const check of profile.l0_checks) {
    if (check?.check_id && checkIds.has(check.check_id)) issues.push(`重复 L0 check_id: ${check.check_id}`);
    if (check?.check_id) checkIds.add(check.check_id);
    if (check?.cwd_rel && (isAbsolute(check.cwd_rel) || check.cwd_rel.includes('\\') || check.cwd_rel.split('/').some((part) => part === '..'))) issues.push(`${check.check_id ?? 'L0 check'} cwd_rel 非法`);
  }
  if (Array.isArray(profile.l0_checks) && profile.l0_checks.length > 0 && (!profile.l0_checks.some((check) => ['smoke', 'both'].includes(check?.stage)) || !profile.l0_checks.some((check) => ['final', 'both'].includes(check?.stage)))) issues.push('Verification Profile 必须覆盖 smoke 与 final L0');
  if (Array.isArray(profile.l1_review)) for (const review of profile.l1_review) {
    if (review?.contract_item_id && !acceptanceIds.has(review.contract_item_id)) issues.push(`L1 引用未知 contract_item_id: ${review.contract_item_id}`);
  }
  for (const path of [...(Array.isArray(profile.protected_verifier_paths) ? profile.protected_verifier_paths : []), ...(Array.isArray(profile.allowed_validation_changes) ? profile.allowed_validation_changes : [])]) {
    try { validateProfilePath(path); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
  }
  if (Array.isArray(profile.runtime?.env_allowlist) && profile.runtime.env_allowlist.some((name) => typeof name !== 'string' || !name)) issues.push('runtime.env_allowlist 只能包含非空变量名');
  if (Array.isArray(profile.l0_checks) && profile.runtime?.executable_paths && typeof profile.runtime.executable_paths === 'object') for (const check of profile.l0_checks) {
    const executable = profile.runtime.executable_paths[check?.argv?.[0]];
    if (!executable || !isAbsolute(executable) || !existsSync(executable) || !statSync(executable).isFile()) issues.push(`未冻结绝对 executable: ${check?.argv?.[0] ?? '<missing>'}`);
  }
  issues.push(...digestIssues(profile, 'verification_profile_digest', 'Verification Profile'));
  return [...new Set(issues)];
}

/** @param {Record<string, any>} profile @param {Set<string>} acceptanceIds */
function validateProfile(profile, acceptanceIds) {
  throwIssues('Verification Profile', collectProfileIssues(profile, acceptanceIds));
}

/** @param {Record<string, any>} artifact */
function collectArtifactIssues(artifact) {
  const issues = collectJsonSchemaErrors(artifact, schema('artifact-ref-v1.schema.json'), 'Artifact Ref');
  if (artifact?.provider === 'manage-worktrees') {
    if (!artifact.worktree_id) issues.push('manage-worktrees Artifact Ref 缺少 worktree_id');
    if (!Number.isInteger(artifact.ownership_epoch) || artifact.ownership_epoch < 1) issues.push('manage-worktrees Artifact Ref ownership_epoch 无效');
  }
  return [...new Set(issues)];
}

/** @param {Record<string, any>} artifact */
function validateArtifact(artifact) {
  throwIssues('Artifact Ref', collectArtifactIssues(artifact));
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
  scaffold: { values: ['kind', 'workdir', 'base-sha', 'artifact-sha', 'review-input'], flags: [] },
  prepare: { values: ['workdir', 'out-dir'], flags: [] },
  digest: { values: ['kind', 'input'], flags: [] },
  readiness: { values: ['contract', 'profile', 'workdir', 'state-root'], flags: [] },
  preflight: { values: ['contract', 'profile', 'artifact'], flags: ['network-isolated'] },
  init: { values: ['contract', 'profile', 'artifact', 'workdir', 'state-root', 'isolation-assurance', 'run-id'], flags: ['network-isolated', 'allow-repository-state'] },
  'prepare-run': { values: ['contract', 'profile', 'artifact', 'workdir', 'state-root', 'isolation-assurance', 'run-id'], flags: ['network-isolated', 'allow-repository-state', 'verbose'] },
  'run-smoke': { values: ['run', 'expected-revision'], flags: ['verbose'] },
  'review-input': { values: ['run'], flags: [] },
  'review-bundle': { values: ['run', 'out'], flags: [] },
  'record-review': { values: ['run', 'review', 'verifier-run-id', 'isolation-assurance', 'expected-revision'], flags: ['stdin', 'verbose'] },
  'run-final': { values: ['run', 'expected-revision'], flags: ['verbose'] },
  'record-reflection': { values: ['run', 'input', 'expected-revision'], flags: [] },
  'propose-improvement': { values: ['run', 'reflection', 'input', 'expected-revision'], flags: [] },
  status: { values: ['run'], flags: [] }, inspect: { values: ['run'], flags: [] }, validate: { values: ['run'], flags: [] }, doctor: { values: ['run'], flags: [] },
};
const CLI_USAGE = {
  capabilities: '用法: capabilities [--json]',
  scaffold: '用法: scaffold --kind contract|profile|artifact|review|bundle [--workdir <git-root> --base-sha <full-sha>] [--review-input <json>]',
  prepare: '用法: prepare --workdir <git-root> [--out-dir <dir>]',
  digest: '用法: digest --kind contract|profile|review --input <json>',
  readiness: '用法: readiness --contract <json> --profile <json> --workdir <git-root> [--state-root <dir>]',
  preflight: '用法: preflight --contract <json> --profile <json> --artifact <json> [--network-isolated]',
  init: '用法: init --contract <json> --profile <json> --artifact <json> --workdir <git-root> --isolation-assurance host_reported|user_relayed [--state-root <dir>] [--run-id <id>]',
  'prepare-run': '用法: prepare-run --contract <json> --profile <json> --artifact <json> --workdir <git-root> --isolation-assurance host_reported|user_relayed [--state-root <dir>] [--run-id <id>] [--network-isolated] [--verbose]',
  'run-smoke': '用法: run-smoke --run <run-dir> [--expected-revision <n>] [--verbose]',
  'review-input': '用法: review-input --run <run-dir>',
  'review-bundle': '用法: review-bundle --run <run-dir> [--out <path>]',
  'record-review': '用法: record-review --run <run-dir> (--review <json>|--stdin) --verifier-run-id <id> --isolation-assurance host_reported|user_relayed [--expected-revision <n>] [--verbose]',
  'run-final': '用法: run-final --run <run-dir> [--expected-revision <n>] [--verbose]',
  'record-reflection': '用法: record-reflection --run <run-dir> --input <json> [--expected-revision <n>]',
  'propose-improvement': '用法: propose-improvement --run <run-dir> --reflection <ref> --input <json> [--expected-revision <n>]',
  status: '用法: status --run <run-dir>',
  inspect: '用法: inspect --run <run-dir>',
  validate: '用法: validate --run <run-dir>',
  doctor: '用法: doctor --run <run-dir>',
};
const CLI_COMMANDS = Object.keys(CLI_SPEC).join('/');

/** @param {string|null} command */
function helpText(command = null) {
  if (command) {
    if (!CLI_SPEC[command]) throw new ValidationError(`未知命令: ${command}`);
    return `${CLI_USAGE[command] ?? `用法: ${command}`}\n`;
  }
  return [
    'verify-agent-output verification runtime',
    '',
    '命令：',
    ...Object.keys(CLI_SPEC).map((name) => `  ${name.padEnd(20)} ${CLI_USAGE[name] ?? ''}`),
    '',
    '运行 `<command> --help` 查看子命令用法。',
  ].join('\n') + '\n';
}

/** @param {string} command */
function usageHint(command) {
  return CLI_USAGE[command] ? `；${CLI_USAGE[command]}` : '';
}

function parseCli(argv) {
  const command = argv[0] ?? '';
  const spec = CLI_SPEC[command];
  if (!spec) throw new ValidationError(`命令必须是 ${CLI_COMMANDS}`);
  const options = {};
  const flags = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new ValidationError(`未知位置参数: ${token}${usageHint(command)}`);
    const name = token.slice(2);
    if (spec.flags.includes(name)) {
      if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) throw new ValidationError(`--${name} 不接受值${usageHint(command)}`);
      flags.add(name);
    } else if (spec.values.includes(name)) {
      if (argv[index + 1] === undefined || argv[index + 1].startsWith('--')) throw new ValidationError(`--${name} 缺少值${usageHint(command)}`);
      options[name] = argv[index + 1];
      index += 1;
    } else throw new ValidationError(`未知选项: --${name}${usageHint(command)}`);
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
    features: ['input-scaffold', 'digest-helper', 'aggregate-preflight', 'prepare-scaffold-chain', 'prepare-run', 'readiness-preconditions', 'review-bundle', 'review-stdin', 'compact-cli-output', 'command-help', 'git-artifact', 'strict-json', 'rfc8785-digest', 'argv-l0', 'immutable-evidence', 'journal-recovery', 'skill-drift', 'evidence-bound-reflection', 'proposed-only-improvement'],
    content_digest: skillContentDigest(),
  };
}

/** @param {Record<string, any>} value @param {string} field */
function addDigest(value, field) {
  const output = { ...value };
  delete output[field];
  output[field] = envelopeDigest(output, field);
  return output;
}

/** @param {string} workdir */
function scaffoldContract(workdir) {
  return addDigest({
    schema_version: 1,
    contract_id: randomUUID(),
    objective: 'TODO: describe the frozen artifact objective',
    scope: { include: ['TODO'], exclude: [] },
    acceptance: [{ contract_item_id: 'acceptance-1', requirement: 'TODO: replace with an observable requirement' }],
    permissions: { mode: 'read_only', writable_paths: [] },
    environment: { repository: resolve(workdir), isolation: 'caller_supplied' },
    skill_set: [{ name: 'verify-agent-output', version: RUNTIME_VERSION, content_digest: skillContentDigest(), provider_mode: 'primary' }],
    stop_conditions: [],
    extensions: {},
  }, 'contract_digest');
}

function scaffoldProfile() {
  return addDigest({
    schema_version: 1,
    profile_id: randomUUID(),
    l0_checks: [{ check_id: 'replace-with-real-check', argv: ['node', '--version'], cwd_rel: '.', stage: 'both', timeout_ms: 30_000, expected_exit_codes: [0] }],
    l1_review: [{ contract_item_id: 'acceptance-1', lenses: ['functional', 'scope', 'verification_definition', 'safety'] }],
    protected_verifier_paths: [],
    allowed_validation_changes: [],
    runtime: { env_allowlist: ['PATH'], executable_paths: { node: process.execPath }, cache_policy: 'trusted_identity', network_policy: 'contract_authorized', max_log_bytes: 1_048_576 },
    human_gate: 'none',
  }, 'verification_profile_digest');
}

/** @param {Record<string,string>} options */
function scaffoldArtifact(options) {
  const workdir = realpathSync(required(options, 'workdir'));
  const objectFormat = String(git(['rev-parse', '--show-object-format'], workdir)).trim();
  const artifactSha = options['artifact-sha'] ?? String(git(['rev-parse', 'HEAD'], workdir)).trim();
  const baseSha = required(options, 'base-sha');
  const roots = String(git(['rev-list', '--max-parents=0', artifactSha], workdir)).trim().split('\n').filter(Boolean).sort();
  const artifact = { schema_version: 1, provider: 'caller-supplied', repository_id: `git:${objectFormat}:${sha256(Buffer.from(canonicalJson(roots), 'utf8'))}`, object_format: objectFormat, base_sha: baseSha, artifact_sha: artifactSha };
  validateArtifact(artifact);
  verifyGitArtifact(artifact, workdir);
  return artifact;
}

/** @param {Record<string,string>} options */
function scaffoldReview(options) {
  const input = readJson(required(options, 'review-input'));
  const contractDigest = input.contract_digest ?? input.contract?.contract_digest;
  const profileDigest = input.verification_profile_digest;
  const firstItem = input.reviewer_view?.[0];
  if (!DIGEST_PATTERN.test(contractDigest ?? '') || !DIGEST_PATTERN.test(profileDigest ?? '') || !input.artifact_ref || !input.challenge_nonce || !firstItem?.contract_item_id) throw new ValidationError('review-input 缺少 Review Result 所需绑定字段');
  return addDigest({
    schema_version: 1,
    review_result_id: randomUUID(),
    contract_digest: contractDigest,
    verification_profile_digest: profileDigest,
    artifact_ref: input.artifact_ref,
    challenge_nonce: input.challenge_nonce,
    verdict: 'undecidable',
    findings: [{ contract_item_id: firstItem.contract_item_id, class: 'verification_definition', evidence: 'TODO: identify the missing or conflicting evidence', expected: firstItem.requirement, actual: 'TODO: describe why the requirement cannot yet be decided' }],
    forensics: ['TODO: replace with independent forensic actions before recording the review'],
  }, 'review_result_digest');
}

/** @param {Record<string,string>} options */
function scaffold(options) {
  if (!options.kind) throw new ValidationError(CLI_USAGE.scaffold);
  const kind = options.kind;
  if (['artifact', 'bundle'].includes(kind) && (!options.workdir || !options['base-sha'])) throw new ValidationError(`${CLI_USAGE.scaffold}；artifact/bundle 必须提供 --workdir 与 --base-sha`);
  if (kind === 'review' && !options['review-input']) throw new ValidationError(`${CLI_USAGE.scaffold}；review 必须提供 --review-input`);
  if (kind === 'contract') return scaffoldContract(options.workdir ?? process.cwd());
  if (kind === 'profile') return scaffoldProfile();
  if (kind === 'artifact') return scaffoldArtifact(options);
  if (kind === 'review') return scaffoldReview(options);
  if (kind === 'bundle') return { contract: scaffoldContract(required(options, 'workdir')), profile: scaffoldProfile(), artifact: scaffoldArtifact(options) };
  throw new ValidationError('--kind 必须是 contract/profile/artifact/review/bundle');
}

const RUNTIME_SCRIPT_PATH = join(DOMAIN_ROOT, 'verification-runtime.mjs');
const PREPARE_NOTICE = 'Verification Profile 的 l0_checks 需 controller 按项目实际填写并确认；本命令不猜测任何测试命令，也不内置任何项目专属 preset。';

/** 串联 scaffold contract + scaffold profile，只产出骨架与 TODO 清单，不猜测测试命令。 @param {Record<string,string>} options */
function prepare(options) {
  const workdir = realpathSync(required(options, 'workdir'));
  const contract = scaffoldContract(workdir);
  const profile = scaffoldProfile();
  const result = {
    schema_version: 1,
    kind: 'prepare_scaffold_chain',
    runtime_version: RUNTIME_VERSION,
    workdir,
    notice: PREPARE_NOTICE,
    todo: [
      'contract.json: objective 替换 TODO，写清被验收产物的目标',
      'contract.json: scope.include / scope.exclude 按真实改动面填写',
      'contract.json: acceptance[] 每条给稳定唯一 contract_item_id 与可观察 requirement；acceptance-1 只是占位',
      'contract.json: permissions 与 environment.isolation 按实际授权和隔离方式填写',
      'profile.json: l0_checks 必须由 controller 按项目实际测试命令填写并确认；骨架里的 node --version 只是占位，不是推荐值',
      'profile.json: l0_checks 至少覆盖一条 smoke（stage=smoke|both）和一条 final（stage=final|both）',
      'profile.json: runtime.executable_paths 为每个 argv[0] 冻结绝对可执行文件路径',
      'profile.json: l1_review[].contract_item_id 必须引用 contract.json 里已存在的 acceptance ID',
      'profile.json: protected_verifier_paths / allowed_validation_changes 按验证定义面填写',
      'profile.json: human_gate、runtime.network_policy、runtime.cache_policy 按实际风险选择',
      '两份文件改完后先用 digest 重算摘要，再跑 readiness 与 preflight；readiness 与 preflight 由 controller 自行执行，prepare 不代跑',
    ],
    next_steps: [
      `node ${RUNTIME_SCRIPT_PATH} digest --kind contract --input <contract.json>`,
      `node ${RUNTIME_SCRIPT_PATH} digest --kind profile --input <profile.json>`,
      `node ${RUNTIME_SCRIPT_PATH} scaffold --kind artifact --workdir ${workdir} --base-sha <full-base-sha>`,
      `node ${RUNTIME_SCRIPT_PATH} readiness --contract <contract.json> --profile <profile.json> --workdir ${workdir}`,
      `node ${RUNTIME_SCRIPT_PATH} preflight --contract <contract.json> --profile <profile.json> --artifact <artifact.json>`,
    ],
  };
  if (!options['out-dir']) return { ...result, contract, profile };
  const outDir = resolve(options['out-dir']);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const contractPath = join(outDir, 'contract.json');
  const profilePath = join(outDir, 'profile.json');
  for (const path of [contractPath, profilePath]) if (existsSync(path)) throw new ValidationError(`prepare 拒绝覆盖已存在的文件: ${path}`);
  writeNewJson(contractPath, contract);
  writeNewJson(profilePath, profile);
  return { ...result, out_dir: outDir, contract_path: contractPath, profile_path: profilePath };
}

/** @param {Record<string,string>} options */
function digestEnvelope(options) {
  if (!options.kind || !options.input) throw new ValidationError(CLI_USAGE.digest);
  const kind = options.kind;
  const field = { contract: 'contract_digest', profile: 'verification_profile_digest', review: 'review_result_digest' }[kind];
  if (!field) throw new ValidationError('--kind 必须是 contract/profile/review');
  return addDigest(readJson(required(options, 'input')), field);
}

/** @param {Record<string,any>|null} contract @param {Record<string,any>|null} profile @param {Record<string,any>|null} artifact @param {Set<string>} flags */
function inspectValues(contract, profile, artifact, flags) {
  const issues = [];
  if (contract) issues.push(...collectContractIssues(contract));
  const acceptanceIds = new Set(Array.isArray(contract?.acceptance) ? contract.acceptance.map((item) => item?.contract_item_id).filter(Boolean) : []);
  if (profile) issues.push(...collectProfileIssues(profile, acceptanceIds));
  if (artifact) issues.push(...collectArtifactIssues(artifact));
  if (contract) {
    try { validateSkillBinding(contract, skillContentDigest()); }
    catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
  }
  if (profile?.runtime?.network_policy === 'denied' && !flags.has('network-isolated')) issues.push('network_policy=denied 时必须由宿主提供 --network-isolated assurance');
  return {
    valid: issues.length === 0,
    errors: [...new Set(issues)],
    content_digest: skillContentDigest(),
    contract_digest: contract?.contract_digest ?? null,
    verification_profile_digest: profile?.verification_profile_digest ?? null,
  };
}

/** @param {Record<string,string>} options @param {Set<string>} flags */
function inspectInputs(options, flags) {
  const issues = [];
  const load = (name, label) => {
    if (!options[name]) { issues.push(`${label} 缺少 --${name}`); return null; }
    try { return readJson(options[name]); }
    catch (error) { issues.push(`${label} 无法读取: ${error instanceof Error ? error.message : String(error)}`); return null; }
  };
  const contract = load('contract', 'Task Contract');
  const profile = load('profile', 'Verification Profile');
  const artifact = load('artifact', 'Artifact Ref');
  const report = inspectValues(contract, profile, artifact, flags);
  const errors = [...new Set([...issues, ...report.errors])];
  return {
    report: { ...report, valid: errors.length === 0, errors },
    contract,
    profile,
    artifact,
  };
}

/** @param {Record<string,string>} options @param {Set<string>} flags */
function preflight(options, flags) {
  return inspectInputs(options, flags).report;
}

/** @param {string} path @param {number} mode */
function accessible(path, mode) {
  try { accessSync(path, mode); return true; } catch { return false; }
}

/** 找到 path 自身或最近一个已存在的祖先目录。 @param {string} path */
function nearestExistingAncestor(path) {
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
  return cursor;
}

/**
 * 机械检查“环境前提”，不检查产物质量。任何未通过项都归类为 blocked/precondition，
 * 永远不是 Artifact fail。frozen executable / argv 文件的身份漂移由 run 内的冻结门禁
 * （check_runtime_failure）负责，因此可用 exclude 排除，避免两套语义互相顶掉。
 * @param {{contract?:Record<string,any>|null, profile?:Record<string,any>|null, workdir:string, stateRoot?:string|null, exclude?:RegExp|null}} input
 */
function evaluateReadiness({ contract = null, profile = null, workdir, stateRoot = null, exclude = null }) {
  const checks = [];
  const notes = [];
  const record = (checkId, ok, detail) => {
    if (exclude && exclude.test(checkId)) return;
    checks.push({ check_id: checkId, ok, detail });
  };

  let resolvedWorkdir = resolve(workdir);
  if (!existsSync(resolvedWorkdir)) record('workdir_git_root', false, `workdir 不存在: ${resolvedWorkdir}`);
  else if (!statSync(resolvedWorkdir).isDirectory()) record('workdir_git_root', false, `workdir 不是目录: ${resolvedWorkdir}`);
  else {
    resolvedWorkdir = realpathSync(resolvedWorkdir);
    const toplevel = gitStatus(['rev-parse', '--show-toplevel'], resolvedWorkdir);
    if (toplevel.status !== 0) record('workdir_git_root', false, `workdir 不是 Git 仓库: ${resolvedWorkdir}`);
    else if (realpathSync(String(toplevel.stdout).trim()) !== resolvedWorkdir) record('workdir_git_root', false, `workdir 不是 Git worktree 根目录，根目录是 ${String(toplevel.stdout).trim()}`);
    else record('workdir_git_root', true, `Git worktree 根目录: ${resolvedWorkdir}`);
  }

  const stateRootPath = resolve(stateRoot ?? join(tmpdir(), 'verify-agent-output-state'));
  const stateAnchor = nearestExistingAncestor(stateRootPath);
  if (existsSync(stateRootPath) && !statSync(stateRootPath).isDirectory()) record('state_root_writable', false, `state root 不是目录: ${stateRootPath}`);
  else if (!accessible(stateAnchor, fsConstants.W_OK | fsConstants.X_OK)) record('state_root_writable', false, `state root 不可写: ${stateRootPath}（受阻于 ${stateAnchor}）`);
  else record('state_root_writable', true, `state root 可写: ${stateRootPath}`);

  if (contract && typeof contract.environment?.repository === 'string' && contract.environment.repository) {
    const declared = resolve(contract.environment.repository);
    if (existsSync(declared) && existsSync(resolvedWorkdir) && realpathSync(declared) !== resolvedWorkdir) {
      notes.push(`Task Contract environment.repository (${declared}) 与 workdir (${resolvedWorkdir}) 不是同一目录；readiness 不据此拦截，请自行确认是否有意为之。`);
    }
  }

  const executablePaths = profile?.runtime?.executable_paths;
  if (executablePaths && typeof executablePaths === 'object') {
    for (const [name, path] of Object.entries(executablePaths)) {
      if (typeof path !== 'string' || !path) record(`executable:${name}`, false, `runtime.executable_paths.${name} 不是路径字符串`);
      else if (!isAbsolute(path)) record(`executable:${name}`, false, `runtime.executable_paths.${name} 必须是绝对路径: ${path}`);
      else if (!existsSync(path)) record(`executable:${name}`, false, `冻结 executable 不存在: ${name} -> ${path}`);
      else if (!statSync(path).isFile()) record(`executable:${name}`, false, `冻结 executable 不是文件: ${name} -> ${path}`);
      else if (!accessible(path, fsConstants.X_OK)) record(`executable:${name}`, false, `冻结 executable 不可执行: ${name} -> ${path}`);
      else record(`executable:${name}`, true, `${name} -> ${path}`);
    }
  }

  if (Array.isArray(profile?.l0_checks)) {
    for (const check of profile.l0_checks) {
      const checkId = check?.check_id ?? '<missing>';
      if (typeof check?.cwd_rel !== 'string' || !Array.isArray(check?.argv)) continue;
      const cwd = resolve(resolvedWorkdir, check.cwd_rel);
      if (!existsSync(cwd)) record(`l0_cwd:${checkId}`, false, `L0 cwd 不存在: ${cwd}`);
      else if (!statSync(cwd).isDirectory()) record(`l0_cwd:${checkId}`, false, `L0 cwd 不是目录: ${cwd}`);
      else if (!pathInside(cwd, resolvedWorkdir)) record(`l0_cwd:${checkId}`, false, `L0 cwd 越出 workdir: ${cwd}`);
      else record(`l0_cwd:${checkId}`, true, cwd);
      // 只对已经存在的路径类参数做可读性检查，与 L0 冻结逻辑同口径：不猜测哪些参数是文件。
      for (let index = 1; index < check.argv.length; index += 1) {
        const argument = check.argv[index];
        if (typeof argument !== 'string' || argument.startsWith('-')) continue;
        const candidate = isAbsolute(argument) ? argument : resolve(cwd, argument);
        if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
        if (accessible(candidate, fsConstants.R_OK)) record(`argv_file:${checkId}:${index}`, true, candidate);
        else record(`argv_file:${checkId}:${index}`, false, `L0 argv 文件不可读: ${candidate}`);
      }
    }
  }

  const allowlist = Array.isArray(profile?.runtime?.env_allowlist) ? profile.runtime.env_allowlist.filter((name) => typeof name === 'string' && name) : [];
  if (allowlist.length > 0) {
    const missing = allowlist.filter((name) => process.env[name] === undefined);
    notes.push(`env_allowlist 是否为 L0 必需无法机械判定，readiness 不猜测也不拦截；当前未设置的变量：${missing.length ? missing.join(', ') : '（无）'}。`);
  }

  const blockers = checks.filter((item) => !item.ok).map((item) => ({ kind: 'precondition', check_id: item.check_id, detail: item.detail }));
  return {
    ready: blockers.length === 0,
    workdir: resolvedWorkdir,
    state_root: stateRootPath,
    blockers,
    checks,
    notes,
    blocker_semantics: 'blocked_precondition_not_artifact_defect',
  };
}

/** @param {Record<string,string>} options */
function readiness(options) {
  const workdir = required(options, 'workdir');
  const loaded = {};
  const readErrors = [];
  for (const [name, label] of [['contract', 'Task Contract'], ['profile', 'Verification Profile']]) {
    const path = required(options, name);
    try { loaded[name] = readJson(path); }
    catch (error) { readErrors.push({ kind: 'precondition', check_id: `${name}_readable`, detail: `${label} 无法读取或解析: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  const report = evaluateReadiness({ contract: loaded.contract ?? null, profile: loaded.profile ?? null, workdir, stateRoot: options['state-root'] ?? null });
  if (readErrors.length === 0) return report;
  return { ...report, ready: false, blockers: [...readErrors, ...report.blockers] };
}

/**
 * Happy path：只在 readiness 与 preflight 都通过后创建 run；输入文件只读，digest 在临时副本中规范化。
 * @param {Record<string,string>} options @param {Set<string>} flags
 */
function prepareRun(options, flags) {
  const contractSource = readJson(required(options, 'contract'));
  const profileSource = readJson(required(options, 'profile'));
  const artifact = readJson(required(options, 'artifact'));
  const contract = addDigest(contractSource, 'contract_digest');
  const profile = addDigest(profileSource, 'verification_profile_digest');
  const workdir = required(options, 'workdir');
  const stateRoot = options['state-root'] ?? join(tmpdir(), 'verify-agent-output-state');
  const readinessReport = evaluateReadiness({ contract, profile, workdir, stateRoot });
  if (!readinessReport.ready) {
    return { prepared: false, status: 'blocked_precondition', readiness: readinessReport, preflight: null, run_id: null, revision: null, evidence_digest: null };
  }
  const preflightReport = inspectValues(contract, profile, artifact, flags);
  if (!preflightReport.valid) {
    return { prepared: false, status: 'invalid_input', readiness: readinessReport, preflight: preflightReport, run_id: null, revision: null, evidence_digest: null };
  }

  const temporary = mkdtempSync(join(tmpdir(), 'verify-agent-output-prepare-'));
  try {
    const paths = {
      contract: join(temporary, 'contract.json'),
      profile: join(temporary, 'profile.json'),
      artifact: join(temporary, 'artifact.json'),
    };
    writeNewJson(paths.contract, contract);
    writeNewJson(paths.profile, profile);
    writeNewJson(paths.artifact, artifact);
    const initialized = initialize({
      ...options,
      contract: paths.contract,
      profile: paths.profile,
      artifact: paths.artifact,
      'state-root': stateRoot,
    }, flags);
    return {
      prepared: true,
      ...initialized,
      readiness: readinessReport,
      preflight: preflightReport,
      normalized_digests: {
        contract_digest: contract.contract_digest,
        verification_profile_digest: profile.verification_profile_digest,
      },
      evidence_digest: null,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** @param {Record<string,string>} options @param {Set<string>} flags */
function initialize(options, flags) {
  const checked = inspectInputs(options, flags);
  throwIssues('Verification input preflight', checked.report.errors);
  const { contract, profile, artifact } = checked;
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

/**
 * run 内的内联 readiness：只覆盖尚未被冻结身份门禁接管的环境前提。
 * executable / argv 文件的漂移仍由 verifyExecutable / verifyArgvFiles 判 check_runtime_failure，
 * 这里排除它们，避免同一现象出现两种 abort 语义。
 */
const INLINE_READINESS_EXCLUDED = /^(?:executable|argv_file):/u;

/** @param {Record<string, any>} snapshot @param {string} runDir */
function assertRunReadiness(snapshot, runDir) {
  const report = evaluateReadiness({
    contract: readJson(join(runDir, 'contract.json')),
    profile: readJson(join(runDir, 'profile.json')),
    workdir: snapshot.workdir,
    stateRoot: dirname(dirname(runDir)),
    exclude: INLINE_READINESS_EXCLUDED,
  });
  if (report.ready) return report;
  throw new OperationalAbort('stale_precondition', `readiness 前置检查未通过（环境问题，不是 Artifact 缺陷）：${report.blockers.map((item) => `${item.check_id}: ${item.detail}`).join('; ')}`);
}

/** @param {Record<string,string>} options */
function runSmoke(options) {
  const runDir = realpathSync(required(options, 'run'));
  return mutateRun(runDir, expectedRevision(options), (snapshot) => {
    if (snapshot.status !== 'initialized') throw new ValidationError(`run-smoke 不接受状态 ${snapshot.status}`);
    assertRunReadiness(snapshot, runDir);
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
    contract_digest: snapshot.contract_digest,
    verification_profile_digest: snapshot.verification_profile_digest,
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

/** 从协议真源取「证伪任务」原文，避免 bundle 里的提示词与 references 漂移。 */
function falsificationTask() {
  const text = readFileSync(join(PACKAGE_ROOT, 'docs', 'verify', 'verification-protocol.md'), 'utf8');
  const section = text.split(/^## /mu).find((part) => part.startsWith('证伪任务'));
  if (!section) throw new ValidationError('verification-protocol.md 缺少「证伪任务」段');
  const fenced = section.match(/```text\n([\s\S]*?)\n```/u);
  if (!fenced) throw new ValidationError('「证伪任务」段缺少提示词代码块');
  return fenced[1];
}

/** @param {{workdir:string, contractKind:string, digestCommand:string}} input */
function reviewerPrompt({ workdir, contractKind, digestCommand }) {
  return [
    '你是独立验收者。本 bundle 自带全部验收输入；不要索取或采信实现者叙事、过程对话与“已经测试通过”一类自述。',
    '',
    '## 证伪任务',
    '',
    falsificationTask(),
    '',
    '## 输出契约（Review Result v1）',
    `- verdict 只能是三态之一：${[...REVIEW_VERDICTS].join(' | ')}。`,
    `- findings[] 每条必须包含五个非空字符串字段：${REVIEW_FINDING_FIELDS.join(' / ')}；class 只能取 ${[...FINDING_CLASSES].join(' | ')}。`,
    '- forensics 必须是非空字符串数组，逐条记录你实际执行过的取证动作。',
    '- no_defect_found：findings 必须为空且 forensics 必须非空；它只表示在取证范围内未发现缺陷。',
    '- fail 与 undecidable：findings 至少一条，contract_item_id 只能引用 review_input.reviewer_view 中已冻结的 ID。',
    '- 任何 safety finding 都使最终 outcome 至少为 blocked_safety，不能被其他通过项抵消。',
    '- contract_digest、verification_profile_digest、artifact_ref、challenge_nonce 必须从 review_input 原样复制，不得改写或事后补写。',
    '- 完整结构以本 bundle 的 review_result_schema 为准；不要填写 L0 exit code，不生成 Evidence，不宣布任务完成。',
    '',
    '## 权限',
    `- 只读审查 ${workdir}：禁止 commit、checkout、切分支、reset、stash，禁止修改业务产物、Task Contract、Verification Profile 或任何验证定义。`,
    '',
    '## 停止条件',
    '- 产出一份三态 verdict 的 Review Result v1 后立即停止：不修复缺陷、不重跑 L0、不自行发起下一轮验收。',
    '',
    '## digest 回填',
    `- 填好除 review_result_digest 外的全部字段后运行：${digestCommand}`,
    '- 以该命令输出的新 JSON 作为最终 Review Result；不要手写 review_result_digest。',
    '',
    '## 合同种类',
    contractKind === 'projected'
      ? '- 本次是投影合同：只覆盖公共合同 acceptance 的一个子集。只对 review_input.contract.acceptance 列出的条目取证，不越界评判未投影条目。'
      : '- 本次是公共合同：review_input.contract.acceptance 即完整验收面。',
  ].join('\n');
}

/** 打包一次可直接投递给任意 reviewer 的自包含验收输入。 @param {Record<string,string>} options */
function reviewBundle(options) {
  const runDir = realpathSync(required(options, 'run'));
  const input = reviewInput({ run: runDir });
  const { snapshot } = loadSnapshot(runDir);
  const contract = readJson(join(runDir, 'contract.json'));
  const projection = contract.extensions && typeof contract.extensions === 'object' && !Array.isArray(contract.extensions) ? contract.extensions.projection : undefined;
  const contractKind = projection && typeof projection === 'object' ? 'projected' : 'public';
  const digestCommand = `node ${RUNTIME_SCRIPT_PATH} digest --kind review --input <review-result.json>`;
  const bundle = {
    schema_version: 1,
    bundle_kind: 'reviewer_dispatch',
    runtime_version: RUNTIME_VERSION,
    run_id: snapshot.run_id,
    contract_kind: contractKind,
    reviewer_prompt: reviewerPrompt({ workdir: snapshot.workdir, contractKind, digestCommand }),
    review_input: input,
    review_result_schema: schema('review-result-v1.schema.json'),
    artifact_ref: snapshot.artifact_ref,
    workdir: snapshot.workdir,
    permissions: {
      mode: 'read_only',
      writable_paths: [],
      forbidden_operations: ['git commit', 'git checkout', 'git switch', 'git reset', 'git stash', '修改业务产物', '修改 Task Contract / Verification Profile / 验证定义'],
    },
    stop_conditions: [
      '产出 fail / no_defect_found / undecidable 三态之一的 Review Result v1 后立即停止',
      '不修复缺陷、不重跑 L0、不自行发起下一轮验收',
    ],
    digest_backfill: {
      command: digestCommand,
      note: 'digest 输出的新 JSON 才是提交给 record-review 的最终 Review Result；不要手写 review_result_digest。',
    },
    controller_next_step: {
      note: '以下命令由 controller 执行，不属于 reviewer 权限。',
      command: `node ${RUNTIME_SCRIPT_PATH} record-review --run ${runDir} --review <review-result.json> --verifier-run-id <opaque-id> --isolation-assurance ${snapshot.planned_isolation_assurance}`,
    },
  };
  if (!options.out) return bundle;
  const outPath = resolve(options.out);
  const text = `${JSON.stringify(bundle, null, 2)}\n`;
  atomicWriteText(outPath, text);
  return { out: outPath, bytes: Buffer.byteLength(text, 'utf8'), run_id: bundle.run_id, contract_kind: contractKind };
}

/** @param {Record<string,string>} options @param {Set<string>} flags */
function reviewPayload(options, flags) {
  const fromStdin = flags.has('stdin');
  if (fromStdin && options.review) throw new ValidationError('record-review 的 --review 与 --stdin 互斥');
  if (!fromStdin) return readJson(required(options, 'review'));
  if (process.stdin.isTTY === true) throw new ValidationError('--stdin 拒绝从交互式 TTY 等待输入；请使用 pipe 或 --review <json>');
  const text = readFileSync(0, 'utf8');
  if (!text.trim()) throw new ValidationError('--stdin 未收到 Review Result JSON');
  if (Buffer.byteLength(text, 'utf8') > REVIEW_STDIN_MAX_BYTES) throw new ValidationError(`--stdin 超过 ${REVIEW_STDIN_MAX_BYTES} bytes 上限`);
  const parsed = parseJsonStrict(text);
  return parsed.review_result_digest ? parsed : addDigest(parsed, 'review_result_digest');
}

/** @param {Record<string,string>} options @param {Set<string>} flags */
function recordReview(options, flags) {
  const runDir = realpathSync(required(options, 'run'));
  const review = reviewPayload(options, flags);
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
    // 旧 run 即使已漂移也要能只读检查：同时给出冻结时的摘要与当前摘要，便于判断漂移了什么。
    frozen_content_digest: loaded.snapshot.skill_provenance.content_digest,
    current_content_digest: currentDigest,
  };
}

/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) {
  if (['--help', '-h', 'help'].includes(argv[0] ?? '')) return { __help: helpText(argv[0] === 'help' ? argv[1] ?? null : null) };
  if (['--help', '-h'].includes(argv[1] ?? '')) return { __help: helpText(argv[0] ?? null) };
  const { command, options, flags } = parseCli(argv);
  switch (command) {
    case 'capabilities': return capabilities();
    case 'scaffold': return scaffold(options);
    case 'prepare': return prepare(options);
    case 'digest': return digestEnvelope(options);
    case 'readiness': return readiness(options);
    case 'preflight': return preflight(options, flags);
    case 'init': return initialize(options, flags);
    case 'prepare-run': return prepareRun(options, flags);
    case 'run-smoke': return runSmoke(options);
    case 'review-input': return reviewInput(options);
    case 'review-bundle': return reviewBundle(options);
    case 'record-review': return recordReview(options, flags);
    case 'run-final': return runFinal(options);
    case 'record-reflection': return recordReflection(options);
    case 'propose-improvement': return proposeImprovement(options);
    case 'status':
    case 'inspect': return status(options);
    case 'validate': return validateRun(options);
    case 'doctor': return doctor(options);
    default: throw new ValidationError(`命令必须是 ${CLI_COMMANDS}`);
  }
}

/** @param {Record<string,any>} result */
function compactRunResult(result) {
  const failedChecks = [];
  for (const stage of Object.values(result?.stages ?? {})) {
    for (const check of stage?.checks ?? []) if (check.passed === false) failedChecks.push(check.check_id);
  }
  for (const finding of result?.review_result?.findings ?? []) failedChecks.push(`l1:${finding.contract_item_id}`);
  const outcome = result?.terminal?.outcome ?? result?.status ?? (result?.prepared === false ? 'blocked' : null);
  return {
    run_id: result?.run_id ?? null,
    revision: result?.revision ?? null,
    status: outcome,
    failed_checks: [...new Set(failedChecks)],
    evidence_digest: result?.terminal?.evidence_digest ?? result?.evidence_digest ?? null,
    ...(result?.run_dir ? { run_dir: result.run_dir } : {}),
    ...(result?.prepared !== undefined ? { prepared: result.prepared } : {}),
    ...(result?.terminal && result.terminal.outcome !== 'pass' ? {
      next_mode_hint: '本次单 Artifact 验收已终止并保留 Evidence；若已授权修复且预期多轮，请用 run-agent-verify-loop 创建新 Artifact/run。',
    } : {}),
  };
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

export function runCli(argv = process.argv.slice(2)) {
  try {
    const result = main(argv);
    const command = argv[0];
    if (result?.__help) process.stdout.write(result.__help);
    else {
      const compact = ['prepare-run', 'run-smoke', 'record-review', 'run-final'].includes(command) && !argv.includes('--verbose');
      process.stdout.write(`${JSON.stringify(compact ? compactRunResult(result) : result, null, 2)}\n`);
    }
    if (command === 'preflight' && result?.valid === false) return 2;
    if (command === 'readiness' && result?.ready === false) return 2;
    if (command === 'prepare-run' && result?.prepared === false) return 2;
    return 0;
  } catch (error) {
    const code = error instanceof OperationalAbort ? error.code : error instanceof ValidationError ? 'invalid_input' : 'runtime_error';
    process.stderr.write(`${JSON.stringify({ error: code, message: error instanceof Error ? error.message : String(error) })}\n`);
    return error instanceof ValidationError ? 2 : 3;
  }
}

if (isCliEntry(import.meta.url, process.argv[1])) process.exitCode = runCli();
