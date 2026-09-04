// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { explain, parseCli, repositoryRoot, resolve, userConfigDir } from './resolve_model_policy.mjs';

const FAILURE_REF = `sha256:${'a'.repeat(64)}`;
const HOST_CONFIG = {
  schema_version: 2,
  host: 'test-host',
  effort_order: ['low', 'medium', 'high', 'xhigh'],
  tier_order: ['utility', 'primary', 'frontier'],
  tiers: {
    utility: { models: ['luna', 'sonnet'], effort: { default: 'xhigh', min: 'medium', max: 'xhigh' }, channel: 'worker', dispatch: 'explicit' },
    primary: { models: ['terra', 'opus'], effort: { default: 'xhigh', min: 'medium', max: 'xhigh' }, channel: 'worker', dispatch: 'explicit' },
    frontier: { models: ['sol'], effort: { default: 'high', min: 'medium', max: 'xhigh' }, channel: 'worker', dispatch: 'explicit' },
  },
  dynamic_adjustment: {
    enabled: true,
    max_attempts: 3,
    allowed_actions: ['retry_same', 'raise_effort', 'switch_model', 'promote_tier', 'fresh_context', 'change_strategy'],
  },
};

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'model-policy-v2-'));
  writeJson(join(root, 'hosts', 'test-host.json'), HOST_CONFIG);
  return root;
}

function args(root, overrides = {}) {
  return {
    host: 'test-host', config_dir: root, tier: 'primary', model: null, effort: null,
    selection_reason: '常规实现使用本地主力层', user_explicit: false,
    attempt: 1, attempt_id: 'attempt-1', previous_dispatch: null, action: null, failure_kind: null, failure_ref: null,
    available_model: ['sol', 'terra', 'opus', 'luna', 'sonnet'], available_effort: ['low', 'medium', 'high', 'xhigh'], available_channel: ['worker'], explain: false,
    ...overrides,
  };
}

function dispatchPatch(result) {
  return result.dispatch_record_patch;
}

test('Platform user config path resolution remains portable', () => {
  assert.equal(userConfigDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me'), join('C:\\Users\\me\\AppData\\Roaming', 'agent-skills', 'orchestrate-subagents'));
  assert.equal(userConfigDir({}, 'darwin', '/Users/me'), join('/Users/me', 'Library', 'Application Support', 'agent-skills', 'orchestrate-subagents'));
  assert.equal(userConfigDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/me'), join('/cfg', 'agent-skills', 'orchestrate-subagents'));
  assert.equal(userConfigDir({ ORCHESTRATE_SUBAGENTS_CONFIG: '~/routing' }, 'linux', '/home/me'), '/home/me/routing');
});

test('Repository root lookup starts from the nearest existing ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'model-policy-repo-'));
  try {
    mkdirSync(join(root, '.git'));
    assert.equal(repositoryRoot(join(root, 'typo', 'nested')), root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Initial dispatch resolves a locally configured tier', () => {
  const root = setup();
  try {
    const result = resolve(args(root));
    const patch = dispatchPatch(result);
    assert.equal(result.schema_version, 1);
    assert.equal(result.record_type, 'model-policy-resolution');
    assert.equal(patch.tier, 'primary');
    assert.equal(patch.model, 'terra');
    assert.equal(patch.reasoning_effort, 'xhigh');
    assert.equal(patch.adjustment_action, 'initial');
    assert.equal(patch.configuration_state, 'persisted-config');
    assert.equal('dispatch' in result, false);
    assert.deepEqual(Object.keys(patch).sort(), [
      'adjustment_action', 'attempt', 'attempt_id', 'config_source', 'configuration_state',
      'dispatch_provenance', 'failure_kind', 'failure_ref', 'max_attempts', 'model',
      'model_resolution_state', 'previous_attempt_id', 'reasoning_effort', 'selection_reason', 'tier',
    ]);
    assert.match(explain(result), /tier: primary/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Resolver selects the first live candidate in local preference order', () => {
  const root = setup();
  try {
    const result = resolve(args(root, { available_model: ['opus', 'sol'] }));
    assert.equal(dispatchPatch(result).model, 'opus');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Local effort range and live schema are both enforced', () => {
  const root = setup();
  try {
    assert.throws(() => resolve(args(root, { tier: 'frontier', effort: 'low' })), /outside tier range/);
    assert.throws(() => resolve(args(root, { effort: 'xhigh', available_effort: ['medium', 'high'] })), /not exposed/);
    assert.throws(() => resolve(args(root, { available_channel: ['other'] })), /channel .* not exposed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Dynamic adjustment validates retry lineage and effort increase', () => {
  const root = setup();
  try {
    const first = resolve(args(root, { tier: 'frontier', effort: 'medium' }));
    const previous = join(root, 'previous.json');
    writeJson(previous, first);
    const second = resolve(args(root, {
      tier: 'frontier', effort: 'high', attempt: 2, attempt_id: 'attempt-2', previous_dispatch: previous,
      action: 'raise_effort', failure_kind: 'reasoning_gap', failure_ref: FAILURE_REF,
      selection_reason: '验收显示推理遗漏，在同模型允许范围内提升强度',
    }));
    assert.equal(dispatchPatch(second).previous_attempt_id, 'attempt-1');
    assert.equal(dispatchPatch(second).adjustment_action, 'raise_effort');
    assert.equal(dispatchPatch(second).failure_ref, FAILURE_REF);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Tier promotion is ordered by local config rather than hard-coded model names', () => {
  const root = setup();
  try {
    const first = resolve(args(root, { tier: 'utility', model: 'luna', effort: 'xhigh' }));
    const previous = join(root, 'previous.json');
    writeJson(previous, first);
    const promoted = resolve(args(root, {
      tier: 'primary', model: 'terra', effort: 'xhigh', attempt: 2, previous_dispatch: previous,
      action: 'promote_tier', failure_kind: 'strategy_gap', failure_ref: FAILURE_REF,
      selection_reason: '局部策略已失败，切换到本地主力层',
    }));
    assert.equal(promoted.tier_rank, 1);
    assert.throws(() => resolve(args(root, {
      tier: 'utility', attempt: 2, previous_dispatch: previous, action: 'promote_tier',
      failure_kind: 'strategy_gap', failure_ref: FAILURE_REF, selection_reason: '无效升级',
    })), /higher configured tier/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Context refresh preserves model parameters and non-reroutable failures stop', () => {
  const root = setup();
  try {
    const first = resolve(args(root));
    const previous = join(root, 'previous.json');
    writeJson(previous, first);
    const fresh = resolve(args(root, {
      attempt: 2, previous_dispatch: previous, action: 'fresh_context', failure_kind: 'context_gap', failure_ref: FAILURE_REF,
      selection_reason: '清理被旧方案锚定的上下文',
    }));
    assert.equal(dispatchPatch(fresh).model, dispatchPatch(first).model);
    assert.throws(() => resolve(args(root, {
      attempt: 2, previous_dispatch: previous, action: 'promote_tier', tier: 'frontier',
      failure_kind: 'environment_fault', failure_ref: FAILURE_REF, selection_reason: '错误地用模型处理环境故障',
    })), /must stop\/re-contract/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Dynamic limits and action invariants fail closed', () => {
  const root = setup();
  try {
    const first = resolve(args(root, { tier: 'frontier', effort: 'medium' }));
    const previous = join(root, 'previous.json');
    writeJson(previous, first);
    assert.throws(() => resolve(args(root, {
      tier: 'frontier', effort: 'medium', attempt: 2, previous_dispatch: previous, action: 'raise_effort',
      failure_kind: 'reasoning_gap', failure_ref: FAILURE_REF, selection_reason: '没有实际提强度',
    })), /increase effort/);
    assert.throws(() => resolve(args(root, {
      attempt: 4, previous_dispatch: previous, action: 'retry_same', failure_kind: 'implementation_defect',
      failure_ref: FAILURE_REF, selection_reason: '超过上限',
    })), /exceeds local max_attempts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Persisted config requires discovery while user-explicit values can be marked unverifiable', () => {
  const root = setup();
  try {
    assert.throws(() => resolve(args(root, { available_model: [], available_effort: [] })), /discovery is unavailable/);
    const result = resolve(args(root, {
      model: 'session-model', effort: 'high', user_explicit: true, available_model: [], available_effort: [],
    }));
    assert.equal(dispatchPatch(result).configuration_state, 'user-explicit');
    assert.equal(dispatchPatch(result).model_resolution_state, 'user-explicit-unverifiable');
    assert.throws(() => resolve(args(root, {
      user_explicit: true, available_model: [], available_effort: [],
    })), /requires explicit --model and --effort/);
    assert.throws(() => resolve(args(root, {
      model: 'session-model', user_explicit: true, available_model: [], available_effort: [],
    })), /requires explicit --model and --effort/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Unknown config fields and invalid tier definitions fail closed', () => {
  const root = setup();
  try {
    writeJson(join(root, 'hosts', 'test-host.json'), { ...HOST_CONFIG, budget_mode: 'quality' });
    assert.throws(() => resolve(args(root)), /unknown keys: budget_mode/);
    writeJson(join(root, 'hosts', 'test-host.json'), { ...HOST_CONFIG, tier_order: ['utility', 'primary'] });
    assert.throws(() => resolve(args(root)), /tier_order and tiers/);
    for (const inheritedName of ['valueOf', 'toString']) {
      const config = structuredClone(HOST_CONFIG);
      config.tiers.primary.effort.min = inheritedName;
      writeJson(join(root, 'hosts', 'test-host.json'), config);
      assert.throws(() => resolve(args(root)), /must appear in effort_order/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI rejects missing option values before applying defaults', () => {
  assert.throws(() => parseCli(['--host', 'test-host', '--tier', 'primary', '--selection-reason', 'reason', '--config-dir']), /--config-dir 缺少值/);
  assert.throws(() => parseCli(['--host', 'test-host', '--tier', 'primary', '--selection-reason', 'reason', '--config-dir', '--explain']), /--config-dir 缺少值/);
});

test('CLI executes through a symlinked skill installation path', () => {
  const root = setup();
  try {
    const realScript = fileURLToPath(new URL('./resolve_model_policy.mjs', import.meta.url));
    const linkedScript = join(root, 'installed', 'scripts', 'resolve_model_policy.mjs');
    mkdirSync(dirname(linkedScript), { recursive: true });
    symlinkSync(realScript, linkedScript);
    const result = spawnSync(process.execPath, [
      linkedScript, '--host', 'test-host', '--config-dir', root, '--tier', 'primary', '--selection-reason', '常规实现',
      '--available-model', 'terra', '--available-effort', 'xhigh', '--available-channel', 'worker',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).dispatch_record_patch.tier, 'primary');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
