import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runtimeBundleDigest, validateShellManifest } from '../core/runtime-bundle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('shell manifest 与 package、CLI、四个 Skill 及全部兼容入口闭合', () => {
  const report = validateShellManifest(ROOT);
  assert.equal(report.package_name, '@cr1992/agentkit');
  assert.equal(report.package_version, '1.0.0');
  assert.deepEqual(Object.keys(report.manifest.skills).sort(), [
    'manage-worktrees', 'orchestrate-subagents', 'run-agent-verify-loop', 'verify-agent-output',
  ]);
});

test('runtime bundle digest 与安装绝对路径无关', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'runtime-bundle-path-'));
  try {
    const copy = join(sandbox, 'nested', 'agentkit');
    cpSync(ROOT, copy, { recursive: true });
    assert.equal(runtimeBundleDigest(copy), runtimeBundleDigest(ROOT));
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test('CLI/shell 版本失配时写命令 fail closed，但只读能力与 doctor 仍可诊断', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'runtime-bundle-mismatch-'));
  try {
    const copy = join(sandbox, 'agentkit');
    cpSync(ROOT, copy, { recursive: true });
    const manifestPath = join(copy, 'shell-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.package_version = '9.9.9';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const cli = join(copy, 'bin', 'agentkit.mjs');
    const readonly = spawnSync(process.execPath, [cli, 'contract', 'capabilities'], { cwd: copy, encoding: 'utf8' });
    assert.equal(readonly.status, 0, readonly.stderr);

    const args = ['orchestrate', 'reflection', 'record', '--state-root', join(sandbox, 'state'), '--input', join(sandbox, 'input.json')];
    const blocked = spawnSync(process.execPath, [cli, ...args], { cwd: copy, encoding: 'utf8' });
    assert.equal(blocked.status, 3);
    assert.equal(blocked.stdout, '');
    assert.match(blocked.stderr, /CLI\/shell 版本不匹配/u);

    const legacy = spawnSync(process.execPath, [join(copy, 'orchestrate-subagents', 'scripts', 'orchestration-reflection.mjs'), ...args.slice(2)], { cwd: copy, encoding: 'utf8' });
    assert.equal(legacy.status, blocked.status);
    assert.equal(legacy.stdout, blocked.stdout);
    assert.equal(legacy.stderr, blocked.stderr);

    const doctor = spawnSync(process.execPath, [cli, 'doctor', '--json'], { cwd: copy, encoding: 'utf8' });
    assert.equal(doctor.status, 1);
    const report = JSON.parse(doctor.stdout);
    assert.equal(report.healthy, false);
    assert.equal(report.checks.manifest.healthy, false);
    assert.match(report.checks.manifest.error, /CLI\/shell 版本不匹配/u);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});
