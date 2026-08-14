#!/usr/bin/env node
// @ts-check

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROFILE_FILENAME,
  WorktreeProfileError,
  canonicalizeFuturePath,
  claimWorktreeRepositoryRoot,
  classifyStorage,
  ensureRepositoryIdentity,
  loadRepositoryProfile,
  readRepositoryIdentity,
  resolveBaseRef,
  resolveSpawnPlan,
  validateTaskNaming,
  validateTaskSlug,
} from './worktree-profile.mjs';
import {
  GitlabSubmitError,
  gitlabSubmitPushArgs,
  parseGitlabMergeRequestUrl,
} from './worktree-provider-gitlab.mjs';
import {
  WorktreeTraceError,
  appendTraceEvent,
  initializeTraceStore,
  inspectRecordLock,
  listRecordCacheEntries,
  readEventChain,
  rebuildRecordCache,
  recoverRecordLock,
  traceLayout,
} from './worktree-trace.mjs';

const PREFIX = '[worktree-mgr]';
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const FETCH_TIMEOUT_MS = 10_000;
const SUBMIT_PUSH_TIMEOUT_MS = 60_000;
const CODEGRAPH_TIMEOUT_MS = 10 * 60_000;
const WATCH_DEFAULT_INTERVAL_MS = 30_000;
const WATCH_MIN_INTERVAL_MS = 100;
const WATCH_MAX_INTERVAL_MS = 60 * 60_000;
const WATCH_HEARTBEAT_MIN_STALE_MS = 5_000;
const WATCH_TARGET_CACHE_MAX_AGE_MS = 15_000;
const WATCH_TARGET_LEASE_STALE_MS = FETCH_TIMEOUT_MS * 2;
const WATCH_SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const TERMINAL_TASK_STATES = new Set(['done', 'abandoned']);
const TASK_TRANSITIONS = {
  active: new Set(['active', 'blocked', 'ready_for_review', 'abandoned']),
  blocked: new Set(['blocked', 'active', 'abandoned']),
  ready_for_review: new Set(['ready_for_review', 'integrating', 'active', 'abandoned']),
  integrating: new Set(['integrating', 'done', 'active', 'abandoned']),
  done: new Set(['done']),
  abandoned: new Set(['abandoned']),
};

/** @param {string[]} args @param {string} [cwd] */
function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/**
 * 有界执行外部命令。timeout 是 spawn/fetch 不得无限挂住的底线，也供单测验证。
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?:string, timeoutMs?:number, stdio?:any}} [options]
 */
export function runFileTry(command, args, options = {}) {
  try {
    const output = execFileSync(command, args, {
      cwd: options.cwd ?? process.cwd(),
      encoding: 'utf8',
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, out: typeof output === 'string' ? output.trim() : '' };
  } catch (error) {
    return {
      ok: false,
      out: error && typeof error === 'object' && 'stdout' in error ? String(error.stdout).trim() : '',
      error,
    };
  }
}

/**
 * 同时捕获 stdout/stderr，供 Git remote sideband（MR URL 通常写在 stderr）解析。
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?:string, timeoutMs?:number}} [options]
 */
export function runFileCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = String(result.stdout ?? '').trim();
  const stderr = String(result.stderr ?? '').trim();
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout,
    stderr,
    out: [stdout, stderr].filter(Boolean).join('\n'),
    error: result.error ?? null,
  };
}

/** @param {string[]} args @param {string} [cwd] @param {{timeoutMs?:number,stdio?:any}} [options] */
function gitTry(args, cwd = process.cwd(), options = {}) {
  return runFileTry('git', args, { cwd, ...options });
}

/** @param {string|Buffer} value */
function contentDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** Installation-path-independent digest used in cross-Skill contracts. */
export function worktreeSkillDigest(root = SKILL_ROOT) {
  const files = [];
  const visit = (absolute, relativePath) => {
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) for (const name of readdirSync(absolute).sort()) visit(join(absolute, name), relativePath ? `${relativePath}/${name}` : name);
    else if (stat.isFile() || stat.isSymbolicLink()) {
      const bytes = readFileSync(absolute);
      files.push({ path: relativePath, size: bytes.length, sha256: contentDigest(bytes) });
    }
  };
  for (const name of ['SKILL.md', 'agents', 'references', 'scripts']) if (existsSync(join(root, name))) visit(join(root, name), name);
  return contentDigest(Buffer.from(JSON.stringify(files.sort((a, b) => a.path.localeCompare(b.path)))));
}

/** @param {{error?:unknown}} result @param {string} fallback */
function commandFailureReason(result, fallback) {
  const error = result.error;
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String(error.stderr ?? '').trim();
    if (stderr) return stderr.slice(0, 500);
  }
  if (error instanceof Error && error.message) return error.message.slice(0, 500);
  return fallback;
}

/** @param {unknown} error */
function isRootWriteDenied(error) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['EACCES', 'EPERM', 'EROFS'].includes(String(error.code)),
  );
}

/** @param {number} milliseconds */
function sleep(milliseconds) {
  Atomics.wait(WATCH_SLEEP_CELL, 0, 0, milliseconds);
}

/** @param {number} pid @param {(pid:number,signal:0)=>void} [probe] */
export function processIsAlive(pid, probe = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    // kill(2) 的 EPERM 表示进程存在、只是当前 sandbox/user 无权 signal；不能误报 stale。
    return Boolean(error && typeof error === 'object' && error.code === 'EPERM');
  }
}

/** @param {string} commonDir */
function watcherDirectory(commonDir) {
  return join(traceLayout(commonDir).root, 'watchers');
}

/** @param {string} commonDir @param {string} worktreeId */
function watcherPath(commonDir, worktreeId) {
  return join(watcherDirectory(commonDir), `${worktreeId}.json`);
}

/** @param {string} commonDir @param {string} worktreeId */
function readWatcherHeartbeat(commonDir, worktreeId) {
  const path = watcherPath(commonDir, worktreeId);
  if (!existsSync(path)) return { ok: false, state: null, error: 'missing' };
  try {
    return { ok: true, state: JSON.parse(readFileSync(path, 'utf8')), error: null };
  } catch (error) {
    return { ok: false, state: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** @param {string} commonDir @param {Record<string,unknown>} state */
function writeWatcherHeartbeat(commonDir, state) {
  const directory = watcherDirectory(commonDir);
  mkdirSync(directory, { recursive: true });
  const path = watcherPath(commonDir, String(state.worktree_id));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...state, heartbeat_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** @param {string} commonDir @param {string} worktreeId @param {string} token */
function removeWatcherHeartbeat(commonDir, worktreeId, token) {
  const current = readWatcherHeartbeat(commonDir, worktreeId);
  if (current.ok && current.state?.token !== token) return;
  rmSync(watcherPath(commonDir, worktreeId), { force: true });
}

/** @param {unknown} raw */
function parseWatchInterval(raw) {
  const value = raw === null || raw === undefined ? WATCH_DEFAULT_INTERVAL_MS : Number(raw);
  if (!Number.isInteger(value) || value < WATCH_MIN_INTERVAL_MS || value > WATCH_MAX_INTERVAL_MS) {
    die(`--interval-ms 必须是 ${WATCH_MIN_INTERVAL_MS}-${WATCH_MAX_INTERVAL_MS} 的整数。`, 2);
  }
  return value;
}

/** @param {Record<string,any>} record @param {{ok:boolean,state:any,error:string|null}} heartbeat */
function watcherHealth(record, heartbeat) {
  const armed = record.auto_reclaim;
  if (!armed || armed.state === 'disarmed' || armed.state === 'reclaimed') return { healthy: false, reason: 'not armed' };
  if (!heartbeat.ok) return { healthy: false, reason: heartbeat.error ?? 'missing heartbeat' };
  if (heartbeat.state?.token !== armed.token) return { healthy: false, reason: 'token mismatch' };
  if (!processIsAlive(Number(heartbeat.state?.pid))) return { healthy: false, reason: 'pid not alive' };
  const heartbeatAt = Date.parse(String(heartbeat.state?.heartbeat_at ?? ''));
  const staleAfter = Math.max(Number(armed.interval_ms ?? WATCH_DEFAULT_INTERVAL_MS) * 4, WATCH_HEARTBEAT_MIN_STALE_MS);
  if (!Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > staleAfter) return { healthy: false, reason: 'heartbeat stale' };
  return { healthy: true, reason: null };
}

/** @param {string} targetRef @param {string} cwd */
function refreshTargetRef(targetRef, cwd) {
  const remotes = gitTry(['remote'], cwd);
  const remote = remotes.ok
    ? remotes.out.split('\n').filter(Boolean).find((name) => targetRef.startsWith(`${name}/`))
    : null;
  let fetch = { ok: true, out: '' };
  if (remote) {
    const branch = targetRef.slice(remote.length + 1);
    fetch = gitTry(['fetch', remote, branch, '-q'], cwd, { timeoutMs: FETCH_TIMEOUT_MS, stdio: 'ignore' });
  }
  const resolved = gitTry(['rev-parse', `${targetRef}^{commit}`], cwd);
  return { ok: resolved.ok, target_sha: resolved.ok ? resolved.out : null, fetch_ok: fetch.ok };
}

/** @param {string} commonDir */
function targetCacheDirectory(commonDir) {
  return join(traceLayout(commonDir).root, 'watch-targets');
}

/** @param {string} targetRef */
function targetCacheKey(targetRef) {
  return createHash('sha256').update(targetRef).digest('hex');
}

/** @param {string} commonDir @param {string} targetRef */
function readTargetCache(commonDir, targetRef) {
  const path = join(targetCacheDirectory(commonDir), `${targetCacheKey(targetRef)}.json`);
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return state?.target_ref === targetRef ? state : null;
  } catch {
    return null;
  }
}

/** @param {Record<string,any>|null} state @param {number} maxAgeMs */
function freshTargetCache(state, maxAgeMs) {
  const fetchedAt = Date.parse(String(state?.fetched_at ?? ''));
  const age = Date.now() - fetchedAt;
  return Number.isFinite(fetchedAt) && age >= 0 && age <= maxAgeMs ? state : null;
}

/**
 * 多个 per-record worker 通过 common-dir cache + 原子 mkdir lease 合并同 target fetch。
 * cache 只减少远端请求；调用方仍必须逐 record 执行 merge-base 祖先校验。
 * @param {string} commonDir
 * @param {string} targetRef
 * @param {string} cwd
 * @param {number} [maxAgeMs]
 */
export function refreshTargetRefCached(commonDir, targetRef, cwd, maxAgeMs = WATCH_TARGET_CACHE_MAX_AGE_MS) {
  const cached = freshTargetCache(readTargetCache(commonDir, targetRef), maxAgeMs);
  if (cached) return { ok: cached.ok, target_sha: cached.target_sha, fetch_ok: cached.fetch_ok, cache_hit: true, fetch_count: cached.fetch_count };

  const directory = targetCacheDirectory(commonDir);
  mkdirSync(directory, { recursive: true });
  const key = targetCacheKey(targetRef);
  const lockPath = join(directory, `${key}.lock`);
  let ownsLease = false;
  try {
    mkdirSync(lockPath);
    ownsLease = true;
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > WATCH_TARGET_LEASE_STALE_MS) {
        rmSync(lockPath, { recursive: true, force: true });
        mkdirSync(lockPath);
        ownsLease = true;
      }
    } catch {}
  }

  if (!ownsLease) {
    const deadline = Date.now() + Math.min(FETCH_TIMEOUT_MS, 2_000);
    while (Date.now() < deadline) {
      sleep(25);
      const shared = freshTargetCache(readTargetCache(commonDir, targetRef), maxAgeMs);
      if (shared) return { ok: shared.ok, target_sha: shared.target_sha, fetch_ok: shared.fetch_ok, cache_hit: true, fetch_count: shared.fetch_count };
    }
    return { ...refreshTargetRef(targetRef, cwd), cache_hit: false, cache_bypassed: true, fetch_count: null };
  }

  try {
    const afterLease = freshTargetCache(readTargetCache(commonDir, targetRef), maxAgeMs);
    if (afterLease) return { ok: afterLease.ok, target_sha: afterLease.target_sha, fetch_ok: afterLease.fetch_ok, cache_hit: true, fetch_count: afterLease.fetch_count };
    const previous = readTargetCache(commonDir, targetRef);
    const refreshed = refreshTargetRef(targetRef, cwd);
    const state = {
      schema_version: 1,
      target_ref: targetRef,
      ...refreshed,
      fetched_at: new Date().toISOString(),
      fetch_count: Number(previous?.fetch_count ?? 0) + 1,
    };
    const path = join(directory, `${key}.json`);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return { ...refreshed, cache_hit: false, fetch_count: state.fetch_count };
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/** @param {unknown} raw */
function parseNotifyMode(raw) {
  const mode = raw === null || raw === undefined ? 'auto' : String(raw);
  if (!['auto', 'off'].includes(mode)) die('--notify 只接受 auto/off。', 2);
  return mode;
}

/**
 * 固定 argv 的 best-effort 通知 adapter；不拼 shell，也不执行仓库/Profile 字符串。
 * @param {Record<string,any>} record
 * @param {{platform?:string, runner?:typeof runFileTry}} [options]
 */
export function deliverReclaimNotification(record, options = {}) {
  const mode = record.auto_reclaim?.notify ?? 'auto';
  if (mode === 'off') return { attempted: false, delivered: false, adapter: 'off', reason: 'disabled' };
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runFileTry;
  const summary = record.reclaim_summary ?? {};
  const change = summary.change_ref ? ` (${summary.change_ref})` : '';
  const message = `${record.task}${change} 已自动回收`;
  let adapter;
  let command;
  let args;
  if (platform === 'darwin') {
    adapter = 'macos-osascript';
    command = 'osascript';
    args = ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run', message, 'Worktree 已回收'];
  } else if (platform === 'linux') {
    adapter = 'linux-notify-send';
    command = 'notify-send';
    args = ['Worktree 已回收', message];
  } else {
    return { attempted: false, delivered: false, adapter: 'unavailable', reason: `unsupported platform: ${platform}` };
  }
  const result = runner(command, args, { timeoutMs: 3_000, stdio: 'ignore' });
  return { attempted: true, delivered: result.ok, adapter, reason: result.ok ? null : 'notification command unavailable/failed' };
}

function log(message) {
  console.log(`${PREFIX} ${message}`);
}

function die(message, code = 1) {
  console.error(`${PREFIX} ${message}`);
  process.exit(code);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const flags = new Map();
  const positionals = [];
  const booleanFlags = new Set(['json', 'all', 'recover-lock', 'no-watch', 'abort-on-conflict', 'no-rerere', 'recompose']);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const equal = value.indexOf('=');
    const key = value.slice(2, equal >= 0 ? equal : undefined);
    if (booleanFlags.has(key)) {
      flags.set(key, true);
      continue;
    }
    const flagValue = equal >= 0 ? value.slice(equal + 1) : argv[++index];
    if (flagValue === undefined || flagValue.startsWith('--')) die(`--${key} 后需要值。`, 2);
    flags.set(key, flagValue);
  }
  return { flags, positionals };
}

/** @param {Map<string, unknown>} flags @param {string} name */
function flag(flags, name) {
  const value = flags.get(name);
  return typeof value === 'string' ? value : null;
}

/** @param {Map<string, unknown>} flags @param {string[]} allowed */
function rejectUnknownFlags(flags, allowed) {
  const allow = new Set(allowed);
  for (const key of flags.keys()) if (!allow.has(key)) die(`未知 flag: --${key}`, 2);
}

/** @param {string} value @param {string} label @param {number} max */
function oneLine(value, label, max) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f\r\n]/.test(normalized)) {
    die(`${label} 必须是 1-${max} 字符的单行文本。`, 2);
  }
  return normalized;
}

/** @param {Map<string, unknown>} flags @param {{target?:boolean, requirePurpose?:boolean}} [options] */
function resolveIdentity(flags, options = {}) {
  const target = options.target ?? false;
  const hostFlag = target ? 'to-agent' : 'agent';
  const idFlag = target ? 'to-agent-id' : 'agent-id';
  const hostEnv = target ? null : process.env.WORKTREE_AGENT_HOST;
  const idEnv = target ? null : process.env.WORKTREE_AGENT_ID;
  const host = flag(flags, hostFlag) ?? hostEnv ?? null;
  const id = flag(flags, idFlag) ?? idEnv ?? null;
  if (!host || !id) {
    die(
      [
        `需要 --${hostFlag} 和 --${idFlag}（或标准 WORKTREE_AGENT_* 环境变量）。`,
        `  --${hostFlag}: 宿主名，取 claude / codex / kiro / cursor / aider / human / custom:<name>。`,
        `  --${idFlag}: 宿主的真实 session/thread ID（如 Claude Code 会话 UUID、Codex thread id）——去宿主上下文里查，禁止现编占位值，否则 trace 记录无法回溯到会话。`,
        `  取值规范：使用可读 semantic task，branch/path 保留完整 host 与 task。`,
      ].join('\n'),
      2,
    );
  }
  const normalizedHost = oneLine(host, hostFlag, 64).toLowerCase();
  if (!/^(?:[a-z][a-z0-9._:-]{0,63}|custom:[a-z0-9._-]+)$/.test(normalizedHost)) {
    die(`${hostFlag} 格式非法。`, 2);
  }
  const actor = { host: normalizedHost, id: oneLine(id, idFlag, 128) };
  const purposeRaw = flag(flags, 'purpose') ?? process.env.WORKTREE_TASK_PURPOSE ?? null;
  const purpose = options.requirePurpose
    ? oneLine(purposeRaw ?? '', 'purpose', 240)
    : purposeRaw
      ? oneLine(purposeRaw, 'purpose', 240)
      : null;
  return {
    actor,
    purpose,
    owner: flag(flags, 'owner') ?? process.env.WORKTREE_OWNER ?? null,
    sources: {
      host: flag(flags, hostFlag) ? 'CLI' : 'ENV',
      id: flag(flags, idFlag) ? 'CLI' : 'ENV',
      purpose: purposeRaw ? (flag(flags, 'purpose') ? 'CLI' : 'ENV') : null,
    },
  };
}

function printIdentity(identity, task, profile) {
  log(`Agent: ${identity.actor.host} / ${identity.actor.id}（host=${identity.sources.host}, id=${identity.sources.id}）`);
  log(`Task: ${task}`);
  if (identity.purpose) log(`Purpose: ${identity.purpose}（${identity.sources.purpose}）`);
  if (identity.owner) log(`Owner: ${identity.owner}`);
  log(`Profile: ${profile.profile_source} (${profile.profile_path})`);
}

/**
 * primary Profile 决定 branch/path 命名，必须先与其声明的 remote base 对齐。
 * 否则继续 spawn 会用旧模板创建一个“技术合法、治理错误”的 worktree。
 * 显式 --config 是恢复出口：调用者可提供已核对过的 base Profile。
 * @param {ReturnType<typeof loadRepositoryProfile>} loaded
 */
function requireFreshPrimaryProfile(loaded) {
  if (loaded.profile_source !== 'primary' || !loaded.profile.default_base) return;
  const [remote, ...branchParts] = loaded.profile.default_base.split('/');
  const branch = branchParts.join('/');
  if (!remote || !branch) {
    die(
      `Profile default_base=${loaded.profile.default_base} 不是可刷新 remote/branch；无法证明命名 DoD，请用 --config 指向已核对 Profile。`,
      2,
    );
  }
  const fetched = gitTry(['fetch', remote, branch, '-q'], loaded.context.current_worktree, {
    timeoutMs: FETCH_TIMEOUT_MS,
    stdio: 'ignore',
  });
  if (!fetched.ok) {
    die(
      `无法刷新 Profile baseline ${loaded.profile.default_base}；为避免使用陈旧 branch/path 模板，拒绝继续。请恢复网络或用 --config 指向已核对 Profile。`,
      2,
    );
  }
  const drift = primaryProfileDriftFinding(loaded);
  if (drift) die(`${drift.detail}\n恢复方式：同步 primary Profile，或用 --config <已核对的 .worktree-trace.json>。`, 2);
}

/**
 * Profile 的 default_base 是项目默认治理边界。portable core 仍允许依赖分支，
 * 但显式偏离时必须留下原因，避免“技术上已登记、语义上无人知道为何偏离”。
 * @param {Map<string, unknown>} flags
 * @param {string|null} defaultBase
 * @param {string} baseRef
 * @param {string} baseSource
 */
function resolveBaseOverrideReason(flags, defaultBase, baseRef, baseSource) {
  if (baseSource !== 'cli' || !defaultBase || baseRef === defaultBase) return null;
  const raw = flag(flags, 'base-reason');
  if (!raw) {
    die(`--base ${baseRef} 偏离 Profile default_base=${defaultBase}；必须同时提供 --base-reason <原因>。`, 2);
  }
  return oneLine(raw, 'base-reason', 240);
}

/** @returns {{path:string,branch:string|null,head:string|null,bare:boolean,detached:boolean}[]} */
function parseWorktrees(cwd = process.cwd()) {
  const listed = gitTry(['worktree', 'list', '--porcelain'], cwd);
  if (!listed.ok) return [];
  const records = [];
  let current = null;
  for (const line of listed.out.split('\n')) {
    if (line.startsWith('worktree ')) {
      const rawPath = line.slice('worktree '.length);
      current = {
        path: existsSync(rawPath) ? realpathSync(rawPath) : resolve(rawPath),
        branch: null,
        head: null,
        bare: false,
        detached: false,
      };
      records.push(current);
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (current && line === 'detached') current.detached = true;
    else if (current && line === 'bare') current.bare = true;
  }
  return records;
}

/** @param {string} commonDir */
function loadRecords(commonDir) {
  return listRecordCacheEntries(commonDir)
    .filter((entry) => entry.record)
    .map((entry) => entry.record);
}

/** @param {Record<string, any>} record */
function isActiveRecord(record) {
  return !TERMINAL_TASK_STATES.has(record.task_status) && record.worktree_state !== 'reclaimed';
}

/**
 * 同一宿主会话默认只延续一条交付链。task 名不是交付身份：如果仅因刷新 base、
 * 整理提交或继续验收而换名，必须继续使用已有 worktree。确需并存/替代时由 CLI
 * 显式留下关系和原因，不能靠新 task slug 绕过复用。
 * @param {Record<string, any>[]} records
 * @param {{host:string,id:string}} actor
 * @param {string} task
 */
function coexistingSessionRecords(records, actor, task) {
  return records.filter((record) =>
    record.worktree_state !== 'reclaimed' &&
    record.task !== task &&
    record.agent?.host === actor.host &&
    record.agent?.id === actor.id);
}

/**
 * @param {Map<string, unknown>} flags
 * @param {Record<string, any>[]} records
 * @param {Record<string, any>[]} coexisting
 */
function resolveDeliveryRelation(flags, records, coexisting) {
  const parallelReasonRaw = flag(flags, 'parallel-reason');
  const supersedesSelector = flag(flags, 'supersedes');
  const replacementReasonRaw = flag(flags, 'replacement-reason');
  if (parallelReasonRaw && (supersedesSelector || replacementReasonRaw)) {
    die('--parallel-reason 与 --supersedes/--replacement-reason 互斥；请明确是独立并行还是替代。', 2);
  }
  if (replacementReasonRaw && !supersedesSelector) {
    die('--replacement-reason 必须与 --supersedes <selector> 一起使用。', 2);
  }
  if (supersedesSelector && !replacementReasonRaw) {
    die('--supersedes 必须同时提供 --replacement-reason <原因>。', 2);
  }
  if (coexisting.length === 0) {
    if (parallelReasonRaw || supersedesSelector) {
      die('当前会话没有其他未回收 worktree；不应声明 parallel/supersedes 关系。', 2);
    }
    return null;
  }

  const summary = coexisting
    .map((record) => `${record.task}(${record.task_status}/${record.worktree_state})=${record.path}`)
    .join('\n  - ');
  if (!parallelReasonRaw && !supersedesSelector) {
    die(
      `DELIVERY_WORKTREE_EXISTS: 同一 Agent 会话已有未回收 worktree，默认复用而不是换 task 名新建：\n` +
      `  - ${summary}\n` +
      '继续同一事项：直接进入原路径工作；确属独立并行：加 --parallel-reason <原因>；' +
      '确属替代：先冻结旧树并标记 abandoned，再加 --supersedes <selector> --replacement-reason <原因>。',
      2,
    );
  }

  const declaredAt = new Date().toISOString();
  if (parallelReasonRaw) {
    return {
      kind: 'parallel',
      reason: oneLine(parallelReasonRaw, 'parallel-reason', 240),
      related_worktree_ids: coexisting.map((record) => record.worktree_id),
      declared_at: declaredAt,
    };
  }

  const superseded = selectRecord(records, supersedesSelector, null);
  if (!coexisting.some((record) => record.worktree_id === superseded.worktree_id)) {
    die('--supersedes 必须指向同一 Agent 会话的一棵未回收 worktree。', 2);
  }
  if (superseded.task_status !== 'abandoned') {
    die(`替代前必须先冻结旧树并 touch ${superseded.task} --status abandoned --note <迁移边界>；当前为 ${superseded.task_status}。`, 2);
  }
  const snapshot = liveGitSnapshot(superseded);
  if (!snapshot.present) die(`被替代 worktree missing: ${superseded.path}；请先 doctor/reclaim。`, 2);
  if (snapshot.dirty !== false) die(`被替代 worktree 必须干净，当前 dirty=${snapshot.dirty}: ${superseded.path}`, 2);
  return {
    kind: 'supersedes',
    reason: oneLine(replacementReasonRaw, 'replacement-reason', 240),
    related_worktree_ids: [superseded.worktree_id],
    superseded_worktree_id: superseded.worktree_id,
    declared_at: declaredAt,
  };
}

/** @param {Record<string,any>} left @param {Record<string,any>} right */
function sameAgentSession(left, right) {
  return left.agent?.host === right.agent?.host && left.agent?.id === right.agent?.id;
}

/**
 * 校验一对 record 确实能形成“旧树被新树替代”的交付关系。
 * 这既供 spawn 后的补登记使用，也供 superseded reclaim 做强前置校验。
 * @param {Record<string,any>} superseded
 * @param {Record<string,any>} replacement
 */
function validateSupersessionPair(superseded, replacement) {
  if (superseded.worktree_id === replacement.worktree_id) die('旧树和替代树不能是同一条 record。', 2);
  if (!sameAgentSession(superseded, replacement)) {
    die('替代关系只允许连接同一 Agent 会话的 worktree；跨会话请走 handoff 或人工说明。', 2);
  }
  if (superseded.owner && replacement.owner && superseded.owner !== replacement.owner) {
    die(`替代关系 owner 不一致：${superseded.owner} != ${replacement.owner}。`, 2);
  }
  if (superseded.task_status !== 'abandoned') {
    die(`被替代树必须先标记 abandoned；当前 ${superseded.task}=${superseded.task_status}。`, 2);
  }
  if (superseded.worktree_state === 'reclaimed') die('被替代树已经 reclaimed，无需再登记替代关系。', 2);
  if (TERMINAL_TASK_STATES.has(replacement.task_status) || replacement.worktree_state === 'reclaimed') {
    die(`替代树必须仍是可交付状态；当前 ${replacement.task}=${replacement.task_status}/${replacement.worktree_state}。`, 2);
  }
  if (String(replacement.created_at ?? '') < String(superseded.created_at ?? '')) {
    die('替代树的 created_at 早于被替代树，拒绝反向登记。', 2);
  }
  for (const record of [superseded, replacement]) {
    const snapshot = liveGitSnapshot(record);
    if (!snapshot.present) die(`worktree missing: ${record.path}；请先 doctor。`, 2);
    if (snapshot.dirty !== false) die(`替代关系两端必须干净，当前 dirty=${snapshot.dirty}: ${record.path}`, 2);
  }
}

/**
 * 对已经存在的两棵树补登记双向 supersession。命令可幂等重跑；任何冲突关系均 fail-closed。
 * @param {{positionals:string[],flags:Map<string,unknown>}} args
 */
function cmdSupersede(args) {
  rejectUnknownFlags(args.flags, ['by', 'reason', 'id', 'by-id', 'config']);
  const bySelector = flag(args.flags, 'by');
  const reason = oneLine(flag(args.flags, 'reason') ?? '', 'reason', 240);
  if (!bySelector) die('supersede 需要 --by <replacement-selector>。', 2);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const records = loadRecords(loaded.context.common_dir);
  let superseded = selectRecord(records, args.positionals[0] ?? null, flag(args.flags, 'id'));
  let replacement = selectRecord(records, bySelector, flag(args.flags, 'by-id'));
  validateSupersessionPair(superseded, replacement);

  const existingForward = replacement.delivery_relation;
  if (existingForward && (
    existingForward.kind !== 'supersedes' ||
    existingForward.superseded_worktree_id !== superseded.worktree_id
  )) {
    die(`替代树已有冲突 delivery_relation=${existingForward.kind ?? 'unknown'}。`, 2);
  }
  const existingBack = superseded.superseded_by;
  if (existingBack && existingBack.worktree_id !== replacement.worktree_id) {
    die(`被替代树已指向另一替代树 ${existingBack.worktree_id}。`, 2);
  }
  const existingReason = existingForward?.reason ?? existingBack?.reason ?? null;
  if (existingReason && existingReason !== reason) {
    die(`替代关系已用不同原因登记：${existingReason}`, 2);
  }
  const declaredAt = existingForward?.declared_at ?? existingBack?.declared_at ?? new Date().toISOString();

  if (!existingForward) {
    replacement = updateRecord(replacement, 'delivery_relation_declared', (next) => {
      next.delivery_relation = {
        kind: 'supersedes',
        reason,
        related_worktree_ids: [superseded.worktree_id],
        superseded_worktree_id: superseded.worktree_id,
        declared_at: declaredAt,
      };
    }, {
      superseded_worktree_id: superseded.worktree_id,
      superseded_task: superseded.task,
      reason,
    }, loaded.context.common_dir);
  }
  if (!existingBack) {
    superseded = updateRecord(superseded, 'superseded_by_declared', (next) => {
      next.superseded_by = {
        worktree_id: replacement.worktree_id,
        task: replacement.task,
        reason,
        declared_at: declaredAt,
      };
    }, {
      replacement_worktree_id: replacement.worktree_id,
      replacement_task: replacement.task,
      reason,
    }, loaded.context.common_dir);
  }
  log(`替代关系已登记 ${superseded.task} -> ${replacement.task}（${superseded.worktree_id.slice(0, 8)} -> ${replacement.worktree_id.slice(0, 8)}）。`);
}

/** @param {string} value */
function canonicalSelectorPath(value) {
  try {
    return existsSync(value) ? realpathSync(value) : resolve(value);
  } catch {
    return resolve(value);
  }
}

/** @param {Record<string, any>[]} records @param {string|null} selector @param {string|null} explicitId */
function selectRecord(records, selector, explicitId) {
  const idQuery = explicitId ?? null;
  let idMatches = [];
  if (idQuery) {
    if (!/^(?:[0-9a-f]{8,32}|[0-9a-f-]{36})$/i.test(idQuery)) die('--id 需要完整 UUID 或至少 8 位十六进制前缀。', 2);
    idMatches = records.filter((record) => record.worktree_id.toLowerCase().startsWith(idQuery.toLowerCase()));
    if (idMatches.length !== 1) die(`--id 匹配 ${idMatches.length} 条 record，必须唯一。`, 2);
  }
  if (!selector) {
    if (idMatches.length === 1) return idMatches[0];
    die('缺少 record selector。', 2);
  }

  const matches = new Map();
  if (/^[0-9a-f]{8,}$/i.test(selector) || /^[0-9a-f-]{36}$/i.test(selector)) {
    for (const record of records) if (record.worktree_id.toLowerCase().startsWith(selector.toLowerCase())) matches.set(record.worktree_id, record);
  }
  const pathCandidate = canonicalSelectorPath(selector);
  const semanticMatches = (pool) => pool.filter((record) =>
    record.task === selector || record.branch === selector || canonicalSelectorPath(record.path) === pathCandidate,
  );
  const activeSemantic = semanticMatches(records.filter(isActiveRecord));
  const selectedSemantic = activeSemantic.length > 0 ? activeSemantic : semanticMatches(records);
  for (const record of selectedSemantic) matches.set(record.worktree_id, record);
  if (idMatches.length === 1) {
    for (const record of matches.values()) if (record.worktree_id !== idMatches[0].worktree_id) die('selector 与 --id 指向不同 record，拒绝歧义。', 2);
    return idMatches[0];
  }
  if (matches.size !== 1) die(`selector 匹配 ${matches.size} 条 record；请传 --id。`, 2);
  return [...matches.values()][0];
}

/** @param {Record<string, any>} record */
function liveGitSnapshot(record) {
  const live = parseWorktrees().find((worktree) => worktree.path === canonicalSelectorPath(record.path));
  if (!live) return { present: false, head: record.last_head ?? null, dirty: null, upstream: null };
  const status = gitTry(['status', '--porcelain'], live.path);
  const upstream = gitTry(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], live.path);
  return {
    present: true,
    head: live.head ?? gitTry(['rev-parse', 'HEAD'], live.path).out ?? null,
    dirty: status.ok ? status.out !== '' : null,
    upstream: upstream.ok ? upstream.out : null,
  };
}

/** @param {Record<string, any>} record @param {string} eventType @param {(next:Record<string,any>)=>void} update @param {Record<string,unknown>} [details] @param {string|null} [commonDir] */
function updateRecord(record, eventType, update, details = {}, commonDir = null) {
  return appendTraceEvent({
    commonDir: commonDir ?? loadRepositoryProfile().context.common_dir,
    worktreeId: record.worktree_id,
    eventType,
    actor: record.agent ?? null,
    details,
    mutate(current) {
      if (!current) throw new Error('record snapshot missing');
      const next = structuredClone(current);
      update(next);
      next.updated_at = new Date().toISOString();
      return next;
    },
  }).record;
}

/** @param {string|null|undefined} value */
export function normalizeCodegraphMode(value) {
  const mode = value || 'auto';
  if (!['auto', 'on', 'off'].includes(mode)) {
    throw new Error(`--codegraph 只接受 auto/on/off，收到: ${mode}`);
  }
  return mode;
}

/** @param {string} worktreePath @param {string} primaryWorktree @param {string} mode */
function ensureWorktreeCodegraph(worktreePath, primaryWorktree, mode) {
  if (mode === 'off') {
    log('CodeGraph: 已按 --codegraph off 跳过。');
    return;
  }
  const database = resolve(worktreePath, '.codegraph', 'codegraph.db');
  if (existsSync(database)) {
    log(`CodeGraph: 独立索引已存在，复用 ${database}`);
    return;
  }
  const sourceDatabase = resolve(primaryWorktree, '.codegraph', 'codegraph.db');
  if (mode === 'auto' && !existsSync(sourceDatabase)) {
    log('CodeGraph: 主工作树未初始化，auto 模式跳过（需要时用 --codegraph on）。');
    return;
  }
  const available = runFileTry('codegraph', ['--version'], { timeoutMs: 5_000 });
  if (!available.ok) {
    if (mode === 'on') die('CodeGraph: 本机找不到 codegraph CLI，--codegraph on 无法完成。');
    log('警告: 主树有 CodeGraph，但本机 CLI 不可用；隔离树暂未建立索引。');
    return;
  }
  const initializedDir = resolve(worktreePath, '.codegraph');
  const commandArgs = existsSync(initializedDir)
    ? ['index', worktreePath]
    : ['init', '-i', worktreePath];
  log(`CodeGraph: 为隔离树建立独立索引（mode=${mode}）...`);
  const indexed = runFileTry('codegraph', commandArgs, {
    cwd: worktreePath,
    timeoutMs: CODEGRAPH_TIMEOUT_MS,
    stdio: 'inherit',
  });
  if (!indexed.ok) {
    if (mode === 'on') die('CodeGraph 独立索引初始化失败（--codegraph on 为强制模式）。');
    log('警告: CodeGraph 独立索引初始化失败；worktree 已保留，可稍后手工重试。');
    return;
  }
  log(`CodeGraph: 独立索引就绪 ${database}`);
}

function cmdSpawn(args) {
  rejectUnknownFlags(args.flags, [
    'agent', 'agent-id', 'purpose', 'owner', 'base', 'base-reason', 'config', 'codegraph', 'root',
    'parallel-reason', 'supersedes', 'replacement-reason',
  ]);
  const task = args.positionals[0];
  if (!task) die('spawn 需要 <task>。', 2);
  validateTaskSlug(task);
  const identity = resolveIdentity(args.flags, { requirePurpose: true });
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  requireFreshPrimaryProfile(loaded);
  validateTaskNaming(task, loaded.profile.task_naming);
  let codegraphMode;
  try {
    codegraphMode = normalizeCodegraphMode(flag(args.flags, 'codegraph'));
  } catch (error) {
    die(error instanceof Error ? error.message : String(error), 2);
  }

  const existingRecords = loadRecords(loaded.context.common_dir);
  const reusable = existingRecords.find((record) =>
    record.worktree_state !== 'reclaimed' &&
    record.task === task &&
    record.agent?.host === identity.actor.host &&
    record.agent?.id === identity.actor.id);
  if (reusable) {
    const snapshot = liveGitSnapshot(reusable);
    if (!snapshot.present) die(`同一 Agent/task 的 record 已存在但 worktree missing: ${reusable.worktree_id}；请先 doctor/reclaim。`);
    updateRecord(reusable, 'spawn_reused', (next) => {
      next.last_seen_at = new Date().toISOString();
      next.last_head = snapshot.head;
    }, {}, loaded.context.common_dir);
    ensureWorktreeCodegraph(reusable.path, loaded.context.primary_worktree, codegraphMode);
    log(`复用已登记 worktree id=${reusable.worktree_id}: ${reusable.path}`);
    return;
  }
  const coexisting = coexistingSessionRecords(existingRecords, identity.actor, task);
  const deliveryRelation = resolveDeliveryRelation(args.flags, existingRecords, coexisting);

  const worktreeId = randomUUID();
  const repositoryId = readRepositoryIdentity(loaded.context)?.repository_id ?? randomUUID();
  const cliRoot = flag(args.flags, 'root');
  const environmentRoot = process.env.WORKTREE_ROOT?.trim() || null;
  const configuredRoot = cliRoot ?? environmentRoot;
  let rootSelectionSource = cliRoot
    ? 'cli'
    : environmentRoot
      ? 'environment'
      : loaded.profile_source === 'defaults'
        ? 'default'
        : 'profile';
  const planOptions = {
    cwd: process.cwd(),
    task,
    host: identity.actor.host,
    worktreeId,
    repositoryId,
    base: flag(args.flags, 'base'),
    explicitConfigPath: flag(args.flags, 'config'),
    worktreeRootOverride: configuredRoot,
  };
  let plan = resolveSpawnPlan(planOptions);
  const baseReason = resolveBaseOverrideReason(
    args.flags,
    plan.profile.default_base,
    plan.base_ref,
    plan.base_source,
  );
  if (plan.branch_exists) {
    die(
      `BRANCH_ALREADY_EXISTS: 本地 branch ${plan.branch} 已存在；为防同名返工静默继承旧 tip，拒绝 spawn。` +
      `请先完成或修复原 branch cleanup，或改用新的 semantic task；若它属于另一 Agent 的在飞任务，请先 handoff；若属于外部 worktree，请先 adopt。`,
      2,
    );
  }
  printIdentity(identity, task, plan);
  log(`Base: ${plan.base_ref}（source=${plan.base_source}${baseReason ? `, reason=${baseReason}` : ''}）`);

  gitTry(['worktree', 'prune'], plan.context.current_worktree);
  const baseSha = gitTry(['rev-parse', `${plan.base_ref}^{commit}`], plan.context.current_worktree);
  if (!baseSha.ok) die(`base ref 不存在: ${plan.base_ref}`);
  const repository = ensureRepositoryIdentity(plan.context, repositoryId);
  if (repository.repository_id !== plan.repository_id) {
    plan = resolveSpawnPlan({ ...planOptions, repositoryId: repository.repository_id });
  }
  if (!plan.legacy_layout) {
    const claimRoot = () => claimWorktreeRepositoryRoot({
      root_base: plan.worktree_root_base,
      repo_name: plan.context.repo_name,
      repository_id: repository.repository_id,
      primary_worktree: plan.context.primary_worktree,
    });
    let claimedRoot;
    try {
      claimedRoot = claimRoot();
    } catch (error) {
      const mayFallback = configuredRoot === null && loaded.profile_source === 'defaults' && isRootWriteDenied(error);
      if (!mayFallback) {
        throw new WorktreeProfileError(
          'WORKTREE_ROOT_UNWRITABLE',
          `无法写入 worktree_root ${plan.worktree_root_base}: ${error instanceof Error ? error.message : String(error)}。` +
          '请用 --root、WORKTREE_ROOT 或 primary Profile worktree_root 指向已授权目录。',
        );
      }
      const fallbacks = [
        { source: 'fallback:repository-sibling', root: join(dirname(plan.context.primary_worktree), '.worktrees') },
        { source: 'fallback:system-temp', root: join(tmpdir(), 'agent-worktrees') },
      ];
      let lastError = error;
      for (const fallback of fallbacks) {
        try {
          planOptions.worktreeRootOverride = fallback.root;
          plan = resolveSpawnPlan({ ...planOptions, repositoryId: repository.repository_id });
          claimedRoot = claimRoot();
          rootSelectionSource = fallback.source;
          log(`警告: 默认 worktree_root 不可写，降级到 ${fallback.root}（${fallback.source}）。`);
          break;
        } catch (fallbackError) {
          lastError = fallbackError;
        }
      }
      if (!claimedRoot) {
        throw new WorktreeProfileError(
          'WORKTREE_ROOT_UNWRITABLE',
          `默认 root 与安全降级 root 均不可写: ${lastError instanceof Error ? lastError.message : String(lastError)}。` +
          '请用 --root、WORKTREE_ROOT 或 primary Profile worktree_root 指向宿主已授权目录。',
        );
      }
    }
    if (claimedRoot !== plan.repository_root) {
      plan = resolveSpawnPlan({ ...planOptions, repositoryId: repository.repository_id });
    }
  }
  const worktrees = parseWorktrees(plan.context.current_worktree);
  const occupant = worktrees.find((worktree) => worktree.branch === plan.branch);
  const byPath = worktrees.find((worktree) => worktree.path === plan.path);
  const currentRecords = loadRecords(plan.context.common_dir);
  const tracked = currentRecords.find((record) => record.worktree_state !== 'reclaimed' && (record.path === plan.path || record.branch === plan.branch));
  if (tracked) {
    if (tracked.agent?.host !== identity.actor.host || tracked.agent?.id !== identity.actor.id) {
      die(`worktree 已由 ${tracked.agent?.host}/${tracked.agent?.id} 登记；请用 handoff，不要覆盖身份。`);
    }
    updateRecord(tracked, 'spawn_reused', (next) => {
      const snapshot = liveGitSnapshot(next);
      next.last_seen_at = new Date().toISOString();
      next.last_head = snapshot.head;
    }, {}, plan.context.common_dir);
    ensureWorktreeCodegraph(plan.path, plan.context.primary_worktree, codegraphMode);
    log(`复用已登记 worktree id=${tracked.worktree_id}: ${tracked.path}`);
    return;
  }
  if (byPath || occupant) die(`现有 worktree 未登记（UNTRACKED）: ${(byPath ?? occupant).path}；请先 adopt。`);
  if (existsSync(plan.path)) die(`目标目录已存在但不是已登记 worktree: ${plan.path}`);

  const branchCreated = gitTry(['branch', '--', plan.branch, baseSha.out], plan.context.current_worktree);
  if (!branchCreated.ok) {
    die(`创建 branch 失败: ${plan.branch}: ${commandFailureReason(branchCreated, 'unknown git error')}`);
  }
  const added = gitTry(['worktree', 'add', plan.path, plan.branch], plan.context.current_worktree);
  if (!added.ok) {
    const branchTip = gitTry(['rev-parse', '--verify', `refs/heads/${plan.branch}^{commit}`], plan.context.current_worktree);
    const attached = parseWorktrees(plan.context.current_worktree).some(
      (worktree) => worktree.branch === plan.branch || worktree.path === plan.path,
    );
    let branchCleanup = 'branch absent';
    if (branchTip.ok && !attached && branchTip.out === baseSha.out) {
      const removed = gitTry(['branch', '-D', '--', plan.branch], plan.context.current_worktree);
      branchCleanup = removed.ok ? 'empty branch removed' : `empty branch KEEP: ${commandFailureReason(removed, 'delete failed')}`;
    } else if (branchTip.ok) {
      branchCleanup = attached ? 'branch attached; KEEP' : 'branch tip changed; KEEP';
    }
    die(`git worktree add 失败: ${plan.path}: ${commandFailureReason(added, 'unknown git error')}；${branchCleanup}`);
  }

  initializeTraceStore(plan.context);
  const now = new Date().toISOString();
  const head = git(['rev-parse', 'HEAD'], plan.path);
  const record = {
    schema_version: 1,
    worktree_id: worktreeId,
    task,
    purpose: identity.purpose,
    path: realpathSync(plan.path),
    branch: plan.branch,
    base_ref: plan.base_ref,
    base_sha: baseSha.out,
    base_reason: baseReason,
    agent: identity.actor,
    owner: identity.owner,
    task_status: 'active',
    worktree_state: 'present',
    storage_class: classifyStorage(plan.path, plan.profile.ephemeral_path_patterns),
    profile_source: plan.profile_source,
    profile_path: plan.profile_path,
    naming: {
      host_slug: plan.host_slug,
      task_short: plan.task_short,
      id8: worktreeId.replaceAll('-', '').slice(0, 8),
      repository_root: plan.repository_root,
      root_source: rootSelectionSource,
      task_policy: plan.profile.task_naming.mode,
    },
    created_at: now,
    updated_at: now,
    last_seen_at: now,
    last_head: head,
    ownership_epochs: [{ agent: identity.actor, started_at: now, start_sha: baseSha.out, end_sha: null, ended_at: null }],
    delivery_relation: deliveryRelation,
  };
  appendTraceEvent({
    commonDir: plan.context.common_dir,
    worktreeId,
    eventType: 'created',
    actor: identity.actor,
    details: { identity_sources: identity.sources, base_source: plan.base_source, base_reason: baseReason, delivery_relation: deliveryRelation },
    mutate: () => record,
  });
  if (deliveryRelation?.kind === 'supersedes') {
    const superseded = existingRecords.find((candidate) => candidate.worktree_id === deliveryRelation.superseded_worktree_id);
    updateRecord(superseded, 'superseded_by_declared', (next) => {
      next.superseded_by = {
        worktree_id: worktreeId,
        task,
        reason: deliveryRelation.reason,
        declared_at: deliveryRelation.declared_at,
      };
    }, { replacement_worktree_id: worktreeId, replacement_task: task, reason: deliveryRelation.reason }, plan.context.common_dir);
  }
  ensureWorktreeCodegraph(record.path, plan.context.primary_worktree, codegraphMode);
  log(`worktree 就绪 id=${worktreeId} branch=${plan.branch} path=${record.path}`);
}

function inferTask(branch) {
  if (!branch) return null;
  const candidate = branch.split('/').at(-1);
  try { return validateTaskSlug(candidate); } catch { return null; }
}

function cmdAdopt(args) {
  rejectUnknownFlags(args.flags, ['agent', 'agent-id', 'purpose', 'owner', 'task', 'base', 'base-reason', 'config']);
  const rawPath = args.positionals[0];
  if (!rawPath) die('adopt 需要 <path>。', 2);
  const identity = resolveIdentity(args.flags, { requirePurpose: true });
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  requireFreshPrimaryProfile(loaded);
  const path = existsSync(rawPath) ? realpathSync(rawPath) : canonicalizeFuturePath(rawPath);
  const worktree = parseWorktrees(loaded.context.current_worktree).find((item) => item.path === path);
  if (!worktree) die(`path 不是当前仓库登记的 worktree: ${path}`);
  if (path === loaded.context.primary_worktree) die('primary worktree 不需要 adopt。');
  const task = flag(args.flags, 'task') ?? inferTask(worktree.branch);
  if (!task) die('detached 或无法从 branch 推断 task；请传 --task。', 2);
  validateTaskNaming(task, loaded.profile.task_naming);
  const records = loadRecords(loaded.context.common_dir);
  const existing = records.find((record) => record.worktree_state !== 'reclaimed' && (record.path === path || (worktree.branch && record.branch === worktree.branch)));
  if (existing) die(`worktree 已登记 id=${existing.worktree_id}。`);
  const base = resolveBaseRef(loaded.context.current_worktree, loaded.profile.default_base, flag(args.flags, 'base'));
  const baseReason = resolveBaseOverrideReason(
    args.flags,
    loaded.profile.default_base,
    base.ref,
    base.source,
  );
  const head = worktree.head ?? git(['rev-parse', 'HEAD'], path);
  const mergeBase = gitTry(['merge-base', head, base.ref], loaded.context.current_worktree);
  initializeTraceStore(loaded.context);
  const worktreeId = randomUUID();
  const now = new Date().toISOString();
  const record = {
    schema_version: 1, worktree_id: worktreeId, task, purpose: identity.purpose, path,
    branch: worktree.branch, base_ref: base.ref, base_sha: mergeBase.ok ? mergeBase.out : head,
    base_reason: baseReason,
    agent: identity.actor, owner: identity.owner, task_status: 'active', worktree_state: 'present',
    storage_class: classifyStorage(path, loaded.profile.ephemeral_path_patterns),
    profile_source: loaded.profile_source, profile_path: loaded.profile_path,
    naming: { task_policy: loaded.profile.task_naming.mode },
    created_at: now, updated_at: now, last_seen_at: now, last_head: head,
    ownership_epochs: [{ agent: identity.actor, started_at: now, start_sha: mergeBase.ok ? mergeBase.out : head, end_sha: null, ended_at: null }],
  };
  printIdentity(identity, task, loaded);
  log(`Base: ${base.ref}（source=${base.source}${baseReason ? `, reason=${baseReason}` : ''}）`);
  appendTraceEvent({
    commonDir: loaded.context.common_dir,
    worktreeId,
    eventType: 'adopted',
    actor: identity.actor,
    details: {
      task_source: flag(args.flags, 'task') ? 'explicit' : 'branch_inferred',
      base_source: base.source,
      base_reason: baseReason,
    },
    mutate: () => record,
  });
  log(`已接管 id=${worktreeId} branch=${worktree.branch ?? '(detached)'} path=${path}`);
}

/** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record */
function hasPendingBranchCleanup(loaded, record) {
  return record.worktree_state === 'reclaimed' && (
    record.branch_cleanup?.status === 'failed' || localBranchExists(loaded, record)
  );
}

function buildListing(includeAll = false, loaded = loadRepositoryProfile()) {
  const worktrees = parseWorktrees(loaded.context.current_worktree);
  const records = loadRecords(loaded.context.common_dir);
  const mainPath = loaded.context.primary_worktree;
  const rows = worktrees.map((worktree) => {
    const record = records.find((candidate) => candidate.worktree_state !== 'reclaimed' && canonicalSelectorPath(candidate.path) === worktree.path);
    const status = worktree.bare ? null : gitTry(['status', '--porcelain'], worktree.path);
    return {
      kind: worktree.path === mainPath ? 'MAIN' : record ? 'TRACKED' : 'UNTRACKED',
      path: worktree.path, branch: worktree.branch, head: worktree.head,
      dirty: status?.ok ? status.out !== '' : null, record: record ?? null,
    };
  });
  const livePaths = new Set(worktrees.map((worktree) => worktree.path));
  const historical = records
    .filter((record) => {
      if (livePaths.has(canonicalSelectorPath(record.path))) return false;
      return includeAll || record.worktree_state !== 'reclaimed' || hasPendingBranchCleanup(loaded, record);
    })
    .map((record) => ({ ...record, branch_cleanup_pending: hasPendingBranchCleanup(loaded, record) }));
  return { loaded, rows, historical, records };
}

/** @param {Record<string,any>} record */
function reclaimSummaryFor(record) {
  if (record.worktree_state !== 'reclaimed') return null;
  const fallback = {
    worktree_id: record.worktree_id,
    task: record.task,
    change_ref: record.auto_reclaim?.change_ref ?? null,
    source_sha: record.auto_reclaim?.head_sha ?? record.last_head ?? null,
    target_ref: record.auto_reclaim?.target_ref ?? record.base_ref ?? null,
    target_sha: record.auto_reclaim?.target_sha ?? null,
    completed_at: record.reclaimed_at ?? record.auto_reclaim?.completed_at ?? null,
  };
  return {
    ...fallback,
    ...(record.reclaim_summary ?? {}),
    branch_cleanup: record.branch_cleanup ?? record.reclaim_summary?.branch_cleanup ?? null,
  };
}

/** @param {Record<string,any>[]} records */
function latestReclaim(records) {
  return records.map(reclaimSummaryFor).filter(Boolean).sort((left, right) => String(right.completed_at ?? '').localeCompare(String(left.completed_at ?? '')))[0] ?? null;
}

function cmdList(args) {
  rejectUnknownFlags(args.flags, ['json', 'all', 'config']);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const listing = buildListing(Boolean(args.flags.get('all')), loaded);
  const summary = {
    worktrees: listing.rows.length,
    tracked: listing.rows.filter((row) => row.kind === 'TRACKED').length,
    untracked: listing.rows.filter((row) => row.kind === 'UNTRACKED').length,
    historical: listing.historical.length,
  };
  const lastReclaim = latestReclaim(listing.records);
  if (args.flags.get('json')) {
    console.log(JSON.stringify({ profile: { source: listing.loaded.profile_source, path: listing.loaded.profile_path }, summary, last_reclaim: lastReclaim, worktrees: listing.rows, records: listing.historical }, null, 2));
    return;
  }
  log(`worktrees=${summary.worktrees} TRACKED=${summary.tracked} UNTRACKED=${summary.untracked} history=${summary.historical}`);
  if (lastReclaim) {
    console.log(`  [LAST_RECLAIM] ${lastReclaim.completed_at ?? '?'} task=${lastReclaim.task} change=${lastReclaim.change_ref ?? '-'} target=${lastReclaim.target_sha?.slice(0, 12) ?? '-'} branch=${lastReclaim.branch_cleanup?.status ?? 'legacy'}`);
  }
  for (const row of listing.rows) {
    console.log(`  [${row.kind}] [${row.dirty === null ? '?' : row.dirty ? 'DIRTY' : 'CLEAN'}] ${row.branch ?? '(detached)'}  ${row.path}`);
    if (row.record) console.log(`    ${row.record.agent.host}/${row.record.agent.id}  task=${row.record.task}  status=${row.record.task_status}/${row.record.worktree_state}\n    ${row.record.purpose}`);
  }
  for (const record of listing.historical) {
    const label = record.branch_cleanup_pending
      ? 'BRANCH_PENDING'
      : record.worktree_state === 'reclaimed'
        ? 'HISTORY'
        : 'MISSING';
    const cleanup = record.worktree_state === 'reclaimed' ? ` branch=${record.branch_cleanup?.status ?? 'legacy'}` : '';
    console.log(`  [${label}] ${record.worktree_id.slice(0, 8)} ${record.task} ${record.agent.host}/${record.agent.id}${cleanup} ${record.path}`);
  }
}

function cmdTouch(args) {
  rejectUnknownFlags(args.flags, ['status', 'note', 'id', 'config', 'no-watch', 'target', 'interval-ms', 'change-ref', 'notify']);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
  if (record.worktree_state === 'reclaimed') {
    die('已回收 record 是不可变历史，不能 touch；同名返工请重新 spawn。');
  }
  const requested = flag(args.flags, 'status') ?? record.task_status;
  if (!TASK_TRANSITIONS[record.task_status]?.has(requested)) die(`非法状态流转: ${record.task_status} -> ${requested}`);
  const note = flag(args.flags, 'note') ? oneLine(flag(args.flags, 'note'), 'note', 240) : null;
  const snapshot = liveGitSnapshot(record);
  const activeWatch = record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)
    ? record.auto_reclaim
    : null;
  // HEAD 已前进时，旧冻结证据必须在 touch 的第一条 event 内原子失效。若先写 status_updated、
  // 再另写 disarm，后台 watcher 就能在两条 event 之间用旧 SHA 抢先推进 merge_detected/done。
  const staleWatch = requested === 'ready_for_review'
    && activeWatch
    && activeWatch.state !== 'merge_detected'
    && Boolean(snapshot.head)
    && activeWatch.head_sha !== snapshot.head
    ? activeWatch
    : null;
  const updated = updateRecord(record, staleWatch ? 'auto_reclaim_disarmed' : 'status_updated', (next) => {
    if (next.task_status !== record.task_status) {
      throw new WorktreeTraceError(
        'TOUCH_STATE_CHANGED',
        `touch 期间 task_status 已由 ${record.task_status} 变为 ${next.task_status}；请重新读取状态后重试。`,
      );
    }
    if (staleWatch) {
      const currentWatch = next.auto_reclaim;
      if (
        currentWatch?.token !== staleWatch.token
        || ['merge_detected', 'disarmed', 'reclaimed'].includes(currentWatch?.state)
      ) {
        throw new WorktreeTraceError(
          'WATCHER_CHANGED',
          '旧 watcher 已被并发 rearm、解除或推进到 merge_detected；拒绝用陈旧快照覆盖当前状态。',
        );
      }
      currentWatch.state = 'disarmed';
      currentWatch.disarmed_at = new Date().toISOString();
      currentWatch.disarm_reason = 'stale_frozen_head';
    }
    next.task_status = requested;
    if (next.worktree_state === 'present' && !snapshot.present) next.worktree_state = 'missing';
    else if (next.worktree_state === 'missing' && snapshot.present) next.worktree_state = 'present';
    next.last_seen_at = new Date().toISOString();
    next.last_head = snapshot.head;
  }, {
    note,
    git: snapshot,
    ...(staleWatch ? {
      source: 'auto_touch_head_drift',
      reason: 'live HEAD 已偏离冻结 SHA；在检查新 HEAD 是否可武装前先原子失效旧 watcher。',
      stale_head_sha: staleWatch.head_sha,
      live_head: snapshot.head,
      target_ref: staleWatch.target_ref,
      token: staleWatch.token,
    } : {}),
  }, loaded.context.common_dir);
  log(`已更新 ${updated.worktree_id.slice(0, 8)} ${record.task_status} -> ${updated.task_status}`);
  if (staleWatch) {
    removeWatcherHeartbeat(loaded.context.common_dir, record.worktree_id, staleWatch.token);
    log(`watch 已解除（原冻结 head=${staleWatch.head_sha.slice(0, 12)} 已过期，当前 HEAD=${snapshot.head.slice(0, 12)}）。`);
  }
  if (requested === 'ready_for_review') autoArmReviewWatch(loaded, updated, args, snapshot);
}

/**
 * 进入 ready_for_review 时默认武装合入监听。
 *
 * 纪律来源：监听绑定的是「内容进主干」这一事实，与内容经哪个载体（自建 change request、
 * 聚合 change request、他人代推）无关。靠人在建 change request 时手工挂 watch，一旦中途改成
 * 由别的载体合入，监听就会漏挂、合入后无人回收——默认武装把这个洞堵死。
 *
 * 失败一律 fail-soft：touch 的主职是状态流转，不因为没有 remote / 未推送而失败，
 * 但必须把未武装的原因说清楚，避免「以为挂上了」。
 * @param {ReturnType<typeof loadRepositoryProfile>} loaded
 * @param {Record<string,any>} record
 * @param {{flags:Map<string,unknown>}} args
 * @param {{present:boolean,head:string|null,dirty:boolean|null,upstream:string|null}} snapshot
 */
function autoArmReviewWatch(loaded, record, args, snapshot) {
  if (args.flags.get('no-watch')) {
    log('watch 未武装：--no-watch 显式退出；合入后需要人工回收。');
    return;
  }
  const existing = record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)
    ? record.auto_reclaim
    : null;
  // 原子失效旧 watcher 后仍沿用它的 target/interval/change-ref 默认值，避免自动重冻结
  // 把人工显式选择的 target 静默改回 Profile default_base。
  const previous = record.auto_reclaim ?? null;
  if (existing?.state === 'merge_detected') {
    log('watch 保持原冻结 SHA：目标分支已确认包含该 head，自动回收已进入提交阶段。');
    return;
  }
  const skip = (reason) => log(`watch 未武装：${reason}；自动回收保持关闭，可补齐前提后重新 touch。`);
  const targetRef = flag(args.flags, 'target') ?? previous?.target_ref ?? loaded.profile.default_base ?? record.base_ref;
  if (!targetRef || !targetRef.includes('/')) {
    skip(`无法确定远端主干 target（Profile default_base=${loaded.profile.default_base ?? 'null'}）`);
    return;
  }
  if (!snapshot.present) { skip('worktree 不存在'); return; }
  if (snapshot.dirty !== false) { skip('工作树非干净'); return; }
  if (!snapshot.head) { skip('无法读取 HEAD'); return; }
  const upstream = gitTry(['rev-parse', '@{upstream}^{commit}'], record.path);
  if (!upstream.ok || upstream.out !== snapshot.head) {
    skip('当前 HEAD 尚未完整 push 到 upstream');
    return;
  }
  if (!refreshTargetRef(targetRef, loaded.context.current_worktree).ok) { skip(`目标 ref 不存在或无法刷新: ${targetRef}`); return; }
  // auto_touch 是可重算的默认动作，可在当轮直接改 target；人工显式 watch（以及没有来源字段的
  // legacy watcher）是用户指令，touch 不能静默改写。即使它刚因 HEAD 漂移被原子撤防，也保留
  // 这条 provenance 边界；此时改目标应显式执行 watch --target 重新建立指令。
  if (previous && previous.target_ref !== targetRef && previous.armed_by !== 'auto_touch') {
    skip(
      `人工武装 target=${previous.target_ref} 与请求的 ${targetRef} 不同；` +
      `${previous.state === 'disarmed' ? '请显式执行 watch --target 建立新监听' : '换目标请先 unwatch'}`,
    );
    return;
  }

  const heartbeat = readWatcherHeartbeat(loaded.context.common_dir, record.worktree_id);
  const health = watcherHealth(record, heartbeat);
  // 已武装且 HEAD 未变、watcher 健康：保持原样，不重复起进程。
  if (existing && health.healthy && existing.head_sha === snapshot.head && existing.target_ref === targetRef) {
    log(`watch 已在运行 pid=${heartbeat.state.pid} target=${targetRef} head=${snapshot.head.slice(0, 12)}`);
    return;
  }
  try {
    const started = startWatcher(loaded, record, {
      targetRef,
      headSha: snapshot.head,
      intervalMs: parseWatchInterval(flag(args.flags, 'interval-ms') ?? previous?.interval_ms),
      changeRef: flag(args.flags, 'change-ref')
        ? oneLine(flag(args.flags, 'change-ref'), 'change-ref', 240)
        : previous?.change_ref ?? null,
      notifyMode: parseNotifyMode(flag(args.flags, 'notify') ?? previous?.notify),
      explicitConfig: flag(args.flags, 'config') ? loaded.profile_path : null,
      previousHealth: health.reason,
      armedBy: 'auto_touch',
    });
    const rearming = Boolean(existing) || (
      previous?.state === 'disarmed' && previous.disarm_reason === 'stale_frozen_head'
    );
    const refroze = rearming && previous?.head_sha !== snapshot.head;
    log(
      `watch 已${rearming ? '重新' : ''}武装 pid=${started.pid} target=${targetRef} head=${snapshot.head.slice(0, 12)}` +
      `${refroze ? `（HEAD 变化，已从 ${previous.head_sha.slice(0, 12)} 重冻结）` : ''}`,
    );
  } catch (error) {
    skip(`watcher 启动失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function cmdHandoff(args) {
  rejectUnknownFlags(args.flags, ['to-agent', 'to-agent-id', 'note', 'id', 'config']);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
  const target = resolveIdentity(args.flags, { target: true });
  const note = oneLine(flag(args.flags, 'note') ?? '', 'note', 240);
  const snapshot = liveGitSnapshot(record);
  if (!snapshot.present) die('handoff 要求 worktree 存在。');
  if (snapshot.dirty !== false) die('handoff 要求工作树干净；请先 WIP commit + push。');
  const now = new Date().toISOString();
  const from = record.agent;
  const updated = appendTraceEvent({
    commonDir: loaded.context.common_dir, worktreeId: record.worktree_id, eventType: 'handed_off', actor: from,
    details: { from, to: target.actor, boundary_sha: snapshot.head, note },
    mutate(current) {
      const next = structuredClone(current);
      const epoch = next.ownership_epochs.at(-1);
      if (epoch && !epoch.ended_at) { epoch.ended_at = now; epoch.end_sha = snapshot.head; }
      next.agent = target.actor;
      next.ownership_epochs.push({ agent: target.actor, started_at: now, start_sha: snapshot.head, end_sha: null, ended_at: null });
      next.updated_at = now; next.last_seen_at = now; next.last_head = snapshot.head;
      return next;
    },
  }).record;
  log(`已交接 ${updated.worktree_id.slice(0, 8)}: ${from.host}/${from.id} -> ${target.actor.host}/${target.actor.id}`);
}

function commitsForEpoch(cwd, epoch, endSha) {
  if (!epoch.start_sha || !endSha) return { degraded: true, reason: 'missing boundary', commits: [] };
  if (!gitTry(['cat-file', '-e', `${epoch.start_sha}^{commit}`], cwd).ok || !gitTry(['cat-file', '-e', `${endSha}^{commit}`], cwd).ok) return { degraded: true, reason: 'boundary unreachable', commits: [] };
  if (!gitTry(['merge-base', '--is-ancestor', epoch.start_sha, endSha], cwd).ok) return { degraded: true, reason: 'boundary rewritten (amend/rebase)', commits: [] };
  const revs = gitTry(['rev-list', '--reverse', `${epoch.start_sha}..${endSha}`], cwd);
  const commits = revs.ok && revs.out ? revs.out.split('\n').map((sha) => {
    const meta = git(['show', '-s', '--format=%H%x09%an%x09%s', sha], cwd).split('\t');
    const files = gitTry(['show', '--pretty=format:', '--name-only', sha], cwd);
    return { sha: meta[0], author: meta[1], subject: meta.slice(2).join('\t'), files: files.ok ? files.out.split('\n').filter(Boolean) : [] };
  }) : [];
  return { degraded: false, reason: null, commits };
}

function cmdAudit(args) {
  rejectUnknownFlags(args.flags, ['json', 'id', 'config']);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const records = loadRecords(loaded.context.common_dir);
  const record = selectRecord(records, args.positionals[0] ?? null, flag(args.flags, 'id'));
  const chain = readEventChain(loaded.context.common_dir, record.worktree_id);
  const epochs = (record.ownership_epochs ?? []).map((epoch) => ({ ...epoch, attribution: commitsForEpoch(loaded.context.current_worktree, epoch, epoch.end_sha ?? record.last_head) }));
  const result = { record, events: chain.map(({ snapshot, ...event }) => event), ownership_epochs: epochs };
  if (args.flags.get('json')) { console.log(JSON.stringify(result, null, 2)); return; }
  log(`${record.worktree_id} task=${record.task} ${record.task_status}/${record.worktree_state}`);
  for (const epoch of epochs) {
    console.log(`  ${epoch.agent.host}/${epoch.agent.id} ${epoch.start_sha?.slice(0, 12)}..${(epoch.end_sha ?? record.last_head)?.slice(0, 12)}`);
    if (epoch.attribution.degraded) console.log(`    ATTRIBUTION_DEGRADED: ${epoch.attribution.reason}`);
    for (const commit of epoch.attribution.commits) console.log(`    ${commit.sha.slice(0, 12)} ${commit.subject} (${commit.files.length} files)`);
  }
  for (const event of result.events) console.log(`  ${event.occurred_at} ${event.event_type} ${event.actor ? `${event.actor.host}/${event.actor.id}` : '-'}`);
}

/** @param {unknown} value */
export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

/** @param {string} content */
function normalizedProfileContent(content) {
  try {
    return JSON.stringify(canonicalJson(JSON.parse(content)));
  } catch {
    return content.trim();
  }
}

/** @param {string} cwd */
function gitOperationState(cwd) {
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (gitTry(['rev-parse', '--verify', '--quiet', marker], cwd).ok) return marker.toLowerCase();
  }
  for (const marker of ['rebase-merge', 'rebase-apply']) {
    const path = gitTry(['rev-parse', '--git-path', marker], cwd);
    if (path.ok && path.out && existsSync(resolve(cwd, path.out))) return marker;
  }
  return null;
}

/** @param {string} cwd @param {string} ancestor @param {string} descendant */
function isAncestor(cwd, ancestor, descendant) {
  return gitTry(['merge-base', '--is-ancestor', ancestor, descendant], cwd).ok;
}

/** @param {string} targetSha @param {string[]} orderedInputShas */
export function batchFingerprint(targetSha, orderedInputShas) {
  const input = { schema_version: 1, target_sha: targetSha, ordered_input_shas: orderedInputShas };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalJson(input))).digest('hex')}`;
}

/** @param {Record<string,any>} item @param {string} code @param {string} detail */
function blockBatchItem(item, code, detail) {
  item.state = 'blocked';
  item.reasons.push({ code, detail });
}

/**
 * 为同一 repository identity 内的多个 feature 生成只读、可复现的集成候选计划。
 * 不 fetch、不 merge、不创建 worktree；调用者必须把 target SHA 和有序输入 SHA 当作冻结契约。
 *
 * 与 cmdPlanBatch 分离是为了让 batch-integrate 能用同一套规则重算计划做新鲜度校验，
 * 避免「规划口径」和「合成口径」各写一份而悄悄漂移。
 * @param {ReturnType<typeof loadRepositoryProfile>} loaded
 * @param {string[]} selectors
 * @param {string|null} targetOverride
 */
function computeBatchPlan(loaded, selectors, targetOverride) {
  const records = loadRecords(loaded.context.common_dir);
  const target = resolveBaseRef(
    loaded.context.current_worktree,
    loaded.profile.default_base,
    targetOverride,
  );
  const targetCommit = gitTry(['rev-parse', '--verify', `${target.ref}^{commit}`], loaded.context.current_worktree);
  if (!targetCommit.ok || !targetCommit.out) die(`无法解析批次 target commit: ${target.ref}`, 2);

  const seenRecords = new Set();
  const requested = selectors.map((selector) => {
    const record = selectRecord(records, selector, null);
    if (seenRecords.has(record.worktree_id)) die(`重复 selector 指向同一 record: ${selector}`, 2);
    seenRecords.add(record.worktree_id);
    const snapshot = liveGitSnapshot(record);
    const item = {
      selector,
      worktree_id: record.worktree_id,
      task: record.task,
      branch: record.branch ?? null,
      path: record.path,
      task_status: record.task_status,
      worktree_state: record.worktree_state,
      base_ref: record.base_ref ?? null,
      base_sha: record.base_sha ?? null,
      head: snapshot.head ?? null,
      upstream_ref: snapshot.upstream ?? null,
      upstream_sha: null,
      state: 'candidate',
      reasons: [],
    };

    if (!snapshot.head) {
      blockBatchItem(item, 'HEAD_UNREADABLE', '无法读取 feature HEAD。');
      return item;
    }
    if (isAncestor(loaded.context.current_worktree, snapshot.head, targetCommit.out)) {
      item.state = 'already_integrated';
      item.reasons.push({ code: 'ALREADY_IN_TARGET', detail: `${snapshot.head} 已被 ${target.ref} 包含。` });
      return item;
    }
    if (!snapshot.present || record.worktree_state === 'reclaimed') {
      blockBatchItem(item, 'WORKTREE_NOT_PRESENT', '尚未进入 target 的批次输入必须来自仍存在的 tracked worktree。');
      return item;
    }
    if (!['ready_for_review', 'integrating'].includes(record.task_status)) {
      blockBatchItem(item, 'NOT_READY_FOR_REVIEW', `task_status=${record.task_status}`);
    }
    if (snapshot.dirty !== false) {
      blockBatchItem(item, 'DIRTY_WORKTREE', '批次只接受干净 worktree 的固定提交。');
    }
    const operation = gitOperationState(record.path);
    if (operation) blockBatchItem(item, 'GIT_OPERATION_IN_PROGRESS', `检测到 ${operation}。`);
    if (record.last_head && record.last_head !== snapshot.head) {
      blockBatchItem(item, 'HEAD_DRIFT', `trace=${record.last_head} live=${snapshot.head}`);
    }
    if (!snapshot.upstream) {
      blockBatchItem(item, 'UPSTREAM_MISSING', 'feature branch 尚未登记 upstream，无法证明已推送。');
      return item;
    }
    const upstreamCommit = gitTry(['rev-parse', '--verify', `${snapshot.upstream}^{commit}`], record.path);
    item.upstream_sha = upstreamCommit.ok ? upstreamCommit.out : null;
    if (!upstreamCommit.ok || upstreamCommit.out !== snapshot.head) {
      blockBatchItem(
        item,
        'UPSTREAM_NOT_AT_HEAD',
        upstreamCommit.ok ? `upstream=${upstreamCommit.out} live=${snapshot.head}` : `无法解析 ${snapshot.upstream}`,
      );
    }
    return item;
  });

  const candidates = requested.filter((item) => item.state === 'candidate');
  for (let index = 0; index < candidates.length; index++) {
    const item = candidates[index];
    const duplicate = candidates.slice(0, index).find((other) => other.state === 'candidate' && other.head === item.head);
    if (duplicate) {
      item.state = 'covered';
      item.reasons.push({ code: 'DUPLICATE_HEAD', detail: `与 ${duplicate.task} 指向同一 HEAD。` });
      continue;
    }
    const covering = candidates.find((other) =>
      other !== item &&
      other.state === 'candidate' &&
      other.head !== item.head &&
      isAncestor(loaded.context.current_worktree, item.head, other.head),
    );
    if (covering) {
      item.state = 'covered';
      item.reasons.push({ code: 'COVERED_BY_DESCENDANT', detail: `${item.task} 已包含在 ${covering.task}。` });
    }
  }

  const included = requested.filter((item) => item.state === 'candidate');
  const blockers = requested
    .filter((item) => item.state === 'blocked')
    .flatMap((item) => item.reasons.map((reason) => ({ task: item.task, worktree_id: item.worktree_id, ...reason })));
  if (included.length === 0) blockers.push({ task: null, worktree_id: null, code: 'NO_UNIQUE_INPUT', detail: '没有需要合成的唯一 feature HEAD。' });
  const repositoryId = readRepositoryIdentity(loaded.context)?.repository_id ?? null;
  const ready = blockers.length === 0;
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    repository_id: repositoryId,
    // 原始 selector 全集（含随后被折叠或已在 target 的输入）。重验新鲜度必须按这一份重算：
    // 只回算 included 会把「被折叠的父分支后来前进了」这类漂移整个漏掉。
    requested_selectors: [...selectors],
    target: { ref: target.ref, sha: targetCommit.out, source: target.source },
    ready,
    fingerprint: ready ? batchFingerprint(targetCommit.out, included.map((item) => item.head)) : null,
    included,
    excluded: requested.filter((item) => item.state !== 'candidate' && item.state !== 'blocked'),
    blockers,
  };
}

/** @param {{positionals:string[],flags:Map<string,unknown>}} args */
function cmdPlanBatch(args) {
  rejectUnknownFlags(args.flags, ['json', 'target', 'config']);
  if (args.positionals.length < 2) die('plan-batch 至少需要两个 feature selector。', 2);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const result = computeBatchPlan(loaded, args.positionals, flag(args.flags, 'target'));
  const included = result.included;
  const blockers = result.blockers;
  if (args.flags.get('json')) console.log(JSON.stringify(result, null, 2));
  else {
    log(`batch target=${result.target.ref}@${result.target.sha.slice(0, 12)} ready=${result.ready} inputs=${included.length}`);
    for (const item of included) console.log(`  [INCLUDE] ${item.task} ${item.head.slice(0, 12)} upstream=${item.upstream_ref}`);
    for (const item of result.excluded) console.log(`  [${item.state.toUpperCase()}] ${item.task} ${item.reasons.map((reason) => reason.code).join(',')}`);
    for (const blocker of blockers) console.log(`  [BLOCK] ${blocker.task ?? '-'} ${blocker.code}: ${blocker.detail}`);
    if (result.fingerprint) console.log(`  fingerprint=${result.fingerprint}`);
  }
  if (!result.ready) process.exitCode = 1;
}

/**
 * 在一次性集成候选树上开启 rerere，让多轮候选之间同一冲突自动重放已录解法。
 *
 * 作用域是 worktree 级（`git config --worktree`），不写全局、也不改其他 worktree 的行为；
 * 但 Git 的 rerere **解法缓存位于共享 common dir 的 `rr-cache/`**，因此同一仓库任何
 * worktree 录下的解法都会被这里复用——这正是「上一轮候选解过的冲突，下一轮不再手解」
 * 的机制，同时也意味着一个错误解法会跨候选扩散，需要时用 `git rerere forget <path>` 清除。
 *
 * `--worktree` 依赖仓库 `extensions.worktreeConfig`。未启用时按 Git 的要求先确认
 * `core.bare` / `core.worktree` 仍是默认值再启用；否则 fail-open 成「不启用 rerere」
 * 并回报原因，绝不擅自搬动这两个键。
 * @param {ReturnType<typeof loadRepositoryProfile>} loaded
 * @param {string} candidatePath
 */
function enableCandidateRerere(loaded, candidatePath) {
  const read = (key, cwd) => {
    const got = gitTry(['config', '--get', key], cwd);
    return got.ok ? got.out : null;
  };
  const readBool = (key, cwd) => {
    const got = gitTry(['config', '--bool', '--get', key], cwd);
    if (!got.ok) return null;
    return got.out === 'true';
  };
  const inherited = {
    enabled: readBool('rerere.enabled', candidatePath) === true,
    autoUpdate: readBool('rerere.autoUpdate', candidatePath) === true,
  };
  // 必须两项都已生效才算「继承即可」。只有 rerere.enabled 而没有 autoUpdate 时，rerere 会把
  // 已录解法写回工作区却**不更新 index**，冲突路径依然是 unmerged，合成循环会把它当成真冲突，
  // 重放形同失效。因此这里不能因为 enabled 已是 true 就提前返回。
  if (inherited.enabled && inherited.autoUpdate) {
    return {
      enabled: true,
      auto_update: true,
      scope: 'inherited',
      worktree_config_extension: 'not_needed',
      worktree_config_previous: read('extensions.worktreeConfig', loaded.context.primary_worktree),
      reason: null,
    };
  }
  const partialScope = inherited.enabled ? 'inherited-partial' : 'none';
  const primary = loaded.context.primary_worktree;
  const extensionPrevious = read('extensions.worktreeConfig', primary);
  let extensionProvenance = 'already_enabled';
  if (readBool('extensions.worktreeConfig', primary) !== true) {
    const bare = readBool('core.bare', primary);
    const coreWorktree = read('core.worktree', primary);
    if (bare === true || (coreWorktree !== null && coreWorktree !== '')) {
      return {
        enabled: inherited.enabled,
        auto_update: inherited.autoUpdate,
        scope: partialScope,
        worktree_config_extension: 'refused',
        worktree_config_previous: extensionPrevious,
        reason: 'core.bare/core.worktree 非默认值；按 Git 要求需人工先迁移这两个键，拒绝自动启用 extensions.worktreeConfig。',
      };
    }
    const enabled = gitTry(['config', 'extensions.worktreeConfig', 'true'], primary);
    if (!enabled.ok) {
      return {
        enabled: inherited.enabled,
        auto_update: inherited.autoUpdate,
        scope: partialScope,
        worktree_config_extension: 'failed',
        worktree_config_previous: extensionPrevious,
        reason: commandFailureReason(enabled, '无法启用 extensions.worktreeConfig'),
      };
    }
    extensionProvenance = 'enabled_by_this_command';
  }
  for (const [key, value] of [['rerere.enabled', 'true'], ['rerere.autoUpdate', 'true']]) {
    const set = gitTry(['config', '--worktree', key, value], candidatePath);
    if (!set.ok) {
      return {
        enabled: false,
        auto_update: false,
        scope: 'none',
        worktree_config_extension: extensionProvenance,
        worktree_config_previous: extensionPrevious,
        reason: commandFailureReason(set, `无法设置 ${key}`),
      };
    }
  }
  return {
    enabled: true,
    auto_update: true,
    scope: 'worktree',
    worktree_config_extension: extensionProvenance,
    worktree_config_previous: extensionPrevious,
    reason: null,
  };
}

/** @param {string} cwd */
function unmergedPaths(cwd) {
  const unmerged = gitTry(['diff', '--name-only', '--diff-filter=U'], cwd);
  return unmerged.ok && unmerged.out ? unmerged.out.split('\n').filter(Boolean) : [];
}

/** @param {string} path */
function readBatchPlanFile(path) {
  if (!existsSync(path)) die(`--plan 文件不存在: ${path}`, 2);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    die(`--plan 文件不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) die('--plan 文件根节点必须是 object。', 2);
  if (parsed.schema_version !== 1) die(`--plan schema_version 必须是 1，当前 ${parsed.schema_version}。`, 2);
  if (parsed.ready !== true) die('--plan 是未就绪计划（ready=false）；请先让 plan-batch 返回 ready=true。', 2);
  if (!parsed.fingerprint || !parsed.target?.sha || !parsed.target?.ref) die('--plan 缺少 fingerprint 或 target。', 2);
  if (!Array.isArray(parsed.included) || parsed.included.length === 0) die('--plan 缺少 included 输入。', 2);
  for (const item of parsed.included) {
    if (!item?.worktree_id || !item?.head) die('--plan included 每项都需要 worktree_id 与 head。', 2);
  }
  if (parsed.excluded !== undefined && !Array.isArray(parsed.excluded)) die('--plan excluded 必须是 array。', 2);
  for (const item of parsed.excluded ?? []) {
    if (!item?.worktree_id) die('--plan excluded 每项都需要 worktree_id。', 2);
  }
  if (parsed.requested_selectors !== undefined) {
    if (!Array.isArray(parsed.requested_selectors) || parsed.requested_selectors.some((item) => typeof item !== 'string' || !item)) {
      die('--plan requested_selectors 必须是非空字符串数组。', 2);
    }
  }
  return parsed;
}

/**
 * 冻结计划只有在 target 与全部输入 HEAD 都没漂移时才可继续合成。
 * 任何一处变化都必须回到 plan-batch 重新冻结，而不是就地放行。
 * @param {Record<string,any>} frozen
 * @param {ReturnType<typeof computeBatchPlan>} fresh
 */
function assertBatchPlanFresh(frozen, fresh) {
  const drifts = [];
  if (frozen.repository_id && fresh.repository_id && frozen.repository_id !== fresh.repository_id) {
    drifts.push(`repository_id: plan=${frozen.repository_id} live=${fresh.repository_id}`);
  }
  if (frozen.target.ref !== fresh.target.ref) drifts.push(`target ref: plan=${frozen.target.ref} live=${fresh.target.ref}`);
  if (frozen.target.sha !== fresh.target.sha) drifts.push(`target SHA: plan=${frozen.target.sha} live=${fresh.target.sha}`);
  const frozenInputs = frozen.included.map((item) => `${item.worktree_id}@${item.head}`);
  const freshInputs = fresh.included.map((item) => `${item.worktree_id}@${item.head}`);
  if (frozenInputs.join(',') !== freshInputs.join(',')) {
    drifts.push(`有序输入: plan=[${frozenInputs.join(' ')}] live=[${freshInputs.join(' ')}]`);
  }
  // 被折叠（COVERED_BY_DESCENDANT / DUPLICATE_HEAD）或已在 target 的输入同样是批次决策的一部分：
  // 它们后来前进、或不再被覆盖，都意味着这份计划描述的合成边界已经变了。不比对这一段，
  // 「父分支被折叠后又推了新提交」会在指纹不变的假象下被静默漏出合成结果。
  const summarizeExcluded = (plan) => (plan.excluded ?? [])
    .map((item) => `${item.worktree_id}@${item.state}@${item.head ?? 'null'}`)
    .sort()
    .join(',');
  const frozenExcluded = summarizeExcluded(frozen);
  const freshExcluded = summarizeExcluded(fresh);
  if (frozenExcluded !== freshExcluded) {
    drifts.push(`折叠/已合入输入: plan=[${frozenExcluded}] live=[${freshExcluded}]`);
  }
  if (fresh.blockers.length > 0) {
    drifts.push(`重算出现 blocker: ${fresh.blockers.map((item) => `${item.task ?? '-'}:${item.code}`).join(' ')}`);
  }
  if (frozen.fingerprint !== fresh.fingerprint) {
    drifts.push(`fingerprint: plan=${frozen.fingerprint} live=${fresh.fingerprint}`);
  }
  if (drifts.length > 0) {
    die(
      `BATCH_PLAN_STALE: 冻结计划与当前仓库状态不一致，拒绝按旧计划合成。\n  - ${drifts.join('\n  - ')}\n` +
      '请重新执行 plan-batch 冻结新计划（新指纹会自动走替代登记），不要在旧计划上继续。',
    );
  }
}

/**
 * 在候选树上按冻结顺序 merge 精确 SHA。冲突时 fail-closed：停在冲突处、不自动解、不自动 abort。
 * @param {Record<string,any>} record
 * @param {ReturnType<typeof computeBatchPlan>} plan
 * @param {{abortOnConflict:boolean,recomposeExpectedHead:string|null}} options
 */
function composeBatchCandidate(record, plan, options) {
  const path = record.path;
  const liveHead = gitTry(['rev-parse', 'HEAD'], path);
  if (!liveHead.ok) die(`无法读取候选树 HEAD: ${path}`);
  if (options.recomposeExpectedHead && liveHead.out !== options.recomposeExpectedHead) {
    die(
      `RECOMPOSE_HEAD_STALE: 候选 HEAD 已从授权值 ${options.recomposeExpectedHead} 变化为 ${liveHead.out}，拒绝重置。\n` +
      '请重新核对候选树并用当前完整 HEAD 重新授权。',
    );
  }
  if (liveHead.out !== plan.target.sha) {
    const reset = gitTry(['reset', '--hard', plan.target.sha], path);
    if (!reset.ok) die(`无法把候选树重置到批次 target: ${commandFailureReason(reset, 'reset 失败')}`);
  }

  const steps = [];
  for (const item of plan.included) {
    const message = `integrate(batch): ${item.task} ${item.head.slice(0, 12)}`;
    const merged = runFileCapture(
      'git',
      ['merge', '--no-ff', '--no-edit', '-m', message, item.head],
      { cwd: path, timeoutMs: SUBMIT_PUSH_TIMEOUT_MS },
    );
    if (!merged.ok) {
      const unresolved = unmergedPaths(path);
      // rerere 重放了全部解法时只差落 commit：这正是多轮候选免于重复手解的收口。
      if (unresolved.length === 0 && gitOperationState(path) === 'merge_head') {
        const committed = gitTry(['commit', '--no-edit'], path);
        if (committed.ok) {
          steps.push({
            task: item.task,
            worktree_id: item.worktree_id,
            input_sha: item.head,
            merge_commit: gitTry(['rev-parse', 'HEAD'], path).out || null,
            rerere_replayed: true,
          });
          continue;
        }
      }
      const conflict = {
        task: item.task,
        worktree_id: item.worktree_id,
        input_sha: item.head,
        onto_sha: liveHead.out === plan.target.sha && steps.length === 0
          ? plan.target.sha
          : (steps.at(-1)?.merge_commit ?? plan.target.sha),
        files: unresolved,
        candidate_path: path,
        detail: (merged.out || '').slice(0, 1000),
        aborted: false,
      };
      if (options.abortOnConflict) {
        gitTry(['merge', '--abort'], path);
        const reset = gitTry(['reset', '--hard', plan.target.sha], path);
        conflict.aborted = reset.ok;
      }
      return { state: 'conflict', steps, conflict, composed_sha: null };
    }
    steps.push({
      task: item.task,
      worktree_id: item.worktree_id,
      input_sha: item.head,
      merge_commit: gitTry(['rev-parse', 'HEAD'], path).out || null,
      rerere_replayed: false,
    });
  }
  return { state: 'composed', steps, conflict: null, composed_sha: gitTry(['rev-parse', 'HEAD'], path).out || null };
}

/**
 * 把 plan-batch 之后的手工仪式（建候选树、按序 merge、指纹落账）收进一条可重跑命令。
 *
 * 边界：**不执行任何门禁命令**。合成完成后只回显 Profile 声明的 post_integrate_steps
 * 清单，由 controller 逐条执行并用 `batch-step` 登记结果；portable core 永不跑 Profile 内容。
 * @param {{positionals:string[],flags:Map<string,unknown>}} args
 */
function cmdBatchIntegrate(args) {
  rejectUnknownFlags(args.flags, [
    'plan', 'target', 'candidate-task', 'agent', 'agent-id', 'purpose', 'owner',
    'abort-on-conflict', 'no-rerere', 'recompose', 'recompose-head', 'json', 'config', 'root', 'codegraph',
  ]);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const identity = resolveIdentity(args.flags);
  const asJson = Boolean(args.flags.get('json'));
  // --json 的 stdout 必须只有 JSON；诊断类回显在 JSON 模式下一律走 stderr。
  const notice = (message) => (asJson ? console.error(`${PREFIX} ${message}`) : log(message));

  const planPath = flag(args.flags, 'plan');
  let frozenPlan = null;
  let selectors = args.positionals;
  let targetOverride = flag(args.flags, 'target');
  if (planPath) {
    if (args.positionals.length > 0) die('--plan 与 selector 位置参数互斥；冻结计划已经带有输入清单。', 2);
    frozenPlan = readBatchPlanFile(planPath);
    // 必须用原始 selector 全集重算，而不是只用 included：被折叠或已在 target 的输入
    // 若随后前进，只回算 included 会让旧计划继续判定「新鲜」，把那部分改动静默漏出合成。
    selectors = Array.isArray(frozenPlan.requested_selectors) && frozenPlan.requested_selectors.length > 0
      ? frozenPlan.requested_selectors
      : [...frozenPlan.included, ...(frozenPlan.excluded ?? [])].map((item) => item.worktree_id);
    targetOverride = targetOverride ?? frozenPlan.target.ref;
  } else if (selectors.length < 2) {
    die('batch-integrate 需要 --plan <plan.json>，或至少两个 feature selector（即时规划）。', 2);
  }

  const plan = computeBatchPlan(loaded, selectors, targetOverride);
  if (!plan.ready) {
    for (const blocker of plan.blockers) console.error(`  [BLOCK] ${blocker.task ?? '-'} ${blocker.code}: ${blocker.detail}`);
    die('批次输入未就绪，拒绝合成；请先修复上述 blocker 再重新规划。');
  }
  if (frozenPlan) assertBatchPlanFresh(frozenPlan, plan);

  const candidateTask = flag(args.flags, 'candidate-task') ?? 'batch-integration-candidate';
  validateTaskSlug(candidateTask);
  validateTaskNaming(candidateTask, loaded.profile.task_naming);

  const records = loadRecords(loaded.context.common_dir);
  const liveCandidates = records.filter((record) => record.batch_integration && isActiveRecord(record));
  const reusable = liveCandidates.find((record) => record.batch_integration.fingerprint === plan.fingerprint);
  const superseded = liveCandidates.filter((record) => record.batch_integration.fingerprint !== plan.fingerprint);

  const recompose = Boolean(args.flags.get('recompose'));
  const recomposeHead = flag(args.flags, 'recompose-head');
  if (recomposeHead && !recompose) die('--recompose-head 只能与 --recompose 一起使用。', 2);
  if (recompose && !recomposeHead) {
    die('--recompose 是破坏性操作，必须同时提供 --recompose-head <候选当前完整 HEAD> 进行精确授权。', 2);
  }
  let candidate = reusable ?? null;
  let recomposeContext = null;
  if (candidate) {
    const snapshot = liveGitSnapshot(candidate);
    if (!snapshot.present) die(`同指纹候选 record 存在但 worktree missing: ${candidate.path}；请先 doctor/reclaim。`);
    const batch = candidate.batch_integration;
    const composedBefore = batch.state === 'composed' && Boolean(batch.composed_sha);
    const ownedByController = candidate.agent?.host === identity.actor.host && candidate.agent?.id === identity.actor.id;
    // 跨会话可只读查询一棵已完成候选，但任何会移动 HEAD、续合冲突或改写台账的路径都必须
    // 先显式 handoff。否则另一个 controller 仅凭同一 fingerprint 就能重置原 owner 的提交。
    if (!ownedByController && (!composedBefore || recompose)) {
      die(
        `候选属于 ${candidate.agent?.host ?? 'unknown'}/${candidate.agent?.id ?? 'unknown'}，` +
        `当前会话是 ${identity.actor.host}/${identity.actor.id}；跨会话只允许读取 already_composed。\n` +
        '需要继续合成或重合成时，请先执行 handoff 转移所有权。',
      );
    }
    // 已合成的候选**默认永不重置**。合成之后候选树通常还会前进：controller 执行 Profile 声明的
    // 合成后再生成步骤（golden / codegen / lock）并提交，HEAD 就不再等于 composed_sha。
    // 旧实现只认「HEAD == composed_sha」为幂等，于是同指纹重跑会落进重新合成路径，
    // reset --hard 把这些生成提交连同已登记的步骤状态一起抹掉。
    if (composedBefore && !recompose) {
      const advanced = snapshot.head !== batch.composed_sha
        && Boolean(snapshot.head)
        && isAncestor(candidate.path, batch.composed_sha, snapshot.head);
      if (snapshot.head !== batch.composed_sha && !advanced) {
        die(
          `候选 HEAD=${snapshot.head?.slice(0, 12) ?? 'unreadable'} 既不等于已落账 composed_sha=` +
          `${batch.composed_sha.slice(0, 12)}，也不是它的后继提交，无法判定候选树处于何种状态。\n` +
          '请人工核对候选树历史；确需按同一计划重新合成，加 --recompose（会丢弃合成之后的提交）。',
        );
      }
      const result = {
        schema_version: 1,
        outcome: 'already_composed',
        fingerprint: plan.fingerprint,
        candidate: { worktree_id: candidate.worktree_id, task: candidate.task, path: candidate.path, branch: candidate.branch },
        target: plan.target,
        composed_sha: batch.composed_sha,
        head_sha: snapshot.head,
        advanced_beyond_composition: advanced,
        dirty: snapshot.dirty,
        steps: batch.steps,
        rerere: batch.rerere ?? null,
        post_integrate_steps: batch.post_integrate_steps ?? [],
      };
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else {
        log(`同指纹候选已合成，幂等返回 fingerprint=${plan.fingerprint.slice(7, 19)} composed=${result.composed_sha.slice(0, 12)}`);
        if (advanced) {
          console.log(`  候选已在合成之上前进到 ${snapshot.head.slice(0, 12)}（通常是合成后再生成步骤的提交）；未重置、未改动步骤状态。`);
          console.log('  确需按同一计划重新合成请加 --recompose，它会丢弃这些提交。');
        }
        if (snapshot.dirty) console.log('  注意：候选树当前非干净，验收前请先处理未提交改动。');
        printPostIntegrateSteps(result.post_integrate_steps, candidate.task);
      }
      return;
    }
    if (snapshot.dirty !== false) {
      die(
        `候选树非干净，拒绝重置重合成: ${candidate.path}\n` +
        '若上一轮冲突已手工解出，请先提交该 merge（rerere 会录下解法），再重跑本命令；' +
        '若要放弃，请在候选树执行 git merge --abort。',
      );
    }
    if (composedBefore && recompose) {
      if (recomposeHead !== snapshot.head) {
        die(
          `RECOMPOSE_HEAD_STALE: --recompose-head=${recomposeHead} 与候选当前完整 HEAD=${snapshot.head ?? 'unreadable'} 不一致，拒绝重置。\n` +
          '请重新核对候选树，并用当前完整 HEAD 明示授权。',
        );
      }
      recomposeContext = {
        authorized_head_sha: recomposeHead,
        discarded_head_sha: snapshot.head,
        previous_composed_sha: batch.composed_sha,
      };
      candidate = updateRecord(candidate, 'batch_candidate_recompose_authorized', (next) => {
        if (next.agent?.host !== identity.actor.host || next.agent?.id !== identity.actor.id) {
          throw new WorktreeTraceError('RECOMPOSE_OWNER_CHANGED', '候选所有权已变化，拒绝重置。');
        }
        if (
          next.batch_integration?.fingerprint !== plan.fingerprint
          || next.batch_integration?.state !== 'composed'
          || next.batch_integration?.composed_sha !== batch.composed_sha
        ) {
          throw new WorktreeTraceError('RECOMPOSE_RECORD_CHANGED', '候选合成台账已变化，拒绝按陈旧快照授权重置。');
        }
        next.last_seen_at = new Date().toISOString();
      }, {
        fingerprint: plan.fingerprint,
        target_sha: plan.target.sha,
        ...recomposeContext,
        requested_by: identity.actor,
      }, loaded.context.common_dir);
      notice(`--recompose：已按精确 HEAD ${recomposeHead.slice(0, 12)} 授权，将丢弃候选后续提交并重新合成。`);
    } else if (recompose) {
      die('--recompose 只适用于已落账为 composed 的同指纹候选。');
    }
  } else {
    if (recompose) die('--recompose 未找到已落账为 composed 的同指纹候选，拒绝新建候选。');
    if (superseded.length > 1) {
      die(
        `存在 ${superseded.length} 棵旧指纹集成候选，自动替代登记只处理一棵，拒绝猜测：\n  - ` +
        superseded.map((record) => `${record.task}(${record.batch_integration.fingerprint.slice(7, 19)})=${record.path}`).join('\n  - ') +
        '\n请先回收多余候选，只保留一棵待替代的。',
      );
    }
    const previous = superseded[0] ?? null;
    if (previous && previous.task === candidateTask) {
      die(
        `候选 task ${candidateTask} 已绑定旧指纹 ${previous.batch_integration.fingerprint.slice(7, 19)}，` +
        `新指纹为 ${plan.fingerprint.slice(7, 19)}。\n` +
        '一次性候选不复用身份：请用 --candidate-task <新的 semantic slug> 建立替代候选（工具会自动登记替代关系），' +
        '或先回收旧候选再重跑。',
      );
    }
    if (previous) {
      const previousSnapshot = liveGitSnapshot(previous);
      if (!previousSnapshot.present) die(`旧候选 worktree missing: ${previous.path}；请先 doctor/reclaim。`);
      if (previousSnapshot.dirty !== false) die(`旧候选必须干净才能登记替代: ${previous.path}`);
      if (previous.agent?.host !== identity.actor.host || previous.agent?.id !== identity.actor.id) {
        die(
          `旧候选属于 ${previous.agent?.host}/${previous.agent?.id}，与当前会话不同；` +
          '跨会话不自动登记替代关系，请先人工回收旧候选。',
        );
      }
      if (previous.task_status !== 'abandoned') {
        updateRecord(previous, 'status_updated', (next) => {
          next.task_status = 'abandoned';
          next.last_seen_at = new Date().toISOString();
        }, { note: `批次输入变化，指纹 ${previous.batch_integration.fingerprint.slice(7, 19)} 已失效` }, loaded.context.common_dir);
      }
    }

    const spawnFlags = new Map();
    for (const key of ['agent', 'agent-id', 'owner', 'config', 'root', 'codegraph']) {
      const value = flag(args.flags, key);
      if (value) spawnFlags.set(key, value);
    }
    spawnFlags.set('purpose', flag(args.flags, 'purpose') ?? `一次性批次集成候选 fingerprint=${plan.fingerprint.slice(7, 19)}`);
    spawnFlags.set('base', plan.target.ref);
    spawnFlags.set('base-reason', `集成候选必须从批次冻结 target ${plan.target.ref} 起步`);
    if (previous) {
      spawnFlags.set('supersedes', previous.worktree_id);
      spawnFlags.set('replacement-reason', `批次输入变化：${previous.batch_integration.fingerprint.slice(7, 19)} -> ${plan.fingerprint.slice(7, 19)}`);
    } else if (coexistingSessionRecords(records, identity.actor, candidateTask).length > 0) {
      spawnFlags.set('parallel-reason', '一次性批次集成候选，与各 feature 交付可独立评审、合入和回退');
    }
    // spawn 的身份/路径回显对人有用，但 --json 的 stdout 必须只有 JSON；
    // 转存到 stderr，既不污染机器可读输出，也不丢诊断信息。
    const spawnChatter = [];
    const originalLog = console.log;
    if (asJson) console.log = (...parts) => spawnChatter.push(parts.join(' '));
    try {
      cmdSpawn({ positionals: [candidateTask], flags: spawnFlags });
    } finally {
      console.log = originalLog;
    }
    if (spawnChatter.length > 0) console.error(spawnChatter.join('\n'));

    candidate = loadRecords(loaded.context.common_dir).find((record) =>
      record.task === candidateTask &&
      record.agent?.host === identity.actor.host &&
      record.agent?.id === identity.actor.id &&
      isActiveRecord(record));
    if (!candidate) die('集成候选 spawn 后未能定位到对应 record；请运行 doctor 复查。');
    const candidateHead = gitTry(['rev-parse', 'HEAD'], candidate.path);
    if (!candidateHead.ok || candidateHead.out !== plan.target.sha) {
      die(
        `候选树 HEAD=${candidateHead.out || 'unreadable'} 与冻结 target SHA=${plan.target.sha} 不一致；` +
        'target ref 可能在建树期间移动，请重新 plan-batch。',
      );
    }
  }

  const rerere = args.flags.get('no-rerere')
    ? { enabled: false, auto_update: false, scope: 'none', worktree_config_extension: 'not_needed', worktree_config_previous: null, reason: '--no-rerere 显式关闭' }
    : enableCandidateRerere(loaded, candidate.path);
  // 自动写共享 config（extensions.worktreeConfig）是本命令唯一会碰仓库级配置的动作，
  // 必须留下独立、可区分「本轮写入」与「原本已启用」的审计事件。
  if (rerere.worktree_config_extension === 'enabled_by_this_command') {
    updateRecord(candidate, 'repository_config_extension_enabled', (next) => {
      next.last_seen_at = new Date().toISOString();
    }, {
      key: 'extensions.worktreeConfig',
      value: 'true',
      previous: rerere.worktree_config_previous ?? 'unset',
      scope: 'shared_repository_config',
      written_by: 'batch-integrate',
      purpose: '为集成候选启用 worktree 级 rerere（rerere.enabled + rerere.autoUpdate）',
    }, loaded.context.common_dir);
    notice('已在共享仓库 config 启用 extensions.worktreeConfig（本轮写入，已记审计事件）。');
  }

  const composed = composeBatchCandidate(candidate, plan, {
    abortOnConflict: Boolean(args.flags.get('abort-on-conflict')),
    recomposeExpectedHead: recomposeContext?.authorized_head_sha ?? null,
  });

  const orderedInputs = plan.included.map((item) => ({
    task: item.task,
    worktree_id: item.worktree_id,
    branch: item.branch,
    head: item.head,
    upstream_ref: item.upstream_ref,
  }));
  const declaredSteps = (loaded.profile.post_integrate_steps ?? []).map((step) => ({
    name: step.name,
    hint: step.hint,
    state: 'pending',
    note: null,
    recorded_at: null,
  }));
  const now = new Date().toISOString();
  const batchState = {
    fingerprint: plan.fingerprint,
    target_ref: plan.target.ref,
    target_sha: plan.target.sha,
    plan_generated_at: frozenPlan?.generated_at ?? plan.generated_at,
    plan_source: frozenPlan ? 'frozen_plan_file' : 'inline_plan',
    ordered_inputs: orderedInputs,
    state: composed.state,
    steps: composed.steps,
    composed_sha: composed.composed_sha,
    composed_at: composed.state === 'composed' ? now : null,
    conflict: composed.conflict,
    rerere,
    recompose: recomposeContext,
    post_integrate_steps: composed.state === 'composed' ? declaredSteps : [],
  };

  candidate = updateRecord(
    candidate,
    composed.state === 'composed' ? 'batch_candidate_composed' : 'batch_candidate_conflict',
    (next) => {
      next.batch_integration = batchState;
      next.task_status = composed.state === 'composed' ? 'integrating' : next.task_status;
      next.last_seen_at = now;
      next.last_head = composed.composed_sha ?? next.last_head;
    },
    {
      fingerprint: plan.fingerprint,
      target_sha: plan.target.sha,
      ordered_input_shas: orderedInputs.map((item) => item.head),
      merge_commits: composed.steps.map((step) => step.merge_commit),
      rerere,
      recompose: recomposeContext,
      conflict: composed.conflict,
    },
    loaded.context.common_dir,
  );

  const result = {
    schema_version: 1,
    outcome: composed.state,
    fingerprint: plan.fingerprint,
    candidate: { worktree_id: candidate.worktree_id, task: candidate.task, path: candidate.path, branch: candidate.branch },
    target: plan.target,
    ordered_inputs: orderedInputs,
    steps: composed.steps,
    composed_sha: composed.composed_sha,
    rerere,
    recompose: recomposeContext,
    conflict: composed.conflict,
    post_integrate_steps: batchState.post_integrate_steps,
  };
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else if (composed.state === 'composed') {
    log(`批次合成完成 candidate=${candidate.task} sha=${composed.composed_sha.slice(0, 12)} fingerprint=${plan.fingerprint.slice(7, 19)}`);
    for (const step of composed.steps) {
      console.log(`  [MERGED] ${step.task} ${step.input_sha.slice(0, 12)} -> ${step.merge_commit?.slice(0, 12)}${step.rerere_replayed ? ' (rerere 重放)' : ''}`);
    }
    console.log(`  rerere=${rerere.enabled ? rerere.scope : `off(${rerere.reason})`}`);
    console.log(`  候选树: ${candidate.path}`);
    printPostIntegrateSteps(batchState.post_integrate_steps, candidate.task);
    console.log('  下一步由 controller 执行门禁；本命令不跑任何验收命令。');
  } else {
    log(`批次合成冲突，停在 ${composed.conflict.task} ${composed.conflict.input_sha.slice(0, 12)}`);
    console.log(`  候选树: ${composed.conflict.candidate_path}`);
    console.log(`  合入侧(ours): ${composed.conflict.onto_sha.slice(0, 12)}  待并侧(theirs): ${composed.conflict.input_sha.slice(0, 12)}`);
    for (const file of composed.conflict.files) console.log(`  [CONFLICT] ${file}`);
    console.log(composed.conflict.aborted
      ? '  已按 --abort-on-conflict 回滚到干净 target。'
      : '  已停在冲突处（未自动解、未自动 abort）：请裁决后手工解并提交该 merge，再重跑本命令由 rerere 重放。');
  }
  if (composed.state !== 'composed') process.exitCode = 1;
}

/** @param {Record<string,any>[]} steps @param {string} task */
function printPostIntegrateSteps(steps, task) {
  if (!steps || steps.length === 0) return;
  console.log('  Profile 声明的合成后再生成步骤（只回显、不代跑）：');
  for (const step of steps) {
    console.log(`  [${step.state.toUpperCase()}] ${step.name}: ${step.hint}`);
  }
  console.log(`  执行后登记：batch-step ${task} --step <name> --state done|skipped|failed`);
}

/**
 * 登记 Profile 声明的合成后步骤的执行结果。工具只记录 controller 的回报，从不代跑。
 * @param {{positionals:string[],flags:Map<string,unknown>}} args
 */
function cmdBatchStep(args) {
  rejectUnknownFlags(args.flags, ['step', 'state', 'note', 'id', 'json', 'config']);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
  const stepName = flag(args.flags, 'step');
  const state = flag(args.flags, 'state');
  if (!stepName) die('batch-step 需要 --step <name>。', 2);
  if (!['done', 'skipped', 'failed'].includes(state ?? '')) die('--state 只接受 done / skipped / failed。', 2);
  const batch = record.batch_integration;
  if (!batch || batch.state !== 'composed') die(`${record.task} 不是已合成的集成候选，无法登记合成后步骤。`);
  const steps = batch.post_integrate_steps ?? [];
  const target = steps.find((step) => step.name === stepName);
  if (!target) {
    die(
      `未声明的步骤名: ${stepName}；当前候选只登记 Profile 声明过的步骤` +
      `${steps.length ? `：${steps.map((step) => step.name).join(', ')}` : '（该 Profile 未声明任何步骤）'}。`,
      2,
    );
  }
  const note = flag(args.flags, 'note') ? oneLine(flag(args.flags, 'note'), 'note', 240) : null;
  const now = new Date().toISOString();
  const updated = updateRecord(record, 'batch_post_step_recorded', (next) => {
    const step = next.batch_integration.post_integrate_steps.find((item) => item.name === stepName);
    step.state = state;
    step.note = note;
    step.recorded_at = now;
    next.last_seen_at = now;
  }, { step: stepName, state, note, fingerprint: batch.fingerprint }, loaded.context.common_dir);
  const recorded = updated.batch_integration.post_integrate_steps;
  if (args.flags.get('json')) {
    console.log(JSON.stringify({ schema_version: 1, worktree_id: updated.worktree_id, post_integrate_steps: recorded }, null, 2));
    return;
  }
  log(`已登记 ${stepName} -> ${state}`);
  const pending = recorded.filter((step) => step.state === 'pending');
  console.log(pending.length === 0
    ? '  合成后步骤已全部登记。'
    : `  仍待登记: ${pending.map((step) => step.name).join(', ')}`);
}

/** @param {ReturnType<typeof loadRepositoryProfile>} loaded */
function primaryProfileDriftFinding(loaded) {
  const defaultBase = loaded.profile.default_base;
  if (loaded.profile_source !== 'primary' || !defaultBase || !existsSync(loaded.profile_path)) return null;
  const baseline = gitTry(
    ['show', `${defaultBase}:${PROFILE_FILENAME}`],
    loaded.context.current_worktree,
  );
  if (!baseline.ok) return null;
  const current = readFileSync(loaded.profile_path, 'utf8');
  if (normalizedProfileContent(current) === normalizedProfileContent(baseline.out)) return null;
  return {
    code: 'PRIMARY_PROFILE_DRIFT_FROM_BASE',
    severity: 'error',
    path: loaded.profile_path,
    baseline_ref: defaultBase,
    detail: `primary worktree Profile 与 ${defaultBase}:${PROFILE_FILENAME} 不一致；spawn/adopt 必须 fail-closed，禁止继续使用陈旧命名配置。`,
  };
}

function cmdDoctor(args) {
  rejectUnknownFlags(args.flags, ['json', 'config']);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const findings = [];
  const listing = buildListing(true, loaded);
  const profileDrift = primaryProfileDriftFinding(loaded);
  if (profileDrift) findings.push(profileDrift);
  for (const row of listing.rows.filter((row) => row.kind === 'UNTRACKED')) {
    findings.push({ code: 'UNTRACKED_WORKTREE', severity: 'warning', path: row.path, branch: row.branch });
    if (classifyStorage(row.path, loaded.profile.ephemeral_path_patterns) === 'ephemeral') {
      findings.push({ code: 'EPHEMERAL_UNTRACKED', severity: 'warning', path: row.path, branch: row.branch });
    }
  }
  for (const entry of listRecordCacheEntries(loaded.context.common_dir)) {
    if (entry.error) { findings.push({ code: 'RECORD_CACHE_INVALID', severity: 'error', path: entry.path, detail: entry.error }); continue; }
    const record = entry.record;
    try { readEventChain(loaded.context.common_dir, record.worktree_id); } catch (error) { findings.push({ code: error.code ?? 'EVENT_CHAIN_INVALID', severity: 'error', worktree_id: record.worktree_id, detail: error.message }); }
    if (record.worktree_state !== 'reclaimed') {
      try {
        validateTaskNaming(record.task, loaded.profile.task_naming);
      } catch (error) {
        findings.push({
          code: error instanceof WorktreeProfileError ? error.code : 'TASK_NAMING_DOD_FAILED',
          severity: 'error',
          worktree_id: record.worktree_id,
          path: record.path,
          task: record.task,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (record.storage_class === 'ephemeral' && record.worktree_state !== 'reclaimed') findings.push({ code: 'EPHEMERAL_WORKTREE', severity: 'warning', worktree_id: record.worktree_id, path: record.path });
    if (
      record.worktree_state !== 'reclaimed' &&
      loaded.profile.default_base &&
      record.base_ref &&
      record.base_ref !== loaded.profile.default_base
    ) {
      findings.push({
        code: 'BASE_OVERRIDE',
        severity: 'warning',
        worktree_id: record.worktree_id,
        path: record.path,
        base_ref: record.base_ref,
        default_base: loaded.profile.default_base,
        base_reason: record.base_reason ?? null,
        detail: record.base_reason ? `非默认基线：${record.base_reason}` : '非默认基线未记录原因（legacy record）。',
      });
    }
    const present = listing.rows.some((row) => row.path === canonicalSelectorPath(record.path));
    const liveRow = listing.rows.find((row) => row.path === canonicalSelectorPath(record.path));
    if (present && record.worktree_state !== 'reclaimed' && record.task_status === 'abandoned') {
      findings.push({
        code: record.superseded_by ? 'SUPERSEDED_WORKTREE_RECLAIM_PENDING' : 'ABANDONED_WORKTREE_RECLAIM_PENDING',
        severity: 'warning',
        worktree_id: record.worktree_id,
        path: record.path,
        replacement_worktree_id: record.superseded_by?.worktree_id ?? null,
        detail: record.superseded_by
          ? '被替代 worktree 仍占用目录；保存独有提交后应执行 reclaim --superseded-by。'
          : 'abandoned 只冻结任务，不会回收目录；补登记 supersede 关系或使用已有 pushed 证据回收。',
      });
    }
    if (liveRow && record.worktree_state !== 'reclaimed') {
      const operation = gitOperationState(record.path);
      if (operation) {
        findings.push({
          code: 'GIT_OPERATION_IN_PROGRESS',
          severity: 'error',
          worktree_id: record.worktree_id,
          path: record.path,
          detail: `检测到 ${operation}；禁止把该树作为交付或批次验收输入。`,
        });
      }
      if (record.branch && liveRow.branch !== record.branch) {
        findings.push({
          code: 'LIVE_BRANCH_MISMATCH',
          severity: 'error',
          worktree_id: record.worktree_id,
          path: record.path,
          recorded_branch: record.branch,
          live_branch: liveRow.branch,
        });
      }
      if (record.last_head && liveRow.head && record.last_head !== liveRow.head) {
        findings.push({
          code: 'HEAD_DRIFT',
          severity: ['ready_for_review', 'integrating'].includes(record.task_status) ? 'error' : 'warning',
          worktree_id: record.worktree_id,
          path: record.path,
          recorded_head: record.last_head,
          live_head: liveRow.head,
          detail: 'live HEAD 与最后登记 SHA 不一致；先 touch/audit 并重新确认交付边界。',
        });
      }
      if (liveRow.dirty === true && ['ready_for_review', 'integrating'].includes(record.task_status)) {
        findings.push({
          code: 'REVIEW_STATE_DIRTY',
          severity: 'error',
          worktree_id: record.worktree_id,
          path: record.path,
          task_status: record.task_status,
          detail: 'ready_for_review/integrating worktree 必须保持干净；当前验收边界已失效。',
        });
      }
    }
    if (record.worktree_state === 'reclaim_ready') {
      findings.push({
        code: 'RECLAIM_INTERRUPTED',
        severity: 'warning',
        worktree_id: record.worktree_id,
        path: record.path,
        phase: present ? 'before_remove' : 'after_remove',
        last_reclaim_error: record.last_reclaim_error ?? null,
      });
    } else if (!present && record.worktree_state !== 'reclaimed') {
      findings.push({ code: 'WORKTREE_MISSING', severity: 'warning', worktree_id: record.worktree_id, path: record.path });
    }
    if (present && record.worktree_state === 'reclaimed') {
      const reusedByNewerRecord = listing.records.some((candidate) =>
        candidate.worktree_id !== record.worktree_id &&
        candidate.worktree_state !== 'reclaimed' &&
        canonicalSelectorPath(candidate.path) === canonicalSelectorPath(record.path) &&
        String(candidate.created_at) > String(record.created_at),
      );
      if (!reusedByNewerRecord) findings.push({ code: 'RECLAIMED_PATH_CONFLICT', severity: 'error', worktree_id: record.worktree_id, path: record.path });
    }
    if (record.worktree_state === 'reclaimed') {
      const branchExists = Boolean(record.branch) && gitTry(
        ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`],
        loaded.context.current_worktree,
      ).ok;
      if (record.branch_cleanup?.status === 'failed' || branchExists) {
        findings.push({
          code: 'LOCAL_BRANCH_CLEANUP_FAILED',
          severity: 'warning',
          worktree_id: record.worktree_id,
          branch: record.branch ?? null,
          status: record.branch_cleanup?.status ?? 'legacy',
          branch_exists: branchExists,
          detail: record.branch_cleanup?.reason ?? (branchExists ? 'local branch ref still exists' : 'cleanup failure not reconciled'),
        });
      }
    }
    if (record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state) && record.worktree_state !== 'reclaimed') {
      const heartbeat = readWatcherHeartbeat(loaded.context.common_dir, record.worktree_id);
      const health = watcherHealth(record, heartbeat);
      if (!health.healthy) {
        findings.push({
          code: 'AUTO_RECLAIM_WATCHER_STALE',
          severity: 'error',
          worktree_id: record.worktree_id,
          path: watcherPath(loaded.context.common_dir, record.worktree_id),
          detail: health.reason,
        });
      } else if (heartbeat.state?.blocked_reason) {
        findings.push({
          code: 'AUTO_RECLAIM_BLOCKED',
          severity: 'warning',
          worktree_id: record.worktree_id,
          detail: heartbeat.state.blocked_reason,
        });
      }
    }
  }
  const relationPairs = new Map();
  for (const record of listing.records) {
    if (record.delivery_relation?.kind === 'supersedes' && record.delivery_relation.superseded_worktree_id) {
      const oldId = record.delivery_relation.superseded_worktree_id;
      relationPairs.set(`${oldId}\u0000${record.worktree_id}`, { oldId, replacementId: record.worktree_id });
    }
    if (record.superseded_by?.worktree_id) {
      const replacementId = record.superseded_by.worktree_id;
      relationPairs.set(`${record.worktree_id}\u0000${replacementId}`, { oldId: record.worktree_id, replacementId });
    }
  }
  for (const { oldId, replacementId } of relationPairs.values()) {
    const oldRecord = listing.records.find((record) => record.worktree_id === oldId);
    const replacement = listing.records.find((record) => record.worktree_id === replacementId);
    const reciprocal = Boolean(
      oldRecord &&
      replacement &&
      oldRecord.superseded_by?.worktree_id === replacementId &&
      replacement.delivery_relation?.kind === 'supersedes' &&
      replacement.delivery_relation.superseded_worktree_id === oldId &&
      replacement.delivery_relation.related_worktree_ids?.includes(oldId),
    );
    if (!reciprocal) {
      findings.push({
        code: 'SUPERSESSION_RELATION_BROKEN',
        severity: 'error',
        worktree_id: oldId,
        replacement_worktree_id: replacementId,
        detail: 'superseded_by 与 delivery_relation 必须双向一致；使用 supersede 命令补齐后再回收。',
      });
    }
  }
  const unreclaimedBySession = new Map();
  for (const record of listing.records.filter((candidate) => candidate.worktree_state !== 'reclaimed')) {
    const key = `${record.agent?.host ?? 'unknown'}\u0000${record.agent?.id ?? 'unknown'}`;
    const group = unreclaimedBySession.get(key) ?? [];
    group.push(record);
    unreclaimedBySession.set(key, group);
  }
  for (const group of unreclaimedBySession.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
    const earlierIds = new Set();
    const undeclared = [];
    for (const record of ordered) {
      const related = record.delivery_relation?.related_worktree_ids ?? [];
      if (earlierIds.size > 0 && !related.some((id) => earlierIds.has(id))) undeclared.push(record);
      earlierIds.add(record.worktree_id);
    }
    if (undeclared.length > 0) {
      findings.push({
        code: 'UNDECLARED_SESSION_WORKTREE_MULTIPLICITY',
        severity: 'warning',
        agent: ordered[0].agent,
        worktree_ids: ordered.map((record) => record.worktree_id),
        tasks: ordered.map((record) => record.task),
        undeclared_worktree_ids: undeclared.map((record) => record.worktree_id),
        detail: '同一 Agent 会话存在多棵未回收 worktree，且后建树未声明 parallel/supersedes 关系；复查是否应复用或回收。',
      });
    }
  }
  const locks = traceLayout(loaded.context.common_dir).locks;
  if (existsSync(locks)) for (const name of readdirSync(locks)) if (name.endsWith('.lock')) {
    const id = name.slice(0, -5); const finding = inspectRecordLock(loaded.context.common_dir, id);
    if (finding.state === 'stale' || finding.state === 'malformed') findings.push({ code: `LOCK_${finding.state.toUpperCase()}`, severity: 'error', worktree_id: id, detail: finding });
  }
  if (loaded.context.current_worktree !== loaded.context.primary_worktree) {
    const local = join(loaded.context.current_worktree, PROFILE_FILENAME);
    if (existsSync(local) && existsSync(loaded.profile_path) && readFileSync(local, 'utf8') !== readFileSync(loaded.profile_path, 'utf8')) findings.push({ code: 'PROFILE_DRIFT', severity: 'warning', path: local, authoritative: loaded.profile_path });
  }
  const learning = learningRoot(loaded.context.common_dir);
  const reflectionById = new Map();
  const reflectionDir = join(learning, 'reflections');
  if (existsSync(reflectionDir)) for (const name of readdirSync(reflectionDir).filter((item) => item.endsWith('.json'))) {
    const path = join(reflectionDir, name);
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      const clone = { ...value }; delete clone.reflection_digest;
      if (contentDigest(Buffer.from(JSON.stringify(canonicalJson(clone)))) !== value.reflection_digest) throw new Error('reflection digest mismatch');
      const eventRef = value.evidence_refs?.find((item) => item.type === 'event');
      const match = /^([^:]+):(.+)$/u.exec(eventRef?.id ?? '');
      if (!match) throw new Error('event ref invalid');
      const event = readEventChain(loaded.context.common_dir, match[1]).find((item) => item.event_id === match[2]);
      if (!event || contentDigest(Buffer.from(JSON.stringify(canonicalJson(event)))) !== eventRef.digest) throw new Error('event evidence digest mismatch');
      reflectionById.set(value.reflection_id, value);
    } catch (error) {
      findings.push({ code: 'LEARNING_REFLECTION_INVALID', severity: 'error', path, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const proposalDir = join(learning, 'proposals');
  if (existsSync(proposalDir)) for (const name of readdirSync(proposalDir).filter((item) => item.endsWith('.json'))) {
    const path = join(proposalDir, name);
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      const clone = { ...value }; delete clone.proposal_digest;
      if (value.lifecycle !== 'proposed' || contentDigest(Buffer.from(JSON.stringify(canonicalJson(clone)))) !== value.proposal_digest) throw new Error('proposal digest/lifecycle invalid');
      if (!(value.source_reflections ?? []).every((item) => reflectionById.get(item.reflection_id)?.reflection_digest === item.reflection_digest)) throw new Error('proposal reflection binding invalid');
    } catch (error) {
      findings.push({ code: 'LEARNING_PROPOSAL_INVALID', severity: 'error', path, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  if (args.flags.get('json')) console.log(JSON.stringify({ findings }, null, 2));
  else { log(`doctor findings=${findings.length}`); for (const finding of findings) console.log(`  [${finding.severity}] ${finding.code} ${finding.path ?? finding.worktree_id ?? ''}`); }
}

function cmdRebuild(args) {
  rejectUnknownFlags(args.flags, ['id', 'recover-lock', 'config']);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const records = loadRecords(loaded.context.common_dir);
  const eventsDir = traceLayout(loaded.context.common_dir).events;
  const eventIds = existsSync(eventsDir)
    ? readdirSync(eventsDir).filter((name) => /^[0-9a-f-]{36}$/i.test(name))
    : [];
  let targetIds;
  const explicitId = flag(args.flags, 'id');
  if (explicitId) {
    if (!/^(?:[0-9a-f]{8,32}|[0-9a-f-]{36})$/i.test(explicitId)) die('--id 需要完整 UUID 或至少 8 位十六进制前缀。', 2);
    targetIds = eventIds.filter((id) => id.toLowerCase().startsWith(explicitId.toLowerCase()));
    if (targetIds.length !== 1) die(`--id 在 event store 中匹配 ${targetIds.length} 条 chain。`, 2);
  } else if (args.positionals[0]) {
    targetIds = [selectRecord(records, args.positionals[0], null).worktree_id];
  } else {
    targetIds = eventIds;
  }
  for (const worktreeId of targetIds) {
    if (args.flags.get('recover-lock')) {
      const finding = inspectRecordLock(loaded.context.common_dir, worktreeId);
      if (finding.state !== 'absent' && finding.state !== 'held') recoverRecordLock(loaded.context.common_dir, worktreeId, { forceMalformed: true });
    }
    rebuildRecordCache(loaded.context.common_dir, worktreeId);
    log(`rebuilt ${worktreeId}`);
  }
}

function appendReclaimEvent(commonDir, record, type, update, details = {}) {
  return appendTraceEvent({ commonDir, worktreeId: record.worktree_id, eventType: type, actor: record.agent, details, mutate(current) { const next = structuredClone(current); update(next); next.updated_at = new Date().toISOString(); return next; } }).record;
}

/**
 * watcher 与 unwatch 以同一条 record lock 为裁决边界：谁先写入 event，谁赢。
 * 这样即使两个进程同时动作，已解除的 token 也不能靠旧 record 快照复活。
 * @param {string} commonDir
 * @param {Record<string,any>} record
 * @param {string} token
 * @param {string} type
 * @param {(next:Record<string,any>)=>void} update
 * @param {Record<string,any>} [details]
 */
function appendWatchedEvent(commonDir, record, token, type, update, details = {}) {
  return appendTraceEvent({
    commonDir,
    worktreeId: record.worktree_id,
    eventType: type,
    actor: record.agent,
    details,
    mutate(current) {
      if (current.auto_reclaim?.token !== token || ['disarmed', 'reclaimed'].includes(current.auto_reclaim?.state)) {
        throw new WorktreeTraceError('WATCHER_CANCELLED', `watch token 已失效: ${record.worktree_id}`);
      }
      const next = structuredClone(current);
      update(next);
      next.updated_at = new Date().toISOString();
      return next;
    },
  }).record;
}

/** @param {Record<string,any>} record */
function supersededArchiveRef(record) {
  return `refs/worktree-archive/superseded/${record.worktree_id}`;
}

/**
 * superseded reclaim 比普通 pushed reclaim 多两层证据：双向替代关系必须完整，且替代树不能脏。
 * 旧树的普通干净/stash/submodule 检查仍统一交给 reclaimPreflight。
 * @param {ReturnType<typeof loadRepositoryProfile>} loaded
 * @param {Record<string,any>} superseded
 * @param {Record<string,any>} replacement
 * @param {string|null} discardSha
 */
function prepareSupersededReclaim(loaded, superseded, replacement, discardSha) {
  if (superseded.task_status !== 'abandoned') {
    die(`reclaim --superseded-by 只接受 abandoned 旧树；当前 ${superseded.task_status}。`, 2);
  }
  if (!sameAgentSession(superseded, replacement)) die('旧树与替代树不属于同一 Agent 会话。', 2);
  if (superseded.owner && replacement.owner && superseded.owner !== replacement.owner) {
    die(`旧树与替代树 owner 不一致：${superseded.owner} != ${replacement.owner}。`, 2);
  }
  if (
    superseded.superseded_by?.worktree_id !== replacement.worktree_id ||
    replacement.delivery_relation?.kind !== 'supersedes' ||
    replacement.delivery_relation.superseded_worktree_id !== superseded.worktree_id ||
    !replacement.delivery_relation.related_worktree_ids?.includes(superseded.worktree_id)
  ) {
    die('替代关系未双向登记；先运行 supersede <old> --by <new> --reason <原因>。', 2);
  }
  const replacementSnapshot = liveGitSnapshot(replacement);
  if (replacement.worktree_state !== 'reclaimed') {
    if (!replacementSnapshot.present) die(`替代 worktree missing: ${replacement.path}`, 2);
    if (replacementSnapshot.dirty !== false) die(`替代 worktree 必须干净：${replacement.path}`, 2);
  }
  const supersededSnapshot = liveGitSnapshot(superseded);
  const sourceSha = supersededSnapshot.head ?? superseded.last_head ?? superseded.reclaim_summary?.source_sha ?? null;
  if (!sourceSha || !/^[0-9a-f]{40}$/i.test(sourceSha)) die('无法确定被替代树的精确 HEAD，拒绝回收。', 2);
  const preflight = reclaimPreflight(loaded, superseded, sourceSha);
  if (preflight.reason) {
    die(`被替代树尚未达到归档/丢弃前置条件：${preflight.reason}`, 2);
  }

  let record = superseded;
  let evidence;
  if (discardSha) {
    if (!/^[0-9a-f]{40}$/i.test(discardSha)) die('--discard 必须填写 40 位旧树精确 HEAD。', 2);
    if (discardSha.toLowerCase() !== sourceSha.toLowerCase()) {
      die(`--discard SHA 与旧树 HEAD 不一致：expected ${sourceSha}`, 2);
    }
    if (record.superseded_recovery && (
      record.superseded_recovery.mode !== 'discard' ||
      record.superseded_recovery.source_sha !== sourceSha
    )) {
      die('该旧树已经登记不同的恢复策略，拒绝改写。', 2);
    }
    evidence = {
      kind: 'superseded_discard',
      source_sha: sourceSha,
      replacement_worktree_id: replacement.worktree_id,
      replacement_task: replacement.task,
    };
    if (!record.superseded_recovery) {
      record = appendReclaimEvent(loaded.context.common_dir, record, 'superseded_head_discard_authorized', (next) => {
        next.superseded_recovery = { mode: 'discard', ...evidence, authorized_at: new Date().toISOString() };
      }, evidence);
    }
  } else {
    const archiveRef = supersededArchiveRef(record);
    if (record.superseded_recovery && (
      record.superseded_recovery.mode !== 'archive_ref' ||
      record.superseded_recovery.source_sha !== sourceSha ||
      record.superseded_recovery.archive_ref !== archiveRef
    )) {
      die('该旧树已经登记不同的恢复策略，拒绝改写。', 2);
    }
    const existing = gitTry(['rev-parse', '--verify', `${archiveRef}^{commit}`], loaded.context.current_worktree);
    if (existing.ok && existing.out !== sourceSha) {
      die(`归档 ref 已指向其他提交：${archiveRef} -> ${existing.out}`, 2);
    }
    if (!existing.ok) {
      const archived = gitTry(['update-ref', archiveRef, sourceSha, '0'.repeat(40)], loaded.context.current_worktree);
      if (!archived.ok) die(commandFailureReason(archived, `无法创建归档 ref ${archiveRef}`));
    }
    const verified = gitTry(['rev-parse', '--verify', `${archiveRef}^{commit}`], loaded.context.current_worktree);
    if (!verified.ok || verified.out !== sourceSha) die(`归档 ref 校验失败：${archiveRef}`, 2);
    evidence = {
      kind: 'superseded_archive',
      source_sha: sourceSha,
      archive_ref: archiveRef,
      replacement_worktree_id: replacement.worktree_id,
      replacement_task: replacement.task,
    };
    if (!record.superseded_recovery) {
      record = appendReclaimEvent(loaded.context.common_dir, record, 'superseded_head_archived', (next) => {
        next.superseded_recovery = { mode: 'archive_ref', ...evidence, archived_at: new Date().toISOString() };
      }, evidence);
    }
  }
  return { record, sourceSha, evidence };
}

/** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {string} pushed */
function reclaimPreflight(loaded, record, pushed) {
  const stash = gitTry(['stash', 'list'], loaded.context.current_worktree);
  const live = parseWorktrees(loaded.context.current_worktree).find((worktree) => worktree.path === canonicalSelectorPath(record.path));
  const dangling = live ? inspectDanglingSubmodulePointers(live.path) : { reason: null };
  const status = live ? gitTry(['status', '--porcelain'], live.path) : { ok: true, out: '' };
  const commit = record.branch && gitTry(['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`], loaded.context.current_worktree).ok
    ? record.branch
    : record.last_head;
  const merged = commit ? gitTry(['merge-base', '--is-ancestor', commit, pushed], loaded.context.current_worktree).ok : false;
  const reason = dangling.reason
    ? dangling.reason
    : stash.ok && stash.out
    ? 'repository has stash entries'
    : !status.ok || status.out
      ? 'worktree dirty/unreadable'
      : !merged
        ? 'branch/head not merged into pushed sha'
        : null;
  return { reason, live };
}

/** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record */
function localBranchExists(loaded, record) {
  return Boolean(record.branch) && gitTry(
    ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`],
    loaded.context.current_worktree,
  ).ok;
}

/** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {string} pushed */
function attemptLocalBranchCleanup(loaded, record, pushed) {
  const checkedAt = new Date().toISOString();
  const previousAttempts = Number(record.branch_cleanup?.attempts ?? 0);
  if (!record.branch || !localBranchExists(loaded, record)) {
    return {
      status: 'absent',
      branch: record.branch ?? null,
      attempts: previousAttempts,
      checked_at: checkedAt,
      reason: null,
    };
  }
  if (!gitTry(['merge-base', '--is-ancestor', record.branch, pushed], loaded.context.current_worktree).ok) {
    return {
      status: 'failed',
      branch: record.branch,
      attempts: previousAttempts + 1,
      checked_at: checkedAt,
      reason: `local branch tip is not merged into pushed sha: ${pushed}`,
    };
  }
  const removed = gitTry(['branch', '-D', '--', record.branch], loaded.context.current_worktree);
  if (removed.ok) {
    return {
      status: 'deleted',
      branch: record.branch,
      attempts: previousAttempts + 1,
      checked_at: checkedAt,
      reason: null,
    };
  }
  return {
    status: 'failed',
    branch: record.branch,
    attempts: previousAttempts + 1,
    checked_at: checkedAt,
    reason: commandFailureReason(removed, 'git branch -D failed'),
  };
}

/** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {string} pushed */
function reconcileReclaimedBranchCleanup(loaded, record, pushed) {
  const branchExists = localBranchExists(loaded, record);
  if (['deleted', 'absent'].includes(record.branch_cleanup?.status) && !branchExists) {
    return { record, branch_cleanup: record.branch_cleanup, changed: false };
  }
  const cleanup = attemptLocalBranchCleanup(loaded, record, pushed);
  const updated = appendReclaimEvent(loaded.context.common_dir, record, 'branch_cleanup_retried', (next) => {
    next.branch_cleanup = cleanup;
    if (next.reclaim_summary) next.reclaim_summary.branch_cleanup = cleanup;
  }, { pushed, branch_cleanup: cleanup });
  return { record: updated, branch_cleanup: cleanup, changed: true };
}

/** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record */
function reconcileReclaimedTerminalState(loaded, record) {
  const finalEpoch = record.ownership_epochs?.at(-1);
  const needsStatus = !TERMINAL_TASK_STATES.has(record.task_status);
  const needsEpoch = Boolean(finalEpoch && !finalEpoch.ended_at);
  if (!needsStatus && !needsEpoch) return { record, changed: false };
  const branchHead = record.branch
    ? gitTry(['rev-parse', '--verify', record.branch], loaded.context.current_worktree)
    : { ok: false, out: '' };
  const endSha = branchHead.ok
    ? branchHead.out
    : record.last_head ?? record.reclaim_summary?.source_sha ?? null;
  const completedAt = record.reclaimed_at ?? new Date().toISOString();
  const updated = appendReclaimEvent(loaded.context.common_dir, record, 'reclaim_terminal_reconciled', (next) => {
    if (next.task_status !== 'abandoned') next.task_status = 'done';
    const epoch = next.ownership_epochs?.at(-1);
    if (epoch && !epoch.ended_at && endSha) {
      epoch.end_sha = endSha;
      epoch.ended_at = completedAt;
    }
  }, { task_status: needsStatus ? 'done' : record.task_status, end_sha: endSha });
  return { record: updated, changed: true };
}

/**
 * 从 .gitmodules 枚举登记的 submodule 路径。不打开任何 submodule 仓库——
 * `git submodule status` 在 .git 指针悬空（指向已删元数据）时整条命令 fatal，
 * 残骸清理阶段只能走这条纯文件读取的枚举。
 * @param {string} worktreePath
 */
function registeredSubmodulePaths(worktreePath) {
  const config = gitTry(['config', '-f', '.gitmodules', '--get-regexp', String.raw`^submodule\..*\.path$`], worktreePath);
  if (!config.ok || !config.out) return [];
  return config.out.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/).slice(1).join(' '))
    .filter(Boolean);
}

/**
 * 读 submodule 工作目录 .git 指针文件的 gitdir 目标（绝对路径）。
 * 缺失、真目录（嵌入式仓库）或格式不符时返回 null。
 * @param {string} submoduleDir
 */
function submoduleGitPointerTarget(submoduleDir) {
  const gitPointer = join(submoduleDir, '.git');
  if (!existsSync(gitPointer) || statSync(gitPointer).isDirectory()) return null;
  let content;
  try {
    content = readFileSync(gitPointer, 'utf8');
  } catch {
    return null;
  }
  const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
  return match ? resolve(submoduleDir, match[1]) : null;
}

/**
 * 检测悬空 .git 指针。元数据缺失时无法证明目录内容干净，因此必须 fail-closed 返回 KEEP，
 * 由人工检查并修复；不能把不可审计内容当作残骸自动删除。
 * @param {string} worktreePath
 */
function inspectDanglingSubmodulePointers(worktreePath) {
  for (const submodulePath of registeredSubmodulePaths(worktreePath)) {
    const submoduleDir = join(worktreePath, submodulePath);
    const target = submoduleGitPointerTarget(submoduleDir);
    if (!target || existsSync(target)) continue;
    return { reason: `submodule has dangling .git pointer and cannot be audited safely: ${submodulePath}` };
  }
  return { reason: null };
}

/**
 * `git submodule status` 每行前缀标出初始化状态：'-' = 未初始化，其余（空格/'+'/'U'）均已初始化。
 * 未初始化的也要列出：它可能留有历史清理残骸（树私有 modules/ 元数据、工作目录里的
 * .git 指针文件），同样会让 `git worktree remove` 拒绝或 fatal。
 * @param {string} worktreePath
 * @returns {Array<{path:string,initialized:boolean}>}
 */
function listSubmoduleEntries(worktreePath) {
  const status = gitTry(['submodule', 'status'], worktreePath);
  if (!status.ok || !status.out) return [];
  return status.out.split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({ initialized: line[0] !== '-', path: line.trim().split(/\s+/)[1] }))
    .filter((entry) => Boolean(entry.path));
}

/**
 * deinit 完成（或本就未初始化）的 submodule 工作目录必须为空；任何残留都无法被 Git
 * 可靠审计，保守返回 KEEP，不执行递归删除。
 * @param {string} worktreePath @param {string} submodulePath
 */
function ensureSubmoduleWorkdirEmpty(worktreePath, submodulePath) {
  const submoduleDir = join(worktreePath, submodulePath);
  if (!existsSync(submoduleDir)) return { reason: null };
  try {
    const entries = readdirSync(submoduleDir);
    if (entries.length > 0) return { reason: `uninitialized submodule workdir is not empty: ${submodulePath}` };
  } catch (error) {
    return { reason: `failed to inspect submodule workdir: ${submodulePath}: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { reason: null };
}

/**
 * 含 submodule 的树即使标准四项审计（台账/干净/已合入/无 stash）通过，`git worktree remove`
 * 非 force 仍会因树私有的 submodule 克隆元数据（$GIT_COMMON_DIR/worktrees/<id>/modules/）拒绝。
 * 逐个校验已初始化 submodule 工作区干净后 deinit，再清理该元数据与各 submodule 工作目录
 * 残骸，为后续 remove 让路；任一 submodule 脏则不动它，原样返回让调用方 KEEP。
 * 清理触发看「元数据/残骸是否存在」而非初始化状态：submodule 已被 deinit 但元数据或
 * .git 指针残留时（历史清理中断的产物），同样要收拾干净。
 * @param {string} worktreePath
 */
function reclaimSubmodules(worktreePath) {
  const entries = listSubmoduleEntries(worktreePath);
  const gitDir = gitTry(['rev-parse', '--absolute-git-dir'], worktreePath);
  const modulesDir = gitDir.ok && gitDir.out ? join(gitDir.out, 'modules') : null;
  const hasModulesMetadata = modulesDir !== null && existsSync(modulesDir);
  if (entries.length === 0 && !hasModulesMetadata) return { reason: null };
  for (const entry of entries) {
    if (entry.initialized) {
      const status = gitTry(['status', '--porcelain'], join(worktreePath, entry.path));
      if (!status.ok || status.out) return { reason: `submodule dirty/unreadable: ${entry.path}` };
    } else {
      const gitPointer = join(worktreePath, entry.path, '.git');
      if (existsSync(gitPointer) && statSync(gitPointer).isDirectory()) {
        return { reason: `submodule workdir has embedded .git directory, refusing residue cleanup: ${entry.path}` };
      }
      const empty = ensureSubmoduleWorkdirEmpty(worktreePath, entry.path);
      if (empty.reason) return empty;
    }
  }
  if (entries.some((entry) => entry.initialized)) {
    const deinit = gitTry(['submodule', 'deinit', '--all', '-f'], worktreePath);
    if (!deinit.ok) return { reason: commandFailureReason(deinit, 'git submodule deinit failed') };
  }
  if (hasModulesMetadata) {
    try {
      rmSync(modulesDir, { recursive: true, force: true });
    } catch (error) {
      return { reason: `failed to remove submodule metadata: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  for (const entry of entries) {
    const empty = ensureSubmoduleWorkdirEmpty(worktreePath, entry.path);
    if (empty.reason) return empty;
  }
  return { reason: null };
}

/** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} initialRecord @param {string} pushed @param {{recordBlocked?:boolean,evidence?:Record<string,any>}} [options] */
function reclaimRecord(loaded, initialRecord, pushed, options = {}) {
  let record = initialRecord;
  if (record.worktree_state === 'reclaimed') {
    const terminal = reconcileReclaimedTerminalState(loaded, record);
    const reconciled = reconcileReclaimedBranchCleanup(loaded, terminal.record, pushed);
    return {
      reclaimed: true,
      reason: reconciled.branch_cleanup?.status === 'failed' ? reconciled.branch_cleanup.reason : null,
      record: reconciled.record,
      branch_cleanup: reconciled.branch_cleanup,
      branch_cleanup_changed: terminal.changed || reconciled.changed,
    };
  }
  const registeredAtStart = parseWorktrees(loaded.context.current_worktree)
    .find((worktree) => worktree.path === canonicalSelectorPath(record.path));
  if (!registeredAtStart && existsSync(record.path)) {
    return {
      reclaimed: false,
      reason: 'physical directory remains without Git worktree registration; refusing to mark reclaimed before manual recovery',
      record,
    };
  }
  if (record.worktree_state !== 'reclaim_ready') {
    const preflight = reclaimPreflight(loaded, record, pushed);
    if (preflight.reason) {
      if (options.recordBlocked ?? true) {
        record = appendReclaimEvent(loaded.context.common_dir, record, 'reclaim_blocked', () => {}, { reason: preflight.reason, pushed, evidence: options.evidence ?? null });
      }
      return { reclaimed: false, reason: preflight.reason, record };
    }
    const finalHead = preflight.live?.head ?? record.last_head;
    record = appendReclaimEvent(loaded.context.common_dir, record, 'final_snapshot', (next) => {
      next.last_head = finalHead;
      next.last_seen_at = new Date().toISOString();
    }, { pushed, evidence: options.evidence ?? null });
    record = appendReclaimEvent(loaded.context.common_dir, record, 'reclaim_ready', (next) => {
      next.worktree_state = 'reclaim_ready';
    }, { pushed, evidence: options.evidence ?? null });
  }

  const live = parseWorktrees(loaded.context.current_worktree).find((worktree) => worktree.path === canonicalSelectorPath(record.path));
  if (live) {
    const submodules = reclaimSubmodules(live.path);
    if (submodules.reason) return { reclaimed: false, reason: submodules.reason, record };
    const removed = gitTry(['worktree', 'remove', live.path], loaded.context.current_worktree);
    if (!removed.ok) {
      const detail = commandFailureReason(removed, 'git worktree remove refused');
      const stillRegistered = parseWorktrees(loaded.context.current_worktree)
        .some((worktree) => worktree.path === canonicalSelectorPath(record.path));
      const residue = !stillRegistered && existsSync(record.path)
        ? '; Git registration was removed but the physical directory remains'
        : '';
      const reason = `${detail}${residue}`;
      record = appendReclaimEvent(loaded.context.common_dir, record, 'reclaim_failed', (next) => {
        next.last_reclaim_error = {
          reason,
          attempted_at: new Date().toISOString(),
          registration_present: stillRegistered,
          physical_directory_present: existsSync(record.path),
        };
      }, { pushed, evidence: options.evidence ?? null, reason, registration_present: stillRegistered, physical_directory_present: existsSync(record.path) });
      return { reclaimed: false, reason, record };
    }
    if (existsSync(record.path)) {
      return {
        reclaimed: false,
        reason: 'git worktree remove returned success but the physical directory remains',
        record,
      };
    }
  }
  gitTry(['worktree', 'prune'], loaded.context.current_worktree);
  const branchCleanup = attemptLocalBranchCleanup(loaded, record, pushed);
  record = appendReclaimEvent(loaded.context.common_dir, record, 'reclaimed', (next) => {
    const completedAt = new Date().toISOString();
    const finalEpoch = next.ownership_epochs?.at(-1);
    if (finalEpoch && !finalEpoch.ended_at) {
      finalEpoch.end_sha = next.last_head;
      finalEpoch.ended_at = completedAt;
    }
    if (next.task_status !== 'abandoned') next.task_status = 'done';
    next.worktree_state = 'reclaimed';
    next.reclaimed_at = completedAt;
    next.branch_cleanup = branchCleanup;
    next.reclaim_summary = {
      worktree_id: next.worktree_id,
      task: next.task,
      change_ref: next.auto_reclaim?.change_ref ?? null,
      source_sha: next.auto_reclaim?.head_sha ?? next.last_head ?? null,
      target_ref: options.evidence?.archive_ref ?? next.auto_reclaim?.target_ref ?? next.base_ref ?? null,
      target_sha: pushed,
      completed_at: completedAt,
      branch_cleanup: branchCleanup,
      reclaim_evidence: options.evidence ?? { kind: 'pushed', target_sha: pushed },
    };
    if (next.auto_reclaim) {
      next.auto_reclaim.state = 'reclaimed';
      next.auto_reclaim.completed_at = next.reclaimed_at;
    }
  }, { pushed, evidence: options.evidence ?? null, branch_cleanup: branchCleanup });
  if (record.auto_reclaim) {
    const notification = deliverReclaimNotification(record);
    record = appendReclaimEvent(loaded.context.common_dir, record, 'reclaim_notification', (next) => {
      next.reclaim_notification = { ...notification, recorded_at: new Date().toISOString() };
    }, notification);
  }
  return {
    reclaimed: true,
    reason: branchCleanup.status === 'failed' ? branchCleanup.reason : null,
    record,
    branch_cleanup: branchCleanup,
    branch_cleanup_changed: true,
  };
}

/** @param {string} commonDir @param {Record<string,any>} record @param {string} token @param {string} eventType @param {string} targetSha */
function appendAutoStatus(commonDir, record, token, eventType, targetSha) {
  return appendWatchedEvent(commonDir, record, token, eventType, (next) => {
    next.task_status = eventType === 'auto_integrating' ? 'integrating' : 'done';
    next.last_seen_at = new Date().toISOString();
  }, { source: 'auto_reclaim_watcher', target_sha: targetSha });
}

/**
 * @param {ReturnType<typeof loadRepositoryProfile>} loaded
 * @param {Record<string,any>} initialRecord
 * @param {{targetRef:string,headSha:string,intervalMs:number,changeRef:string|null,notifyMode:string,explicitConfig:string|null,previousHealth:string|null,armedBy?:string}} options
 */
function startWatcher(loaded, initialRecord, options) {
  let record = initialRecord;
  const reviveStaleAutoTouch = options.armedBy === 'auto_touch'
    && record.auto_reclaim?.state === 'disarmed'
    && record.auto_reclaim?.disarm_reason === 'stale_frozen_head';
  const existing = record.auto_reclaim && (
    !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state) || reviveStaleAutoTouch
  ) ? record.auto_reclaim : null;
  const token = randomUUID();
  const now = new Date().toISOString();
  const eventType = existing ? 'auto_reclaim_rearmed' : 'auto_reclaim_armed';
  const resumeAfterMerge = existing?.state === 'merge_detected';
  record = appendTraceEvent({
    commonDir: loaded.context.common_dir,
    worktreeId: record.worktree_id,
    eventType,
    actor: record.agent,
    details: {
      target_ref: options.targetRef,
      head_sha: options.headSha,
      interval_ms: options.intervalMs,
      change_ref: options.changeRef,
      notify: options.notifyMode,
      previous_health: options.previousHealth,
    },
    mutate(current) {
      if (existing) {
        const revivableCurrent = reviveStaleAutoTouch
          && current.auto_reclaim?.state === 'disarmed'
          && current.auto_reclaim?.disarm_reason === 'stale_frozen_head';
        if (
          current.auto_reclaim?.token !== existing.token
          || current.auto_reclaim?.state === 'reclaimed'
          || (current.auto_reclaim?.state === 'disarmed' && !revivableCurrent)
        ) {
          throw new WorktreeTraceError('WATCHER_CANCELLED', `watch token 已被并发更新或解除: ${record.worktree_id}`);
        }
      } else if (current.auto_reclaim && !['disarmed', 'reclaimed'].includes(current.auto_reclaim.state)) {
        throw new WorktreeTraceError('WATCHER_ALREADY_ARMED', `watcher 已被另一进程 arm: ${record.worktree_id}`);
      }
      const next = structuredClone(current);
      next.auto_reclaim = {
        ...existing,
        state: resumeAfterMerge ? 'merge_detected' : 'armed',
        // 记录武装来源：自动武装是默认动作，人工显式武装是当轮指引，二者的改目标权限不同。
        armed_by: options.armedBy ?? existing?.armed_by ?? 'explicit',
        target_ref: options.targetRef,
        head_sha: options.headSha,
        interval_ms: options.intervalMs,
        change_ref: options.changeRef,
        notify: options.notifyMode,
        token,
        armed_at: existing?.armed_at ?? now,
        rearmed_at: existing ? now : null,
        disarmed_at: null,
        disarm_reason: null,
        pid: null,
      };
      next.updated_at = now;
      return next;
    },
  }).record;

  const script = fileURLToPath(import.meta.url);
  const workerArgs = [script, 'watch-worker', '--id', record.worktree_id, '--token', token];
  if (options.explicitConfig) workerArgs.push('--config', options.explicitConfig);
  const child = spawn(process.execPath, workerArgs, {
    cwd: loaded.context.primary_worktree,
    detached: true,
    stdio: 'ignore',
  });
  if (!child.pid) throw new WorktreeTraceError('WATCHER_START_FAILED', '无法启动 auto-reclaim watcher。');
  try {
    record = appendWatchedEvent(loaded.context.common_dir, record, token, 'auto_reclaim_watcher_started', (next) => {
      next.auto_reclaim.state = resumeAfterMerge ? 'merge_detected' : 'watching';
      next.auto_reclaim.pid = child.pid;
      next.auto_reclaim.started_at = new Date().toISOString();
    }, { pid: child.pid, token });
  } catch (error) {
    try { process.kill(child.pid, 'SIGTERM'); } catch {}
    throw error;
  }
  writeWatcherHeartbeat(loaded.context.common_dir, {
    schema_version: 1,
    worktree_id: record.worktree_id,
    pid: child.pid,
    token,
    target_ref: options.targetRef,
    head_sha: options.headSha,
    state: 'starting',
    blocked_reason: null,
    started_at: record.auto_reclaim.started_at,
  });
  child.unref();
  return { record, pid: child.pid, token };
}

/** @param {string|null} configured @param {string} remote @param {string|null} baseRef */
function resolveSubmitTargetBranch(configured, remote, baseRef) {
  const candidate = configured ?? (baseRef?.startsWith(`${remote}/`) ? baseRef.slice(remote.length + 1) : null);
  if (!candidate) die('无法从 Profile change_request.target_branch 或 base_ref 推断 MR target branch。');
  return oneLine(candidate, 'target', 240);
}

function cmdSubmit(args) {
  rejectUnknownFlags(args.flags, [
    'title',
    'description',
    'target',
    'remote',
    'interval-ms',
    'notify',
    'id',
    'config',
  ]);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const provider = loaded.profile.change_request;
  if (provider.provider !== 'gitlab') {
    die('当前 Profile 未启用 GitLab change_request provider；请配置 provider=gitlab 或继续人工创建 MR。');
  }
  let record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
  if (!['active', 'ready_for_review'].includes(record.task_status)) {
    die(`submit 只接受 active/ready_for_review，当前为 ${record.task_status}。`);
  }
  if (record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)) {
    die('record 已有 watcher；更新 MR 前先确认旧冻结 SHA，必要时 unwatch 后再 submit。');
  }

  const snapshot = liveGitSnapshot(record);
  if (!snapshot.present) die('submit 要求 worktree 仍存在。');
  if (snapshot.dirty !== false) die('submit 要求工作树干净（含 untracked 必须为空）。');
  if (!record.branch || !snapshot.head) die('submit 不支持 detached HEAD，且必须能解析有效 HEAD。');
  const currentBranch = gitTry(['branch', '--show-current'], record.path);
  if (!currentBranch.ok || currentBranch.out !== record.branch) {
    die(`worktree 当前 branch 与 record 不一致: current=${currentBranch.out || '(detached)'} record=${record.branch}`);
  }
  if (!gitTry(['check-ref-format', '--branch', record.branch], record.path).ok) {
    die(`非法 source branch: ${record.branch}`);
  }

  const remote = oneLine(flag(args.flags, 'remote') ?? provider.remote, 'remote', 120);
  if (!gitTry(['remote', 'get-url', remote], record.path).ok) die(`Git remote 不存在: ${remote}`);
  const targetBranch = resolveSubmitTargetBranch(
    flag(args.flags, 'target') ?? provider.target_branch,
    remote,
    record.base_ref ?? null,
  );
  if (!gitTry(['check-ref-format', '--branch', targetBranch], record.path).ok) {
    die(`非法 target branch: ${targetBranch}`);
  }
  const targetRef = `${remote}/${targetBranch}`;
  const refreshed = refreshTargetRef(targetRef, record.path);
  if (!refreshed.ok) die(`目标 ref 不存在或 fetch 失败: ${targetRef}`);

  const upstreamHead = gitTry(['rev-parse', '@{upstream}^{commit}'], record.path);
  const remoteHead = gitTry(
    ['ls-remote', '--heads', remote, `refs/heads/${record.branch}`],
    record.path,
    { timeoutMs: FETCH_TIMEOUT_MS },
  );
  const remoteHeadSha = remoteHead.ok && remoteHead.out ? remoteHead.out.split(/\s+/)[0] : null;
  if ((upstreamHead.ok && upstreamHead.out === snapshot.head) || remoteHeadSha === snapshot.head) {
    die('当前 HEAD 已完整存在于 remote；GitLab 只在实际 push 时处理 MR push-options。请使用 API/UI 创建 MR 后运行 watch，工具不会为触发 push-option 改写历史或 force push。');
  }

  const title = flag(args.flags, 'title')
    ? oneLine(flag(args.flags, 'title'), 'title', 240)
    : oneLine(git(['show', '-s', '--format=%s', snapshot.head], record.path), 'title', 240);
  const description = flag(args.flags, 'description')
    ? oneLine(flag(args.flags, 'description'), 'description', 1000)
    : null;
  const pushArgs = gitlabSubmitPushArgs({
    remote,
    sourceBranch: record.branch,
    targetBranch,
    title,
    description,
    removeSourceBranch: provider.remove_source_branch,
  });
  const pushed = runFileCapture('git', pushArgs, { cwd: record.path, timeoutMs: SUBMIT_PUSH_TIMEOUT_MS });
  if (!pushed.ok) {
    const detail = pushed.out || pushed.error?.message || `exit=${pushed.status}`;
    die(`GitLab MR push 失败；trace/watcher 未更新。\n${detail}`);
  }

  const submittedAt = new Date().toISOString();
  const mergeRequestUrl = parseGitlabMergeRequestUrl(pushed.out);
  const changeRef = mergeRequestUrl ?? `GitLab MR ${record.branch} -> ${targetBranch}`;
  record = appendTraceEvent({
    commonDir: loaded.context.common_dir,
    worktreeId: record.worktree_id,
    eventType: 'change_submitted',
    actor: record.agent,
    details: {
      provider: 'gitlab',
      change_ref: changeRef,
      source_branch: record.branch,
      target_branch: targetBranch,
      head_sha: snapshot.head,
      title,
    },
    mutate(current) {
      if (!['active', 'ready_for_review'].includes(current.task_status)) {
        throw new WorktreeTraceError('SUBMIT_STATE_CHANGED', `submit 期间 task_status 变为 ${current.task_status}`);
      }
      const next = structuredClone(current);
      next.task_status = 'ready_for_review';
      next.last_seen_at = submittedAt;
      next.last_head = snapshot.head;
      next.change_request = {
        provider: 'gitlab',
        state: 'submitted',
        change_ref: changeRef,
        url: mergeRequestUrl,
        source_branch: record.branch,
        target_branch: targetBranch,
        head_sha: snapshot.head,
        title,
        submitted_at: submittedAt,
      };
      next.updated_at = submittedAt;
      return next;
    },
  }).record;

  const intervalMs = parseWatchInterval(flag(args.flags, 'interval-ms'));
  const notifyMode = parseNotifyMode(flag(args.flags, 'notify'));
  try {
    const started = startWatcher(loaded, record, {
      targetRef,
      headSha: snapshot.head,
      intervalMs,
      changeRef,
      notifyMode,
      explicitConfig: flag(args.flags, 'config') ? loaded.profile_path : null,
      previousHealth: null,
      armedBy: 'explicit',
    });
    log(`GitLab MR 已提交: ${changeRef}`);
    log(`auto-reclaim watcher 已启动 pid=${started.pid} id=${record.worktree_id.slice(0, 8)} head=${snapshot.head.slice(0, 12)} target=${targetRef}`);
  } catch (error) {
    console.error(`${PREFIX} MR 已成功 push 且 trace 已标记 ready_for_review，但 watcher 启动失败；请运行 watch/resume-all 恢复。`);
    throw error;
  }
}

function cmdWatch(args) {
  rejectUnknownFlags(args.flags, ['target', 'interval-ms', 'change-ref', 'notify', 'id', 'config']);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  let record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
  if (record.worktree_state === 'reclaimed') { log(`已回收，无需 watch: ${record.worktree_id}`); return; }
  const existing = record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)
    ? record.auto_reclaim
    : null;
  if (!existing && record.task_status !== 'ready_for_review') {
    die(`首次 watch 要求 task_status=ready_for_review，当前为 ${record.task_status}。`);
  }
  if (existing && !['ready_for_review', 'integrating', 'done'].includes(record.task_status)) {
    die(`恢复 watch 要求状态为 ready_for_review/integrating/done，当前为 ${record.task_status}。`);
  }

  const snapshot = liveGitSnapshot(record);
  if (!snapshot.present) die('watch 要求 worktree 仍存在。');
  if (!existing && snapshot.dirty !== false) die('首次 watch 要求工作树干净（含 untracked 必须为空）。');
  const headSha = existing?.head_sha ?? snapshot.head;
  if (!headSha || !gitTry(['cat-file', '-e', `${headSha}^{commit}`], loaded.context.current_worktree).ok) {
    die('无法冻结有效的 MR head SHA。');
  }
  if (!existing) {
    const upstream = gitTry(['rev-parse', '@{upstream}^{commit}'], record.path);
    if (!upstream.ok || upstream.out !== headSha) {
      die('watch 前必须把当前 HEAD 完整 push 到 upstream；本地 HEAD 与 upstream SHA 不一致。');
    }
  }

  const targetRef = oneLine(flag(args.flags, 'target') ?? existing?.target_ref ?? record.base_ref, 'target', 240);
  if (existing && flag(args.flags, 'target') && targetRef !== existing.target_ref) {
    // 人工显式武装过的目标不被静默改写；但 touch 的自动武装只是默认动作，
    // 调用者当轮显式给出的 target 优先，直接改指而不是要求先 unwatch。
    if (existing.armed_by !== 'auto_touch') {
      die(`已 arm 的 target=${existing.target_ref}；先 unwatch 再更换目标。`);
    }
    log(`自动武装的 target=${existing.target_ref} 按当轮显式指引改为 ${targetRef}。`);
  }
  const intervalMs = parseWatchInterval(flag(args.flags, 'interval-ms') ?? existing?.interval_ms);
  const changeRef = flag(args.flags, 'change-ref')
    ? oneLine(flag(args.flags, 'change-ref'), 'change-ref', 240)
    : existing?.change_ref ?? null;
  const notifyMode = parseNotifyMode(flag(args.flags, 'notify') ?? existing?.notify);
  const refreshed = refreshTargetRef(targetRef, loaded.context.current_worktree);
  if (!refreshed.ok) die(`目标 ref 不存在: ${targetRef}`);

  const heartbeat = readWatcherHeartbeat(loaded.context.common_dir, record.worktree_id);
  const health = watcherHealth(record, heartbeat);
  if (existing && health.healthy && existing.head_sha === headSha && existing.target_ref === targetRef && (existing.change_ref ?? null) === changeRef && (existing.notify ?? 'auto') === notifyMode) {
    log(`watcher 已运行 pid=${heartbeat.state.pid} id=${record.worktree_id.slice(0, 8)} target=${targetRef}`);
    return;
  }
  try {
    const started = startWatcher(loaded, record, {
      targetRef,
      headSha,
      intervalMs,
      changeRef,
      notifyMode,
      explicitConfig: flag(args.flags, 'config') ? loaded.profile_path : null,
      previousHealth: health.reason,
      armedBy: 'explicit',
    });
    record = started.record;
    log(`auto-reclaim watcher 已启动 pid=${started.pid} id=${record.worktree_id.slice(0, 8)} head=${headSha.slice(0, 12)} target=${targetRef}`);
  } catch (error) {
    if (error instanceof WorktreeTraceError && error.code === 'WATCHER_CANCELLED') {
      die('watcher 启动期间被另一进程解除，请重新检查 record 状态。');
    }
    throw error;
  }
}

function cmdResumeAll(args) {
  rejectUnknownFlags(args.flags, ['json', 'config']);
  if (args.positionals.length) die('resume-all 不接受 selector；它只扫描已 arm record。', 2);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const result = { resumed: [], healthy: [], skipped: [] };
  const records = loadRecords(loaded.context.common_dir).filter((record) =>
    record.auto_reclaim &&
    !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state) &&
    record.worktree_state !== 'reclaimed');
  for (const record of records) {
    const heartbeat = readWatcherHeartbeat(loaded.context.common_dir, record.worktree_id);
    const health = watcherHealth(record, heartbeat);
    if (health.healthy) {
      result.healthy.push({ worktree_id: record.worktree_id, task: record.task, pid: heartbeat.state.pid });
      continue;
    }
    const auto = record.auto_reclaim;
    const intervalMs = Number(auto.interval_ms);
    const snapshot = liveGitSnapshot(record);
    let reason = null;
    if (!['ready_for_review', 'integrating', 'done'].includes(record.task_status)) reason = `task_status=${record.task_status}`;
    else if (!snapshot.present && record.worktree_state !== 'reclaim_ready') reason = 'worktree missing';
    else if (!auto.head_sha || !gitTry(['cat-file', '-e', `${auto.head_sha}^{commit}`], loaded.context.current_worktree).ok) reason = 'frozen head unreachable';
    else if (!auto.target_ref || typeof auto.target_ref !== 'string') reason = 'target ref missing';
    else if (!Number.isInteger(intervalMs) || intervalMs < WATCH_MIN_INTERVAL_MS || intervalMs > WATCH_MAX_INTERVAL_MS) reason = 'interval invalid';
    if (reason) {
      result.skipped.push({ worktree_id: record.worktree_id, task: record.task, reason });
      continue;
    }
    try {
      const started = startWatcher(loaded, record, {
        targetRef: auto.target_ref,
        headSha: auto.head_sha,
        intervalMs,
        changeRef: auto.change_ref ?? null,
        notifyMode: auto.notify ?? 'auto',
        explicitConfig: flag(args.flags, 'config') ? loaded.profile_path : null,
        previousHealth: health.reason,
        armedBy: auto.armed_by ?? 'explicit',
      });
      result.resumed.push({ worktree_id: record.worktree_id, task: record.task, pid: started.pid, previous_health: health.reason, dirty: snapshot.dirty });
    } catch (error) {
      result.skipped.push({ worktree_id: record.worktree_id, task: record.task, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (args.flags.get('json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  log(`resume-all resumed=${result.resumed.length} healthy=${result.healthy.length} skipped=${result.skipped.length}`);
  for (const item of result.resumed) console.log(`  [RESUMED] ${item.worktree_id.slice(0, 8)} ${item.task} pid=${item.pid} previous=${item.previous_health}${item.dirty ? ' dirty=blocked-until-clean' : ''}`);
  for (const item of result.healthy) console.log(`  [HEALTHY] ${item.worktree_id.slice(0, 8)} ${item.task} pid=${item.pid}`);
  for (const item of result.skipped) console.log(`  [SKIPPED] ${item.worktree_id.slice(0, 8)} ${item.task} ${item.reason}`);
}

function cmdUnwatch(args) {
  rejectUnknownFlags(args.flags, ['id', 'config']);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  let record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
  const token = record.auto_reclaim?.token;
  if (!token || ['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)) {
    log(`watcher 未 arm: ${record.worktree_id.slice(0, 8)}`);
    return;
  }
  if (record.auto_reclaim.state === 'merge_detected') {
    die('目标分支已确认包含冻结的 MR head，自动回收已进入提交阶段，不能再 unwatch。');
  }
  record = appendReclaimEvent(loaded.context.common_dir, record, 'auto_reclaim_disarmed', (next) => {
    next.auto_reclaim.state = 'disarmed';
    next.auto_reclaim.disarmed_at = new Date().toISOString();
  });
  removeWatcherHeartbeat(loaded.context.common_dir, record.worktree_id, token);
  log(`auto-reclaim watcher 已解除: ${record.worktree_id.slice(0, 8)}`);
}

function cmdWatchWorker(args) {
  rejectUnknownFlags(args.flags, ['id', 'token', 'config']);
  const worktreeId = flag(args.flags, 'id');
  const token = flag(args.flags, 'token');
  if (!worktreeId || !token) die('watch-worker 需要 --id 与 --token。', 2);
  while (true) {
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    let record = loadRecords(loaded.context.common_dir).find((candidate) => candidate.worktree_id === worktreeId);
    if (!record || record.worktree_state === 'reclaimed' || record.auto_reclaim?.token !== token || record.auto_reclaim?.state === 'disarmed') {
      removeWatcherHeartbeat(loaded.context.common_dir, worktreeId, token);
      return;
    }
    const baseHeartbeat = {
      schema_version: 1,
      worktree_id: worktreeId,
      pid: process.pid,
      token,
      target_ref: record.auto_reclaim.target_ref,
      head_sha: record.auto_reclaim.head_sha,
      started_at: record.auto_reclaim.started_at ?? record.auto_reclaim.armed_at,
    };
    const cacheMaxAgeMs = Math.min(WATCH_TARGET_CACHE_MAX_AGE_MS, Math.max(Math.floor(record.auto_reclaim.interval_ms / 2), WATCH_MIN_INTERVAL_MS));
    const refreshed = refreshTargetRefCached(loaded.context.common_dir, record.auto_reclaim.target_ref, loaded.context.current_worktree, cacheMaxAgeMs);
    if (!refreshed.fetch_ok || !refreshed.ok) {
      writeWatcherHeartbeat(loaded.context.common_dir, { ...baseHeartbeat, state: 'waiting', blocked_reason: 'target fetch/ref unavailable', fetch_cache_hit: refreshed.cache_hit ?? false });
      sleep(record.auto_reclaim.interval_ms);
      continue;
    }
    const headMerged = gitTry(['merge-base', '--is-ancestor', record.auto_reclaim.head_sha, refreshed.target_sha], loaded.context.current_worktree).ok;
    if (!headMerged) {
      writeWatcherHeartbeat(loaded.context.common_dir, { ...baseHeartbeat, state: 'waiting', blocked_reason: null, target_sha: refreshed.target_sha, fetch_cache_hit: refreshed.cache_hit ?? false, fetch_count: refreshed.fetch_count ?? null });
      sleep(record.auto_reclaim.interval_ms);
      continue;
    }
    try {
      if (record.auto_reclaim.state !== 'merge_detected') {
        record = appendWatchedEvent(loaded.context.common_dir, record, token, 'merge_detected', (next) => {
          next.auto_reclaim.state = 'merge_detected';
          next.auto_reclaim.target_sha = refreshed.target_sha;
          next.auto_reclaim.detected_at = new Date().toISOString();
        }, { target_ref: record.auto_reclaim.target_ref, target_sha: refreshed.target_sha, head_sha: record.auto_reclaim.head_sha });
      }
      if (record.task_status === 'ready_for_review') record = appendAutoStatus(loaded.context.common_dir, record, token, 'auto_integrating', refreshed.target_sha);
      if (record.task_status === 'integrating') record = appendAutoStatus(loaded.context.common_dir, record, token, 'auto_done', refreshed.target_sha);
    } catch (error) {
      if (error instanceof WorktreeTraceError && error.code === 'WATCHER_CANCELLED') {
        removeWatcherHeartbeat(loaded.context.common_dir, worktreeId, token);
        return;
      }
      throw error;
    }
    if (record.task_status !== 'done') {
      writeWatcherHeartbeat(loaded.context.common_dir, { ...baseHeartbeat, state: 'blocked', blocked_reason: `task_status=${record.task_status}`, target_sha: refreshed.target_sha, fetch_cache_hit: refreshed.cache_hit ?? false });
      sleep(record.auto_reclaim.interval_ms);
      continue;
    }
    const preflight = reclaimPreflight(loaded, record, refreshed.target_sha);
    if (preflight.reason) {
      writeWatcherHeartbeat(loaded.context.common_dir, { ...baseHeartbeat, state: 'blocked', blocked_reason: preflight.reason, target_sha: refreshed.target_sha, fetch_cache_hit: refreshed.cache_hit ?? false });
      sleep(record.auto_reclaim.interval_ms);
      continue;
    }
    const result = reclaimRecord(loaded, record, refreshed.target_sha, { recordBlocked: false });
    if (result.reclaimed) {
      removeWatcherHeartbeat(loaded.context.common_dir, worktreeId, token);
      return;
    }
    writeWatcherHeartbeat(loaded.context.common_dir, { ...baseHeartbeat, state: 'blocked', blocked_reason: result.reason, target_sha: refreshed.target_sha, fetch_cache_hit: refreshed.cache_hit ?? false });
    sleep(record.auto_reclaim.interval_ms);
  }
}

function cmdReclaim(args) {
  rejectUnknownFlags(args.flags, ['pushed', 'superseded-by', 'replacement-id', 'discard', 'id', 'config']);
  const pushed = flag(args.flags, 'pushed');
  const supersededBy = flag(args.flags, 'superseded-by');
  const discardSha = flag(args.flags, 'discard');
  if (pushed && (supersededBy || discardSha)) {
    die('--pushed 与 --superseded-by/--discard 互斥。', 2);
  }
  if (!pushed && !supersededBy) {
    die('reclaim 需要 --pushed <sha>，或 --superseded-by <replacement-selector>。', 2);
  }
  if (discardSha && !supersededBy) die('--discard 只能与 --superseded-by 一起使用。', 2);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const records = loadRecords(loaded.context.common_dir);
  let record = selectRecord(records, args.positionals[0] ?? null, flag(args.flags, 'id'));
  let evidenceSha = pushed;
  let evidence = null;
  if (supersededBy) {
    const replacement = selectRecord(records, supersededBy, flag(args.flags, 'replacement-id'));
    const prepared = prepareSupersededReclaim(loaded, record, replacement, discardSha);
    record = prepared.record;
    evidenceSha = prepared.sourceSha;
    evidence = prepared.evidence;
  }
  const result = reclaimRecord(loaded, record, evidenceSha, { evidence });
  if (!result.reclaimed) {
    log(`KEEP ${record.path}: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  if (result.branch_cleanup?.status === 'failed') {
    log(`目录已回收 ${result.record.worktree_id.slice(0, 8)}；本地分支 ${result.record.branch} 清理待重试: ${result.branch_cleanup.reason}`);
    return;
  }
  const recovery = result.record.superseded_recovery?.mode === 'archive_ref'
    ? `，归档=${result.record.superseded_recovery.archive_ref}`
    : result.record.superseded_recovery?.mode === 'discard'
      ? '，旧 HEAD 已按精确 SHA 授权丢弃'
      : '';
  log(`已回收 ${result.record.worktree_id.slice(0, 8)} ${result.record.branch ?? '(detached)'}；branch=${result.branch_cleanup?.status ?? 'legacy'}${recovery}，审计历史保留。`);
}

function worktreeEnvelopeContext(args) {
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
  const identity = ensureRepositoryIdentity(loaded.context);
  const snapshot = liveGitSnapshot(record);
  return { loaded, record, identity, snapshot };
}

function buildBinding(record, identity, snapshot) {
  return {
    schema_version: 1,
    provider: 'manage-worktrees',
    repository_id: identity.repository_id,
    worktree_id: record.worktree_id,
    workdir: record.path,
    branch: record.branch,
    owner: { agent: record.agent.host, agent_id: record.agent.id, epoch: record.ownership_epochs?.length ?? 0 },
    base_sha: record.base_sha,
    head_sha: snapshot.head ?? record.last_head,
    task_status: record.task_status,
    worktree_state: record.worktree_state,
  };
}

function buildArtifact(record, identity, snapshot, cwd) {
  if (!snapshot.present) die('Artifact 要求 worktree 当前存在。', 2);
  if (snapshot.dirty !== false) die('Artifact 要求 worktree clean。', 2);
  if (!snapshot.head) die('Artifact 无法冻结 HEAD。', 2);
  const objectFormat = git(['rev-parse', '--show-object-format'], cwd);
  return {
    schema_version: 1,
    provider: 'manage-worktrees',
    repository_id: identity.repository_id,
    object_format: objectFormat,
    base_sha: record.base_sha,
    artifact_sha: snapshot.head,
    branch_hint: record.branch ?? undefined,
    worktree_id: record.worktree_id,
    ownership_epoch: record.ownership_epochs?.length ?? 0,
  };
}

function cmdBinding(args) {
  rejectUnknownFlags(args.flags, ['json', 'id', 'config']);
  const { record, identity, snapshot } = worktreeEnvelopeContext(args);
  console.log(JSON.stringify(buildBinding(record, identity, snapshot), null, 2));
}

function cmdArtifact(args) {
  rejectUnknownFlags(args.flags, ['json', 'id', 'config']);
  const { loaded, record, identity, snapshot } = worktreeEnvelopeContext(args);
  console.log(JSON.stringify(buildArtifact(record, identity, snapshot, loaded.context.current_worktree), null, 2));
}

export function verifyArtifactEnvelope(artifact, loaded, records = loadRecords(loaded.context.common_dir)) {
  if (!artifact || artifact.schema_version !== 1 || artifact.provider !== 'manage-worktrees') throw new Error('Artifact schema/provider 无效');
  if (typeof artifact.worktree_id !== 'string' || !artifact.worktree_id) throw new Error('Artifact worktree_id 缺失');
  if (!Number.isInteger(artifact.ownership_epoch) || artifact.ownership_epoch < 1) throw new Error('Artifact ownership_epoch 缺失或无效');
  const identity = readRepositoryIdentity(loaded.context);
  if (!identity || artifact.repository_id !== identity.repository_id) throw new Error('Artifact repository_id 不匹配');
  const objectFormat = git(['rev-parse', '--show-object-format'], loaded.context.current_worktree);
  if (artifact.object_format !== objectFormat) throw new Error('Artifact object_format 不匹配');
  const length = objectFormat === 'sha256' ? 64 : objectFormat === 'sha1' ? 40 : 0;
  for (const field of ['base_sha', 'artifact_sha']) {
    if (!new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(String(artifact[field] ?? ''))) throw new Error(`${field} 不是完整 object id`);
    if (!gitTry(['cat-file', '-e', `${artifact[field]}^{commit}`], loaded.context.current_worktree).ok) throw new Error(`${field} 不是可达 commit`);
  }
  if (!gitTry(['merge-base', '--is-ancestor', artifact.base_sha, artifact.artifact_sha], loaded.context.current_worktree).ok) throw new Error('Artifact base 不是 artifact ancestor');
  const record = records.find((candidate) => candidate.worktree_id === artifact.worktree_id);
  if (!record) throw new Error('Artifact worktree_id 不存在');
  if (record.base_sha !== artifact.base_sha) throw new Error('Artifact base_sha 与 worktree record 不匹配');
  if (artifact.ownership_epoch !== (record.ownership_epochs?.length ?? 0)) throw new Error('Artifact ownership_epoch 已 stale');
  const live = liveGitSnapshot(record);
  if (!live.present) throw new Error('Artifact worktree 已不存在');
  if (live.head !== artifact.artifact_sha) throw new Error('Artifact SHA 与 live HEAD 不一致');
  if (live.dirty !== false) throw new Error('Artifact worktree 已变脏');
  return { valid: true, repository_id: artifact.repository_id, artifact_sha: artifact.artifact_sha, object_format: artifact.object_format };
}

function cmdVerifyArtifact(args) {
  rejectUnknownFlags(args.flags, ['json', 'config']);
  const path = args.positionals[0];
  if (!path) die('verify-artifact 需要 Artifact JSON 文件。', 2);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const artifact = JSON.parse(readFileSync(resolve(path), 'utf8'));
  console.log(JSON.stringify(verifyArtifactEnvelope(artifact, loaded), null, 2));
}

function sanitizeLearningText(value) {
  return oneLine(String(value ?? '').replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]').replace(/\/(?:Users|home)\/[^\s"']+/gu, '[LOCAL_PATH]'), 'reflection text', 1000);
}

function learningRoot(commonDir) {
  return join(traceLayout(commonDir).root, 'learning');
}

function cmdIncident(args) {
  rejectUnknownFlags(args.flags, ['input', 'id', 'config']);
  const inputPath = flag(args.flags, 'input');
  if (!inputPath) die('incident 需要 --input <json>。', 2);
  const { loaded, record } = worktreeEnvelopeContext(args);
  const input = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
  if (!DIGEST_PATTERN.test(String(input.contract_digest ?? ''))) die('incident contract_digest 无效。', 2);
  if (!['contract_gap', 'skill_gap', 'verification_gap', 'tool_gap', 'environment_gap', 'false_positive', 'false_negative', 'inefficiency'].includes(input.classification)) die('incident classification 无效。', 2);
  const chain = readEventChain(loaded.context.common_dir, record.worktree_id);
  const latest = chain.at(-1);
  if (!latest) die('worktree record 没有可引用事件。', 2);
  const eventDigest = contentDigest(Buffer.from(JSON.stringify(canonicalJson(latest))));
  const reflection = {
    schema_version: 1,
    reflection_id: randomUUID(),
    trigger: input.trigger ?? 'unexpected_outcome',
    scope: { contract_digest: input.contract_digest },
    affected_skill: { name: 'manage-worktrees', version: 'unversioned', content_digest: worktreeSkillDigest() },
    classification: input.classification,
    observation: sanitizeLearningText(input.observation),
    evidence_refs: [{ type: 'event', id: `${record.worktree_id}:${latest.event_id}`, digest: eventDigest }],
    impact: input.impact ?? 'medium',
    confidence: input.confidence ?? 'high',
    recommended_disposition: input.recommended_disposition ?? 'continue',
    recorded_at: new Date().toISOString(),
  };
  reflection.reflection_digest = contentDigest(Buffer.from(JSON.stringify(canonicalJson(reflection))));
  const directory = join(learningRoot(loaded.context.common_dir), 'reflections');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${reflection.reflection_id}.json`);
  writeFileSync(path, `${JSON.stringify(reflection, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ reflection, ref: path }, null, 2));
}

function cmdProposeImprovement(args) {
  rejectUnknownFlags(args.flags, ['reflection', 'input', 'config']);
  const reflectionId = flag(args.flags, 'reflection');
  const inputPath = flag(args.flags, 'input');
  if (!reflectionId || !inputPath || !/^[0-9a-f-]{36}$/iu.test(reflectionId)) die('propose-improvement 需要 --reflection <uuid> --input <json>。', 2);
  const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
  const reflectionPath = join(learningRoot(loaded.context.common_dir), 'reflections', `${reflectionId}.json`);
  if (!existsSync(reflectionPath)) die('Reflection 不存在。', 2);
  const reflection = JSON.parse(readFileSync(reflectionPath, 'utf8'));
  const input = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
  if (!reflection.evidence_refs?.length) die('Proposal 必须来自有证据的 Reflection。', 2);
  const proposal = {
    schema_version: 1,
    proposal_id: randomUUID(),
    target_skill: { name: 'manage-worktrees', based_on_version: 'unversioned', based_on_digest: reflection.affected_skill.content_digest },
    source_reflections: [{ reflection_id: reflection.reflection_id, reflection_digest: reflection.reflection_digest }],
    problem: { type: input.problem_type ?? 'skill_gap', evidence_refs: reflection.evidence_refs },
    proposed_change: sanitizeLearningText(input.proposed_change),
    affected_scope: (input.affected_scope ?? []).map(sanitizeLearningText),
    counterexamples: (input.counterexamples ?? []).map(sanitizeLearningText),
    validation_plan: { replay_cases: input.validation_plan?.replay_cases ?? [], regression_suites: input.validation_plan?.regression_suites ?? [], independent_review: 'required', ...(input.validation_plan?.canary ? { canary: input.validation_plan.canary } : {}) },
    lifecycle: 'proposed',
  };
  proposal.proposal_digest = contentDigest(Buffer.from(JSON.stringify(canonicalJson(proposal))));
  const directory = join(learningRoot(loaded.context.common_dir), 'proposals');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${proposal.proposal_id}.json`);
  writeFileSync(path, `${JSON.stringify(proposal, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ proposal, ref: path }, null, 2));
}

function cmdCapabilities(args) {
  rejectUnknownFlags(args.flags, ['json']);
  console.log(JSON.stringify({ skill: 'manage-worktrees', runtime_version: '1.0.0', contracts: { worktree_binding: [1], artifact_ref: [1], reflection_record: [1], improvement_proposal: [1] }, features: ['git-common-dir-ledger', 'ownership-epochs', 'artifact-verification', 'incident-reflection', 'proposed-only-improvement', 'batch-integrate', 'declared-post-integrate-steps', 'auto-armed-review-watch'], content_digest: worktreeSkillDigest() }, null, 2));
}

function usage() {
  console.log(`${PREFIX} portable multi-Agent worktree manager

spawn <task> --agent <host> --agent-id <id> --purpose <text> [--owner <name>] [--base <ref> --base-reason <text>] [--root <path>] [--codegraph auto|on|off]
  同会话已有未回收树时默认拒绝；独立并行加 --parallel-reason <text>；替代加 --supersedes <selector> --replacement-reason <text>
adopt <path> --agent <host> --agent-id <id> --purpose <text> [--task <slug>] [--base <ref> --base-reason <text>]
list [--json] [--all]
plan-batch <selector> <selector> [...] [--target <ref>] [--json]
batch-integrate --plan <plan.json> | <selector> <selector> [...] --agent <host> --agent-id <id>
  [--candidate-task <slug>] [--target <ref>] [--abort-on-conflict] [--no-rerere]
  [--recompose --recompose-head <exact-current-head>] [--json]
  按冻结顺序合成精确 SHA；冲突 fail-closed 停在冲突处；不执行任何门禁命令
batch-step <candidate-selector> --step <name> --state done|skipped|failed [--note <text>] [--json]
touch <selector> [--status <status>] [--note <text>] [--id <uuid>]
  --status ready_for_review 默认自动武装 watch；退出用 --no-watch
supersede <old-selector> --by <replacement-selector> --reason <text> [--id <uuid>] [--by-id <uuid>]
handoff <selector> --to-agent <host> --to-agent-id <id> --note <text> [--id <uuid>]
audit <selector> [--json] [--id <uuid>]
doctor [--json]
rebuild [<selector>] [--id <uuid>] [--recover-lock]
watch <selector> [--target <remote/ref>] [--interval-ms <ms>] [--change-ref <text>] [--notify auto|off] [--id <uuid>]
submit <selector> [--title <text>] [--description <text>] [--target <branch>] [--remote <name>] [--interval-ms <ms>] [--notify auto|off] [--id <uuid>]
resume-all [--json]
unwatch <selector> [--id <uuid>]
reclaim <selector> --pushed <sha> [--id <uuid>]
reclaim <selector> --superseded-by <replacement-selector> [--discard <exact-old-head>] [--id <uuid>] [--replacement-id <uuid>]
binding <selector> [--id <uuid>] [--json]
artifact <selector> [--id <uuid>] [--json]
verify-artifact <artifact.json> [--json]
incident <selector> --input <json> [--id <uuid>]
propose-improvement --reflection <uuid> --input <json>
capabilities [--json]

所有命令支持 --config <path>；默认 Profile 固定从 primary worktree 读取。`);
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv[0] || ['--help', '-h', 'help'].includes(argv[0])) { usage(); process.exit(argv[0] ? 0 : 1); }
  const sub = argv[0];
  const args = parseArgs(argv.slice(1));
  const commands = {
    spawn: cmdSpawn,
    adopt: cmdAdopt,
    list: cmdList,
    'plan-batch': cmdPlanBatch,
    'batch-integrate': cmdBatchIntegrate,
    'batch-step': cmdBatchStep,
    touch: cmdTouch,
    supersede: cmdSupersede,
    handoff: cmdHandoff,
    audit: cmdAudit,
    doctor: cmdDoctor,
    rebuild: cmdRebuild,
    submit: cmdSubmit,
    watch: cmdWatch,
    'resume-all': cmdResumeAll,
    unwatch: cmdUnwatch,
    'watch-worker': cmdWatchWorker,
    reclaim: cmdReclaim,
    binding: cmdBinding,
    artifact: cmdArtifact,
    'verify-artifact': cmdVerifyArtifact,
    incident: cmdIncident,
    'propose-improvement': cmdProposeImprovement,
    capabilities: cmdCapabilities,
  };
  if (!commands[sub]) die(`未知子命令: ${sub}`, 2);
  commands[sub](args);
}

/// 本文件是否被当作 CLI 入口直接执行。
///
/// 必须按 **realpath** 比对：skill 常以软链安装（`~/.claude/skills/<name>` →
/// 团队仓真实目录）。软链下 `import.meta.url` 是 Node 解析后的真实路径，而
/// `process.argv[1]` 保留调用时的软链路径，字符串比对永不相等——main() 不跑、
/// 进程以 0 退出、**stdout/stderr 全空**，调用方只看到「命令成功但没有输出」，
/// 极难归因。realpath 两端归一后两种装法都成立。
export function isCliEntry(argv1 = process.argv[1], selfUrl = import.meta.url) {
  if (!argv1) return false;
  const self = fileURLToPath(selfUrl);
  const entry = resolve(argv1);
  if (self === entry) return true;
  try {
    return realpathSync(self) === realpathSync(entry);
  } catch {
    // 任一端不存在（罕见：入口被删/权限）——退回字符串比对结论。
    return false;
  }
}

if (isCliEntry()) {
  try {
    main();
  } catch (error) {
    if (error instanceof WorktreeProfileError || error instanceof WorktreeTraceError || error instanceof GitlabSubmitError) die(`${error.code}: ${error.message}`);
    throw error;
  }
}
