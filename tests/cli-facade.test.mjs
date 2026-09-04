import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'agentkit.mjs');
const script = (skill, name) => join(ROOT, skill, 'scripts', name);
const run = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });

// 新入口 → 旧入口。P1 的 facade 只加前缀，转发路径上三样东西必须完全一致：
// stdout 逐字节、stderr 逐字节、退出码。成功与失败两类形状都要覆盖。
const EQUIVALENT = [
  [['worktree', 'capabilities', '--json'], ['manage-worktrees', 'worktree-mgr.mjs', 'capabilities', '--json']],
  [['worktree', 'scan', '--help'], ['manage-worktrees', 'worktree-scan.mjs', '--help']],
  [['contract', 'capabilities'], ['orchestrate-subagents', 'contract-tool.mjs', 'capabilities']],
  [['contract', '--help'], ['orchestrate-subagents', 'contract-tool.mjs', '--help']],
  [['orchestrate', 'ledger', 'capabilities', '--json'], ['orchestrate-subagents', 'orchestration-ledger.mjs', 'capabilities', '--json']],
  [['orchestrate', 'preflight', 'capabilities'], ['orchestrate-subagents', 'worker-capability-preflight.mjs', 'capabilities']],
  [['orchestrate', 'review-budget', 'capabilities'], ['orchestrate-subagents', 'review-budget.mjs', 'capabilities']],
  [['orchestrate', 'reflection', 'capabilities'], ['orchestrate-subagents', 'orchestration-reflection.mjs', 'capabilities']],
  [['verify', 'capabilities', '--json'], ['verify-agent-output', 'verification-runtime.mjs', 'capabilities', '--json']],
  [['loop', 'capabilities'], ['run-agent-verify-loop', 'loop-runtime.mjs', 'capabilities']],
  // 失败形状同样要等价：这三个入口在无效输入上各有自己的错误载荷与非零退出码。
  [['loop', '--help'], ['run-agent-verify-loop', 'loop-runtime.mjs', '--help']],
  [['host', 'cache'], ['orchestrate-subagents', 'host_capability_cache.mjs']],
  [['host', 'model-policy', '--help'], ['orchestrate-subagents', 'resolve_model_policy.mjs', '--help']],
  [['verify', 'digest', '--kind', 'contract'], ['verify-agent-output', 'verification-runtime.mjs', 'digest', '--kind', 'contract']],
];

test('facade 转发与直接调用旧入口在 stdout、stderr 与退出码上完全等价', () => {
  for (const [viaCli, viaScript] of EQUIVALENT) {
    const [skill, name, ...args] = viaScript;
    const fresh = run([CLI, ...viaCli]);
    const legacy = run([script(skill, name), ...args]);
    const label = `agentkit ${viaCli.join(' ')}`;
    assert.equal(fresh.stdout, legacy.stdout, `${label}: stdout 不一致`);
    assert.equal(fresh.stderr, legacy.stderr, `${label}: stderr 不一致`);
    assert.equal(fresh.status, legacy.status, `${label}: 退出码不一致`);
  }
});

test('facade 覆盖了每个域与每个二级工具', () => {
  const covered = new Set(EQUIVALENT.map(([viaCli]) => viaCli.slice(0, viaCli[0] === 'orchestrate' || viaCli[0] === 'host' ? 2 : 1).join(' ')));
  for (const expected of ['worktree', 'contract', 'verify', 'loop', 'orchestrate ledger', 'orchestrate preflight', 'orchestrate review-budget', 'orchestrate reflection', 'host cache', 'host model-policy']) {
    assert.ok(covered.has(expected), `等价性用例未覆盖 ${expected}`);
  }
});

test('未知域与缺工具名 fail closed，且提示只写 stderr', () => {
  const unknown = run([CLI, 'nope']);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /未知域/u);
  const noTool = run([CLI, 'orchestrate']);
  assert.equal(noTool.status, 2);
  assert.equal(noTool.stdout, '');
  assert.match(noTool.stderr, /ledger, preflight, review-budget, reflection/u);
});

test('capabilities 聚合逐字段保留各 Skill 的原始载荷', () => {
  const aggregated = JSON.parse(run([CLI, 'capabilities', '--json']).stdout);
  assert.equal(aggregated.cli, 'agentkit');
  assert.equal(typeof aggregated.cli_version, 'string');
  assert.match(aggregated.runtime_bundle_digest, /^sha256:[0-9a-f]{64}$/u);
  for (const [skill, name] of [
    ['orchestrate-subagents', 'orchestration-ledger.mjs'],
    ['manage-worktrees', 'worktree-mgr.mjs'],
    ['verify-agent-output', 'verification-runtime.mjs'],
    ['run-agent-verify-loop', 'loop-runtime.mjs'],
  ]) {
    const direct = JSON.parse(run([script(skill, name), 'capabilities', '--json']).stdout);
    assert.deepEqual(aggregated.skills[skill], direct, `${skill} 能力载荷被聚合层改写`);
  }
});

test('docs 只输出参考文档原文，缺主题时列索引', () => {
  const domains = run([CLI, 'docs']);
  assert.equal(domains.status, 0);
  assert.deepEqual(domains.stdout.trim().split('\n'), ['loop', 'orchestrate', 'verify', 'worktree']);

  const index = run([CLI, 'docs', 'verify']);
  assert.equal(index.status, 0);
  assert.deepEqual(index.stdout.trim().split('\n'), ['evidence-schema', 'input-preparation', 'verification-protocol']);

  const raw = run([CLI, 'docs', 'verify', 'evidence-schema']);
  assert.equal(raw.status, 0);
  assert.equal(raw.stdout, readFileSync(join(ROOT, 'docs', 'verify', 'evidence-schema.md'), 'utf8'));

  const missing = run([CLI, 'docs', 'verify', 'nope']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /没有主题/u);
  assert.deepEqual(missing.stdout.trim().split('\n'), ['evidence-schema', 'input-preparation', 'verification-protocol']);

  const badDomain = run([CLI, 'docs', 'nope']);
  assert.equal(badDomain.status, 2);
  assert.equal(badDomain.stdout, '');
});

test('顶层 doctor 检查安装健康，不把缺少状态选择器误报成域故障', () => {
  const result = run([CLI, 'doctor', '--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.healthy, true);
  assert.equal(report.checks.node.healthy, true);
  assert.equal(report.checks.git.healthy, true);
  assert.equal(report.checks.manifest.healthy, true);
  assert.equal(report.checks.manifest.package_version, report.cli_version);
  assert.match(report.runtime_bundle_digest, /^sha256:[0-9a-f]{64}$/u);
  for (const skill of ['orchestrate-subagents', 'manage-worktrees', 'verify-agent-output', 'run-agent-verify-loop']) {
    assert.equal(report.skills[skill].installed, true, `doctor 缺少 ${skill}`);
    assert.equal(report.skills[skill].healthy, true, `${skill} capabilities 失败`);
    assert.equal(report.skills[skill].state_doctor, 'requires_explicit_state');
  }
  const contextual = run([CLI, 'doctor', '--ledger', '/tmp/example']);
  assert.equal(contextual.status, 2);
  assert.match(contextual.stderr, /对应域的 doctor/u);
});
