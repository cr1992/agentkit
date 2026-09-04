// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkCapabilities, normalizeEffective, normalizeRequirements } from './worker-capability-preflight.mjs';

const fingerprint = `sha256:${'a'.repeat(64)}`;
const evidenceDigest = `sha256:${'b'.repeat(64)}`;
const requirements = {
  schema_version: 1,
  host: 'kiro',
  worker_profile: 'readonly-agent',
  capability_fingerprint: fingerprint,
  binding: 'session:session-a',
  required: ['worker.read.cwd', 'worker.execute_commands'],
};
const effective = {
  schema_version: 1,
  host: 'kiro',
  worker_profile: 'readonly-agent',
  capability_fingerprint: fingerprint,
  binding: 'session:session-a',
  observed_at: '2026-08-19T01:00:00Z',
  expires_at: '2026-08-19T03:00:00Z',
  outcomes: {
    'worker.read.cwd': 'allowed',
    'worker.execute_commands': 'allowed',
  },
  evidence_refs: [{ type: 'probe', id: 'probe-1', digest: evidenceDigest }],
};

test('Effective capability descriptors and requirements fail closed', () => {
  assert.deepEqual(normalizeRequirements({ ...requirements, required: ['worker.read.cwd', 'worker.read.cwd'] }).required, ['worker.read.cwd']);
  assert.equal(normalizeEffective(effective).outcomes['worker.read.cwd'], 'allowed');
  assert.throws(() => normalizeEffective({ ...effective, surprise: true }), /unknown keys/);
  assert.throws(() => normalizeEffective({ ...effective, evidence_refs: [] }), /require at least one evidence ref/);
  assert.throws(() => normalizeRequirements({ ...requirements, required: ['model.discovery'] }), /worker\.\*/);
});

test('非 worker.* 能力键的报错必须给出前缀约定和一个示例键', () => {
  // 实战踩点：required: ["shell.bash"] 只被告知 "must be an array of worker.* capability keys"，
  // 而 worker.* 前缀当时在 SKILL.md / runtime 文档 / schema description 里都查不到。
  for (const key of ['shell.bash', 'host.network', 'read.cwd']) {
    assert.throws(() => normalizeRequirements({ ...requirements, required: [key] }), /required prefix: "worker\."/u, key);
    assert.throws(() => normalizeRequirements({ ...requirements, required: [key] }), /worker\.read\.cwd/u, key);
  }
  const schema = JSON.parse(readFileSync(new URL('../../schemas/worker-capability-requirements-v1.schema.json', import.meta.url), 'utf8'));
  assert.match(schema.properties.required.description, /worker\. 前缀/u);
  assert.match(schema.properties.required.items.description, /worker\.read\.cwd/u);
});

test('Only allowed outcomes satisfy required capabilities', () => {
  const ready = checkCapabilities(effective, requirements, new Date('2026-08-19T02:00:00Z'));
  assert.equal(ready.ready, true);
  assert.equal(ready.action, 'dispatch');

  const denied = checkCapabilities({ ...effective, outcomes: { ...effective.outcomes, 'worker.execute_commands': 'denied_by_policy' } }, requirements, new Date('2026-08-19T02:00:00Z'));
  assert.equal(denied.ready, false);
  assert.equal(denied.action, 'replan_or_controller');

  const fault = checkCapabilities({ ...effective, outcomes: { ...effective.outcomes, 'worker.execute_commands': 'approval_channel_fault' } }, requirements, new Date('2026-08-19T02:00:00Z'));
  assert.equal(fault.action, 'stop_same_class_and_escalate');
});

test('Missing, stale, or mismatched effective profiles require refresh or a scoped probe', () => {
  assert.equal(checkCapabilities(null, requirements).action, 'scoped_probe_or_replan');
  assert.equal(checkCapabilities(effective, requirements, new Date('2026-08-19T04:00:00Z')).effective_status, 'stale');
  assert.equal(checkCapabilities(effective, { ...requirements, binding: 'session:other' }, new Date('2026-08-19T02:00:00Z')).effective_status, 'binding-mismatch');
  assert.equal(checkCapabilities(null, { ...requirements, required: [] }).ready, true);
});

test('CLI executes through a symlink and reports unavailable requirements without an effective profile', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-worker-capability-cli-'));
  try {
    const linkedDir = join(tempDir, 'installed-skill', 'scripts');
    const linkedScript = join(linkedDir, 'worker-capability-preflight.mjs');
    const requirementPath = join(tempDir, 'requirements.json');
    mkdirSync(linkedDir, { recursive: true });
    symlinkSync(fileURLToPath(new URL('./worker-capability-preflight.mjs', import.meta.url)), linkedScript);
    writeFileSync(requirementPath, JSON.stringify(requirements));
    const result = spawnSync(process.execPath, [linkedScript, 'check', '--requirements', requirementPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).action, 'scoped_probe_or_replan');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
