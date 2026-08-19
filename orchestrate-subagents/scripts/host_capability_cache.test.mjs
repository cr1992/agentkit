// @ts-check

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CapabilityCacheError, inspectSnapshot, normalizeObserved, parseCli, parseTime, recordObservation, refreshSnapshot } from './host_capability_cache.mjs';

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

    // Verify atomic file cleanup: no leftover .tmp files
    const capDir = join(tempDir, 'capabilities');
    const files = readdirSync(capDir);
    assert.ok(files.includes('codex.json'));
    assert.ok(!files.some((f) => f.endsWith('.tmp')));
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
