#!/usr/bin/env node
// @ts-check

import { readFileSync, realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseJsonStrict } from './contract-tool.mjs';
import { allOptionNames, isHelpRequest, renderCliHelp } from './cli-help.mjs';
import { ORCHESTRATION_PROTOCOL_VERSION } from './orchestration-metadata.mjs';

// CLI 命令与参数的唯一真源：选项白名单、`--help` 清单和命令错误信息都从这里推导。
const CLI_SPEC = {
  capabilities: {},
  normalize: { required: ['input'] },
  check: { required: ['requirements'], optional: ['effective'] },
};
const CLI_OPTIONS = allOptionNames(CLI_SPEC);
const CLI_NOTES = [
  'requirements.required 里的能力键必须以 worker. 开头，例如 worker.read.cwd；其他前缀一律拒绝。',
  'required 为空数组时无需 --effective，check 直接返回 not_required 形态的 ready。',
];
const SCHEMA_VERSION = 1;
const RUNTIME_VERSION = '1.0.0';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const HOST_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CAPABILITY_PATTERN = /^worker\.[a-z][a-z0-9_.-]{0,63}$/u;
const SESSION_BINDING_PATTERN = /^session:[A-Za-z0-9._-]{1,128}$/u;
const CONFIG_BINDING_PATTERN = /^config:sha256:[0-9a-f]{64}$/u;
const ISO_TZ_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u;
const OUTCOMES = new Set(['allowed', 'denied_by_policy', 'unavailable_or_unproven', 'approval_channel_fault', 'execution_fault']);
const EFFECTIVE_KEYS = new Set(['schema_version', 'host', 'worker_profile', 'capability_fingerprint', 'binding', 'observed_at', 'expires_at', 'outcomes', 'evidence_refs']);
const REQUIREMENT_KEYS = new Set(['schema_version', 'host', 'worker_profile', 'capability_fingerprint', 'binding', 'required']);
const EVIDENCE_KEYS = new Set(['type', 'id', 'digest']);
const EVIDENCE_TYPES = new Set(['probe', 'schema', 'observation']);

export class WorkerCapabilityError extends Error {}

function checkKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) throw new WorkerCapabilityError(`${label} has unknown keys: ${unknown.join(', ')}`);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkerCapabilityError(`${label} must be a JSON object`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !ISO_TZ_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new WorkerCapabilityError(`${label} must be an ISO-8601 timestamp with timezone`);
  }
  return new Date(value);
}

function binding(value) {
  if (typeof value !== 'string' || (!SESSION_BINDING_PATTERN.test(value) && !CONFIG_BINDING_PATTERN.test(value))) {
    throw new WorkerCapabilityError('binding must be session:<opaque> or config:sha256:<64 hex>');
  }
  return value;
}

function metadata(value, label) {
  if (!HOST_PATTERN.test(String(value.host ?? ''))) throw new WorkerCapabilityError(`${label}.host is invalid`);
  if (!PROFILE_PATTERN.test(String(value.worker_profile ?? ''))) throw new WorkerCapabilityError(`${label}.worker_profile is invalid`);
  if (!DIGEST_PATTERN.test(String(value.capability_fingerprint ?? ''))) throw new WorkerCapabilityError(`${label}.capability_fingerprint is invalid`);
  return {
    host: value.host,
    worker_profile: value.worker_profile,
    capability_fingerprint: value.capability_fingerprint,
    binding: binding(value.binding),
  };
}

function capabilityList(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !CAPABILITY_PATTERN.test(item))) {
    throw new WorkerCapabilityError(`${label} must be an array of worker.* capability keys (required prefix: "worker.", e.g. "worker.read.cwd"); other prefixes are rejected`);
  }
  return [...new Set(value)].sort();
}

export function normalizeEffective(value) {
  object(value, 'effective capability descriptor');
  checkKeys(value, EFFECTIVE_KEYS, 'effective capability descriptor');
  if (value.schema_version !== SCHEMA_VERSION) throw new WorkerCapabilityError(`effective capability descriptor must declare schema_version ${SCHEMA_VERSION}`);
  const common = metadata(value, 'effective capability descriptor');
  const observedAt = timestamp(value.observed_at, 'observed_at');
  const expiresAt = timestamp(value.expires_at, 'expires_at');
  const maxHours = common.binding.startsWith('session:') ? 24 : 168;
  if (expiresAt.getTime() <= observedAt.getTime() || expiresAt.getTime() - observedAt.getTime() > maxHours * 3600 * 1000) {
    throw new WorkerCapabilityError(`effective capability validity must be within ${maxHours} hours`);
  }
  object(value.outcomes, 'outcomes');
  const outcomes = {};
  for (const key of Object.keys(value.outcomes).sort()) {
    if (!CAPABILITY_PATTERN.test(key) || !OUTCOMES.has(value.outcomes[key])) throw new WorkerCapabilityError(`outcomes.${key} is invalid`);
    outcomes[key] = value.outcomes[key];
  }
  if (!Array.isArray(value.evidence_refs)) throw new WorkerCapabilityError('evidence_refs must be an array');
  const evidenceRefs = value.evidence_refs.map((item, index) => {
    object(item, `evidence_refs[${index}]`);
    checkKeys(item, EVIDENCE_KEYS, `evidence_refs[${index}]`);
    if (!EVIDENCE_TYPES.has(item.type) || typeof item.id !== 'string' || !item.id || !DIGEST_PATTERN.test(String(item.digest ?? ''))) {
      throw new WorkerCapabilityError(`evidence_refs[${index}] is invalid`);
    }
    return { type: item.type, id: item.id, digest: item.digest };
  });
  if (Object.values(outcomes).some((outcome) => outcome !== 'unavailable_or_unproven') && evidenceRefs.length === 0) {
    throw new WorkerCapabilityError('proven effective outcomes require at least one evidence ref');
  }
  return {
    schema_version: SCHEMA_VERSION,
    ...common,
    observed_at: observedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    outcomes,
    evidence_refs: evidenceRefs,
  };
}

export function normalizeRequirements(value) {
  object(value, 'capability requirements');
  checkKeys(value, REQUIREMENT_KEYS, 'capability requirements');
  if (value.schema_version !== SCHEMA_VERSION) throw new WorkerCapabilityError(`capability requirements must declare schema_version ${SCHEMA_VERSION}`);
  return { schema_version: SCHEMA_VERSION, ...metadata(value, 'capability requirements'), required: capabilityList(value.required, 'required') };
}

export function checkCapabilities(effectiveValue, requirementValue, now = new Date()) {
  const requirements = normalizeRequirements(requirementValue);
  if (requirements.required.length === 0) {
    return { ready: true, required: [], allowed: [], blocked: [], action: 'dispatch', effective_status: effectiveValue ? 'not-required' : 'absent-not-required' };
  }
  if (!effectiveValue) {
    return {
      ready: false,
      required: requirements.required,
      allowed: [],
      blocked: requirements.required.map((capability) => ({ capability, outcome: 'unavailable_or_unproven' })),
      action: 'scoped_probe_or_replan',
      effective_status: 'absent',
    };
  }
  const effective = normalizeEffective(effectiveValue);
  const mismatches = ['host', 'worker_profile', 'capability_fingerprint', 'binding'].filter((key) => effective[key] !== requirements[key]);
  if (mismatches.length) {
    return {
      ready: false,
      required: requirements.required,
      allowed: [],
      blocked: requirements.required.map((capability) => ({ capability, outcome: 'unavailable_or_unproven' })),
      action: 'refresh_effective_profile',
      effective_status: 'binding-mismatch',
      reasons: mismatches.map((key) => `${key}-mismatch`),
    };
  }
  const observedAt = new Date(effective.observed_at);
  const expiresAt = new Date(effective.expires_at);
  if (observedAt.getTime() > now.getTime() + 5 * 60 * 1000 || expiresAt.getTime() <= now.getTime()) {
    return {
      ready: false,
      required: requirements.required,
      allowed: [],
      blocked: requirements.required.map((capability) => ({ capability, outcome: 'unavailable_or_unproven' })),
      action: 'refresh_effective_profile',
      effective_status: 'stale',
    };
  }
  const allowed = [];
  const blocked = [];
  for (const capability of requirements.required) {
    const outcome = effective.outcomes[capability] ?? 'unavailable_or_unproven';
    if (outcome === 'allowed') allowed.push(capability);
    else blocked.push({ capability, outcome });
  }
  let action = 'dispatch';
  if (blocked.some((item) => item.outcome === 'approval_channel_fault')) action = 'stop_same_class_and_escalate';
  else if (blocked.some((item) => item.outcome === 'execution_fault')) action = 'stop_same_class_and_diagnose';
  else if (blocked.some((item) => item.outcome === 'denied_by_policy')) action = 'replan_or_controller';
  else if (blocked.length) action = 'scoped_probe_or_replan';
  return { ready: blocked.length === 0, required: requirements.required, allowed, blocked, action, effective_status: 'fresh' };
}

function readJson(path) {
  return parseJsonStrict(readFileSync(resolvePath(path), 'utf8'));
}

export function main(argv = process.argv.slice(2)) {
  if (isHelpRequest(argv)) return { help: renderCliHelp('worker-capability-preflight.mjs', CLI_SPEC, CLI_NOTES) };
  const command = argv[0];
  if (command === 'capabilities') return { protocol_version: ORCHESTRATION_PROTOCOL_VERSION, runtime_version: RUNTIME_VERSION, schemas: { effective_worker_capability: [1], worker_capability_requirements: [1] }, outcomes: [...OUTCOMES] };
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--') || !CLI_OPTIONS.has(token.slice(2)) || argv[index + 1] === undefined || argv[index + 1].startsWith('--')) throw new WorkerCapabilityError(`unknown or incomplete option: ${token}`);
    options[token.slice(2)] = argv[++index];
  }
  if (command === 'normalize') {
    if (!options.input) throw new WorkerCapabilityError('normalize requires --input');
    return normalizeEffective(readJson(options.input));
  }
  if (command === 'check') {
    if (!options.requirements) throw new WorkerCapabilityError('check requires --requirements');
    return checkCapabilities(options.effective ? readJson(options.effective) : null, readJson(options.requirements));
  }
  throw new WorkerCapabilityError(`command must be one of: ${Object.keys(CLI_SPEC).join(', ')}`);
}

function entry() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(resolvePath(process.argv[1] ?? '')).href === import.meta.url;
  }
}

if (entry()) {
  try {
    const result = main();
    process.stdout.write(typeof result?.help === 'string' ? result.help : `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`worker capability preflight error: ${error.message}\n`);
    process.exit(error instanceof WorkerCapabilityError ? 2 : 3);
  }
}
