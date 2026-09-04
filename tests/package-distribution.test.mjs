import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const npm = (args, cache, options = {}) => spawnSync('npm', args, {
  cwd: ROOT,
  encoding: 'utf8',
  ...options,
  env: { ...process.env, NPM_CONFIG_CACHE: cache, ...options.env },
});

test('package.json 保持零依赖、显式 bin 映射与 Node 下限', () => {
  assert.deepEqual(manifest.dependencies, {});
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.type, 'module');
  // 包名与命令名解耦：命令名固定 agentkit，不随 scope 变化。
  assert.deepEqual(Object.keys(manifest.bin), ['agentkit']);
  assert.equal(manifest.bin.agentkit, './bin/agentkit.mjs');
  assert.notEqual(statSync(join(ROOT, manifest.bin.agentkit)).mode & 0o111, 0, 'CLI 源入口必须可执行');
  assert.equal(manifest.engines.node, '>=22');
  assert.equal(manifest.license, 'MIT');
  assert.deepEqual(manifest.repository, {
    type: 'git',
    url: 'git+https://github.com/cr1992/agentkit.git',
  });
  assert.equal(manifest.homepage, 'https://github.com/cr1992/agentkit#readme');
  assert.equal(manifest.bugs.url, 'https://github.com/cr1992/agentkit/issues');
  assert.deepEqual(manifest.publishConfig, {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
  });
});

test('npm pack 内容清单只含运行时与四个 Skill，不含内部计划与共享测试', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agentkit-pack-list-'));
  try {
    const result = npm(['pack', '--dry-run', '--json'], join(sandbox, 'npm-cache'));
    assert.equal(result.status, 0, result.stderr);
    const packed = JSON.parse(result.stdout)[0];
    const files = packed.files.map((entry) => entry.path);

    for (const required of [
      'package.json',
      'LICENSE',
      'shell-manifest.json',
      'bin/agentkit.mjs',
      'bin/cli.mjs',
      'core/digest.mjs',
      'core/content-digest.mjs',
      'core/runtime-bundle.mjs',
      'orchestrate-subagents/SKILL.md',
      'orchestrate-subagents/scripts/orchestration-ledger.mjs',
      'domains/orchestrate/orchestration-ledger.mjs',
      'domains/worktree/worktree-mgr.mjs',
      'domains/verify/verification-runtime.mjs',
      'domains/loop/loop-runtime.mjs',
    ]) {
      assert.ok(files.includes(required), `发布物缺少 ${required}`);
    }
    // 内部计划文档与跨 Skill 共享测试不进发布物。
    assert.deepEqual(files.filter((path) => path.startsWith('docs/plans/')), []);
    assert.deepEqual(files.filter((path) => path.startsWith('tests/')), []);
    assert.deepEqual(files.filter((path) => path.endsWith('.test.mjs')), []);
    // 没有编译产物或第三方运行时。
    assert.deepEqual(files.filter((path) => path.startsWith('node_modules/') || path.endsWith('.map')), []);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test('真实 tarball 装进临时 prefix 后 agentkit 命令可用', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agentkit-install-'));
  try {
    const cache = join(sandbox, 'npm-cache');
    const packed = npm(['pack', '--pack-destination', sandbox, '--json'], cache);
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = join(sandbox, JSON.parse(packed.stdout)[0].filename);
    assert.ok(existsSync(tarball));

    const prefix = join(sandbox, 'prefix');
    // --offline：零依赖包不该访问 registry，一旦访问就说明依赖闭包出了问题。
    const installed = npm(['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', '--offline', tarball], cache);
    assert.equal(installed.status, 0, installed.stderr);

    const env = { ...process.env, PATH: `${join(prefix, 'bin')}${delimiter}${process.env.PATH}` };
    const version = spawnSync('agentkit', ['--version'], { encoding: 'utf8', env, cwd: sandbox });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), manifest.version);

    // 从 PATH 启动时仍能定位到随包分发的四个 Skill。
    const capabilities = spawnSync('agentkit', ['capabilities', '--json'], { encoding: 'utf8', env, cwd: sandbox });
    assert.equal(capabilities.status, 0, capabilities.stderr);
    const payload = JSON.parse(capabilities.stdout);
    assert.deepEqual(Object.keys(payload.skills).sort(), [
      'manage-worktrees', 'orchestrate-subagents', 'run-agent-verify-loop', 'verify-agent-output',
    ]);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});
