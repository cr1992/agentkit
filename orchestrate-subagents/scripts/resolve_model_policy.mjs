#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseJsonStrict } from './contract-tool.mjs';

const CONFIG_SCHEMA_VERSION = 2;
const RESULT_SCHEMA_VERSION = 1;
const HOST_KEYS = new Set(['schema_version', 'host', 'effort_order', 'tier_order', 'tiers', 'dynamic_adjustment']);
const TIER_KEYS = new Set(['models', 'effort', 'channel', 'dispatch']);
const EFFORT_KEYS = new Set(['default', 'min', 'max']);
const DYNAMIC_KEYS = new Set(['enabled', 'max_attempts', 'allowed_actions']);
const DISPATCH_PROVENANCE = new Set(['explicit', 'inherited-controller', 'host-default']);
export const ADJUSTMENT_ACTIONS = new Set(['retry_same', 'raise_effort', 'switch_model', 'promote_tier', 'fresh_context', 'change_strategy']);
export const FAILURE_KINDS = new Set(['implementation_defect', 'reasoning_gap', 'context_gap', 'strategy_gap', 'environment_fault', 'contract_gap', 'safety', 'undecidable']);
const REROUTABLE_FAILURES = new Set(['implementation_defect', 'reasoning_gap', 'context_gap', 'strategy_gap']);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export class PolicyError extends Error {}

function expandUserPath(value, home = homedir()) {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2));
  return value;
}

export function resolveUserPath(value, home = homedir()) {
  return resolvePath(expandUserPath(value, home));
}

export function userConfigDir(env = process.env, platformName = platform(), home = homedir()) {
  const explicit = env.ORCHESTRATE_SUBAGENTS_CONFIG;
  if (explicit) return resolveUserPath(explicit, home);
  const suffix = join('agent-skills', 'orchestrate-subagents');
  if (platformName.startsWith('win')) return join(env.APPDATA || join(home, 'AppData', 'Roaming'), suffix);
  if (platformName === 'darwin') return join(home, 'Library', 'Application Support', suffix);
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), suffix);
}

// Capability cache still has a project-scoped facts directory. Model preferences do not load from it.
export function repositoryRoot(candidatePath) {
  const requested = resolveUserPath(candidatePath);
  let current = requested;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return requested;
    current = parent;
  }
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return requested;
    current = parent;
  }
}

export function projectConfigDir(repoPath) {
  return join(repositoryRoot(repoPath), '.agents', 'orchestrate-subagents');
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PolicyError(`${label} must be a JSON object`);
  return value;
}

function checkKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) throw new PolicyError(`${label} has unknown keys: ${unknown.join(', ')}`);
}

function uniqueStrings(value, label, { nonEmpty = true } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0) || value.some((item) => typeof item !== 'string' || !item.trim()) || new Set(value).size !== value.length) {
    throw new PolicyError(`${label} must be a${nonEmpty ? ' non-empty' : ''} unique string array`);
  }
  return value;
}

function readJson(path, label = path) {
  try { return parseJsonStrict(readFileSync(path, 'utf8')); }
  catch (error) { throw new PolicyError(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`); }
}

function loadHostConfig(path, expectedHost) {
  if (!existsSync(path)) return null;
  const config = assertObject(readJson(path), path);
  checkKeys(config, HOST_KEYS, path);
  if (config.schema_version !== CONFIG_SCHEMA_VERSION) throw new PolicyError(`${path} must declare schema_version ${CONFIG_SCHEMA_VERSION}`);
  if (config.host !== expectedHost) throw new PolicyError(`${path} host must be ${JSON.stringify(expectedHost)}`);

  const effortOrder = uniqueStrings(config.effort_order, `${path}.effort_order`);
  const effortRank = new Map(effortOrder.map((name, index) => [name, index]));
  const tierOrder = uniqueStrings(config.tier_order, `${path}.tier_order`);
  const tiers = assertObject(config.tiers, `${path}.tiers`);
  if (Object.keys(tiers).length !== tierOrder.length || tierOrder.some((name) => !Object.hasOwn(tiers, name)) || Object.keys(tiers).some((name) => !tierOrder.includes(name))) {
    throw new PolicyError(`${path}.tier_order and tiers must name the same tiers exactly once`);
  }

  for (const [name, raw] of Object.entries(tiers)) {
    const tier = assertObject(raw, `${path}.tiers.${name}`);
    checkKeys(tier, TIER_KEYS, `${path}.tiers.${name}`);
    uniqueStrings(tier.models, `${path}.tiers.${name}.models`);
    const effort = assertObject(tier.effort, `${path}.tiers.${name}.effort`);
    checkKeys(effort, EFFORT_KEYS, `${path}.tiers.${name}.effort`);
    for (const key of EFFORT_KEYS) {
      if (typeof effort[key] !== 'string' || !effortRank.has(effort[key])) throw new PolicyError(`${path}.tiers.${name}.effort.${key} must appear in effort_order`);
    }
    if (effortRank.get(effort.min) > effortRank.get(effort.default) || effortRank.get(effort.default) > effortRank.get(effort.max)) throw new PolicyError(`${path}.tiers.${name}.effort must satisfy min <= default <= max`);
    if (typeof tier.channel !== 'string' || !tier.channel.trim()) throw new PolicyError(`${path}.tiers.${name}.channel must be a non-empty string`);
    if (!DISPATCH_PROVENANCE.has(tier.dispatch)) throw new PolicyError(`${path}.tiers.${name}.dispatch is invalid`);
  }

  const dynamic = assertObject(config.dynamic_adjustment, `${path}.dynamic_adjustment`);
  checkKeys(dynamic, DYNAMIC_KEYS, `${path}.dynamic_adjustment`);
  if (typeof dynamic.enabled !== 'boolean') throw new PolicyError(`${path}.dynamic_adjustment.enabled must be boolean`);
  if (!Number.isSafeInteger(dynamic.max_attempts) || dynamic.max_attempts < 1) throw new PolicyError(`${path}.dynamic_adjustment.max_attempts must be a positive safe integer`);
  uniqueStrings(dynamic.allowed_actions, `${path}.dynamic_adjustment.allowed_actions`, { nonEmpty: false });
  const unknownActions = dynamic.allowed_actions.filter((action) => !ADJUSTMENT_ACTIONS.has(action));
  if (unknownActions.length) throw new PolicyError(`${path}.dynamic_adjustment.allowed_actions has invalid actions: ${unknownActions.join(', ')}`);
  return config;
}

function rankOf(order, value, label) {
  const rank = order.indexOf(value);
  if (rank < 0) throw new PolicyError(`${label} ${JSON.stringify(value)} is not configured`);
  return rank;
}

function chooseModel(tier, explicitModel, availableModels, userExplicit) {
  if (explicitModel) {
    if (!userExplicit && !tier.models.includes(explicitModel)) throw new PolicyError(`model ${JSON.stringify(explicitModel)} is outside the selected local tier`);
    if (availableModels.length && !availableModels.includes(explicitModel)) throw new PolicyError(`model ${JSON.stringify(explicitModel)} is not exposed by the current host schema`);
    return explicitModel;
  }
  if (!availableModels.length) throw new PolicyError('model discovery is unavailable; persisted tier candidates cannot be validated');
  const selected = tier.models.find((model) => availableModels.includes(model));
  if (!selected) throw new PolicyError('none of the selected tier models is exposed by the current host schema');
  return selected;
}

function validateEffort(tier, effortOrder, effort, availableEfforts) {
  const effortRank = new Map(effortOrder.map((name, index) => [name, index]));
  if (!effortRank.has(effort)) throw new PolicyError(`effort ${JSON.stringify(effort)} is absent from effort_order`);
  if (effortRank.get(effort) < effortRank.get(tier.effort.min) || effortRank.get(effort) > effortRank.get(tier.effort.max)) throw new PolicyError(`effort ${JSON.stringify(effort)} is outside tier range ${JSON.stringify(tier.effort.min)}..${JSON.stringify(tier.effort.max)}`);
  if (availableEfforts.length && !availableEfforts.includes(effort)) throw new PolicyError(`effort ${JSON.stringify(effort)} is not exposed by the current host schema`);
}

function validateAdjustment(args, config, selection, previous) {
  if (args.attempt === 1) {
    if (previous || args.action || args.failure_kind || args.failure_ref) throw new PolicyError('initial dispatch cannot declare retry inputs');
    return { action: 'initial', failure_kind: null, failure_ref: null, previous_attempt_id: null };
  }
  if (!config.dynamic_adjustment.enabled) throw new PolicyError('dynamic adjustment is disabled by local config');
  if (args.attempt > config.dynamic_adjustment.max_attempts) throw new PolicyError(`attempt ${args.attempt} exceeds local max_attempts ${config.dynamic_adjustment.max_attempts}`);
  if (!previous) throw new PolicyError('retry dispatch requires --previous-dispatch');
  const previousPatch = previous.dispatch_record_patch;
  if (previous.schema_version !== RESULT_SCHEMA_VERSION || previous.record_type !== 'model-policy-resolution' || previous.host !== args.host || !previousPatch || typeof previousPatch !== 'object' || Array.isArray(previousPatch)) throw new PolicyError('previous resolution schema/host mismatch');
  if (previousPatch.attempt !== args.attempt - 1) throw new PolicyError('previous resolution attempt is not immediately prior');
  if (!ADJUSTMENT_ACTIONS.has(args.action)) throw new PolicyError('retry dispatch requires a valid --action');
  if (!config.dynamic_adjustment.allowed_actions.includes(args.action)) throw new PolicyError(`adjustment action ${JSON.stringify(args.action)} is outside local config`);
  if (!FAILURE_KINDS.has(args.failure_kind)) throw new PolicyError('retry dispatch requires a valid --failure-kind');
  if (!REROUTABLE_FAILURES.has(args.failure_kind)) throw new PolicyError(`failure kind ${JSON.stringify(args.failure_kind)} must stop/re-contract instead of model rerouting`);
  if (!DIGEST_PATTERN.test(args.failure_ref || '')) throw new PolicyError('retry dispatch requires a sha256 --failure-ref');

  const sameTier = previousPatch.tier === selection.tier;
  const sameModel = previousPatch.model === selection.model;
  const sameEffort = previousPatch.reasoning_effort === selection.effort;
  const effortRank = new Map(config.effort_order.map((name, index) => [name, index]));
  if (args.action === 'retry_same' && !(sameTier && sameModel && sameEffort)) throw new PolicyError('retry_same must preserve tier, model and effort');
  if (args.action === 'raise_effort' && !(sameTier && sameModel && effortRank.get(selection.effort) > effortRank.get(previousPatch.reasoning_effort))) throw new PolicyError('raise_effort must keep tier/model and increase effort');
  if (args.action === 'switch_model' && sameModel) throw new PolicyError('switch_model must change the model');
  if (args.action === 'promote_tier' && rankOf(config.tier_order, selection.tier, 'tier') <= rankOf(config.tier_order, previousPatch.tier, 'previous tier')) throw new PolicyError('promote_tier must move to a higher configured tier');
  if (args.action === 'fresh_context' && !(sameTier && sameModel && sameEffort)) throw new PolicyError('fresh_context changes worker context, not model parameters');
  return { action: args.action, failure_kind: args.failure_kind, failure_ref: args.failure_ref, previous_attempt_id: previousPatch.attempt_id };
}

export function resolve(args) {
  const configRoot = args.config_dir ? resolveUserPath(args.config_dir) : userConfigDir();
  const configPath = join(configRoot, 'hosts', `${args.host}.json`);
  const config = loadHostConfig(configPath, args.host);
  if (!config) throw new PolicyError(`no local host config: ${configPath}`);
  const tierName = args.tier;
  const tier = Object.hasOwn(config.tiers, tierName) ? config.tiers[tierName] : null;
  if (!tier) throw new PolicyError(`tier ${JSON.stringify(tierName)} is not configured`);
  const availableModels = args.available_model || [];
  const availableEfforts = args.available_effort || [];
  const availableChannels = args.available_channel || [];
  const userExplicit = args.user_explicit === true;
  if (userExplicit && (!args.model || !args.effort)) throw new PolicyError('--user-explicit requires explicit --model and --effort values');
  const model = chooseModel(tier, args.model, availableModels, userExplicit);
  const effort = args.effort || tier.effort.default;
  validateEffort(tier, config.effort_order, effort, availableEfforts);
  if (availableChannels.length && !availableChannels.includes(tier.channel)) throw new PolicyError(`channel ${JSON.stringify(tier.channel)} is not exposed by the current host schema`);
  if ((!availableModels.length || !availableEfforts.length) && !userExplicit) throw new PolicyError('persisted local config requires live model and effort discovery');

  const previous = args.previous_dispatch ? assertObject(readJson(resolveUserPath(args.previous_dispatch), args.previous_dispatch), args.previous_dispatch) : null;
  const selection = { tier: tierName, model, effort };
  const adjustment = validateAdjustment(args, config, selection, previous);
  const dispatchRecordPatch = {
    attempt_id: args.attempt_id || randomUUID(),
    attempt: args.attempt,
    previous_attempt_id: adjustment.previous_attempt_id,
    tier: tierName,
    model,
    reasoning_effort: effort,
    adjustment_action: adjustment.action,
    failure_kind: adjustment.failure_kind,
    failure_ref: adjustment.failure_ref,
    selection_reason: args.selection_reason,
    config_source: [configPath],
    configuration_state: userExplicit ? 'user-explicit' : 'persisted-config',
    model_resolution_state: availableModels.length ? 'discovered-and-validated' : 'user-explicit-unverifiable',
    dispatch_provenance: tier.dispatch,
    max_attempts: config.dynamic_adjustment.max_attempts,
  };
  return {
    schema_version: RESULT_SCHEMA_VERSION,
    record_type: 'model-policy-resolution',
    host: args.host,
    tier_rank: rankOf(config.tier_order, tierName, 'tier'),
    channel: tier.channel,
    selection_source: userExplicit ? 'user-explicit' : 'local-config',
    dispatch_record_patch: dispatchRecordPatch,
  };
}

export function explain(result) {
  const patch = result.dispatch_record_patch;
  return [
    `attempt: ${patch.attempt}`,
    `tier: ${patch.tier}`,
    `model: ${patch.model}`,
    `effort: ${patch.reasoning_effort}`,
    `action: ${patch.adjustment_action}`,
    `channel: ${result.channel}`,
    `provenance: ${patch.dispatch_provenance}`,
    `configuration_state: ${patch.configuration_state}`,
    `model_resolution_state: ${patch.model_resolution_state}`,
    `selection_reason: ${patch.selection_reason}`,
    'source:',
    ...patch.config_source.map((value) => `  - ${value}`),
  ].join('\n');
}

export function parseCli(argv = process.argv.slice(2)) {
  const options = {
    host: '', config_dir: null, tier: '', model: null, effort: null, selection_reason: '', user_explicit: false,
    attempt: 1, attempt_id: null, previous_dispatch: null, action: null, failure_kind: null, failure_ref: null,
    available_model: [], available_effort: [], available_channel: [], explain: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new PolicyError(`${arg} 缺少值`);
      i += 1;
      return value;
    };
    if (arg === '--host') options.host = takeValue();
    else if (arg === '--config-dir') options.config_dir = takeValue();
    else if (arg === '--tier') options.tier = takeValue();
    else if (arg === '--model') options.model = takeValue();
    else if (arg === '--effort') options.effort = takeValue();
    else if (arg === '--selection-reason') options.selection_reason = takeValue();
    else if (arg === '--user-explicit') options.user_explicit = true;
    else if (arg === '--attempt') options.attempt = Number(takeValue());
    else if (arg === '--attempt-id') options.attempt_id = takeValue();
    else if (arg === '--previous-dispatch') options.previous_dispatch = takeValue();
    else if (arg === '--action') options.action = takeValue();
    else if (arg === '--failure-kind') options.failure_kind = takeValue();
    else if (arg === '--failure-ref') options.failure_ref = takeValue();
    else if (arg === '--available-model') options.available_model.push(takeValue());
    else if (arg === '--available-effort') options.available_effort.push(takeValue());
    else if (arg === '--available-channel') options.available_channel.push(takeValue());
    else if (arg === '--explain') options.explain = true;
    else throw new PolicyError(`unknown option: ${arg}`);
  }
  if (!options.host) throw new PolicyError('缺少 --host');
  if (!options.tier) throw new PolicyError('缺少 --tier');
  if (!options.selection_reason || /[\r\n]/u.test(options.selection_reason)) throw new PolicyError('缺少合法 --selection-reason');
  if (!Number.isSafeInteger(options.attempt) || options.attempt < 1) throw new PolicyError('--attempt 必须为正安全整数');
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  const result = resolve(options);
  process.stdout.write(options.explain ? `${explain(result)}\n` : `${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function entry() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return pathToFileURL(resolvePath(process.argv[1] ?? '')).href === import.meta.url; }
}

if (entry()) {
  try { main(); }
  catch (error) {
    if (error instanceof PolicyError) {
      process.stderr.write(`model policy error: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
}
