// @ts-check

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PolicyError, explain, resolve, userConfigDir } from './resolve_model_policy.mjs';

const COMMON = {
  schema_version: 1,
  routes: { scout: 'mechanical', worker: 'implementation', critic: 'judgment' },
  task_overrides: { audit: 'judgment' },
};

const CODEX = {
  schema_version: 1,
  host: 'codex',
  effort_order: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  aliases: { primary: 'gpt-sol', economical: 'gpt-terra' },
  profiles: {
    mechanical: { model: 'economical', effort: 'high', channel: 'spawn_agent' },
    implementation: { model: 'primary', effort: 'medium', channel: 'spawn_agent', dispatch: 'explicit' },
    judgment: { model: 'primary', effort: 'high', channel: 'spawn_agent', dispatch: 'explicit' },
  },
  constraints: {
    allowed_models: ['gpt-sol', 'gpt-terra'],
    minimum_effort: { 'gpt-terra': 'high' },
  },
};

const CLAUDE = {
  schema_version: 1,
  host: 'claude-code',
  effort_order: ['low', 'medium', 'high', 'xhigh', 'max'],
  aliases: { primary: 'claude-opus', economical: 'claude-sonnet' },
  profiles: {
    mechanical: { model: 'economical', effort: 'medium', channel: 'workflow' },
    implementation: { model: 'primary', effort: 'high', channel: 'workflow' },
    judgment: { model: 'primary', effort: 'xhigh', channel: 'workflow' },
  },
};

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function makeArgs(globalRoot, projectRoot, overrides = {}) {
  return {
    host: 'codex',
    repo: join(projectRoot, '..'),
    role: 'worker',
    task_type: null,
    budget_mode: null,
    controller_model: null,
    global_config_dir: globalRoot,
    project_config_dir: projectRoot,
    model: null,
    effort: null,
    available_model: [],
    available_effort: [],
    available_channel: [],
    explain: false,
    ...overrides,
  };
}

test('Platform path resolution', () => {
  assert.equal(
    userConfigDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me'),
    join('C:\\Users\\me\\AppData\\Roaming', 'agent-skills', 'orchestrate-subagents')
  );
  assert.equal(
    userConfigDir({}, 'darwin', '/Users/me'),
    join('/Users/me', 'Library', 'Application Support', 'agent-skills', 'orchestrate-subagents')
  );
  assert.equal(
    userConfigDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/me'),
    join('/cfg', 'agent-skills', 'orchestrate-subagents')
  );
  assert.equal(
    userConfigDir({ ORCHESTRATE_SUBAGENTS_CONFIG: '/custom' }, 'linux', '/home/me'),
    join('/custom')
  );
});

test('Basic policy resolution and merge', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-policy-'));
  try {
    const globalRoot = join(tempDir, 'global');
    const projectRoot = join(tempDir, 'project', '.agents', 'orchestrate-subagents');
    writeJson(join(globalRoot, 'policy.json'), COMMON);
    writeJson(join(globalRoot, 'hosts', 'codex.json'), CODEX);

    const result = resolve(makeArgs(globalRoot, projectRoot, { role: 'worker' }));
    assert.equal(result.profile, 'implementation');
    assert.equal(result.model, 'gpt-sol');
    assert.equal(result.effort, 'medium');
    assert.equal(result.budget_mode, 'balanced');
    assert.equal(result.selection_source, 'external-policy');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Budget mode adjustments (economy / quality)', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-policy-budget-'));
  try {
    const globalRoot = join(tempDir, 'global');
    const projectRoot = join(tempDir, 'project', '.agents', 'orchestrate-subagents');
    writeJson(join(globalRoot, 'policy.json'), COMMON);
    writeJson(join(globalRoot, 'hosts', 'claude-code.json'), CLAUDE);

    // Default balanced: implementation -> high
    const balancedRes = resolve(makeArgs(globalRoot, projectRoot, { host: 'claude-code', role: 'worker' }));
    assert.equal(balancedRes.effort, 'high');
    assert.equal(balancedRes.budget_mode, 'balanced');

    // Economy mode: high steps down to medium
    const economyRes = resolve(makeArgs(globalRoot, projectRoot, { host: 'claude-code', role: 'worker', budget_mode: 'economy' }));
    assert.equal(economyRes.effort, 'medium');
    assert.equal(economyRes.budget_mode, 'economy');

    // Quality mode: high steps up to xhigh
    const qualityRes = resolve(makeArgs(globalRoot, projectRoot, { host: 'claude-code', role: 'worker', budget_mode: 'quality' }));
    assert.equal(qualityRes.effort, 'xhigh');
    assert.equal(qualityRes.budget_mode, 'quality');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Controller model collapse and inversion warnings', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-policy-collapse-'));
  try {
    const globalRoot = join(tempDir, 'global');
    const projectRoot = join(tempDir, 'project', '.agents', 'orchestrate-subagents');
    writeJson(join(globalRoot, 'policy.json'), COMMON);
    writeJson(join(globalRoot, 'hosts', 'codex.json'), CODEX);

    // Model collapse: controller model is gpt-sol, worker is gpt-sol
    const collapseRes = resolve(makeArgs(globalRoot, projectRoot, { role: 'worker', controller_model: 'gpt-sol' }));
    assert.ok(collapseRes.warnings.some((w) => w.includes('model_collapse')));

    // Model inversion: controller model is gpt-terra (economical), worker is gpt-sol (primary)
    const inversionRes = resolve(makeArgs(globalRoot, projectRoot, { role: 'worker', controller_model: 'gpt-terra' }));
    assert.ok(inversionRes.warnings.some((w) => w.includes('model_inversion')));

    // No warning when controller is primary and worker is economical (scout)
    const scoutRes = resolve(makeArgs(globalRoot, projectRoot, { role: 'scout', controller_model: 'gpt-sol' }));
    assert.equal(scoutRes.warnings.length, 0);

    const explanation = explain(collapseRes);
    assert.match(explanation, /warnings:/);
    assert.match(explanation, /model_collapse/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Constraints and minimum effort enforcement', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-policy-constraints-'));
  try {
    const globalRoot = join(tempDir, 'global');
    const projectRoot = join(tempDir, 'project', '.agents', 'orchestrate-subagents');
    writeJson(join(globalRoot, 'policy.json'), COMMON);
    writeJson(join(globalRoot, 'hosts', 'codex.json'), CODEX);

    // Effort below minimum_effort for gpt-terra (which is 'high') must fail
    assert.throws(
      () => resolve(makeArgs(globalRoot, projectRoot, { role: 'scout', effort: 'medium' })),
      /below gpt-terra minimum "high"/
    );

    // Model outside allowed_models must fail
    assert.throws(
      () => resolve(makeArgs(globalRoot, projectRoot, { role: 'worker', model: 'unauthorized-model' })),
      /outside allowed_models/
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Host-level budget_mode configuration and hierarchical precedence', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-policy-host-budget-'));
  try {
    const globalRoot = join(tempDir, 'global');
    const projectRoot = join(tempDir, 'project', '.agents', 'orchestrate-subagents');
    writeJson(join(globalRoot, 'policy.json'), { ...COMMON, budget_mode: 'balanced' });
    writeJson(join(globalRoot, 'hosts', 'codex.json'), { ...CODEX, budget_mode: 'economy' });

    // Host config specifies economy, so worker (implementation: medium) is downgraded to low
    const resHost = resolve(makeArgs(globalRoot, projectRoot, { role: 'worker' }));
    assert.equal(resHost.budget_mode, 'economy');
    assert.equal(resHost.effort, 'low');

    // CLI override takes precedence over host
    const resCli = resolve(makeArgs(globalRoot, projectRoot, { role: 'worker', budget_mode: 'quality' }));
    assert.equal(resCli.budget_mode, 'quality');
    assert.equal(resCli.effort, 'high');

    // Invalid budget_mode in host.json must throw PolicyError
    writeJson(join(globalRoot, 'hosts', 'codex.json'), { ...CODEX, budget_mode: 'invalid_mode' });
    assert.throws(
      () => resolve(makeArgs(globalRoot, projectRoot, { role: 'worker' })),
      /budget_mode must be one of/
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

