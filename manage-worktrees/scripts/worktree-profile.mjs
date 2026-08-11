#!/usr/bin/env node
// @ts-check

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const PROFILE_FILENAME = '.worktree-trace.json';
export const PROFILE_SCHEMA_VERSION = 1;

const TASK_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WORKTREE_ROOT_MARKER = '.repository.json';
const TASK_SHORT_MAX = 28;
const SPAWN_TEMPLATE_PLACEHOLDERS = new Set(['task', 'task_short', 'repo', 'host', 'id8']);
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'schema_version',
  'default_base',
  'branch_template',
  'path_template',
  'worktree_root',
  'change_request',
  'task_naming',
  'scan',
  'ephemeral_path_patterns',
  'extensions',
]);
const ALLOWED_SCAN_KEYS = new Set(['sources']);
const ALLOWED_CHANGE_REQUEST_KEYS = new Set(['provider', 'remote', 'target_branch', 'remove_source_branch']);
const ALLOWED_TASK_NAMING_KEYS = new Set(['mode', 'example']);
const ALLOWED_TASK_SOURCE_KEYS = new Set(['type', 'glob']);
const PORTABLE_SCAN_SOURCES = new Set(['git_worktrees', 'recent_commits']);
const CONFIGURED_SCAN_SOURCE_TYPES = new Set(['kiro_tasks']);
const BUILTIN_EPHEMERAL_PATTERNS = [
  `${resolve(tmpdir()).replaceAll('\\', '/').replace(/\/+$/, '')}/`,
  '/tmp/',
  '/private/tmp/',
  '/var/folders/',
  '/private/var/folders/',
  '/scratchpad/',
];

const DEFAULT_PROFILE = Object.freeze({
  schema_version: PROFILE_SCHEMA_VERSION,
  default_base: null,
  branch_template: '{host}/{task}',
  path_template: '{host}-{task}',
  worktree_root: '~/.worktrees',
  change_request: {
    provider: 'manual',
    remote: 'origin',
    target_branch: null,
    remove_source_branch: true,
  },
  task_naming: {
    mode: 'semantic',
    example: 'ci-gate-hardening',
  },
  scan: { sources: ['git_worktrees', 'recent_commits'] },
  ephemeral_path_patterns: BUILTIN_EPHEMERAL_PATTERNS,
  extensions: {},
});

export class WorktreeProfileError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'WorktreeProfileError';
    this.code = code;
  }
}

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** @param {string[]} args @param {string} cwd */
function gitTry(args, cwd) {
  try {
    return { ok: true, out: git(args, cwd) };
  } catch (error) {
    return {
      ok: false,
      out: error && typeof error === 'object' && 'stdout' in error ? String(error.stdout).trim() : '',
    };
  }
}

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {Record<string, unknown>} value @param {Set<string>} allowed @param {string} location */
function rejectUnknownKeys(value, allowed, location) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new WorktreeProfileError('PROFILE_UNKNOWN_KEY', `${location}.${key} 是未知配置字段。`);
    }
  }
}

/** @param {unknown} value @param {string} location */
function requireNonEmptyString(value, location) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorktreeProfileError('PROFILE_INVALID_TYPE', `${location} 必须是非空字符串。`);
  }
  return value;
}

/** @param {unknown} value @param {string} location */
function requireSafeRepositoryGlob(value, location) {
  const glob = requireNonEmptyString(value, location).replaceAll('\\', '/');
  const segments = glob.split('/');
  if (
    glob.startsWith('/') ||
    /^[A-Za-z]:\//.test(glob) ||
    segments.some((segment) => segment === '..' || segment === '') ||
    /[\u0000]/.test(glob)
  ) {
    throw new WorktreeProfileError(
      'PROFILE_INVALID_GLOB',
      `${location} 必须是仓库内的安全相对 glob，不能含绝对路径、空路径段或 ..。`,
    );
  }
  return glob;
}

/** @param {string} template @param {string} location @param {Set<string>} allowed @param {boolean} requireTask */
function validateTemplate(template, location, allowed, requireTask) {
  const placeholders = [...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
  for (const placeholder of placeholders) {
    if (!allowed.has(placeholder)) {
      throw new WorktreeProfileError(
        'PROFILE_INVALID_TEMPLATE',
        `${location} 含未知占位符 {${placeholder}}；只允许 ${[...allowed].map((item) => `{${item}}`).join(' / ')}。`,
      );
    }
  }
  if (requireTask && !placeholders.some((item) => item === 'task' || item === 'task_short')) {
    throw new WorktreeProfileError('PROFILE_INVALID_TEMPLATE', `${location} 必须包含 {task} 或 {task_short}。`);
  }
  const residue = template.replace(/\{[^{}]+\}/g, '');
  if (residue.includes('{') || residue.includes('}')) {
    throw new WorktreeProfileError('PROFILE_INVALID_TEMPLATE', `${location} 含未闭合占位符。`);
  }
}

/** @param {unknown} raw */
export function validateProfile(raw) {
  if (!isPlainObject(raw)) {
    throw new WorktreeProfileError('PROFILE_INVALID_TYPE', 'Profile 根节点必须是 JSON object。');
  }
  rejectUnknownKeys(raw, ALLOWED_TOP_LEVEL_KEYS, 'profile');
  if (raw.schema_version !== PROFILE_SCHEMA_VERSION) {
    throw new WorktreeProfileError(
      'PROFILE_SCHEMA_UNSUPPORTED',
      `profile.schema_version 必须是 ${PROFILE_SCHEMA_VERSION}。`,
    );
  }

  const branchTemplate = requireNonEmptyString(
    raw.branch_template ?? DEFAULT_PROFILE.branch_template,
    'profile.branch_template',
  );
  const pathTemplate = requireNonEmptyString(
    raw.path_template ?? DEFAULT_PROFILE.path_template,
    'profile.path_template',
  );
  validateTemplate(branchTemplate, 'profile.branch_template', SPAWN_TEMPLATE_PLACEHOLDERS, true);
  validateTemplate(pathTemplate, 'profile.path_template', SPAWN_TEMPLATE_PLACEHOLDERS, true);

  if (raw.default_base !== undefined && raw.default_base !== null) {
    requireNonEmptyString(raw.default_base, 'profile.default_base');
  }
  const defaultWorktreeRoot = pathTemplate.startsWith('../') ? '..' : DEFAULT_PROFILE.worktree_root;
  const worktreeRoot = requireNonEmptyString(raw.worktree_root ?? defaultWorktreeRoot, 'profile.worktree_root');
  validateTemplate(worktreeRoot, 'profile.worktree_root', new Set(), false);

  const changeRequest = raw.change_request ?? DEFAULT_PROFILE.change_request;
  if (!isPlainObject(changeRequest)) {
    throw new WorktreeProfileError('PROFILE_INVALID_TYPE', 'profile.change_request 必须是 object。');
  }
  rejectUnknownKeys(changeRequest, ALLOWED_CHANGE_REQUEST_KEYS, 'profile.change_request');
  const changeRequestProvider = requireNonEmptyString(
    changeRequest.provider ?? DEFAULT_PROFILE.change_request.provider,
    'profile.change_request.provider',
  );
  if (!['manual', 'gitlab'].includes(changeRequestProvider)) {
    throw new WorktreeProfileError(
      'PROFILE_UNKNOWN_CHANGE_REQUEST_PROVIDER',
      `profile.change_request.provider 未知: ${changeRequestProvider}`,
    );
  }
  const changeRequestRemote = requireNonEmptyString(
    changeRequest.remote ?? DEFAULT_PROFILE.change_request.remote,
    'profile.change_request.remote',
  );
  if (changeRequest.target_branch !== undefined && changeRequest.target_branch !== null) {
    requireNonEmptyString(changeRequest.target_branch, 'profile.change_request.target_branch');
  }
  if (
    changeRequest.remove_source_branch !== undefined &&
    typeof changeRequest.remove_source_branch !== 'boolean'
  ) {
    throw new WorktreeProfileError(
      'PROFILE_INVALID_TYPE',
      'profile.change_request.remove_source_branch 必须是 boolean。',
    );
  }

  const taskNaming = raw.task_naming ?? DEFAULT_PROFILE.task_naming;
  if (!isPlainObject(taskNaming)) {
    throw new WorktreeProfileError('PROFILE_INVALID_TYPE', 'profile.task_naming 必须是 object。');
  }
  rejectUnknownKeys(taskNaming, ALLOWED_TASK_NAMING_KEYS, 'profile.task_naming');
  const taskNamingMode = requireNonEmptyString(
    taskNaming.mode ?? DEFAULT_PROFILE.task_naming.mode,
    'profile.task_naming.mode',
  );
  if (!['slug', 'semantic'].includes(taskNamingMode)) {
    throw new WorktreeProfileError(
      'PROFILE_UNKNOWN_TASK_NAMING_MODE',
      `profile.task_naming.mode 未知: ${taskNamingMode}`,
    );
  }
  const taskNamingExample = requireNonEmptyString(
    taskNaming.example ?? DEFAULT_PROFILE.task_naming.example,
    'profile.task_naming.example',
  );
  validateTaskSlug(taskNamingExample);
  if (taskNamingMode === 'semantic') {
    validateTaskNaming(taskNamingExample, { mode: taskNamingMode, example: taskNamingExample });
    const required = [
      ['profile.branch_template', branchTemplate],
      ['profile.path_template', pathTemplate],
    ];
    for (const [location, template] of required) {
      if (!template.includes('{host}') || !template.includes('{task}')) {
        throw new WorktreeProfileError(
          'PROFILE_NAMING_DOD_FAILED',
          `${location} 在 semantic 模式必须同时包含 {host} 和完整 {task}。`,
        );
      }
      if (template.includes('{id8}') || template.includes('{task_short}')) {
        throw new WorktreeProfileError(
          'PROFILE_NAMING_DOD_FAILED',
          `${location} 在 semantic 模式禁止 {id8}/{task_short}；trace identity 只留在 metadata。`,
        );
      }
    }
  }

  const scan = raw.scan ?? DEFAULT_PROFILE.scan;
  if (!isPlainObject(scan)) {
    throw new WorktreeProfileError('PROFILE_INVALID_TYPE', 'profile.scan 必须是 object。');
  }
  rejectUnknownKeys(scan, ALLOWED_SCAN_KEYS, 'profile.scan');
  if (!Array.isArray(scan.sources)) {
    throw new WorktreeProfileError('PROFILE_INVALID_TYPE', 'profile.scan.sources 必须是 array。');
  }
  for (const [index, source] of scan.sources.entries()) {
    const location = `profile.scan.sources[${index}]`;
    if (typeof source === 'string') {
      if (!PORTABLE_SCAN_SOURCES.has(source)) {
        throw new WorktreeProfileError('PROFILE_UNKNOWN_SCAN_SOURCE', `${location} 未知 source: ${source}`);
      }
      continue;
    }
    if (!isPlainObject(source)) {
      throw new WorktreeProfileError('PROFILE_INVALID_TYPE', `${location} 必须是 string 或 object。`);
    }
    rejectUnknownKeys(source, ALLOWED_TASK_SOURCE_KEYS, location);
    const type = requireNonEmptyString(source.type, `${location}.type`);
    if (!CONFIGURED_SCAN_SOURCE_TYPES.has(type)) {
      throw new WorktreeProfileError('PROFILE_UNKNOWN_SCAN_SOURCE', `${location}.type 未知: ${type}`);
    }
    requireSafeRepositoryGlob(source.glob, `${location}.glob`);
  }

  const ephemeralPathPatterns = raw.ephemeral_path_patterns ?? [];
  if (!Array.isArray(ephemeralPathPatterns)) {
    throw new WorktreeProfileError(
      'PROFILE_INVALID_TYPE',
      'profile.ephemeral_path_patterns 必须是 string array。',
    );
  }
  for (const [index, pattern] of ephemeralPathPatterns.entries()) {
    requireNonEmptyString(pattern, `profile.ephemeral_path_patterns[${index}]`);
  }
  const extensions = raw.extensions ?? {};
  if (!isPlainObject(extensions)) {
    throw new WorktreeProfileError('PROFILE_INVALID_TYPE', 'profile.extensions 必须是 object。');
  }

  return {
    schema_version: PROFILE_SCHEMA_VERSION,
    default_base: raw.default_base ?? null,
    branch_template: branchTemplate,
    path_template: pathTemplate,
    worktree_root: worktreeRoot,
    change_request: {
      provider: changeRequestProvider,
      remote: changeRequestRemote,
      target_branch: changeRequest.target_branch ?? null,
      remove_source_branch: changeRequest.remove_source_branch ?? true,
    },
    task_naming: {
      mode: taskNamingMode,
      example: taskNamingExample,
    },
    scan: structuredClone(scan),
    ephemeral_path_patterns: [...new Set([...BUILTIN_EPHEMERAL_PATTERNS, ...ephemeralPathPatterns])],
    extensions: structuredClone(extensions),
  };
}

/** @param {string} task */
export function validateTaskSlug(task) {
  if (
    typeof task !== 'string' ||
    !TASK_PATTERN.test(task) ||
    task.includes('..') ||
    task.includes('/') ||
    task.includes('\\') ||
    task.startsWith('.') ||
    task.endsWith('.')
  ) {
    throw new WorktreeProfileError(
      'INVALID_TASK_SLUG',
      'task 必须匹配 ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$，且不能含 ..、路径分隔符、空白、控制字符或首尾点号。',
    );
  }
  return task;
}

/**
 * Profile 可把自由 slug 收紧为可读语义 slug。semantic 模式的 DoD：
 * lowercase、至少两个以字母开头的连字符分词；纯编号和 trace identity 不进入可见名称。
 * @param {string} task
 * @param {{mode?:string,example?:string}|null|undefined} taskNaming
 */
export function validateTaskNaming(task, taskNaming) {
  validateTaskSlug(task);
  const mode = taskNaming?.mode ?? 'slug';
  if (mode === 'slug') return task;
  const semantic = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)+$/.test(task);
  if (!semantic) {
    const example = taskNaming?.example ?? 'ci-gate-hardening';
    throw new WorktreeProfileError(
      'TASK_NAMING_DOD_FAILED',
      `task "${task}" 未满足 Profile 命名 DoD：必须使用可读的 lowercase semantic slug（例如 ${example}），至少两个以字母开头的连字符分词；纯 Task 编号和 trace ID 不得进入可见名称。`,
    );
  }
  return task;
}

/** @param {string} task */
export function shortenTaskSlug(task) {
  validateTaskSlug(task);
  if (task.length <= TASK_SHORT_MAX) return task;
  const digest = createHash('sha256').update(task).digest('hex').slice(0, 6);
  const head = task.slice(0, 12).replace(/[._-]+$/, '');
  const tail = task.slice(-8).replace(/^[._-]+/, '');
  return `${head}-${digest}-${tail}`;
}

/** @param {string} host */
export function normalizeHostSlug(host) {
  const normalized = String(host).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw new WorktreeProfileError('INVALID_HOST_SLUG', 'Agent host 无法生成安全命名 slug。');
  return normalized;
}

/** @param {string} template @param {Record<string,string>} values */
export function renderTemplate(template, values) {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) rendered = rendered.replaceAll(`{${key}}`, value);
  return rendered;
}

/** @param {string} configured @param {string} primaryWorktree @param {Record<string,string>} values */
function resolveRootBase(configured, primaryWorktree, values) {
  const rendered = renderTemplate(configured, values);
  if (rendered === '~') return homedir();
  if (rendered.startsWith('~/')) return resolve(homedir(), rendered.slice(2));
  if (rendered.startsWith('~')) {
    throw new WorktreeProfileError('WORKTREE_ROOT_INVALID', 'worktree_root 只支持 ~ 或 ~/ 前缀，不展开其他用户 home。');
  }
  return resolve(primaryWorktree, rendered);
}

/** @param {string} directory */
function readRootMarker(directory) {
  const markerPath = join(directory, WORKTREE_ROOT_MARKER);
  if (!existsSync(markerPath)) return null;
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    return typeof marker?.repository_id === 'string' ? marker : null;
  } catch {
    return null;
  }
}

/** @param {string} directory @param {string} repositoryId */
function rootAvailability(directory, repositoryId) {
  if (!existsSync(directory)) return 'vacant';
  if (!statSync(directory).isDirectory()) return 'occupied';
  const marker = readRootMarker(directory);
  if (marker) return marker.repository_id === repositoryId ? 'owned' : 'occupied';
  return readdirSync(directory).length === 0 ? 'vacant' : 'occupied';
}

/** @param {string} rootBase @param {string} repoName @param {string} repositoryId */
function selectRepositoryRoot(rootBase, repoName, repositoryId) {
  const preferred = canonicalizeFuturePath(join(rootBase, repoName));
  const status = rootAvailability(preferred, repositoryId);
  if (status === 'vacant' || status === 'owned') return preferred;
  const fallback = canonicalizeFuturePath(`${preferred}-${repositoryId.slice(0, 8)}`);
  const fallbackStatus = rootAvailability(fallback, repositoryId);
  if (fallbackStatus === 'occupied') {
    throw new WorktreeProfileError('WORKTREE_ROOT_CONFLICT', `worktree repository root 已被其他 identity 占用: ${fallback}`);
  }
  return fallback;
}

/**
 * 在所有纯校验通过后原子认领集中目录；同名仓库冲突时只给冲突方追加 repository id8。
 * @param {{root_base:string,repo_name:string,repository_id:string,primary_worktree:string}} options
 */
export function claimWorktreeRepositoryRoot(options) {
  mkdirSync(options.root_base, { recursive: true });
  let directory = selectRepositoryRoot(options.root_base, options.repo_name, options.repository_id);
  for (let attempt = 0; attempt < 2; attempt++) {
    mkdirSync(directory, { recursive: true });
    const markerPath = join(directory, WORKTREE_ROOT_MARKER);
    const marker = {
      schema_version: PROFILE_SCHEMA_VERSION,
      repository_id: options.repository_id,
      primary_worktree: options.primary_worktree,
      claimed_at: new Date().toISOString(),
    };
    try {
      writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return realpathSync(directory);
    } catch (error) {
      const current = readRootMarker(directory);
      if (current?.repository_id === options.repository_id) return realpathSync(directory);
      if (attempt === 0) {
        directory = canonicalizeFuturePath(join(options.root_base, `${options.repo_name}-${options.repository_id.slice(0, 8)}`));
        continue;
      }
      throw new WorktreeProfileError('WORKTREE_ROOT_CONFLICT', `无法认领 worktree repository root: ${directory}`);
    }
  }
  throw new WorktreeProfileError('WORKTREE_ROOT_CONFLICT', '无法认领 worktree repository root。');
}

/**
 * git worktree list --porcelain 的第一条是 primary worktree；路径按前缀后整行读取，保留空格。
 * @param {string} cwd
 */
function primaryWorktreePath(cwd) {
  const listed = gitTry(['worktree', 'list', '--porcelain'], cwd);
  if (!listed.ok) return null;
  for (const line of listed.out.split('\n')) {
    if (line.startsWith('worktree ')) return resolve(line.slice('worktree '.length));
  }
  return null;
}

/** @param {string} cwd */
export function resolveGitContext(cwd = process.cwd()) {
  const top = gitTry(['rev-parse', '--show-toplevel'], cwd);
  if (!top.ok) {
    throw new WorktreeProfileError('NOT_A_GIT_REPOSITORY', `${cwd} 不在 Git 工作树内。`);
  }
  const currentWorktree = resolve(top.out);
  const common = gitTry(['rev-parse', '--git-common-dir'], currentWorktree);
  if (!common.ok) {
    throw new WorktreeProfileError('GIT_COMMON_DIR_UNAVAILABLE', '无法解析 git common-dir。');
  }
  const commonDir = resolve(currentWorktree, common.out);
  const primaryWorktree = primaryWorktreePath(currentWorktree);
  return {
    current_worktree: currentWorktree,
    primary_worktree: primaryWorktree,
    common_dir: commonDir,
    repo_name: basename(primaryWorktree ?? currentWorktree),
  };
}

/** @param {string} profilePath */
function readProfileFile(profilePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(profilePath, 'utf8'));
  } catch (error) {
    throw new WorktreeProfileError(
      'PROFILE_READ_FAILED',
      `无法读取或解析 Profile ${profilePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateProfile(parsed);
}

/**
 * @param {{cwd?:string, explicitConfigPath?:string|null}} [options]
 */
export function loadRepositoryProfile(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const context = resolveGitContext(cwd);
  let profilePath;
  let source;
  if (options.explicitConfigPath) {
    profilePath = resolve(cwd, options.explicitConfigPath);
    source = 'explicit';
    if (!existsSync(profilePath)) {
      throw new WorktreeProfileError('PROFILE_NOT_FOUND', `显式 Profile 不存在: ${profilePath}`);
    }
  } else {
    if (!context.primary_worktree) {
      throw new WorktreeProfileError(
        'PRIMARY_WORKTREE_UNAVAILABLE',
        '无法定位 primary worktree；请显式传 --config <path>。',
      );
    }
    profilePath = join(context.primary_worktree, PROFILE_FILENAME);
    source = existsSync(profilePath) ? 'primary' : 'defaults';
  }

  const profile = existsSync(profilePath) ? readProfileFile(profilePath) : structuredClone(DEFAULT_PROFILE);
  return { context, profile, profile_path: profilePath, profile_source: source };
}

/** @param {string} target */
export function canonicalizeFuturePath(target) {
  const absolute = resolve(target);
  let cursor = absolute;
  const missing = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new WorktreeProfileError('PATH_CANONICALIZE_FAILED', `找不到 ${absolute} 的已存在祖先。`);
    }
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  let canonical = realpathSync(cursor);
  for (const segment of missing) canonical = join(canonical, segment);
  return canonical;
}

/** @param {string} parent @param {string} child */
export function isStrictlyInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** @param {string} branch @param {string} cwd */
export function validateBranchName(branch, cwd) {
  const checked = gitTry(['check-ref-format', '--branch', branch], cwd);
  if (!checked.ok) {
    throw new WorktreeProfileError('INVALID_BRANCH_NAME', `branch template 生成非法 Git ref: ${branch}`);
  }
  return branch;
}

/** @param {string} cwd @param {string|null} profileBase @param {string|null} override */
export function resolveBaseRef(cwd, profileBase, override) {
  if (override) return { ref: override, source: 'cli' };
  if (profileBase) return { ref: profileBase, source: 'profile' };

  const remotes = gitTry(['remote'], cwd);
  if (remotes.ok) {
    for (const remote of remotes.out.split('\n').filter(Boolean)) {
      const head = gitTry(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], cwd);
      if (head.ok && head.out) return { ref: head.out, source: 'remote_head' };
    }
  }
  for (const candidate of ['origin/main', 'origin/master']) {
    if (gitTry(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], cwd).ok) {
      return { ref: candidate, source: 'well_known_remote' };
    }
  }
  const upstream = gitTry(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd);
  if (upstream.ok && upstream.out) return { ref: upstream.out, source: 'upstream' };
  if (gitTry(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], cwd).ok) {
    return { ref: 'HEAD', source: 'head' };
  }
  throw new WorktreeProfileError('DEFAULT_BASE_UNAVAILABLE', '无法自动探测 default base；请传 --base <ref>。');
}

/**
 * 只解析和校验，不创建 branch/path/trace，供 spawn 在副作用前调用。
 * @param {{cwd?:string, task:string, host?:string, worktreeId?:string, repositoryId?:string, base?:string|null, explicitConfigPath?:string|null, worktreeRootOverride?:string|null}} options
 */
export function resolveSpawnPlan(options) {
  const loaded = loadRepositoryProfile({
    cwd: options.cwd,
    explicitConfigPath: options.explicitConfigPath,
  });
  const { context, profile } = loaded;
  const task = validateTaskNaming(options.task, profile.task_naming);
  if (!context.primary_worktree) {
    throw new WorktreeProfileError('PRIMARY_WORKTREE_UNAVAILABLE', 'spawn 需要可定位的 primary worktree。');
  }

  const worktreeId = options.worktreeId ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(worktreeId)) {
    throw new WorktreeProfileError('INVALID_WORKTREE_ID', 'worktreeId 必须是完整 UUID。');
  }
  const repositoryId = options.repositoryId ?? readRepositoryIdentity(context)?.repository_id ?? randomUUID();
  const values = {
    task,
    task_short: shortenTaskSlug(task),
    repo: context.repo_name,
    host: normalizeHostSlug(options.host ?? 'agent'),
    id8: worktreeId.replaceAll('-', '').slice(0, 8),
  };
  const branch = validateBranchName(renderTemplate(profile.branch_template, values), context.current_worktree);
  const renderedPath = renderTemplate(profile.path_template, values);
  if (isAbsolute(renderedPath)) {
    throw new WorktreeProfileError('SPAWN_PATH_OUTSIDE_ROOT', `path_template 不能生成绝对路径: ${renderedPath}`);
  }

  const rootCandidate = resolveRootBase(
    options.worktreeRootOverride ?? profile.worktree_root,
    context.primary_worktree,
    values,
  );
  if (existsSync(rootCandidate) && !statSync(rootCandidate).isDirectory()) {
    throw new WorktreeProfileError('WORKTREE_ROOT_INVALID', `worktree_root 已存在但不是目录: ${rootCandidate}`);
  }
  const rootBase = canonicalizeFuturePath(rootCandidate);
  const legacyLayout = renderedPath.startsWith('../');
  const repositoryRoot = legacyLayout
    ? rootBase
    : selectRepositoryRoot(rootBase, context.repo_name, repositoryId);
  const allowedRoot = repositoryRoot;
  const targetCandidate = legacyLayout
    ? resolve(context.primary_worktree, renderedPath)
    : resolve(repositoryRoot, renderedPath);
  const targetPath = canonicalizeFuturePath(targetCandidate);
  if (!isStrictlyInside(allowedRoot, targetPath)) {
    throw new WorktreeProfileError(
      'SPAWN_PATH_OUTSIDE_ROOT',
      `spawn path 逃出允许根: target=${targetPath} root=${allowedRoot}`,
    );
  }

  const base = resolveBaseRef(context.current_worktree, profile.default_base, options.base ?? null);
  const branchExists = gitTry(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], context.current_worktree).ok;
  return {
    ...loaded,
    task,
    task_short: values.task_short,
    host_slug: values.host,
    worktree_id: worktreeId,
    repository_id: repositoryId,
    branch,
    path: targetPath,
    worktree_root_base: rootBase,
    repository_root: repositoryRoot,
    legacy_layout: legacyLayout,
    allowed_root: allowedRoot,
    base_ref: base.ref,
    base_source: base.source,
    branch_exists: branchExists,
    path_exists: existsSync(targetPath),
  };
}

/** @param {ReturnType<typeof resolveGitContext>} context */
export function readRepositoryIdentity(context) {
  const identityPath = join(context.common_dir, 'worktree-trace', 'v1', 'repository.json');
  if (!existsSync(identityPath)) return null;
  try {
    const value = JSON.parse(readFileSync(identityPath, 'utf8'));
    if (
      value &&
      value.schema_version === PROFILE_SCHEMA_VERSION &&
      typeof value.repository_id === 'string'
    ) {
      return value;
    }
  } catch {
    // 由调用者/doctor 决定如何报告损坏；读取函数不覆盖。
  }
  throw new WorktreeProfileError('REPOSITORY_IDENTITY_INVALID', `repository identity 损坏: ${identityPath}`);
}

/** @param {ReturnType<typeof resolveGitContext>} context @param {string|null} [proposedId] */
export function ensureRepositoryIdentity(context, proposedId = null) {
  const existing = readRepositoryIdentity(context);
  if (existing) return existing;
  const traceRoot = join(context.common_dir, 'worktree-trace', 'v1');
  mkdirSync(traceRoot, { recursive: true });
  const identityPath = join(traceRoot, 'repository.json');
  const value = {
    schema_version: PROFILE_SCHEMA_VERSION,
    repository_id: proposedId ?? randomUUID(),
    created_at: new Date().toISOString(),
  };
  const tempPath = `${identityPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      // hard link 是同一 common-dir 文件系统内的原子「不存在才创建」，不会像 rename 覆盖并发赢家。
      linkSync(tempPath, identityPath);
      unlinkSync(tempPath);
    } catch (error) {
      if (existsSync(identityPath)) {
        unlinkSync(tempPath);
        return readRepositoryIdentity(context);
      }
      throw error;
    }
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  return value;
}

/** @param {string} candidate @param {string[]} patterns */
export function classifyStorage(candidate, patterns = BUILTIN_EPHEMERAL_PATTERNS) {
  const normalized = `${canonicalizeFuturePath(candidate).replaceAll('\\', '/')}/`;
  return patterns.some((pattern) => normalized.includes(pattern.replaceAll('\\', '/')))
    ? 'ephemeral'
    : 'persistent';
}
