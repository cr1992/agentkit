import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { distributionDigest, skillDistributionRoots } from '../core/content-digest.mjs';
import { canonicalJson, envelopeDigest } from '../domains/orchestrate/contract-tool.mjs';
import { main as ledgerMain, skillContentDigest as ledgerDigest } from '../domains/orchestrate/orchestration-ledger.mjs';
import { skillContentDigest as loopDigest } from '../domains/loop/loop-runtime.mjs';
import { skillContentDigest as verifyDigest } from '../domains/verify/verification-runtime.mjs';
import { worktreeSkillDigest } from '../domains/worktree/worktree-core.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// 造一个最小包结构：包根有 core/schemas/bin，外加一个 Skill 目录。
function fakePackage(base, marker) {
  mkdirSync(join(base, 'core'), { recursive: true });
  mkdirSync(join(base, 'schemas'), { recursive: true });
  mkdirSync(join(base, 'bin'), { recursive: true });
  mkdirSync(join(base, 'demo-skill', 'scripts'), { recursive: true });
  mkdirSync(join(base, 'demo-skill', 'agents'), { recursive: true });
  writeFileSync(join(base, 'shell-manifest.json'), `{"marker":"${marker}"}\n`);
  writeFileSync(join(base, 'core', 'digest.mjs'), `core ${marker}\n`);
  writeFileSync(join(base, 'schemas', 'thing-v1.schema.json'), `{"marker":"${marker}"}\n`);
  writeFileSync(join(base, 'bin', 'agentkit.mjs'), `router ${marker}\n`);
  writeFileSync(join(base, 'demo-skill', 'SKILL.md'), `skill ${marker}\n`);
  writeFileSync(join(base, 'demo-skill', 'agents', 'openai.yaml'), `agent ${marker}\n`);
  writeFileSync(join(base, 'demo-skill', 'scripts', 'runtime.mjs'), `runtime ${marker}\n`);
  return skillDistributionRoots({ packageRoot: base, skillRoot: join(base, 'demo-skill') });
}

test('摘要覆盖 Skill、domain 依赖、共享 core、schema 与 shell manifest，不覆盖 CLI 路由', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'content-digest-scope-'));
  try {
    const roots = fakePackage(join(sandbox, 'pkg'), 'same');
    const base = distributionDigest(roots);

    // core 与 schemas 是执行真正依赖的内容，改动必须体现在摘要里。
    writeFileSync(join(sandbox, 'pkg', 'core', 'digest.mjs'), 'core changed\n');
    const afterCore = distributionDigest(roots);
    assert.notEqual(afterCore, base, 'core 变化未反映在摘要中');
    writeFileSync(join(sandbox, 'pkg', 'schemas', 'thing-v1.schema.json'), '{"marker":"changed"}\n');
    assert.notEqual(distributionDigest(roots), afterCore, 'schema 变化未反映在摘要中');
    const afterSchema = distributionDigest(roots);
    writeFileSync(join(sandbox, 'pkg', 'shell-manifest.json'), '{"marker":"changed"}\n');
    assert.notEqual(distributionDigest(roots), afterSchema, 'shell manifest 变化未反映在摘要中');

    // CLI 路由只决定命令怎么分发，不参与执行语义；改它不应让所有域一起 re-contract。
    const beforeRouter = distributionDigest(roots);
    writeFileSync(join(sandbox, 'pkg', 'bin', 'agentkit.mjs'), 'router changed\n');
    assert.equal(distributionDigest(roots), beforeRouter, 'CLI 路由不应进入域级摘要');
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test('摘要与安装绝对路径无关', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'content-digest-path-'));
  try {
    const one = fakePackage(join(sandbox, 'install-one'), 'same');
    const two = fakePackage(join(sandbox, 'a', 'deeper', 'install-two'), 'same');
    assert.equal(distributionDigest(two), distributionDigest(one));
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test('四个域使用同一套摘要口径', () => {
  // 运行时迁入 domains/ 后，各域的摘要各自覆盖自己的 domain 目录，值必然不同。
  // 要守的是它们由同一个函数、按同一套根算出，而不是四份各写各的遍历。
  for (const [digest, skill, domain] of [
    [verifyDigest, 'verify-agent-output', 'verify'],
    [loopDigest, 'run-agent-verify-loop', 'loop'],
    [ledgerDigest, 'orchestrate-subagents', 'orchestrate'],
    [worktreeSkillDigest, 'manage-worktrees', 'worktree'],
  ]) {
    const expected = distributionDigest(skillDistributionRoots({
      packageRoot: ROOT, skillRoot: join(ROOT, skill), domainRoot: join(ROOT, 'domains', domain),
      docsRoot: join(ROOT, 'docs', domain),
    }));
    assert.equal(digest(), expected, `${skill} 的摘要不是由共享实现算出`);
  }
  // 四者互不相同：各自覆盖了不同的 domain。
  const all = new Set([verifyDigest(), loopDigest(), ledgerDigest(), worktreeSkillDigest()]);
  assert.equal(all.size, 4);
});

test('摘要漂移后：旧 ledger 只读可检查并同时报告两个摘要，写入必须 re-contract', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'content-digest-drift-'));
  try {
    const contract = {
      schema_version: 1,
      contract_id: 'drift-contract',
      objective: '验证摘要漂移后的迁移语义',
      scope: { include: ['result.txt'], exclude: [] },
      acceptance: [{ contract_item_id: 'item-1', requirement: 'result.txt 非空' }],
      permissions: { mode: 'read_only', writable_paths: [] },
      environment: { repository: join(sandbox, 'repo'), isolation: 'caller_supplied' },
      skill_set: [{ name: 'orchestrate-subagents', version: '1.0.0', content_digest: ledgerDigest(), provider_mode: 'primary' }],
      stop_conditions: [],
      extensions: {},
    };
    contract.contract_digest = envelopeDigest(contract, 'contract_digest');
    mkdirSync(join(sandbox, 'repo'), { recursive: true });
    const contractPath = join(sandbox, 'contract.json');
    writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    const ledger = ledgerMain(['init', '--contract', contractPath, '--state-root', join(sandbox, 'state')]);
    const dir = ledger.ledger_dir;

    // 把冻结摘要改成一个不同的值，模拟「这份状态是在旧代码上冻结的」。
    const drifted = `sha256:${'0'.repeat(64)}`;
    const journalPath = join(dir, 'events.ndjson');
    const events = readFileSync(journalPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    let previous = null;
    const rewritten = events.map((event) => {
      const next = { ...event, previous_event_digest: previous, snapshot: { ...event.snapshot, skill_provenance: { ...event.snapshot.skill_provenance, content_digest: drifted } } };
      delete next.event_digest;
      next.event_digest = envelopeDigest(next, 'event_digest');
      previous = next.event_digest;
      return next;
    });
    writeFileSync(journalPath, `${rewritten.map((event) => canonicalJson(event)).join('\n')}\n`);
    writeFileSync(join(dir, 'snapshot.json'), `${JSON.stringify(rewritten.at(-1).snapshot, null, 2)}\n`);

    // 只读检查必须仍然可用，并且同时给出历史与当前摘要。
    const health = ledgerMain(['doctor', '--ledger', dir]);
    assert.equal(health.healthy, false);
    assert.ok(health.findings.includes('skill_drift'), health.findings.join(','));
    assert.equal(health.frozen_content_digest, drifted);
    assert.equal(health.current_content_digest, ledgerDigest());

    // 写入路径必须 fail closed，要求 re-contract，而不是在漂移后的代码上继续推进。
    const nodePath = join(sandbox, 'node.json');
    writeFileSync(nodePath, `${JSON.stringify({ node_id: 'n1', title: 'x', contract_items: ['item-1'] }, null, 2)}\n`);
    assert.throws(() => ledgerMain(['add-node', '--ledger', dir, '--input', nodePath]), /skill_drift/u);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});
