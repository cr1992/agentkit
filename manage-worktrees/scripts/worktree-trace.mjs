#!/usr/bin/env node
// @ts-check

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { ensureRepositoryIdentity, readRepositoryIdentity } from './worktree-profile.mjs';

export const TRACE_SCHEMA_VERSION = 1;
export const LOCK_STALE_AFTER_MS = 5 * 60 * 1000;
export const LOCK_WAIT_TIMEOUT_MS = 10 * 1000;
export const LOCK_RETRY_MS = 10;
const MALFORMED_LOCK_GRACE_MS = 250;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

export class WorktreeTraceError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'WorktreeTraceError';
    this.code = code;
  }
}

/** @param {string} commonDir */
export function traceLayout(commonDir) {
  const root = join(commonDir, 'worktree-trace', 'v1');
  return {
    root,
    records: join(root, 'records'),
    events: join(root, 'events'),
    locks: join(root, 'locks'),
    repository: join(root, 'repository.json'),
  };
}

/** @param {{common_dir:string}} context */
export function initializeTraceStore(context) {
  const repository = ensureRepositoryIdentity(context);
  const layout = traceLayout(context.common_dir);
  mkdirSync(layout.records, { recursive: true });
  mkdirSync(layout.events, { recursive: true });
  mkdirSync(layout.locks, { recursive: true });
  return { layout, repository };
}

/** @param {number} milliseconds */
function sleep(milliseconds) {
  Atomics.wait(SLEEP_CELL, 0, 0, milliseconds);
}

/** @param {number} pid */
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'EPERM';
  }
}

/** @param {string} commonDir @param {string} worktreeId */
export function inspectRecordLock(commonDir, worktreeId) {
  const lockDir = join(traceLayout(commonDir).locks, `${worktreeId}.lock`);
  if (!existsSync(lockDir)) return { state: 'absent', lock_dir: lockDir };
  let ageMs = Number.POSITIVE_INFINITY;
  try {
    ageMs = Math.max(0, Date.now() - statSync(lockDir).mtimeMs);
  } catch {
    return { state: 'raced', lock_dir: lockDir };
  }
  const ownerPath = join(lockDir, 'owner.json');
  if (!existsSync(ownerPath)) return { state: 'malformed', lock_dir: lockDir, age_ms: ageMs };
  try {
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    if (
      !owner ||
      typeof owner !== 'object' ||
      !Number.isInteger(owner.pid) ||
      typeof owner.hostname !== 'string' ||
      typeof owner.created_at !== 'string' ||
      typeof owner.token !== 'string'
    ) {
      return { state: 'malformed', lock_dir: lockDir, age_ms: ageMs, owner };
    }
    const sameHost = owner.hostname === hostname();
    const alive = sameHost ? processIsAlive(owner.pid) : null;
    const stale = sameHost ? !alive : ageMs > LOCK_STALE_AFTER_MS;
    return {
      state: stale ? 'stale' : 'held',
      lock_dir: lockDir,
      age_ms: ageMs,
      owner,
      same_host: sameHost,
      pid_alive: alive,
    };
  } catch {
    return { state: 'malformed', lock_dir: lockDir, age_ms: ageMs };
  }
}

/**
 * @param {string} commonDir
 * @param {string} worktreeId
 * @param {{waitTimeoutMs?:number, command?:string}} [options]
 */
function acquireRecordLock(commonDir, worktreeId, options = {}) {
  const layout = traceLayout(commonDir);
  mkdirSync(layout.locks, { recursive: true });
  const lockDir = join(layout.locks, `${worktreeId}.lock`);
  const startedAt = Date.now();
  const waitTimeoutMs = options.waitTimeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
  let recoveredOwner = null;

  for (;;) {
    const token = randomUUID();
    try {
      mkdirSync(lockDir);
      const owner = {
        pid: process.pid,
        hostname: hostname(),
        created_at: new Date().toISOString(),
        command: options.command ?? process.argv.join(' '),
        token,
      };
      writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      return { lock_dir: lockDir, owner, recovered_owner: recoveredOwner };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (code !== 'EEXIST') {
        if (existsSync(lockDir) && !existsSync(join(lockDir, 'owner.json'))) {
          // mkdir 成功、owner 写入失败：由显式 recover 处理，避免误删未知锁。
        }
        throw new WorktreeTraceError('LOCK_ACQUIRE_FAILED', `无法创建 record lock ${lockDir}: ${String(error)}`);
      }
    }

    const finding = inspectRecordLock(commonDir, worktreeId);
    if (finding.state === 'stale') {
      const quarantine = `${lockDir}.stale.${randomUUID()}`;
      try {
        renameSync(lockDir, quarantine);
        recoveredOwner = finding.owner ?? null;
        rmSync(quarantine, { recursive: true, force: true });
        continue;
      } catch {
        // 另一进程可能先完成接管，重新观察。
      }
    } else if (finding.state === 'malformed' && (finding.age_ms ?? 0) > MALFORMED_LOCK_GRACE_MS) {
      throw new WorktreeTraceError(
        'LOCK_MALFORMED',
        `record lock 缺少有效 owner.json: ${lockDir}；请 doctor 后显式 recover。`,
      );
    }

    if (Date.now() - startedAt >= waitTimeoutMs) {
      throw new WorktreeTraceError('LOCK_BUSY', `record lock 等待超时: ${lockDir}`);
    }
    sleep(LOCK_RETRY_MS);
  }
}

/** @param {{lock_dir:string, owner:{token:string}}} lock */
function releaseRecordLock(lock) {
  const ownerPath = join(lock.lock_dir, 'owner.json');
  try {
    const current = JSON.parse(readFileSync(ownerPath, 'utf8'));
    if (current.token !== lock.owner.token) {
      throw new WorktreeTraceError('LOCK_OWNERSHIP_LOST', `record lock token 已变化: ${lock.lock_dir}`);
    }
    rmSync(lock.lock_dir, { recursive: true });
  } catch (error) {
    if (error instanceof WorktreeTraceError) throw error;
    if (existsSync(lock.lock_dir)) {
      throw new WorktreeTraceError('LOCK_RELEASE_FAILED', `无法释放 record lock: ${lock.lock_dir}`);
    }
  }
}

/** @param {string} commonDir @param {string} worktreeId @param {{forceMalformed?:boolean}} [options] */
export function recoverRecordLock(commonDir, worktreeId, options = {}) {
  const finding = inspectRecordLock(commonDir, worktreeId);
  if (finding.state === 'absent' || finding.state === 'raced') return finding;
  if (finding.state === 'held') {
    throw new WorktreeTraceError('LOCK_STILL_HELD', `lock 仍由存活进程持有: ${finding.lock_dir}`);
  }
  if (finding.state === 'malformed' && !options.forceMalformed) {
    throw new WorktreeTraceError('LOCK_MALFORMED', 'malformed lock 需要显式 forceMalformed。');
  }
  const quarantine = `${finding.lock_dir}.recovered.${randomUUID()}`;
  renameSync(finding.lock_dir, quarantine);
  rmSync(quarantine, { recursive: true, force: true });
  return { ...finding, recovered: true };
}

/** @param {string} commonDir @param {string} worktreeId */
function eventDirectory(commonDir, worktreeId) {
  return join(traceLayout(commonDir).events, worktreeId);
}

/** @param {unknown} event @param {string} source */
function validateEvent(event, source) {
  if (
    !event ||
    typeof event !== 'object' ||
    event.schema_version !== TRACE_SCHEMA_VERSION ||
    typeof event.event_id !== 'string' ||
    typeof event.worktree_id !== 'string' ||
    typeof event.event_type !== 'string' ||
    typeof event.occurred_at !== 'string' ||
    !(event.previous_event_id === null || typeof event.previous_event_id === 'string')
  ) {
    throw new WorktreeTraceError('EVENT_INVALID', `event 格式无效: ${source}`);
  }
  return event;
}

/** @param {string} commonDir @param {string} worktreeId */
export function readEventChain(commonDir, worktreeId) {
  const dir = eventDirectory(commonDir, worktreeId);
  if (!existsSync(dir)) return [];
  const events = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new WorktreeTraceError('EVENT_INVALID', `event JSON 损坏: ${path}`);
    }
    const event = validateEvent(parsed, path);
    if (event.worktree_id !== worktreeId) {
      throw new WorktreeTraceError('EVENT_WRONG_RECORD', `event worktree_id 与目录不符: ${path}`);
    }
    events.push(event);
  }
  if (events.length === 0) return [];

  const byPrevious = new Map();
  for (const event of events) {
    const previous = event.previous_event_id ?? '__GENESIS__';
    const followers = byPrevious.get(previous) ?? [];
    followers.push(event);
    byPrevious.set(previous, followers);
  }
  const genesis = byPrevious.get('__GENESIS__') ?? [];
  if (genesis.length !== 1) {
    throw new WorktreeTraceError('EVENT_CHAIN_FORKED', `event chain genesis 数量=${genesis.length}，应为 1。`);
  }

  const chain = [];
  const visited = new Set();
  let current = genesis[0];
  for (;;) {
    if (visited.has(current.event_id)) {
      throw new WorktreeTraceError('EVENT_CHAIN_CYCLE', `event chain 出现环: ${current.event_id}`);
    }
    visited.add(current.event_id);
    chain.push(current);
    const followers = byPrevious.get(current.event_id) ?? [];
    if (followers.length > 1) {
      throw new WorktreeTraceError('EVENT_CHAIN_FORKED', `event ${current.event_id} 有多个后继。`);
    }
    if (followers.length === 0) break;
    current = followers[0];
  }
  if (chain.length !== events.length) {
    throw new WorktreeTraceError('EVENT_CHAIN_DISCONNECTED', '存在不属于权威 chain 的 event。');
  }
  return chain;
}

/** @param {string} commonDir @param {string} worktreeId */
export function readRecordCache(commonDir, worktreeId) {
  const path = join(traceLayout(commonDir).records, `${worktreeId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new WorktreeTraceError('RECORD_CACHE_INVALID', `record cache 损坏: ${path}`);
  }
}

/** @param {string} commonDir */
export function listRecordCacheEntries(commonDir) {
  const recordsDir = traceLayout(commonDir).records;
  if (!existsSync(recordsDir)) return [];
  return readdirSync(recordsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const path = join(recordsDir, name);
      try {
        return { path, record: JSON.parse(readFileSync(path, 'utf8')), error: null };
      } catch (error) {
        return {
          path,
          record: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
}

/** @param {string} commonDir @param {string} worktreeId @param {unknown} snapshot @param {unknown} tail @param {number} count */
function writeRecordCache(commonDir, worktreeId, snapshot, tail, count) {
  const layout = traceLayout(commonDir);
  mkdirSync(layout.records, { recursive: true });
  const target = join(layout.records, `${worktreeId}.json`);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const cache = {
    ...structuredClone(snapshot),
    last_event_id: tail.event_id,
    event_count: count,
    materialized_at: new Date().toISOString(),
  };
  writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    renameSync(temp, target);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return cache;
}

/**
 * @param {string} commonDir
 * @param {string} repositoryId
 * @param {string} worktreeId
 * @param {string} eventType
 * @param {{host:string,id:string}|null} actor
 * @param {unknown} snapshot
 * @param {Record<string, unknown>} details
 * @param {string|null} previousEventId
 */
function appendEventFile(
  commonDir,
  repositoryId,
  worktreeId,
  eventType,
  actor,
  snapshot,
  details,
  previousEventId,
) {
  const dir = eventDirectory(commonDir, worktreeId);
  mkdirSync(dir, { recursive: true });
  const eventId = randomUUID();
  const occurredAt = new Date().toISOString();
  const event = {
    schema_version: TRACE_SCHEMA_VERSION,
    repository_id: repositoryId,
    event_id: eventId,
    worktree_id: worktreeId,
    event_type: eventType,
    occurred_at: occurredAt,
    previous_event_id: previousEventId,
    actor: actor ? structuredClone(actor) : null,
    details: structuredClone(details),
    snapshot: snapshot === null ? null : structuredClone(snapshot),
  };
  const filename = `${occurredAt.replaceAll(':', '-')}-${eventId}.json`;
  writeFileSync(join(dir, filename), `${JSON.stringify(event, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return event;
}

/**
 * @param {{
 *   commonDir:string,
 *   worktreeId:string,
 *   eventType:string,
 *   actor?:{host:string,id:string}|null,
 *   details?:Record<string, unknown>,
 *   mutate:(current:Record<string, unknown>|null)=>Record<string, unknown>,
 *   waitTimeoutMs?:number,
 * }} options
 */
export function appendTraceEvent(options) {
  if (!/^[0-9a-f-]{36}$/i.test(options.worktreeId)) {
    throw new WorktreeTraceError('WORKTREE_ID_INVALID', `worktreeId 不是 UUID: ${options.worktreeId}`);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(options.eventType)) {
    throw new WorktreeTraceError('EVENT_TYPE_INVALID', `eventType 非法: ${options.eventType}`);
  }
  if (
    options.actor &&
    (typeof options.actor.host !== 'string' ||
      options.actor.host.trim() === '' ||
      typeof options.actor.id !== 'string' ||
      options.actor.id.trim() === '')
  ) {
    throw new WorktreeTraceError('ACTOR_INVALID', 'actor.host / actor.id 必须是非空字符串。');
  }

  const repository = readRepositoryIdentity({ common_dir: options.commonDir });
  if (!repository) {
    throw new WorktreeTraceError('TRACE_STORE_UNINITIALIZED', 'trace store 尚未初始化。');
  }
  const lock = acquireRecordLock(options.commonDir, options.worktreeId, {
    waitTimeoutMs: options.waitTimeoutMs,
    command: `append:${options.eventType}`,
  });
  try {
    let chain = readEventChain(options.commonDir, options.worktreeId);
    let tail = chain.at(-1) ?? null;
    const current = tail?.snapshot ? structuredClone(tail.snapshot) : null;

    if (lock.recovered_owner) {
      tail = appendEventFile(
        options.commonDir,
        repository.repository_id,
        options.worktreeId,
        'stale_lock_recovered',
        options.actor ?? null,
        current,
        { recovered_owner: lock.recovered_owner },
        tail?.event_id ?? null,
      );
      chain = [...chain, tail];
    }

    const next = options.mutate(current);
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new WorktreeTraceError('SNAPSHOT_INVALID', 'mutate 必须返回 record snapshot object。');
    }
    if (next.worktree_id !== options.worktreeId) {
      throw new WorktreeTraceError('SNAPSHOT_INVALID', 'snapshot.worktree_id 必须等于目标 UUID。');
    }
    const event = appendEventFile(
      options.commonDir,
      repository.repository_id,
      options.worktreeId,
      options.eventType,
      options.actor ?? null,
      next,
      options.details ?? {},
      tail?.event_id ?? null,
    );
    const cache = writeRecordCache(options.commonDir, options.worktreeId, next, event, chain.length + 1);
    return { event, record: cache };
  } finally {
    releaseRecordLock(lock);
  }
}

/** @param {string} commonDir @param {string} worktreeId */
export function rebuildRecordCache(commonDir, worktreeId) {
  const lock = acquireRecordLock(commonDir, worktreeId, { command: 'rebuild' });
  try {
    const chain = readEventChain(commonDir, worktreeId);
    const tail = chain.at(-1);
    if (!tail || !tail.snapshot) {
      throw new WorktreeTraceError('REBUILD_NO_SNAPSHOT', `record ${worktreeId} 没有可物化 snapshot。`);
    }
    return writeRecordCache(commonDir, worktreeId, tail.snapshot, tail, chain.length);
  } finally {
    releaseRecordLock(lock);
  }
}
