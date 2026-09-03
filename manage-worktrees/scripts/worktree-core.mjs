// @ts-check

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFileCapture, runFileTry } from './worktree-process.mjs';
import {
  PROFILE_FILENAME,
  loadRepositoryProfile,
} from './worktree-profile.mjs';
import {
  appendTraceEvent,
  listRecordCacheEntries,
  traceLayout,
} from './worktree-trace.mjs';

export { runFileCapture, runFileTry } from './worktree-process.mjs';

export const PREFIX = '[worktree-mgr]';
export const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const FETCH_TIMEOUT_MS = 10_000;
export const SUBMIT_PUSH_TIMEOUT_MS = 60_000;
export const CODEGRAPH_TIMEOUT_MS = 10 * 60_000;
export const WATCH_DEFAULT_INTERVAL_MS = 30_000;
export const WATCH_MIN_INTERVAL_MS = 100;
export const WATCH_MAX_INTERVAL_MS = 60 * 60_000;
export const WATCH_HEARTBEAT_MIN_STALE_MS = 5_000;
export const WATCH_TARGET_CACHE_MAX_AGE_MS = 15_000;
export const WATCH_TARGET_LEASE_STALE_MS = FETCH_TIMEOUT_MS * 2;
export const WATCH_SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
export const TERMINAL_TASK_STATES = new Set(['done', 'abandoned']);
export const TASK_TRANSITIONS = {
  active: new Set(['active', 'blocked', 'ready_for_review', 'abandoned']),
  blocked: new Set(['blocked', 'active', 'abandoned']),
  ready_for_review: new Set(['ready_for_review', 'integrating', 'active', 'abandoned']),
  integrating: new Set(['integrating', 'done', 'active', 'abandoned']),
  done: new Set(['done']),
  abandoned: new Set(['abandoned']),
};

/** @param {string[]} args @param {string} [cwd] */
export function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/** @param {string[]} args @param {string} [cwd] @param {{timeoutMs?:number,stdio?:any,env?:NodeJS.ProcessEnv}} [options] */
export function gitTry(args, cwd = process.cwd(), options = {}) {
  return runFileTry('git', args, { cwd, ...options });
}

/** @param {string|Buffer} value */
export function contentDigest(value) {
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
export function commandFailureReason(result, fallback) {
  const error = result.error;
  if (error && typeof error === 'object' && 'stderr' in error) {
    const stderr = String(error.stderr ?? '').trim();
    if (stderr) return stderr.slice(0, 500);
  }
  if (error instanceof Error && error.message) return error.message.slice(0, 500);
  return fallback;
}

/** @param {unknown} error */
export function isRootWriteDenied(error) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['EACCES', 'EPERM', 'EROFS'].includes(String(error.code)),
  );
}

/** @param {number} milliseconds */
export function sleep(milliseconds) {
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
export function watcherDirectory(commonDir) {
  return join(traceLayout(commonDir).root, 'watchers');
}

/** @param {string} commonDir @param {string} worktreeId */
export function watcherPath(commonDir, worktreeId) {
  return join(watcherDirectory(commonDir), `${worktreeId}.json`);
}

/** @param {string} commonDir @param {string} worktreeId */
export function readWatcherHeartbeat(commonDir, worktreeId) {
  const path = watcherPath(commonDir, worktreeId);
  if (!existsSync(path)) return { ok: false, state: null, error: 'missing' };
  try {
    return { ok: true, state: JSON.parse(readFileSync(path, 'utf8')), error: null };
  } catch (error) {
    return { ok: false, state: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** @param {string} commonDir @param {Record<string,unknown>} state */
export function writeWatcherHeartbeat(commonDir, state) {
  const directory = watcherDirectory(commonDir);
  mkdirSync(directory, { recursive: true });
  const path = watcherPath(commonDir, String(state.worktree_id));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...state, heartbeat_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** @param {string} commonDir @param {string} worktreeId @param {string} token */
export function removeWatcherHeartbeat(commonDir, worktreeId, token) {
  const current = readWatcherHeartbeat(commonDir, worktreeId);
  if (current.ok && current.state?.token !== token) return;
  rmSync(watcherPath(commonDir, worktreeId), { force: true });
}

/** @param {unknown} raw */
export function parseWatchInterval(raw) {
  const value = raw === null || raw === undefined ? WATCH_DEFAULT_INTERVAL_MS : Number(raw);
  if (!Number.isInteger(value) || value < WATCH_MIN_INTERVAL_MS || value > WATCH_MAX_INTERVAL_MS) {
    die(`--interval-ms 必须是 ${WATCH_MIN_INTERVAL_MS}-${WATCH_MAX_INTERVAL_MS} 的整数。`, 2);
  }
  return value;
}

/** @param {Record<string,any>} record @param {{ok:boolean,state:any,error:string|null}} heartbeat */
export function watcherHealth(record, heartbeat) {
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
export function refreshTargetRef(targetRef, cwd) {
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
export function targetCacheDirectory(commonDir) {
  return join(traceLayout(commonDir).root, 'watch-targets');
}

/** @param {string} targetRef */
export function targetCacheKey(targetRef) {
  return createHash('sha256').update(targetRef).digest('hex');
}

/** @param {string} commonDir @param {string} targetRef */
export function readTargetCache(commonDir, targetRef) {
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
export function freshTargetCache(state, maxAgeMs) {
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
export function parseNotifyMode(raw) {
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

export function log(message) {
  console.log(`${PREFIX} ${message}`);
}

export function die(message, code = 1) {
  console.error(`${PREFIX} ${message}`);
  process.exit(code);
}

/**
 * 读取并解析用户提供的 JSON 文件。读取/解析失败都按用法错误 fail-closed（exit 2）并给出
 * 可诊断信息，而不是让原始异常堆栈冒出——那看起来像内部崩溃，exit code 语义也是错的。
 * @param {string} path @param {string} label
 */
export function readJsonFileOrDie(path, label) {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    die(`${label} 读取失败: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    die(`${label} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const flags = new Map();
  const positionals = [];
  const booleanFlags = new Set(['json', 'all', 'present', 'archived', 'verbose', 'recover-lock', 'no-watch', 'abort-on-conflict', 'no-rerere', 'recompose', 'scan-conflicts', 'abort', 'continue', 'pause-before-push']);
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
export function flag(flags, name) {
  const value = flags.get(name);
  return typeof value === 'string' ? value : null;
}

/** @param {Map<string, unknown>} flags @param {string[]} allowed */
export function rejectUnknownFlags(flags, allowed) {
  const allow = new Set(allowed);
  for (const key of flags.keys()) if (!allow.has(key)) die(`未知 flag: --${key}`, 2);
}

/** @param {string} value @param {string} label @param {number} max */
export function oneLine(value, label, max) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f\r\n]/.test(normalized)) {
    die(`${label} 必须是 1-${max} 字符的单行文本。`, 2);
  }
  return normalized;
}

/** @param {string} value @param {string} label */
export function httpUrl(value, label) {
  const normalized = oneLine(value, label, 1000);
  let parsed;
  try { parsed = new URL(normalized); } catch { die(`${label} 必须是合法 http(s) URL。`, 2); }
  if (!['http:', 'https:'].includes(parsed.protocol)) die(`${label} 只接受 http(s) URL。`, 2);
  return normalized;
}

/** 同义 flag 只允许给出一个值，避免调用者以为其中一个被忽略。 */
export function aliasedFlag(flags, primary, alias) {
  const left = flag(flags, primary);
  const right = flag(flags, alias);
  if (left && right && left !== right) die(`--${primary} 与 --${alias} 指向不同值，拒绝歧义。`, 2);
  return left ?? right;
}

/** @param {Map<string, unknown>} flags @param {{target?:boolean, requirePurpose?:boolean}} [options] */
export function resolveIdentity(flags, options = {}) {
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

export function printIdentity(identity, task, profile) {
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
export function requireFreshPrimaryProfile(loaded) {
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
export function resolveBaseOverrideReason(flags, defaultBase, baseRef, baseSource) {
  if (baseSource !== 'cli' || !defaultBase || baseRef === defaultBase) return null;
  const raw = flag(flags, 'base-reason');
  if (!raw) {
    die(`--base ${baseRef} 偏离 Profile default_base=${defaultBase}；必须同时提供 --base-reason <原因>。`, 2);
  }
  return oneLine(raw, 'base-reason', 240);
}

/** @returns {{path:string,branch:string|null,head:string|null,bare:boolean,detached:boolean}[]} */
export function parseWorktrees(cwd = process.cwd()) {
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
export function loadRecords(commonDir) {
  return listRecordCacheEntries(commonDir)
    .filter((entry) => entry.record)
    .map((entry) => entry.record);
}

/** worktree_state 值本身没有独立的终态集合导出，这里内联判断，避免和
 * TERMINAL_TASK_STATES（task_status 维度）混淆。archived 与 reclaimed 一样代表
 * "已经不需要再当作在办 worktree 处理"的记录，只是 archived 不删除任何 Git 对象。
 * @param {string} worktreeState */
export function isSettledWorktreeState(worktreeState) {
  return worktreeState === 'reclaimed' || worktreeState === 'archived';
}

/** @param {Record<string, any>} record */
export function isActiveRecord(record) {
  return !TERMINAL_TASK_STATES.has(record.task_status) && !isSettledWorktreeState(record.worktree_state);
}

/**
 * 同一宿主会话默认只延续一条交付链。task 名不是交付身份：如果仅因刷新 base、
 * 整理提交或继续验收而换名，必须继续使用已有 worktree。确需并存/替代时由 CLI
 * 显式留下关系和原因，不能靠新 task slug 绕过复用。
 * @param {Record<string, any>[]} records
 * @param {{host:string,id:string}} actor
 * @param {string} task
 */
export function coexistingSessionRecords(records, actor, task) {
  return records.filter((record) =>
    !isSettledWorktreeState(record.worktree_state) &&
    record.task !== task &&
    record.agent?.host === actor.host &&
    record.agent?.id === actor.id);
}

/**
 * @param {Map<string, unknown>} flags
 * @param {Record<string, any>[]} records
 * @param {Record<string, any>[]} coexisting
 */
export function resolveDeliveryRelation(flags, records, coexisting) {
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
export function sameAgentSession(left, right) {
  return left.agent?.host === right.agent?.host && left.agent?.id === right.agent?.id;
}

/**
 * 校验一对 record 确实能形成“旧树被新树替代”的交付关系。
 * 这既供 spawn 后的补登记使用，也供 superseded reclaim 做强前置校验。
 * @param {Record<string,any>} superseded
 * @param {Record<string,any>} replacement
 */
export function validateSupersessionPair(superseded, replacement) {
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

export function canonicalSelectorPath(value) {
  try {
    return existsSync(value) ? realpathSync(value) : resolve(value);
  } catch {
    return resolve(value);
  }
}

/** @param {Record<string, any>[]} records @param {string|null} selector @param {string|null} explicitId */
export function selectRecord(records, selector, explicitId) {
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
export function liveGitSnapshot(record) {
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
export function updateRecord(record, eventType, update, details = {}, commonDir = null) {
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

/**
 * 交互终端保留 CodeGraph 自己的进度展示；Agent/CI 等非 TTY 调用只捕获输出，
 * 成功时由 manager 给一行摘要，失败时也只回显有界错误，避免 ANSI 进度条污染工具输出。
 * @param {boolean} [interactive]
 */
export function codegraphStdio(interactive = Boolean(process.stdout.isTTY && process.stderr.isTTY)) {
  return interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'];
}

/** @param {string} worktreePath @param {string} primaryWorktree @param {string} mode */
export function ensureWorktreeCodegraph(worktreePath, primaryWorktree, mode) {
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
    stdio: codegraphStdio(),
    env: process.stdout.isTTY && process.stderr.isTTY
      ? process.env
      : { ...process.env, CI: process.env.CI ?? '1', NO_COLOR: process.env.NO_COLOR ?? '1', TERM: 'dumb' },
  });
  if (!indexed.ok) {
    if (mode === 'on') die('CodeGraph 独立索引初始化失败（--codegraph on 为强制模式）。');
    log('警告: CodeGraph 独立索引初始化失败；worktree 已保留，可稍后手工重试。');
    return;
  }
  log(`CodeGraph: 独立索引就绪 ${database}`);
}


export function assertHistoryOperationIdle(record, command) {
  if (record.history_operation) {
    die(
      `${command} 被未完成的 ${record.history_operation.kind ?? 'history'} 操作阻塞` +
      `（token=${record.history_operation.token ?? 'unknown'}, state=${record.history_operation.state ?? 'unknown'}）。` +
      '先重跑 rebase 完成恢复，或使用 rebase --abort。',
      2,
    );
  }
  if (record.review_refresh) {
    die(
      `${command} 被未完成的 review refresh 阻塞（state=${record.review_refresh.state ?? 'unknown'}）。` +
      `运行 refresh-review ${record.task} --continue 恢复，或用 --abort 放弃冲突/暂停在 push 前的刷新。`,
      2,
    );
  }
}

/** Recursively sort object keys before hashing or serializing contracts. */
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
export function normalizedProfileContent(content) {
  try {
    return JSON.stringify(canonicalJson(JSON.parse(content)));
  } catch {
    return content.trim();
  }
}

/** @param {string} cwd @param {string} value @param {string} label */
export function exactCommitOid(cwd, value, label) {
  const normalized = oneLine(value, label, 128).toLowerCase();
  const resolved = gitTry(['rev-parse', '--verify', `${normalized}^{commit}`], cwd);
  if (!resolved.ok || resolved.out.toLowerCase() !== normalized) {
    die(`${label} 必须是当前仓库可解析的完整 commit object ID。`, 2);
  }
  return resolved.out.toLowerCase();
}

/**
 * 面向纯证据输入的 commit 缩写解析：只接受十六进制 object-id/唯一前缀，立即展开为完整 OID。
 * Artifact、discard 等 CAS 边界继续使用 exactCommitOid，不共享这条人体工学放宽。
 * @param {string} cwd @param {string} value @param {string} label
 */
export function resolvableCommitOid(cwd, value, label) {
  const normalized = oneLine(value, label, 128).toLowerCase();
  if (!/^[0-9a-f]{4,64}$/u.test(normalized)) {
    die(`${label} 必须是十六进制 commit object ID 或唯一短前缀。`, 2);
  }
  const resolved = gitTry(['rev-parse', '--verify', `${normalized}^{commit}`], cwd);
  if (!resolved.ok) die(`${label} 不是当前仓库可唯一解析的 commit object ID。`, 2);
  return resolved.out.toLowerCase();
}

/** @param {string} cwd */
export function gitOperationState(cwd) {
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
export function isAncestor(cwd, ancestor, descendant) {
  return gitTry(['merge-base', '--is-ancestor', ancestor, descendant], cwd).ok;
}

/** @param {ReturnType<typeof loadRepositoryProfile>} loaded */
export function primaryProfileDriftFinding(loaded) {
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
