// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { recordStandalone, proposeStandalone } from './orchestration-reflection.mjs';
import { digestBytes } from '../../core/digest.mjs';

const contractDigest = `sha256:${'c'.repeat(64)}`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'test-orchestration-reflection-'));
  const snapshot = join(root, 'lightweight-snapshot.json');
  writeFileSync(snapshot, JSON.stringify({ schema_version: 1, mode: 'lightweight', nodes: [] }));
  const input = {
    contract_digest: contractDigest,
    trigger: 'unexpected_outcome',
    classification: 'skill_gap',
    observation: 'Bearer hidden%token|suffix:secret at /Users/example/project cannot record lightweight feedback',
    evidence_refs: [{ type: 'diagnostic', id: 'lightweight-snapshot.json', digest: digestBytes(readFileSync(snapshot)) }],
    impact: 'medium',
    confidence: 'high',
    recommended_disposition: 'continue',
  };
  return { root, input };
}

test('Lightweight reflection and proposal are ledger-independent and append-only', () => {
  const f = fixture();
  try {
    const reflected = recordStandalone(f.root, f.input);
    const reflection = JSON.parse(readFileSync(join(f.root, reflected.ref), 'utf8'));
    assert.equal(reflection.affected_skill.version, '1.1.0');
    assert.match(reflection.observation, /Bearer \[REDACTED\]/);
    assert.doesNotMatch(reflection.observation, /token|suffix|secret/);
    assert.doesNotMatch(reflection.observation, /\/Users\/example/);

    const proposed = proposeStandalone(f.root, reflected.ref, {
      problem_type: 'skill_gap',
      proposed_change: 'Allow ledger-independent lightweight reflections',
      affected_scope: ['lightweight'],
      counterexamples: ['ordinary successful run'],
      validation_plan: { replay_cases: ['lightweight feedback'], regression_suites: ['orchestration reflection'], independent_review: 'required' },
    });
    const proposal = JSON.parse(readFileSync(join(f.root, proposed.ref), 'utf8'));
    assert.equal(proposal.lifecycle, 'proposed');
    assert.equal(proposal.source_reflections[0].reflection_id, reflected.reflection_id);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Lightweight reflection verifies evidence digests and confidence', () => {
  const f = fixture();
  try {
    assert.throws(() => recordStandalone(f.root, { ...f.input, evidence_refs: [{ ...f.input.evidence_refs[0], digest: `sha256:${'d'.repeat(64)}` }] }), /digest 不匹配/);
    assert.throws(() => recordStandalone(f.root, { ...f.input, evidence_refs: [], confidence: 'high' }), /只能是 low confidence/);
    assert.throws(() => recordStandalone(f.root, { ...f.input, unexpected: true }), /未知字段/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Lightweight reflection rejects evidence symlinks that escape the state root', () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'test-orchestration-reflection-outside-'));
  try {
    const outsideFile = join(outside, 'outside.json');
    writeFileSync(outsideFile, '{}');
    symlinkSync(outsideFile, join(f.root, 'escaped.json'));
    assert.throws(() => recordStandalone(f.root, { ...f.input, evidence_refs: [{ type: 'diagnostic', id: 'escaped.json', digest: digestBytes(readFileSync(outsideFile)) }] }), /越出 state 目录/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('Reflection CLI executes through a symlinked installation path', () => {
  const f = fixture();
  try {
    const linkedDir = join(f.root, 'installed-skill', 'scripts');
    const linkedScript = join(linkedDir, 'orchestration-reflection.mjs');
    const inputPath = join(f.root, 'reflection-input.json');
    mkdirSync(linkedDir, { recursive: true });
    symlinkSync(fileURLToPath(new URL('./orchestration-reflection.mjs', import.meta.url)), linkedScript);
    writeFileSync(inputPath, JSON.stringify(f.input));
    const result = spawnSync(process.execPath, [linkedScript, 'record', '--state-root', f.root, '--input', inputPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).reflection_id);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
