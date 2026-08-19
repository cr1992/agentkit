// @ts-check

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CapabilityCacheError, inspectSnapshot, normalizeObserved, recordObservation, refreshSnapshot } from './host_capability_cache.mjs';

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

test('Record observation event', () => {
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
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
