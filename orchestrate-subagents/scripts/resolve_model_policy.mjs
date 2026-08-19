#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonStrict } from './contract-tool.mjs';

const SCHEMA_VERSION = 1;
export const BUDGET_MODES = new Set(['economy', 'balanced', 'quality']);
const POLICY_KEYS = new Set(['schema_version', 'routes', 'task_overrides', 'budget_mode', 'budget_modes']);
const HOST_KEYS = new Set(['schema_version', 'host', 'effort_order', 'aliases', 'profiles', 'constraints', 'budget_mode', 'budget_modes']);
const PROFILE_KEYS = new Set(['model', 'effort', 'channel', 'dispatch']);
const CONSTRAINT_KEYS = new Set(['allowed_models', 'minimum_effort']);
const DISPATCH_PROVENANCE = new Set(['explicit', 'inherited-controller', 'host-default']);

export class PolicyError extends Error {}

export function userConfigDir(env = process.env, platformName = platform(), home = homedir()) {
  const explicit = env.ORCHESTRATE_SUBAGENTS_CONFIG;
  if (explicit) return resolvePath(explicit);

  const suffix = join('agent-skills', 'orchestrate-subagents');
  if (platformName.startsWith('win')) {
    const base = env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(base, suffix);
  }
  if (platformName === 'darwin') {
    return join(home, 'Library', 'Application Support', suffix);
  }
  const base = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, suffix);
}

export function repositoryRoot(candidatePath) {
  let candidate = resolvePath(candidatePath);
  if (!existsSync(candidate)) return candidate;
  let current = candidate;
  while (current) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidate;
}

export function projectConfigDir(repoPath) {
  return join(repositoryRoot(repoPath), '.agents', 'orchestrate-subagents');
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PolicyError(`${label} must be a JSON object`);
  }
  return value;
}

function checkKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((k) => !allowed.has(k)).sort();
  if (unknown.length) {
    throw new PolicyError(`${label} has unknown keys: ${unknown.join(', ')}`);
  }
}

function loadJson(path, kind, host = null) {
  if (!existsSync(path)) return null;
  let data;
  try {
    data = parseJsonStrict(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new PolicyError(`cannot read ${path}: ${error.message}`);
  }
  assertObject(data, path);
  checkKeys(data, kind === 'policy' ? POLICY_KEYS : HOST_KEYS, path);
  if (data.schema_version !== SCHEMA_VERSION) {
    throw new PolicyError(`${path} must declare schema_version ${SCHEMA_VERSION}`);
  }
  if (kind === 'host' && data.host !== host) {
    throw new PolicyError(`${path} host must be ${JSON.stringify(host)}`);
  }
  return data;
}

function mergeDict(base, overlay) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = mergeDict(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function validatePolicy(data, label) {
  if (data.budget_mode !== undefined && !BUDGET_MODES.has(data.budget_mode)) {
    throw new PolicyError(`${label}.budget_mode must be one of ${Array.from(BUDGET_MODES).sort().join(', ')}`);
  }
  if (data.budget_modes !== undefined) {
    const modes = assertObject(data.budget_modes, `${label}.budget_modes`);
    for (const [modeName, modeVal] of Object.entries(modes)) {
      if (!BUDGET_MODES.has(modeName)) {
        throw new PolicyError(`${label}.budget_modes has invalid mode ${JSON.stringify(modeName)}`);
      }
      const modeObj = assertObject(modeVal, `${label}.budget_modes.${modeName}`);
      for (const field of ['routes', 'task_overrides']) {
        if (modeObj[field] !== undefined) {
          const values = assertObject(modeObj[field], `${label}.budget_modes.${modeName}.${field}`);
          for (const [key, profile] of Object.entries(values)) {
            if (typeof key !== 'string' || typeof profile !== 'string' || !profile) {
              throw new PolicyError(`${label}.budget_modes.${modeName}.${field} entries must map strings to profiles`);
            }
          }
        }
      }
    }
  }

  for (const field of ['routes', 'task_overrides']) {
    const values = assertObject(data[field] || {}, `${label}.${field}`);
    for (const [key, profile] of Object.entries(values)) {
      if (typeof key !== 'string' || typeof profile !== 'string' || !profile) {
        throw new PolicyError(`${label}.${field} entries must map strings to profiles`);
      }
    }
  }
}

function validateHost(data, label) {
  const effortOrder = data.effort_order;
  if (effortOrder !== undefined) {
    if (!Array.isArray(effortOrder) || effortOrder.some((item) => typeof item !== 'string' || !item) || new Set(effortOrder).size !== effortOrder.length) {
      throw new PolicyError(`${label}.effort_order must be a unique string array`);
    }
  }
  const aliases = assertObject(data.aliases || {}, `${label}.aliases`);
  for (const [key, model] of Object.entries(aliases)) {
    if (typeof key !== 'string' || typeof model !== 'string' || !model) {
      throw new PolicyError(`${label}.aliases entries must map strings to model IDs`);
    }
  }
  const profiles = assertObject(data.profiles || {}, `${label}.profiles`);
  for (const [name, raw] of Object.entries(profiles)) {
    const profile = assertObject(raw, `${label}.profiles.${name}`);
    checkKeys(profile, PROFILE_KEYS, `${label}.profiles.${name}`);
    for (const [key, value] of Object.entries(profile)) {
      if (typeof value !== 'string' || !value) {
        throw new PolicyError(`${label}.profiles.${name}.${key} must be a string`);
      }
    }
    if (profile.dispatch && !DISPATCH_PROVENANCE.has(profile.dispatch)) {
      throw new PolicyError(`${label}.profiles.${name}.dispatch is invalid`);
    }
  }
  const constraints = assertObject(data.constraints || {}, `${label}.constraints`);
  checkKeys(constraints, CONSTRAINT_KEYS, `${label}.constraints`);
  const allowed = constraints.allowed_models;
  if (allowed !== undefined && (!Array.isArray(allowed) || allowed.some((item) => typeof item !== 'string' || !item))) {
    throw new PolicyError(`${label}.constraints.allowed_models must be a string array`);
  }
  const minimum = assertObject(constraints.minimum_effort || {}, `${label}.constraints.minimum_effort`);
  for (const [model, effort] of Object.entries(minimum)) {
    if (typeof model !== 'string' || typeof effort !== 'string' || !effort) {
      throw new PolicyError(`${label} minimum effort for ${JSON.stringify(model)} is invalid`);
    }
  }

  if (data.budget_mode !== undefined && !BUDGET_MODES.has(data.budget_mode)) {
    throw new PolicyError(`${label}.budget_mode must be one of ${Array.from(BUDGET_MODES).sort().join(', ')}`);
  }

  if (data.budget_modes !== undefined) {
    const bModes = assertObject(data.budget_modes, `${label}.budget_modes`);
    for (const [modeName, modeVal] of Object.entries(bModes)) {
      if (!BUDGET_MODES.has(modeName)) {
        throw new PolicyError(`${label}.budget_modes has invalid mode ${JSON.stringify(modeName)}`);
      }
      const modeObj = assertObject(modeVal, `${label}.budget_modes.${modeName}`);
      if (modeObj.profiles !== undefined) {
        const mProfiles = assertObject(modeObj.profiles, `${label}.budget_modes.${modeName}.profiles`);
        for (const [pName, pRaw] of Object.entries(mProfiles)) {
          const pProfile = assertObject(pRaw, `${label}.budget_modes.${modeName}.profiles.${pName}`);
          checkKeys(pProfile, PROFILE_KEYS, `${label}.budget_modes.${modeName}.profiles.${pName}`);
        }
      }
    }
  }
}

function stricterEffort(first, second, effortRank) {
  if (!(first in effortRank) || !(second in effortRank)) {
    throw new PolicyError(`unknown effort while merging: ${JSON.stringify(first)} / ${JSON.stringify(second)}`);
  }
  return effortRank[first] >= effortRank[second] ? first : second;
}

function mergeConstraints(globalValue, projectValue, effortRank) {
  const result = {};
  const globalAllowed = globalValue.allowed_models;
  const projectAllowed = projectValue.allowed_models;
  if (globalAllowed && projectAllowed) {
    const projectSet = new Set(projectAllowed);
    result.allowed_models = globalAllowed.filter((m) => projectSet.has(m));
  } else if (globalAllowed) {
    result.allowed_models = [...globalAllowed];
  } else if (projectAllowed) {
    result.allowed_models = [...projectAllowed];
  }

  const minimum = { ...(globalValue.minimum_effort || {}) };
  for (const [model, effort] of Object.entries(projectValue.minimum_effort || {})) {
    minimum[model] = model in minimum ? stricterEffort(minimum[model], effort, effortRank) : effort;
  }
  if (Object.keys(minimum).length) {
    result.minimum_effort = minimum;
  }
  return result;
}

function configPaths(root, host) {
  return [join(root, 'policy.json'), join(root, 'hosts', `${host}.json`)];
}

function adjustEffortByBudget(effort, budgetMode, effortOrder, effortRank, minimumEffort = null) {
  const currentIndex = effortRank[effort];
  if (currentIndex === undefined) return effort;
  const minIndex = minimumEffort ? (effortRank[minimumEffort] ?? -1) : -1;

  if (budgetMode === 'economy') {
    if (currentIndex > 0) {
      const candidateIndex = currentIndex - 1;
      if (candidateIndex >= minIndex) {
        return effortOrder[candidateIndex];
      }
    }
    return effort;
  }
  if (budgetMode === 'quality') {
    if (currentIndex < effortOrder.length - 1) {
      return effortOrder[currentIndex + 1];
    }
    return effort;
  }
  return effort;
}

export function resolve(args) {
  const repo = resolvePath(args.repo || '.');
  const globalRoot = args.global_config_dir ? resolvePath(args.global_config_dir) : userConfigDir();
  const projectRoot = args.project_config_dir ? resolvePath(args.project_config_dir) : projectConfigDir(repo);
  const [globalPolicyPath, globalHostPath] = configPaths(globalRoot, args.host);
  const [projectPolicyPath, projectHostPath] = configPaths(projectRoot, args.host);

  let globalPolicy = null;
  let projectPolicy = null;
  const sources = [];
  let policy = { routes: {}, task_overrides: {} };
  for (const [path, isProject] of [[globalPolicyPath, false], [projectPolicyPath, true]]) {
    const data = loadJson(path, 'policy');
    if (data !== null) {
      validatePolicy(data, path);
      if (isProject) projectPolicy = data;
      else globalPolicy = data;
      const { schema_version, ...rest } = data;
      policy = mergeDict(policy, rest);
      sources.push(path);
    }
  }

  const globalHost = loadJson(globalHostPath, 'host', args.host);
  const projectHost = loadJson(projectHostPath, 'host', args.host);
  for (const [path, data] of [[globalHostPath, globalHost], [projectHostPath, projectHost]]) {
    if (data !== null) {
      validateHost(data, path);
      sources.push(path);
    }
  }

  const hostPolicy = mergeDict(globalHost || {}, projectHost || {});
  const effortOrder = hostPolicy.effort_order;
  if (!Array.isArray(effortOrder) || !effortOrder.length) {
    throw new PolicyError(`host ${JSON.stringify(args.host)} must define effort_order in external config`);
  }
  const effortRank = Object.fromEntries(effortOrder.map((name, index) => [name, index]));
  hostPolicy.constraints = mergeConstraints(
    (globalHost || {}).constraints || {},
    (projectHost || {}).constraints || {},
    effortRank
  );

  const budgetMode = args.budget_mode
    || projectHost?.budget_mode
    || projectPolicy?.budget_mode
    || globalHost?.budget_mode
    || globalPolicy?.budget_mode
    || 'balanced';
  if (!BUDGET_MODES.has(budgetMode)) {
    throw new PolicyError(`budget_mode ${JSON.stringify(budgetMode)} must be one of ${Array.from(BUDGET_MODES).sort().join(', ')}`);
  }

  if (budgetMode !== 'balanced') {
    const policyModeOverlay = policy.budget_modes?.[budgetMode];
    if (policyModeOverlay) {
      if (policyModeOverlay.routes) policy.routes = mergeDict(policy.routes, policyModeOverlay.routes);
      if (policyModeOverlay.task_overrides) policy.task_overrides = mergeDict(policy.task_overrides, policyModeOverlay.task_overrides);
    }
    const hostModeOverlay = hostPolicy.budget_modes?.[budgetMode];
    if (hostModeOverlay) {
      if (hostModeOverlay.profiles) hostPolicy.profiles = mergeDict(hostPolicy.profiles || {}, hostModeOverlay.profiles);
      if (hostModeOverlay.aliases) hostPolicy.aliases = mergeDict(hostPolicy.aliases || {}, hostModeOverlay.aliases);
    }
  }

  let profileName = args.task_type ? policy.task_overrides?.[args.task_type] : null;
  if (!profileName) {
    profileName = policy.routes?.[args.role];
  }
  if (!profileName) {
    throw new PolicyError(`no profile route for role=${JSON.stringify(args.role)} task_type=${JSON.stringify(args.task_type || null)}`);
  }
  const rawProfile = hostPolicy.profiles?.[profileName];
  if (!rawProfile || typeof rawProfile !== 'object') {
    throw new PolicyError(`host ${JSON.stringify(args.host)} has no profile ${JSON.stringify(profileName)}`);
  }

  const aliases = hostPolicy.aliases || {};
  const requestedModel = args.model || rawProfile.model;
  const baseEffort = args.effort || rawProfile.effort;

  const constraints = hostPolicy.constraints || {};
  const model = aliases[requestedModel] || requestedModel;
  const minimum = constraints.minimum_effort?.[model];

  let requestedEffort;
  if (!args.effort && !hostPolicy.budget_modes?.[budgetMode]?.profiles?.[profileName]?.effort) {
    requestedEffort = adjustEffortByBudget(baseEffort, budgetMode, effortOrder, effortRank, minimum);
  } else {
    requestedEffort = baseEffort;
  }

  if (!model || !requestedEffort) {
    throw new PolicyError(`profile ${JSON.stringify(profileName)} must resolve model and effort`);
  }
  if (!(requestedEffort in effortRank)) {
    throw new PolicyError(`effort ${JSON.stringify(requestedEffort)} is absent from host effort_order`);
  }

  const allowed = constraints.allowed_models;
  if (allowed && !allowed.includes(model)) {
    throw new PolicyError(`model ${JSON.stringify(model)} is outside allowed_models`);
  }
  if (minimum) {
    if (!(minimum in effortRank)) {
      throw new PolicyError(`minimum effort ${JSON.stringify(minimum)} is absent from host effort_order`);
    }
    if (effortRank[requestedEffort] < effortRank[minimum]) {
      throw new PolicyError(`effort ${JSON.stringify(requestedEffort)} is below ${model} minimum ${JSON.stringify(minimum)}`);
    }
  }
  if (args.available_model && args.available_model.length && !args.available_model.includes(model)) {
    throw new PolicyError(`model ${JSON.stringify(model)} is not exposed by the current host schema`);
  }
  if (args.available_effort && args.available_effort.length && !args.available_effort.includes(requestedEffort)) {
    throw new PolicyError(`effort ${JSON.stringify(requestedEffort)} is not exposed by the current host schema`);
  }
  if (args.available_channel && args.available_channel.length && !args.available_channel.includes(rawProfile.channel)) {
    throw new PolicyError(`channel ${JSON.stringify(rawProfile.channel)} is not exposed by the current host schema`);
  }

  const warnings = [];
  if (args.controller_model) {
    const controllerResolved = aliases[args.controller_model] || args.controller_model;
    if (controllerResolved === model) {
      warnings.push(`model_collapse: worker model ${JSON.stringify(model)} matches controller model; tiered dispatch provides no cost leverage`);
    }
    const primaryAlias = aliases.primary;
    const economicalAlias = aliases.economical;
    if (primaryAlias && economicalAlias) {
      if (controllerResolved === economicalAlias && model === primaryAlias) {
        warnings.push(`model_inversion: worker model ${JSON.stringify(model)} is higher tier than controller model ${JSON.stringify(controllerResolved)}`);
      }
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    host: args.host,
    role: args.role,
    task_type: args.task_type || null,
    budget_mode: budgetMode,
    profile: profileName,
    model,
    effort: requestedEffort,
    channel: rawProfile.channel || null,
    dispatch: rawProfile.dispatch || null,
    dispatch_provenance: rawProfile.dispatch || 'host-default',
    selection_source: args.model || args.effort ? 'session-explicit' : 'external-policy',
    config_source: sources.length ? sources : ['skill-default'],
    warnings,
  };
}

export function explain(result) {
  const lines = [
    `profile: ${result.profile}`,
    `model: ${result.model}`,
    `effort: ${result.effort}`,
    `budget_mode: ${result.budget_mode || 'balanced'}`,
    `channel: ${result.channel || 'host-default'}`,
    `dispatch: ${result.dispatch || 'host-default'}`,
    `provenance: ${result.dispatch_provenance}`,
    `selection: ${result.selection_source}`,
    'source:',
  ];
  for (const value of result.config_source) {
    lines.push(`  - ${value}`);
  }
  if (result.warnings && result.warnings.length) {
    lines.push('warnings:');
    for (const w of result.warnings) {
      lines.push(`  - ${w}`);
    }
  }
  return lines.join('\n');
}

export function parseCli(argv = process.argv.slice(2)) {
  const options = {
    host: '',
    repo: '.',
    role: 'worker',
    task_type: null,
    budget_mode: null,
    controller_model: null,
    global_config_dir: null,
    project_config_dir: null,
    model: null,
    effort: null,
    available_model: [],
    available_effort: [],
    available_channel: [],
    explain: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') options.host = argv[++i];
    else if (arg === '--repo') options.repo = argv[++i];
    else if (arg === '--role') options.role = argv[++i];
    else if (arg === '--task-type') options.task_type = argv[++i];
    else if (arg === '--budget-mode') options.budget_mode = argv[++i];
    else if (arg === '--controller-model') options.controller_model = argv[++i];
    else if (arg === '--global-config-dir') options.global_config_dir = argv[++i];
    else if (arg === '--project-config-dir') options.project_config_dir = argv[++i];
    else if (arg === '--model') options.model = argv[++i];
    else if (arg === '--effort') options.effort = argv[++i];
    else if (arg === '--available-model') options.available_model.push(argv[++i]);
    else if (arg === '--available-effort') options.available_effort.push(argv[++i]);
    else if (arg === '--available-channel') options.available_channel.push(argv[++i]);
    else if (arg === '--explain') options.explain = true;
    else throw new PolicyError(`unknown option: ${arg}`);
  }
  if (!options.host) throw new PolicyError('缺少 --host');
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  const result = resolve(options);
  if (options.explain) {
    process.stdout.write(`${explain(result)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
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
    if (error instanceof PolicyError) {
      process.stderr.write(`model policy error: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
}
