// repository identity 的跨 clone 语义（架构文档 ADR-4）：完整 clone 得到同一 identity，
// shallow clone 被明确拒绝。放在 tests/ 下，避免新增文件进入 Skill 内容摘要。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { verifyGitArtifact } from '../domains/verify/verification-runtime.mjs';

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeOrigin() {
  const sandbox = mkdtempSync(join(tmpdir(), 'repository-identity-'));
  const origin = join(sandbox, 'origin');
  git(sandbox, ['init', '-q', '-b', 'trunk', origin]);
  git(origin, ['config', 'user.name', 'Identity Test']);
  git(origin, ['config', 'user.email', 'identity@example.invalid']);
  for (const n of [1, 2, 3]) {
    writeFileSync(join(origin, 'f.txt'), `${n}\n`);
    git(origin, ['add', 'f.txt']);
    git(origin, ['commit', '-q', '-m', `c${n}`]);
  }
  const artifact = {
    object_format: 'sha1',
    base_sha: git(origin, ['rev-parse', 'HEAD~1']),
    artifact_sha: git(origin, ['rev-parse', 'HEAD']),
  };
  return { sandbox, origin, artifact, cleanup: () => rmSync(sandbox, { recursive: true, force: true }) };
}

test('完整 clone 与源仓库得到同一 repository identity，路径和 remote 不参与', (t) => {
  const fixture = makeOrigin();
  t.after(fixture.cleanup);
  const clone = join(fixture.sandbox, 'full-clone');
  git(fixture.sandbox, ['clone', '-q', pathToFileURL(fixture.origin).href, clone]);
  const a = verifyGitArtifact(fixture.artifact, fixture.origin).runtime_repository_identity;
  const b = verifyGitArtifact(fixture.artifact, clone).runtime_repository_identity;
  assert.match(a, /^git:sha1:sha256:[0-9a-f]{64}$/);
  assert.equal(a, b);
});

test('shallow clone 被明确拒绝，而不是算出另一个 identity', (t) => {
  const fixture = makeOrigin();
  t.after(fixture.cleanup);
  const shallow = join(fixture.sandbox, 'shallow-clone');
  git(fixture.sandbox, ['clone', '-q', '--depth', '2', pathToFileURL(fixture.origin).href, shallow]);
  assert.throws(
    () => verifyGitArtifact(fixture.artifact, shallow),
    (error) =>
      error.code === 'stale_precondition' && /shallow clone/.test(error.message) && /--unshallow/.test(error.message),
  );
});
