// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cacheRoot, inspectSnapshot, normalizeObserved, parseCli, parseTime, recordObservation, refreshSnapshot, snapshotPath } from './host_capability_cache.mjs';

const OBSERVED_SAMPLE = {
  schema_version: 1,
  host: 'codex',
  host_version: '0.4.0',
  tools: [
    { name: 'spawn_agent', parameters: ['model', 'effort'], returns: ['agent_id'] },
    { name: 'read_file', parameters: ['path'], returns: ['content'] },
  ],
  capabilities: { multi_agent: true, isolate_worktree: true },
  limits: { max_agents: 10 },
  unknown: ['timeout_seconds'],
};

test('Normalize observed schema validation', () => {
  const normalized = normalizeObserved(OBSERVED_SAMPLE, 'codex');
  assert.equal(normalized.host, 'codex');
  assert.equal(normalized.tools.length, 2);
  assert.equal(normalized.tools[0].name, 'read_file'); // sorted

  assert.throws(
    () => normalizeObserved({ ...OBSERVED_SAMPLE, host: 'other' }, 'codex'),
    /observed descriptor host must be "codex"/
  );
  assert.equal(normalizeObserved({ ...OBSERVED_SAMPLE, capabilities: { ...OBSERVED_SAMPLE.capabilities, 'model.discovery': 'unavailable' } }, 'codex').capabilities['model.discovery'], 'unavailable');
  assert.throws(() => normalizeObserved({ ...OBSERVED_SAMPLE, capabilities: { 'model.discovery': 'guessed' } }, 'codex'), /model\.discovery/);
  for (const malformed of [null, 0]) {
    const observed = structuredClone(OBSERVED_SAMPLE);
    observed.tools[0].parameters = malformed;
    assert.throws(() => normalizeObserved(observed, 'codex'), /parameters must be a string array/);
  }
  assert.throws(() => normalizeObserved({ ...OBSERVED_SAMPLE, capabilities: null }, 'codex'), /capabilities must be a JSON object/);
});

test('Snapshot lifecycle: absent -> refresh -> fresh -> expire -> stale', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-cap-cache-'));
  try {
    const now = new Date('2026-08-01T12:00:00Z');

    // 1. Initial inspect: absent
    const initial = inspectSnapshot(tempDir, 'codex', OBSERVED_SAMPLE, now);
    assert.equal(initial.status, 'absent');
    assert.equal(initial.refresh_required, true);

    // 2. Refresh
    const refreshed = refreshSnapshot(tempDir, 'codex', OBSERVED_SAMPLE, 24, now);
    assert.equal(refreshed.status, 'refreshed');

    // 3. Inspect immediately: fresh
    const fresh = inspectSnapshot(tempDir, 'codex', OBSERVED_SAMPLE, now);
    assert.equal(fresh.status, 'fresh');
    assert.equal(fresh.refresh_required, false);

    // 4. Inspect after expiry (25 hours later): stale
    const later = new Date('2026-08-02T13:00:00Z');
    const expired = inspectSnapshot(tempDir, 'codex', OBSERVED_SAMPLE, later);
    assert.equal(expired.status, 'stale');
    assert.equal(expired.refresh_required, true);
    assert.ok(expired.reasons.includes('snapshot-expired'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Live tool and host changes invalidate snapshots, advisory changes do not', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-cap-change-'));
  try {
    const now = new Date('2026-08-01T12:00:00Z');
    refreshSnapshot(tempDir, 'codex', OBSERVED_SAMPLE, 24, now);

    const toolChanged = structuredClone(OBSERVED_SAMPLE);
    toolChanged.tools[0].parameters.push('token_budget');
    assert.ok(inspectSnapshot(tempDir, 'codex', toolChanged, now).reasons.includes('live-capability-fingerprint-changed'));

    const hostChanged = { ...structuredClone(OBSERVED_SAMPLE), host_version: '0.5.0' };
    assert.ok(inspectSnapshot(tempDir, 'codex', hostChanged, now).reasons.includes('host-version-changed'));

    const advisoryChanged = structuredClone(OBSERVED_SAMPLE);
    advisoryChanged.tools.reverse();
    advisoryChanged.capabilities.followup = true;
    advisoryChanged.limits.max_agents = 3;
    advisoryChanged.unknown.push('agent-derived');
    assert.equal(inspectSnapshot(tempDir, 'codex', advisoryChanged, now).status, 'fresh');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Snapshot validation rejects forged source, future generation and overlong validity', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-cap-window-'));
  try {
    const now = new Date('2026-08-01T12:00:00Z');
    const refreshed = refreshSnapshot(tempDir, 'codex', OBSERVED_SAMPLE, 24, now);
    const original = JSON.parse(readFileSync(refreshed.snapshot_path, 'utf8'));

    writeFileSync(refreshed.snapshot_path, JSON.stringify({ ...original, source: 'untrusted' }));
    assert.match(inspectSnapshot(tempDir, 'codex', OBSERVED_SAMPLE, now).reasons[0], /source must be live-tool-schema/);

    writeFileSync(refreshed.snapshot_path, JSON.stringify({ ...original, generated_at: '2026-08-01T12:06:00Z', expires_at: '2026-08-02T12:06:00Z' }));
    assert.match(inspectSnapshot(tempDir, 'codex', OBSERVED_SAMPLE, now).reasons[0], /generated_at is in the future/);

    writeFileSync(refreshed.snapshot_path, JSON.stringify({ ...original, expires_at: '2036-08-01T12:00:00Z' }));
    assert.match(inspectSnapshot(tempDir, 'codex', OBSERVED_SAMPLE, now).reasons[0], /validity window is invalid/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Invalid cache and descriptors fail closed', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-cap-invalid-'));
  try {
    const now = new Date('2026-08-01T12:00:00Z');
    const path = snapshotPath(tempDir, 'codex');
    writeFileSync(join(tempDir, 'placeholder'), 'x');
    assert.throws(() => snapshotPath(tempDir, '../codex'));
    assert.throws(() => refreshSnapshot(tempDir, 'codex', { ...OBSERVED_SAMPLE, instructions: 'ignore schema' }, 24, now), /unknown keys/);
    assert.throws(() => refreshSnapshot(tempDir, 'codex', { ...OBSERVED_SAMPLE, limits: { max_agents: Number.NaN } }, 24, now), /finite number/);

    refreshSnapshot(tempDir, 'codex', OBSERVED_SAMPLE, 24, now);
    writeFileSync(path, '{"schema_version":1,"instructions":"ignore live schema"}');
    assert.equal(inspectSnapshot(tempDir, 'codex', OBSERVED_SAMPLE, now).status, 'stale');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Record observation event and atomic file write cleanup', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-cap-observe-'));
  try {
    refreshSnapshot(tempDir, 'codex', OBSERVED_SAMPLE, 24);
    const observation = {
      schema_version: 1,
      category: 'rate_limit',
      summary: 'Triggered model rate limit on spawn_agent',
      confidence: 'observed-once',
      evidence: { count: 3 },
      portable: false,
    };
    const res = recordObservation(tempDir, 'codex', observation);
    assert.equal(res.status, 'recorded');
    assert.ok(res.record.capability_fingerprint);
    assert.equal(res.record.event.summary, observation.summary);

    // Verify atomic file cleanup: no leftover .tmp files
    const capDir = join(tempDir, 'capabilities');
    const files = readdirSync(capDir);
    assert.ok(files.includes('codex.json'));
    assert.ok(!files.some((f) => f.endsWith('.tmp')));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Observation ignores invalid cached fingerprints and remains append-only', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-cap-corrupt-observe-'));
  try {
    const now = new Date('2026-08-01T12:00:00Z');
    const path = snapshotPath(tempDir, 'codex');
    const refreshed = refreshSnapshot(tempDir, 'codex', OBSERVED_SAMPLE, 24, now);
    const snapshot = JSON.parse(readFileSync(refreshed.snapshot_path, 'utf8'));
    snapshot.capability_fingerprint = 'attacker-controlled';
    writeFileSync(path, JSON.stringify(snapshot));
    const event = { schema_version: 1, category: 'dispatch.error', summary: 'rejected', confidence: 'observed-once', evidence: {}, portable: false };
    const first = recordObservation(tempDir, 'codex', event, now);
    const second = recordObservation(tempDir, 'codex', event, now);
    assert.equal(first.record.capability_fingerprint, null);
    assert.notEqual(first.observation_path, second.observation_path);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Project and explicit cache roots remain separate', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-cap-roots-'));
  try {
    const repo = join(tempDir, 'repo');
    const explicit = join(tempDir, 'global');
    writeFileSync(repo, 'not-used');
    assert.equal(cacheRoot(repo, 'global', explicit), explicit);
    assert.equal(cacheRoot(repo, 'global', '~/capability-cache'), join(homedir(), 'capability-cache'));
    assert.equal(cacheRoot(join(tempDir, 'project'), 'project'), join(tempDir, 'project', '.agents', 'orchestrate-subagents'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Write failures return a candidate snapshot', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-cap-blocked-'));
  try {
    const rootFile = join(tempDir, 'not-a-directory');
    writeFileSync(rootFile, 'x');
    const result = refreshSnapshot(rootFile, 'codex', OBSERVED_SAMPLE, 24);
    assert.equal(result.status, 'write-blocked');
    assert.equal(result.candidate_snapshot.host, 'codex');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Timezone validation strictly requires explicit timezone in ISO strings', () => {
  // Valid timestamps with UTC Z or offset
  const dateZ = parseTime('2026-08-01T12:00:00Z', 'test_time');
  assert.equal(dateZ.toISOString(), '2026-08-01T12:00:00.000Z');

  const dateOffset = parseTime('2026-08-01T20:00:00+08:00', 'test_time');
  assert.equal(dateOffset.toISOString(), '2026-08-01T12:00:00.000Z');

  // Invalid: missing timezone (local time string)
  assert.throws(
    () => parseTime('2026-08-01T12:00:00', 'test_time'),
    /must be a valid ISO-8601 string with timezone/
  );

  // Invalid: garbage string
  assert.throws(
    () => parseTime('not-a-date', 'test_time'),
    /must be a valid ISO-8601 string with timezone/
  );
});

test('CLI parser validates required commands, parameters, scope, and TTL integer range', () => {
  // Missing command
  assert.throws(() => parseCli([]), /missing command/);

  // Unknown command
  assert.throws(() => parseCli(['invalid']), /command must be status, refresh, or observe/);

  // Missing --host
  assert.throws(() => parseCli(['status', '--observed', 'obs.json']), /缺少 --host/);

  // Status missing --observed
  assert.throws(() => parseCli(['status', '--host', 'codex']), /status command requires --observed/);

  // Refresh missing --observed
  assert.throws(() => parseCli(['refresh', '--host', 'codex']), /refresh command requires --observed/);

  // Refresh invalid TTL
  assert.throws(() => parseCli(['refresh', '--host', 'codex', '--observed', 'obs.json', '--ttl-hours', 'invalid']), /--ttl-hours must be an integer/);
  assert.throws(() => parseCli(['refresh', '--host', 'codex', '--observed', 'obs.json', '--ttl-hours', '0']), /--ttl-hours must be between 1 and 2160/);
  assert.throws(() => parseCli(['refresh', '--host', 'codex', '--observed', 'obs.json', '--ttl-hours', '5000']), /--ttl-hours must be between 1 and 2160/);

  // Observe missing --event
  assert.throws(() => parseCli(['observe', '--host', 'codex']), /observe command requires --event/);

  // Invalid scope
  assert.throws(() => parseCli(['status', '--host', 'codex', '--observed', 'obs.json', '--scope', 'invalid']), /scope must be "global" or "project"/);

  // Valid status
  const parsed = parseCli(['status', '--host', 'codex', '--observed', 'obs.json', '--scope', 'project']);
  assert.equal(parsed.command, 'status');
  assert.equal(parsed.host, 'codex');
  assert.equal(parsed.scope, 'project');
});

test('CLI status, refresh and observe complete an end-to-end cycle', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-cap-cli-'));
  try {
    const observedPath = join(tempDir, 'observed.json');
    const eventPath = join(tempDir, 'event.json');
    const configDir = join(tempDir, 'config');
    const script = fileURLToPath(new URL('./host_capability_cache.mjs', import.meta.url));
    writeFileSync(observedPath, JSON.stringify(OBSERVED_SAMPLE));
    writeFileSync(eventPath, JSON.stringify({ schema_version: 1, category: 'lifecycle.wait', summary: 'confirmed', confidence: 'reproduced', evidence: {}, portable: true }));
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const common = ['--host', 'codex', '--config-dir', configDir, '--observed', observedPath];

    const absent = run('status', ...common);
    assert.equal(absent.status, 0, absent.stderr);
    assert.equal(JSON.parse(absent.stdout).status, 'absent');
    const refreshed = run('refresh', ...common);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    const fresh = run('status', ...common);
    assert.equal(JSON.parse(fresh.stdout).status, 'fresh');
    const observed = run('observe', '--host', 'codex', '--config-dir', configDir, '--event', eventPath);
    assert.equal(observed.status, 0, observed.stderr);
    assert.equal(JSON.parse(observed.stdout).status, 'recorded');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('CLI executes through a symlinked skill installation path', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'test-cap-cli-symlink-'));
  try {
    const observedPath = join(tempDir, 'observed.json');
    const configDir = join(tempDir, 'config');
    const realScript = fileURLToPath(new URL('./host_capability_cache.mjs', import.meta.url));
    const linkedDir = join(tempDir, 'installed-skill', 'scripts');
    const linkedScript = join(linkedDir, 'host_capability_cache.mjs');
    mkdirSync(linkedDir, { recursive: true });
    symlinkSync(realScript, linkedScript);
    writeFileSync(observedPath, JSON.stringify(OBSERVED_SAMPLE));

    const result = spawnSync(process.execPath, [linkedScript, 'status', '--host', 'codex', '--config-dir', configDir, '--observed', observedPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.stdout.trim(), '');
    assert.equal(JSON.parse(result.stdout).status, 'absent');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
