import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCAN = join(dirname(fileURLToPath(import.meta.url)), 'worktree-scan.mjs');

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo(profile = null) {
  const sandbox = mkdtempSync(join(tmpdir(), 'worktree-scan-test-'));
  const repo = join(sandbox, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'trunk']);
  git(repo, ['config', 'user.name', 'Scan Test']);
  git(repo, ['config', 'user.email', 'scan-test@example.invalid']);
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  if (profile) writeFileSync(join(repo, '.worktree-trace.json'), `${JSON.stringify(profile, null, 2)}\n`);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'chore: init']);
  return { sandbox, repo, cleanup: () => rmSync(sandbox, { recursive: true, force: true }) };
}

/** @param {string} cwd @param {string[]} args */
function scan(cwd, args) {
  return execFileSync(process.execPath, [SCAN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('零配置仓库只用 portable Git sources，不依赖 .kiro', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.repo, 'local.txt'), 'dirty\n');
  const output = scan(fixture.repo, ['scan', '--target', 'local.txt']);
  assert.match(output, /COLLIDE/);
  assert.match(output, /worktree:repo/);
});

test('kiro_tasks adapter 由 Profile 显式启用', (t) => {
  const fixture = makeRepo({
    schema_version: 1,
    scan: {
      sources: [
        'git_worktrees',
        { type: 'kiro_tasks', glob: '.kiro/specs/*/tasks.md' },
      ],
    },
  });
  t.after(fixture.cleanup);
  const spec = join(fixture.repo, '.kiro', 'specs', 'fixture');
  mkdirSync(spec, { recursive: true });
  writeFileSync(
    join(spec, 'tasks.md'),
    '- [-] FIX-1. fixture\n  - **影响文件或目录**: `src/claimed.ts`\n',
  );
  const output = scan(fixture.repo, ['scan', '--target', 'src/claimed.ts']);
  assert.match(output, /COLLIDE/);
  assert.match(output, /task:\[-\]/);
});

test('Git NUL 路径协议不会把非 ASCII 文件漏报为 CLEAR', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.repo, '中文.txt'), 'dirty\n');
  const output = scan(fixture.repo, ['scan', '--target', '中文.txt']);
  assert.match(output, /COLLIDE/);
  assert.match(output, /中文\.txt/);
});

test('目录 target 与其下已修改文件视为碰撞', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const sourceDir = join(fixture.repo, 'src');
  mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, 'a.ts'), 'base\n');
  git(fixture.repo, ['add', 'src/a.ts']);
  git(fixture.repo, ['commit', '-m', 'chore: add tracked source']);
  writeFileSync(join(sourceDir, 'a.ts'), 'dirty\n');
  const output = scan(fixture.repo, ['scan', '--target', 'src']);
  assert.match(output, /COLLIDE/);
  assert.match(output, /src\/a\.ts/);
});

test('kiro_tasks adapter 使用 Profile 声明的 glob', (t) => {
  const fixture = makeRepo({
    schema_version: 1,
    scan: {
      sources: [{ type: 'kiro_tasks', glob: 'planning/**/work-items.md' }],
    },
  });
  t.after(fixture.cleanup);
  const nested = join(fixture.repo, 'planning', 'mobile', 'phase-one');
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    join(nested, 'work-items.md'),
    '- [-] PORT-1. fixture\n  - **影响文件或目录**: `src/portable.ts`\n',
  );
  const output = scan(fixture.repo, ['scan', '--target', 'src/portable.ts']);
  assert.match(output, /COLLIDE/);
  assert.match(output, /task:\[-\]/);
});
