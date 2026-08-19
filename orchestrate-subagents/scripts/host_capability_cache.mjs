#!/usr/bin/env node
// @ts-check

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonStrict } from './contract-tool.mjs';
import { projectConfigDir, userConfigDir } from './resolve_model_policy.mjs';

const SCHEMA_VERSION = 1;
const MAX_JSON_BYTES = 256 * 1024;
const HOST_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const OBSERVED_KEYS = new Set(['schema_version', 'host', 'host_version', 'tools', 'capabilities', 'limits', 'unknown']);
const TOOL_KEYS = new Set(['name', 'parameters', 'returns']);
const SNAPSHOT_KEYS = new Set(['schema_version', 'host', 'host_version', 'generated_at', 'expires_at', 'capability_fingerprint', 'source', 'observed']);
const EVENT_KEYS = new Set(['schema_version', 'category', 'summary', 'confidence', 'evidence', 'portable']);
const CONFIDENCE_VALUES = new Set(['observed-once', 'reproduced', 'schema-confirmed']);
const ISO_TZ_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u;

export class CapabilityCacheError extends Error {}

function checkKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((k) => !allowed.has(k)).sort();
  if (unknown.length) {
    throw new CapabilityCacheError(`${label} has unknown keys: ${unknown.join(', ')}`);
  }
}

function assertHost(value) {
  if (typeof value !== 'string' || !HOST_PATTERN.test(value)) {
    throw new CapabilityCacheError(`host must match ${HOST_PATTERN}`);
  }
  return value;
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw new CapabilityCacheError(`${label} must be a string array`);
  }
  return Array.from(new Set(value)).sort();
}

function flatMap(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CapabilityCacheError(`${label} must be a JSON object`);
  }
  const normalized = {};
  for (const [key, item] of Object.entries(value)) {
    if (!KEY_PATTERN.test(key)) {
      throw new CapabilityCacheError(`${label} key ${JSON.stringify(key)} is invalid`);
    }
    if (Array.isArray(item)) {
      normalized[key] = stringList(item, `${label}.${key}`);
    } else if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new CapabilityCacheError(`${label}.${key} must be a finite number`);
      normalized[key] = item;
    } else if (typeof item === 'string' || typeof item === 'boolean' || item === null) {
      normalized[key] = item;
    } else {
      throw new CapabilityCacheError(`${label}.${key} must be a scalar or string array`);
    }
  }
  return normalized;
}

export function normalizeObserved(value, expectedHost) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CapabilityCacheError('observed descriptor must be a JSON object');
  }
  checkKeys(value, OBSERVED_KEYS, 'observed descriptor');
  if (value.schema_version !== SCHEMA_VERSION) {
    throw new CapabilityCacheError(`observed descriptor must declare schema_version ${SCHEMA_VERSION}`);
  }
  if (value.host !== expectedHost) {
    throw new CapabilityCacheError(`observed descriptor host must be ${JSON.stringify(expectedHost)}`);
  }
  const hostVersion = value.host_version ?? 'unknown';
  if (typeof hostVersion !== 'string' || !hostVersion) {
    throw new CapabilityCacheError('observed descriptor host_version must be a string');
  }
  const tools = value.tools;
  if (!Array.isArray(tools)) {
    throw new CapabilityCacheError('observed descriptor tools must be an array');
  }
  const normalizedTools = [];
  const names = new Set();
  for (let index = 0; index < tools.length; index += 1) {
    const raw = tools[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new CapabilityCacheError(`tools[${index}] must be a JSON object`);
    }
    checkKeys(raw, TOOL_KEYS, `tools[${index}]`);
    const name = raw.name;
    if (typeof name !== 'string' || !name || name.length > 256 || /[\x00-\x1f]/u.test(name) || names.has(name)) {
      throw new CapabilityCacheError(`tools[${index}].name must be a unique string`);
    }
    names.add(name);
    normalizedTools.push({
      name,
      parameters: stringList(raw.parameters || [], `tools[${index}].parameters`),
      returns: stringList(raw.returns || [], `tools[${index}].returns`),
    });
  }
  return {
    schema_version: SCHEMA_VERSION,
    host: expectedHost,
    host_version: hostVersion,
    tools: normalizedTools.sort((a, b) => a.name.localeCompare(b.name)),
    capabilities: flatMap(value.capabilities || {}, 'capabilities'),
    limits: flatMap(value.limits || {}, 'limits'),
    unknown: stringList(value.unknown || [], 'unknown'),
  };
}

export function capabilityFingerprint(observed) {
  const interfaceData = { tools: observed.tools };
  const payload = Buffer.from(JSON.stringify(interfaceData), 'utf8');
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export function cacheRoot(repo, scope, explicit = null) {
  if (explicit) return resolvePath(explicit);
  return scope === 'global' ? userConfigDir() : projectConfigDir(resolvePath(repo));
}

export function snapshotPath(root, host) {
  return join(root, 'capabilities', `${assertHost(host)}.json`);
}

export function observationsDir(root, host) {
  return join(root, 'observations', assertHost(host));
}

function readJsonFile(path) {
  try {
    const stats = statSync(path);
    if (stats.size > MAX_JSON_BYTES) {
      throw new CapabilityCacheError(`${path} exceeds ${MAX_JSON_BYTES} bytes`);
    }
    return parseJsonStrict(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof CapabilityCacheError) throw error;
    throw new CapabilityCacheError(`cannot read ${path}: ${error.message}`);
  }
}

export function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {}
  }
}

export function parseTime(value, label) {
  if (typeof value !== 'string' || !ISO_TZ_PATTERN.test(value)) {
    throw new CapabilityCacheError(`${label} must be a valid ISO-8601 string with timezone (e.g. 2026-08-01T12:00:00Z)`);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new CapabilityCacheError(`${label} is not valid ISO-8601`);
  }
  return new Date(timestamp);
}

export function refreshSnapshot(root, host, observedValue, ttlHours = 168, now = null) {
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 24 * 90) {
    throw new CapabilityCacheError('ttl_hours must be an integer between 1 and 2160');
  }
  const current = now || new Date();
  const observed = normalizeObserved(observedValue, assertHost(host));
  const expires = new Date(current.getTime() + ttlHours * 3600 * 1000);
  const snapshot = {
    schema_version: SCHEMA_VERSION,
    host,
    host_version: observed.host_version,
    generated_at: current.toISOString(),
    expires_at: expires.toISOString(),
    capability_fingerprint: capabilityFingerprint(observed),
    source: 'live-discovered',
    observed,
  };
  const path = snapshotPath(root, host);
  try {
    atomicWrite(path, snapshot);
  } catch (error) {
    return {
      status: 'write-blocked',
      snapshot_path: path,
      error: error.message,
      candidate_snapshot: snapshot,
    };
  }
  return { status: 'refreshed', snapshot_path: path, snapshot };
}

export function inspectSnapshot(root, host, observedValue, now = null) {
  const current = now || new Date();
  const path = snapshotPath(root, host);
  if (!existsSync(path)) {
    return {
      status: 'absent',
      snapshot_path: path,
      refresh_required: true,
      reasons: ['snapshot-file-missing'],
    };
  }
  let snapshot;
  try {
    snapshot = readJsonFile(path);
  } catch (error) {
    return {
      status: 'stale',
      snapshot_path: path,
      refresh_required: true,
      reasons: [`snapshot-unreadable: ${error.message}`],
    };
  }

  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return {
      status: 'stale',
      snapshot_path: path,
      refresh_required: true,
      reasons: ['snapshot-not-an-object'],
    };
  }
  try {
    checkKeys(snapshot, SNAPSHOT_KEYS, 'snapshot');
  } catch (error) {
    return {
      status: 'stale',
      snapshot_path: path,
      refresh_required: true,
      reasons: [error.message],
    };
  }

  const reasons = [];
  if (snapshot.schema_version !== SCHEMA_VERSION) reasons.push('schema-version-mismatch');
  if (snapshot.host !== host) reasons.push('host-mismatch');

  let expiresAt = null;
  try {
    expiresAt = parseTime(snapshot.expires_at, 'expires_at');
    if (expiresAt.getTime() <= current.getTime()) reasons.push('snapshot-expired');
  } catch (error) {
    reasons.push(error.message);
  }

  let observed = null;
  try {
    observed = normalizeObserved(snapshot.observed, host);
    if (capabilityFingerprint(observed) !== snapshot.capability_fingerprint) {
      reasons.push('capability-fingerprint-mismatch');
    }
    if (observed.host_version !== snapshot.host_version) {
      reasons.push('host-version-mismatch');
    }
  } catch (error) {
    reasons.push(`snapshot-observed-invalid: ${error.message}`);
  }

  if (observedValue !== null && observedValue !== undefined) {
    try {
      const liveObserved = normalizeObserved(observedValue, host);
      const liveFingerprint = capabilityFingerprint(liveObserved);
      if (snapshot.capability_fingerprint && snapshot.capability_fingerprint !== liveFingerprint) {
        reasons.push('live-capability-fingerprint-mismatch');
      }
      if (liveObserved.host_version !== 'unknown' && snapshot.host_version !== 'unknown' && liveObserved.host_version !== snapshot.host_version) {
        reasons.push('live-host-version-mismatch');
      }
    } catch (error) {
      reasons.push(`live-observed-invalid: ${error.message}`);
    }
  }

  if (reasons.length) {
    return {
      status: 'stale',
      snapshot_path: path,
      refresh_required: true,
      reasons,
      snapshot,
    };
  }
  return {
    status: 'fresh',
    snapshot_path: path,
    refresh_required: false,
    reasons: [],
    snapshot,
  };
}

export function recordObservation(root, host, eventValue, now = null) {
  const current = now || new Date();
  if (!eventValue || typeof eventValue !== 'object' || Array.isArray(eventValue)) {
    throw new CapabilityCacheError('observation event must be a JSON object');
  }
  checkKeys(eventValue, EVENT_KEYS, 'observation event');
  if (eventValue.schema_version !== SCHEMA_VERSION) {
    throw new CapabilityCacheError(`observation event must declare schema_version ${SCHEMA_VERSION}`);
  }
  const category = eventValue.category;
  if (typeof category !== 'string' || !KEY_PATTERN.test(category)) {
    throw new CapabilityCacheError('observation category is invalid');
  }
  const summary = eventValue.summary;
  if (typeof summary !== 'string' || !summary || summary.length > 500) {
    throw new CapabilityCacheError('observation summary must be a string up to 500 characters');
  }
  const confidence = eventValue.confidence;
  if (!CONFIDENCE_VALUES.has(confidence)) {
    throw new CapabilityCacheError(`confidence must be one of: ${Array.from(CONFIDENCE_VALUES).join(', ')}`);
  }
  const evidence = eventValue.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new CapabilityCacheError('evidence must be a JSON object');
  }
  const portable = eventValue.portable;
  if (typeof portable !== 'boolean') {
    throw new CapabilityCacheError('portable must be a boolean');
  }

  const inspection = inspectSnapshot(root, host, null, current);
  const fingerprint = inspection.snapshot ? inspection.snapshot.capability_fingerprint : null;
  const eventId = randomUUID();
  const timestamp = current.toISOString().replace(/[:.]/gu, '-');
  const filename = `${timestamp}_${category}_${eventId.slice(0, 8)}.json`;
  const dir = observationsDir(root, host);
  const path = join(dir, filename);

  const record = {
    schema_version: SCHEMA_VERSION,
    event_id: eventId,
    host: assertHost(host),
    observed_at: current.toISOString(),
    capability_fingerprint: fingerprint,
    category,
    summary,
    confidence,
    evidence: flatMap(evidence, 'evidence'),
    portable,
  };

  try {
    atomicWrite(path, record);
  } catch (error) {
    return {
      status: 'write-blocked',
      observation_path: path,
      error: error.message,
      candidate_record: record,
    };
  }
  return { status: 'recorded', observation_path: path, record };
}

export function parseCli(argv = process.argv.slice(2)) {
  if (!argv.length) {
    throw new CapabilityCacheError('missing command: status, refresh, or observe');
  }
  const command = argv[0];
  if (!['status', 'refresh', 'observe'].includes(command)) {
    throw new CapabilityCacheError('command must be status, refresh, or observe');
  }
  const options = { command, host: '', repo: '.', scope: 'global', config_dir: null, observed: null, ttl_hours: 168, event: null };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new CapabilityCacheError('缺少 --host 参数值');
      options.host = argv[++i];
    } else if (arg === '--repo') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new CapabilityCacheError('缺少 --repo 参数值');
      options.repo = argv[++i];
    } else if (arg === '--scope') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new CapabilityCacheError('缺少 --scope 参数值');
      options.scope = argv[++i];
    } else if (arg === '--config-dir') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new CapabilityCacheError('缺少 --config-dir 参数值');
      options.config_dir = argv[++i];
    } else if (arg === '--observed') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new CapabilityCacheError('缺少 --observed 参数值');
      options.observed = argv[++i];
    } else if (arg === '--ttl-hours') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new CapabilityCacheError('缺少 --ttl-hours 参数值');
      const raw = argv[++i];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || !/^-?\d+$/u.test(raw)) {
        throw new CapabilityCacheError(`--ttl-hours must be an integer, got ${JSON.stringify(raw)}`);
      }
      options.ttl_hours = parsed;
    } else if (arg === '--event') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new CapabilityCacheError('缺少 --event 参数值');
      options.event = argv[++i];
    } else {
      throw new CapabilityCacheError(`unknown option: ${arg}`);
    }
  }
  if (!options.host) throw new CapabilityCacheError('缺少 --host');
  assertHost(options.host);

  if (!['global', 'project'].includes(options.scope)) {
    throw new CapabilityCacheError(`scope must be "global" or "project", got ${JSON.stringify(options.scope)}`);
  }
  if (options.command === 'status' && !options.observed) {
    throw new CapabilityCacheError('status command requires --observed <path>');
  }
  if (options.command === 'refresh') {
    if (!options.observed) {
      throw new CapabilityCacheError('refresh command requires --observed <path>');
    }
    if (options.ttl_hours < 1 || options.ttl_hours > 2160) {
      throw new CapabilityCacheError(`--ttl-hours must be between 1 and 2160, got ${options.ttl_hours}`);
    }
  }
  if (options.command === 'observe' && !options.event) {
    throw new CapabilityCacheError('observe command requires --event <path>');
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  const root = cacheRoot(options.repo, options.scope, options.config_dir);
  let result;
  if (options.command === 'status') {
    result = inspectSnapshot(root, options.host, readJsonFile(resolvePath(options.observed)));
  } else if (options.command === 'refresh') {
    result = refreshSnapshot(root, options.host, readJsonFile(resolvePath(options.observed)), options.ttl_hours);
  } else {
    result = recordObservation(root, options.host, readJsonFile(resolvePath(options.event)));
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function entry() {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
  } catch {
    return false;
  }
}

if (entry()) {
  try {
    main();
  } catch (error) {
    if (error instanceof CapabilityCacheError) {
      process.stderr.write(`host capability cache error: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
}
