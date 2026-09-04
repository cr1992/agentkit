import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  PROFILE_FILENAME,
  WorktreeProfileError,
  claimWorktreeRepositoryRoot,
  ensureRepositoryIdentity,
  loadRepositoryProfile,
  resolveGitContext,
  resolveSpawnPlan,
  validateProfile,
} from './worktree-profile.mjs';

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRepo() {
  const sandbox = mkdtempSync(join(tmpdir(), 'worktree-profile-test-'));
  const repo = join(sandbox, 'portable-repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'trunk']);
  git(repo, ['config', 'user.name', 'Worktree Test']);
  git(repo, ['config', 'user.email', 'worktree-test@example.invalid']);
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'chore: init fixture']);
  return {
    sandbox,
    repo,
    cleanup() {
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

/** @param {string} repo @param {Record<string, unknown>} profile */
function writeProfile(repo, profile) {
  writeFileSync(join(repo, PROFILE_FILENAME), `${JSON.stringify(profile, null, 2)}\n`);
}

function genericProfile(overrides = {}) {
  return {
    schema_version: 1,
    default_base: null,
    branch_template: 'worktree/{task}',
    path_template: '../{repo}-{task}',
    worktree_root: '..',
    task_naming: { mode: 'slug', example: 'feature-name' },
    scan: { sources: ['git_worktrees', 'recent_commits'] },
    ephemeral_path_patterns: [],
    extensions: {},
    ...overrides,
  };
}

test('零配置仓库使用 portable 默认值和 HEAD base', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);

  const root = join(realpathSync(fixture.sandbox), '.worktrees');
  const plan = resolveSpawnPlan({
    cwd: fixture.repo,
    task: 'safe-task',
    host: 'agent',
    worktreeId: '12345678-1234-4234-8234-123456789abc',
    repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    worktreeRootOverride: root,
  });
  assert.equal(plan.profile_source, 'defaults');
  assert.equal(plan.branch, 'agent/safe-task');
  assert.equal(plan.repository_root, resolve(root, 'portable-repo'));
  assert.equal(plan.path, resolve(root, 'portable-repo', 'agent-safe-task'));
  assert.equal(plan.base_ref, 'HEAD');
  assert.equal(plan.base_source, 'head');
  assert.equal(plan.profile.ephemeral_path_patterns.includes('/var/folders/'), true);
  assert.equal(plan.profile.ephemeral_path_patterns.includes('/private/var/folders/'), true);
  assert.deepEqual(plan.profile.change_request, {
    provider: 'manual',
    remote: 'origin',
    target_branch: null,
    remove_source_branch: true,
  });
});

test('CLI base 覆盖 Profile default_base', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  writeProfile(fixture.repo, genericProfile({ default_base: 'missing/profile-base' }));

  const plan = resolveSpawnPlan({ cwd: fixture.repo, task: 'base-override', base: 'HEAD' });
  assert.equal(plan.base_ref, 'HEAD');
  assert.equal(plan.base_source, 'cli');
});

test('linked worktree 始终读取 primary worktree Profile', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  writeProfile(
    fixture.repo,
    genericProfile({
      branch_template: 'agent/{task}',
      path_template: '../portable-repo-{task}',
    }),
  );
  git(fixture.repo, ['add', PROFILE_FILENAME]);
  git(fixture.repo, ['commit', '-m', 'chore: add profile']);

  const linked = join(fixture.sandbox, 'linked tree');
  git(fixture.repo, ['worktree', 'add', '-b', 'feature/profile-drift', linked]);
  writeProfile(
    linked,
    genericProfile({
      branch_template: 'drift/{task}',
      path_template: '../drift-{task}',
    }),
  );

  const loaded = loadRepositoryProfile({ cwd: linked });
  const plan = resolveSpawnPlan({ cwd: linked, task: 'same-source' });
  assert.equal(loaded.profile_source, 'primary');
  assert.equal(loaded.profile_path, join(realpathSync(fixture.repo), PROFILE_FILENAME));
  assert.equal(plan.branch, 'agent/same-source');
  assert.equal(plan.path, join(realpathSync(fixture.sandbox), 'portable-repo-same-source'));
});

test('非法 task 在任何 branch/path/repository identity 副作用前拒绝', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const initialBranches = git(fixture.repo, ['branch', '--format=%(refname:short)']);
  const traceRoot = join(fixture.repo, '.git', 'worktree-trace');
  const candidates = [
    '../../evil',
    'bad/task',
    'bad\\task',
    'has space',
    'line\nbreak',
    '.hidden',
    'tail.',
    'a..b',
    `a${'x'.repeat(64)}`,
  ];

  for (const task of candidates) {
    assert.throws(
      () => resolveSpawnPlan({ cwd: fixture.repo, task }),
      (error) => error instanceof WorktreeProfileError && error.code === 'INVALID_TASK_SLUG',
      task,
    );
  }
  assert.equal(git(fixture.repo, ['branch', '--format=%(refname:short)']), initialBranches);
  assert.equal(existsSync(traceRoot), false);
});

test('semantic 命名 DoD 在任何 worktree 副作用前 fail-closed', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  writeProfile(fixture.repo, genericProfile({
    branch_template: '{host}/{task}',
    path_template: '{host}-{task}',
    task_naming: { mode: 'semantic', example: 'ci-gate-hardening' },
  }));
  const initialBranches = git(fixture.repo, ['branch', '--format=%(refname:short)']);

  for (const task of ['trace-9', 'TRACE-NINE', '1234', 'singleword']) {
    assert.throws(
      () => resolveSpawnPlan({ cwd: fixture.repo, task }),
      (error) => error instanceof WorktreeProfileError && error.code === 'TASK_NAMING_DOD_FAILED',
      task,
    );
  }
  const plan = resolveSpawnPlan({ cwd: fixture.repo, task: 'ci-gate-hardening' });
  assert.equal(plan.task, 'ci-gate-hardening');
  assert.equal(plan.profile.task_naming.mode, 'semantic');
  assert.equal(git(fixture.repo, ['branch', '--format=%(refname:short)']), initialBranches);
  assert.equal(existsSync(join(fixture.repo, '.git', 'worktree-trace')), false);
});

test('branch template 输出必须通过 git check-ref-format --branch', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  writeProfile(fixture.repo, genericProfile({ branch_template: 'bad..ref/{task}' }));

  assert.throws(
    () => resolveSpawnPlan({ cwd: fixture.repo, task: 'valid-task' }),
    (error) => error instanceof WorktreeProfileError && error.code === 'INVALID_BRANCH_NAME',
  );
  assert.equal(existsSync(join(fixture.sandbox, 'portable-repo-valid-task')), false);
});

test('path traversal 和绝对 path template 被 containment 拒绝', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);

  writeProfile(fixture.repo, genericProfile({ path_template: '../../escape-{task}' }));
  assert.throws(
    () => resolveSpawnPlan({ cwd: fixture.repo, task: 'traversal' }),
    (error) => error instanceof WorktreeProfileError && error.code === 'SPAWN_PATH_OUTSIDE_ROOT',
  );

  writeProfile(fixture.repo, genericProfile({ path_template: join(tmpdir(), 'absolute-{task}') }));
  assert.throws(
    () => resolveSpawnPlan({ cwd: fixture.repo, task: 'absolute' }),
    (error) => error instanceof WorktreeProfileError && error.code === 'SPAWN_PATH_OUTSIDE_ROOT',
  );
});

test('真实 symlink escape 被最近已存在祖先 realpath 检出', (t) => {
  const fixture = makeRepo();
  const outside = mkdtempSync(join(tmpdir(), 'worktree-profile-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  t.after(fixture.cleanup);

  const link = join(fixture.sandbox, 'escape-link');
  symlinkSync(outside, link, 'dir');
  writeProfile(fixture.repo, genericProfile({ path_template: '../escape-link/{task}' }));

  assert.throws(
    () => resolveSpawnPlan({ cwd: fixture.repo, task: 'symlink-escape' }),
    (error) => error instanceof WorktreeProfileError && error.code === 'SPAWN_PATH_OUTSIDE_ROOT',
  );
  assert.equal(existsSync(join(outside, 'symlink-escape')), false);
});

test('Profile 严格拒绝未知字段和未知 scan adapter', () => {
  assert.throws(
    () => validateProfile(genericProfile({ typo_field: true })),
    (error) => error instanceof WorktreeProfileError && error.code === 'PROFILE_UNKNOWN_KEY',
  );
  assert.throws(
    () => validateProfile(genericProfile({ scan: { sources: ['mystery_source'] } })),
    (error) => error instanceof WorktreeProfileError && error.code === 'PROFILE_UNKNOWN_SCAN_SOURCE',
  );
  assert.throws(
    () => validateProfile(genericProfile({ change_request: { provider: 'github' } })),
    (error) => error instanceof WorktreeProfileError && error.code === 'PROFILE_UNKNOWN_CHANGE_REQUEST_PROVIDER',
  );
  assert.throws(
    () => validateProfile(genericProfile({ change_request: { provider: 'gitlab', shell_command: 'danger' } })),
    (error) => error instanceof WorktreeProfileError && error.code === 'PROFILE_UNKNOWN_KEY',
  );
  assert.throws(
    () => validateProfile(genericProfile({ task_naming: { mode: 'guess', example: 'ci-gate-hardening' } })),
    (error) => error instanceof WorktreeProfileError && error.code === 'PROFILE_UNKNOWN_TASK_NAMING_MODE',
  );
  assert.throws(
    () => validateProfile(genericProfile({ task_naming: { mode: 'semantic', example: 'singleword' } })),
    (error) => error instanceof WorktreeProfileError && error.code === 'TASK_NAMING_DOD_FAILED',
  );
  assert.throws(
    () => validateProfile(genericProfile({
      branch_template: '{host}/{task_short}-{id8}',
      path_template: '{host}-{task_short}-{id8}',
      task_naming: { mode: 'semantic', example: 'ci-gate-hardening' },
    })),
    (error) => error instanceof WorktreeProfileError && error.code === 'PROFILE_NAMING_DOD_FAILED',
  );
});

test('Profile 拒绝逃出仓库的 scan glob，并包含当前平台临时目录', () => {
  assert.throws(
    () => validateProfile(genericProfile({
      scan: { sources: [{ type: 'kiro_tasks', glob: '../outside/tasks.md' }] },
    })),
    (error) => error instanceof WorktreeProfileError && error.code === 'PROFILE_INVALID_GLOB',
  );
  const profile = validateProfile(genericProfile());
  const normalizedTemp = `${resolve(tmpdir()).replaceAll('\\', '/').replace(/\/+$/, '')}/`;
  assert.equal(profile.ephemeral_path_patterns.includes(normalizedTemp), true);
});

test('Profile 可声明薄 GitLab change-request adapter', () => {
  const profile = validateProfile(genericProfile({
    change_request: {
      provider: 'gitlab',
      remote: 'upstream',
      target_branch: 'trunk',
      remove_source_branch: false,
    },
  }));
  assert.deepEqual(profile.change_request, {
    provider: 'gitlab',
    remote: 'upstream',
    target_branch: 'trunk',
    remove_source_branch: false,
  });
});

test('Profile 可只覆盖需要的 portable 默认字段', () => {
  const profile = validateProfile({
    schema_version: 1,
    branch_template: 'feature/{host}/{task}',
  });
  assert.equal(profile.branch_template, 'feature/{host}/{task}');
  assert.equal(profile.path_template, '{host}-{task}');
  assert.equal(profile.worktree_root, '~/.worktrees');
  assert.deepEqual(profile.scan.sources, ['git_worktrees', 'recent_commits']);
  assert.deepEqual(profile.task_naming, { mode: 'semantic', example: 'ci-gate-hardening' });
  assert.deepEqual(profile.extensions, {});
});

test('旧版 ../ path Profile 未声明 worktree_root 时仍沿用 primary 父目录', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  writeProfile(fixture.repo, {
    schema_version: 1,
    branch_template: 'agent/{task}',
    path_template: '../{repo}-{task}',
    task_naming: { mode: 'slug', example: 'feature-name' },
  });
  const plan = resolveSpawnPlan({ cwd: fixture.repo, task: 'legacy-layout' });
  assert.equal(plan.legacy_layout, true);
  assert.equal(plan.worktree_root_base, realpathSync(fixture.sandbox));
  assert.equal(plan.path, join(realpathSync(fixture.sandbox), 'portable-repo-legacy-layout'));
});

test('集中 root 优先使用短仓库名，同名 identity 冲突才追加 id8', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const rootBase = join(realpathSync(fixture.sandbox), '.worktrees');
  const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const first = claimWorktreeRepositoryRoot({
    root_base: rootBase,
    repo_name: 'portable-repo',
    repository_id: firstId,
    primary_worktree: fixture.repo,
  });
  const same = claimWorktreeRepositoryRoot({
    root_base: rootBase,
    repo_name: 'portable-repo',
    repository_id: firstId,
    primary_worktree: fixture.repo,
  });
  const collision = claimWorktreeRepositoryRoot({
    root_base: rootBase,
    repo_name: 'portable-repo',
    repository_id: secondId,
    primary_worktree: fixture.repo,
  });
  assert.equal(first, join(rootBase, 'portable-repo'));
  assert.equal(same, first);
  assert.equal(collision, join(rootBase, 'portable-repo-bbbbbbbb'));
});

test('semantic task 在 branch/path 保持完整可读且 host 不缩写', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const task = 'admin-console-live-session-local-e2e';
  const plan = resolveSpawnPlan({
    cwd: fixture.repo,
    task,
    host: 'codex',
    worktreeId: '12345678-1234-4234-8234-123456789abc',
    repositoryId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    worktreeRootOverride: join(fixture.sandbox, '.worktrees'),
  });
  assert.equal(plan.task, task);
  assert.equal(plan.task_short.length <= 28, true);
  assert.equal(plan.branch, `codex/${task}`);
  assert.match(plan.path, new RegExp(`codex-${task}$`));
  assert.equal(plan.branch.includes('cx/'), false);
});

test('repository_id 初始化后稳定且位于 git common-dir', (t) => {
  const fixture = makeRepo();
  t.after(fixture.cleanup);
  const context = resolveGitContext(fixture.repo);

  const first = ensureRepositoryIdentity(context);
  const second = ensureRepositoryIdentity(context);
  assert.match(first.repository_id, /^[0-9a-f-]{36}$/);
  assert.equal(second.repository_id, first.repository_id);
  const stored = JSON.parse(
    readFileSync(join(context.common_dir, 'worktree-trace', 'v1', 'repository.json'), 'utf8'),
  );
  assert.equal(stored.repository_id, first.repository_id);
  assert.equal(dirname(context.common_dir), realpathSync(fixture.repo));
});
