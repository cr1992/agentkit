#!/usr/bin/env node
// @ts-check

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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

export class CapabilityCacheError extends Error {}

function checkKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((k) => !allowed.has(k)).sort();
  if (unknown.length) {
    throw new CapabilityCacheError(`${label} has unknown keys: ${unknown.join(', ')}`);
  }
}

function assertHost(value) {
  if (!HOST_PATTERN.test(value)) {
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

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    const { renameSync } = require('node:fs');
    renameSync(temp, path);
  } catch {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    try { unlinkSync(temp); } catch {}
  }
}

function parseTime(value, label) {
  if (typeof value !== 'string') {
    throw new CapabilityCacheError(`${label} must be an ISO-8601 string`);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new CapabilityCacheError(`${label} is not valid ISO-8601`);
  }
  return new Date(timestamp);
}

export function refreshSnapshot(root, host, observedValue, ttlHours = 168, now = null) {
  if (ttlHours < 1 || ttlHours > 24 * 90) {
    throw new CapabilityCacheError('ttl_hours must be between 1 and 2160');
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
    source: 'live-tool-schema',
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
  const observed = normalizeObserved(observedValue, assertHost(host));
  const path = snapshotPath(root, host);
  const base = {
    snapshot_path: path,
    observations_path: observationsDir(root, host),
    current_fingerprint: capabilityFingerprint(observed),
  };
  if (!existsSync(path)) {
    return { ...base, status: 'absent', refresh_required: true, reasons: ['snapshot-missing'] };
  }
  const current = now || new Date();
  let snapshot;
  try {
    snapshot = readJsonFile(path);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new CapabilityCacheError('snapshot must be a JSON object');
    }
    checkKeys(snapshot, SNAPSHOT_KEYS, 'snapshot');
    if (snapshot.schema_version !== SCHEMA_VERSION) {
      throw new CapabilityCacheError('snapshot schema_version is unsupported');
    }
    if (snapshot.host !== host) {
      throw new CapabilityCacheError('snapshot host does not match');
    }
    const cachedObserved = normalizeObserved(snapshot.observed, host);
    if (snapshot.host_version !== cachedObserved.host_version) {
      throw new CapabilityCacheError('snapshot host_version does not match its observed descriptor');
    }
    if (snapshot.capability_fingerprint !== capabilityFingerprint(cachedObserved)) {
      throw new CapabilityCacheError('snapshot fingerprint does not match its observed descriptor');
    }
    if (snapshot.source !== 'live-tool-schema') {
      throw new CapabilityCacheError('snapshot source must be live-tool-schema');
    }
    const expiresAt = parseTime(snapshot.expires_at, 'snapshot.expires_at');
    const generatedAt = parseTime(snapshot.generated_at, 'snapshot.generated_at');
    if (generatedAt.getTime() > current.getTime() + 5 * 60 * 1000) {
      throw new CapabilityCacheError('snapshot generated_at is in the future');
    }
    if (expiresAt.getTime() <= generatedAt.getTime() || expiresAt.getTime() - generatedAt.getTime() > 24 * 90 * 3600 * 1000) {
      throw new CapabilityCacheError('snapshot validity window is invalid');
    }
    const reasons = [];
    if (current.getTime() >= expiresAt.getTime()) {
      reasons.push('snapshot-expired');
    }
    if (snapshot.host_version !== observed.host_version) {
      reasons.push('host-version-changed');
    }
    if (snapshot.capability_fingerprint !== base.current_fingerprint) {
      reasons.push('live-capability-fingerprint-changed');
    }
    return {
      ...base,
      status: reasons.length ? 'stale' : 'fresh',
      refresh_required: reasons.length > 0,
      reasons,
      snapshot,
    };
  } catch (error) {
    return { ...base, status: 'stale', refresh_required: true, reasons: [`snapshot-invalid: ${error.message}`] };
  }
}

export function recordObservation(root, host, value, now = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CapabilityCacheError('observation must be a JSON object');
  }
  checkKeys(value, EVENT_KEYS, 'observation');
  if (value.schema_version !== SCHEMA_VERSION) {
    throw new CapabilityCacheError(`observation must declare schema_version ${SCHEMA_VERSION}`);
  }
  const category = value.category;
  if (typeof category !== 'string' || !KEY_PATTERN.test(category)) {
    throw new CapabilityCacheError('observation.category is invalid');
  }
  const summary = value.summary;
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 2000) {
    throw new CapabilityCacheError('observation.summary must be 1-2000 characters');
  }
  const confidence = value.confidence;
  if (!CONFIDENCE_VALUES.has(confidence)) {
    throw new CapabilityCacheError('observation.confidence is invalid');
  }
  const evidence = flatMap(value.evidence || {}, 'observation.evidence');
  const portable = value.portable === true;
  if (value.portable !== undefined && typeof value.portable !== 'boolean') {
    throw new CapabilityCacheError('observation.portable must be boolean');
  }
  const current = now || new Date();
  const snapshotFile = snapshotPath(root, assertHost(host));
  let fingerprint = null;
  if (existsSync(snapshotFile)) {
    try {
      const cached = readJsonFile(snapshotFile);
      if (cached && typeof cached.capability_fingerprint === 'string' && /^sha256:[0-9a-f]{64}$/u.test(cached.capability_fingerprint)) {
        fingerprint = cached.capability_fingerprint;
      }
    } catch {}
  }
  const record = {
    schema_version: SCHEMA_VERSION,
    host,
    recorded_at: current.toISOString(),
    capability_fingerprint: fingerprint,
    event: {
      category,
      summary: summary.trim(),
      confidence,
      evidence,
      portable,
    },
  };
  const directory = observationsDir(root, host);
  const filename = `${current.toISOString().replace(/[:.]/gu, '')}-${randomUUID()}.json`;
  const path = join(directory, filename);
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
  const command = argv[0];
  if (!['status', 'refresh', 'observe'].includes(command)) {
    throw new CapabilityCacheError('command must be status, refresh, or observe');
  }
  const options = { command, host: '', repo: '.', scope: 'global', config_dir: null, observed: null, ttl_hours: 168, event: null };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') options.host = argv[++i];
    else if (arg === '--repo') options.repo = argv[++i];
    else if (arg === '--scope') options.scope = argv[++i];
    else if (arg === '--config-dir') options.config_dir = argv[++i];
    else if (arg === '--observed') options.observed = argv[++i];
    else if (arg === '--ttl-hours') options.ttl_hours = Number(argv[++i]);
    else if (arg === '--event') options.event = argv[++i];
    else throw new CapabilityCacheError(`unknown option: ${arg}`);
  }
  if (!options.host) throw new CapabilityCacheError('缺少 --host');
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
