// Artifact 身份在 SHA-256 object format 仓库上的行为。
//
// 全仓此前只有 `object_format: 'sha1'` 的 fixture，SHA-256 仓库只是架构文档里的一句承诺。
// 这里在真实 `git init --object-format=sha256` 仓库上跑通「冻结 Artifact → 独立校验」，
// 把现状锁成回归：产物如实报告 sha256、两个 SHA 都是 64 位十六进制、verify-artifact 判 valid，
// 并且 sha1 长度的 SHA 在 sha256 仓库上被拒绝。用例只观察现有行为，不改产品语义。
//
// 放在 tests/ 而不是 domains/worktree/：它验证的是跨域共用的 Artifact Ref 身份口径
// （schema + worktree runtime），而且 domains/ 下的任何文件都会进 Skill 内容摘要。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANAGER = resolve(ROOT, 'domains', 'worktree', 'worktree-mgr.mjs');

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** @param {string} cwd @param {string[]} args @param {string} worktreeRoot */
function manager(cwd, args, worktreeRoot) {
  return execFileSync(process.execPath, [MANAGER, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORKTREE_ROOT: worktreeRoot },
  }).trim();
}

/** @param {string} objectFormat */
function makeRepo(objectFormat) {
  const sandbox = mkdtempSync(join(tmpdir(), `object-format-${objectFormat}-`));
  const repo = join(sandbox, 'repo');
  mkdirSync(repo);
  git(repo, ['init', `--object-format=${objectFormat}`, '-b', 'trunk']);
  git(repo, ['config', 'user.name', 'Object Format Test']);
  git(repo, ['config', 'user.email', 'object-format-test@example.invalid']);
  // Git 的自动维护会 detach 成后台进程往 .git 里写，fixture 目录随时会被 teardown 删掉。
  git(repo, ['config', 'gc.auto', '0']);
  git(repo, ['config', 'maintenance.auto', 'false']);
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'chore: init']);
  return {
    repo,
    worktreeRoot: join(sandbox, '.worktrees'),
    sandbox,
    cleanup: () => rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

test('SHA-256 仓库上 Artifact 身份如实报告 object_format 并通过独立校验', (t) => {
  const fixture = makeRepo('sha256');
  t.after(fixture.cleanup);
  assert.equal(git(fixture.repo, ['rev-parse', '--show-object-format']), 'sha256', '本机 git 不支持 sha256 仓库');

  manager(fixture.repo, ['spawn', 'sha256-artifact', '--agent', 'codex', '--agent-id', 'sha256-thread', '--purpose', 'freeze sha256 artifact'], fixture.worktreeRoot);
  const tracked = JSON.parse(manager(fixture.repo, ['list', '--json'], fixture.worktreeRoot)).worktrees.find((row) => row.kind === 'TRACKED');
  writeFileSync(join(tracked.path, 'artifact.txt'), 'frozen\n');
  git(tracked.path, ['add', 'artifact.txt']);
  git(tracked.path, ['commit', '-m', 'feat: frozen artifact']);

  const artifact = JSON.parse(manager(fixture.repo, ['artifact', 'sha256-artifact', '--json'], fixture.worktreeRoot));
  assert.equal(artifact.object_format, 'sha256');
  assert.match(artifact.base_sha, /^[0-9a-f]{64}$/u);
  assert.match(artifact.artifact_sha, /^[0-9a-f]{64}$/u);

  const binding = JSON.parse(manager(fixture.repo, ['binding', 'sha256-artifact', '--json'], fixture.worktreeRoot));
  assert.equal(binding.head_sha, artifact.artifact_sha);

  const artifactPath = join(fixture.sandbox, 'artifact-ref.json');
  writeFileSync(artifactPath, JSON.stringify(artifact));
  const verified = JSON.parse(manager(fixture.repo, ['verify-artifact', artifactPath, '--json'], fixture.worktreeRoot));
  assert.deepEqual(verified, {
    valid: true,
    repository_id: artifact.repository_id,
    artifact_sha: artifact.artifact_sha,
    object_format: 'sha256',
  });

  // sha256 仓库上的 sha1 形状 SHA 必须被长度门禁拦住，而不是当成"另一种合法 id"放行。
  const truncatedPath = join(fixture.sandbox, 'truncated.json');
  writeFileSync(truncatedPath, JSON.stringify({ ...artifact, artifact_sha: artifact.artifact_sha.slice(0, 40) }));
  assert.throws(() => manager(fixture.repo, ['verify-artifact', truncatedPath, '--json'], fixture.worktreeRoot), /Artifact/u);

  // object_format 自报为 sha1 的 Artifact 在 sha256 仓库上同样拒绝。
  const mismatchPath = join(fixture.sandbox, 'mismatch.json');
  writeFileSync(mismatchPath, JSON.stringify({ ...artifact, object_format: 'sha1' }));
  assert.throws(() => manager(fixture.repo, ['verify-artifact', mismatchPath, '--json'], fixture.worktreeRoot), /Artifact/u);
});

test('SHA-1 仓库上 Artifact 身份保持 40 位口径', (t) => {
  const fixture = makeRepo('sha1');
  t.after(fixture.cleanup);

  manager(fixture.repo, ['spawn', 'sha1-artifact', '--agent', 'codex', '--agent-id', 'sha1-thread', '--purpose', 'freeze sha1 artifact'], fixture.worktreeRoot);
  const tracked = JSON.parse(manager(fixture.repo, ['list', '--json'], fixture.worktreeRoot)).worktrees.find((row) => row.kind === 'TRACKED');
  writeFileSync(join(tracked.path, 'artifact.txt'), 'frozen\n');
  git(tracked.path, ['add', 'artifact.txt']);
  git(tracked.path, ['commit', '-m', 'feat: frozen artifact']);

  const artifact = JSON.parse(manager(fixture.repo, ['artifact', 'sha1-artifact', '--json'], fixture.worktreeRoot));
  assert.equal(artifact.object_format, 'sha1');
  assert.match(artifact.artifact_sha, /^[0-9a-f]{40}$/u);

  const artifactPath = join(fixture.sandbox, 'artifact-ref.json');
  writeFileSync(artifactPath, JSON.stringify(artifact));
  assert.equal(JSON.parse(manager(fixture.repo, ['verify-artifact', artifactPath, '--json'], fixture.worktreeRoot)).valid, true);
});
