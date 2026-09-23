import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// domains/worktree/worktree-mgr*.test.mjs 共用的 fixture 与 CLI 调用辅助。放在 tests/ 下而不是
// domains/worktree/：package.json 的 files 只排除 *.test.mjs，普通模块放进 domains/ 会被打进发布包。

const MANAGER = join(dirname(fileURLToPath(import.meta.url)), '../../domains/worktree/worktree-mgr.mjs');

/** @param {string} cwd @param {string[]} args */
export function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** @param {string} path */
export function contentSha(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

/** @param {string} cwd @param {string[]} args */
export function manager(cwd, args) {
  return execFileSync(process.execPath, [MANAGER, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORKTREE_ROOT: join(dirname(cwd), '.worktrees') },
  }).trim();
}

/** 同 manager，但保留退出码：断言"这条命令仍然以 0 退出"时不能靠 execFileSync 抛不抛异常。
 * @param {string} cwd @param {string[]} args */
export function managerExit(cwd, args) {
  const result = spawnSync(process.execPath, [MANAGER, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WORKTREE_ROOT: join(dirname(cwd), '.worktrees') },
  });
  return { status: result.status, stdout: String(result.stdout ?? '').trim() };
}

/** @param {string} cwd @param {string[]} args @param {Record<string,string|undefined>} overrides */
export function managerWithEnvironment(cwd, args, overrides) {
  const env = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return execFileSync(process.execPath, [MANAGER, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  }).trim();
}

/** @param {string} cwd @param {string[]} args */
export function managerKeep(cwd, args) {
  try {
    manager(cwd, args);
    assert.fail('KEEP command should exit non-zero');
  } catch (error) {
    assert.equal(error.status, 1);
    return String(error.stdout ?? '').trim();
  }
}

/** @param {string} cwd @param {string[]} args */
export function managerAsync(cwd, args) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [MANAGER, ...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, WORKTREE_ROOT: join(dirname(cwd), '.worktrees') },
      },
      (error, stdout, stderr) => resolvePromise({ error, stdout, stderr }),
    );
  });
}

export function makeRepo() {
  const sandbox = mkdtempSync(join(tmpdir(), 'worktree-mgr-test-'));
  const repo = join(sandbox, 'generic-repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'trunk']);
  git(repo, ['config', 'user.name', 'Manager Test']);
  git(repo, ['config', 'user.email', 'manager-test@example.invalid']);
  // Git 的自动维护会 detach 成后台进程往 .git 里写；fixture 目录随时会被 teardown 删掉，
  // 不给它留任何自发写入的理由。
  git(repo, ['config', 'gc.auto', '0']);
  git(repo, ['config', 'maintenance.auto', 'false']);
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'chore: init']);
  // maxRetries 只兜底 teardown 与宿主 indexer/AV 之类外部扫描的瞬时占用；测试自己起的
  // 后台写入者必须在 cleanup 之前被停掉，不能靠重试掩盖。
  return {
    sandbox,
    repo,
    cleanup: () => rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  };
}

export function makeRemoteRepo() {
  const fixture = makeRepo();
  const remote = join(fixture.sandbox, 'origin.git');
  mkdirSync(remote);
  git(remote, ['init', '--bare']);
  // receive-pack 收包后会触发同样会 detach 的自动 gc，裸源仓与工作仓一起关掉。
  git(remote, ['config', 'gc.auto', '0']);
  git(remote, ['config', 'maintenance.auto', 'false']);
  git(remote, ['config', 'receive.autogc', 'false']);
  git(fixture.repo, ['remote', 'add', 'origin', remote]);
  git(fixture.repo, ['push', 'origin', 'trunk:main']);
  git(fixture.repo, ['fetch', 'origin', 'main']);
  return { ...fixture, remote };
}

export function publishProfile(fixture, message = 'chore: publish worktree profile') {
  git(fixture.repo, ['add', '.worktree-trace.json']);
  git(fixture.repo, ['commit', '-m', message]);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
}

export function configureGitlabSubmit(fixture) {
  writeFileSync(
    join(fixture.repo, '.worktree-trace.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        default_base: 'origin/main',
        change_request: {
          provider: 'gitlab',
          remote: 'origin',
          target_branch: 'main',
          remove_source_branch: true,
        },
      },
      null,
      2,
    )}\n`,
  );
  publishProfile(fixture);
  git(fixture.remote, ['config', 'receive.advertisePushOptions', 'true']);
  const hook = join(fixture.remote, 'hooks', 'pre-receive');
  writeFileSync(
    hook,
    `#!/bin/sh
log="$(dirname "$0")/push-options.log"
printf '%s\n' "$GIT_PUSH_OPTION_0" "$GIT_PUSH_OPTION_1" "$GIT_PUSH_OPTION_2" "$GIT_PUSH_OPTION_3" "$GIT_PUSH_OPTION_4" > "$log"
cat >/dev/null
`,
  );
  chmodSync(hook, 0o755);
  return join(fixture.remote, 'hooks', 'push-options.log');
}

export async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  assert.fail(message);
}

/** watcher 是 detached 进程组 leader；负号 pid 一次探到 worker 和它在途的 git 子进程。 */
export function processGroupIsAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function prepareReviewTask(fixture, task) {
  manager(fixture.repo, [
    'spawn',
    task,
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    `watch-${task}`,
    '--purpose',
    'auto reclaim fixture',
  ]);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, 'feature.txt'), `${task}\n`);
  git(worktree, ['add', 'feature.txt']);
  git(worktree, ['commit', '-m', `feat: ${task}`]);
  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  // 这些 fixture 要么随后显式 watch，要么根本不关心监听；用 --no-watch 退出默认自动武装，
  // 保持各用例原本的武装语义，并避免留下与用例无关的 watcher 进程。
  manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--note', 'fixture MR created', '--no-watch']);
  return { worktree };
}

export function prepareWatchedTask(fixture, task) {
  const prepared = prepareReviewTask(fixture, task);
  const output = manager(fixture.repo, [
    'watch',
    task,
    '--target',
    'origin/main',
    '--interval-ms',
    '100',
    '--change-ref',
    `MR !${task}`,
    '--notify',
    'off',
  ]);
  assert.match(output, /watcher 已启动/);
  return prepared;
}

export function recordFor(fixture, task, includeAll = false) {
  const args = ['list'];
  if (includeAll) args.push('--all');
  args.push('--json');
  const listing = JSON.parse(manager(fixture.repo, args));
  return (
    listing.worktrees.find((row) => row.record?.task === task)?.record ??
    listing.records.find((record) => record.task === task)
  );
}

export function worktreeFor(fixture, task) {
  return recordFor(fixture, task).path;
}

export function branchFor(fixture, task) {
  return recordFor(fixture, task).branch;
}

/** 造一个本地裸源仓，供 `git submodule add` 用 file 协议克隆，不依赖网络。 */
export function makeSubmoduleSource(fixture) {
  const source = join(fixture.sandbox, 'submodule-source');
  mkdirSync(source);
  git(source, ['init', '-q', '-b', 'main']);
  git(source, ['config', 'user.name', 'Manager Test']);
  git(source, ['config', 'user.email', 'manager-test@example.invalid']);
  writeFileSync(join(source, 'lib.txt'), 'submodule fixture\n');
  git(source, ['add', 'lib.txt']);
  git(source, ['commit', '-m', 'chore: submodule init']);
  return source;
}

/**
 * 在 fixture.repo 的 trunk 上登记一个 submodule（供后续 spawn 的 task 分支带上）。
 * `ignoreAll` 用于隔离测试：设 `submodule.<path>.ignore=all` 后顶层 `git status --porcelain`
 * 不再反映 submodule 内部脏状态，才能验证 reclaim 自己的逐 submodule 检查确实生效，
 * 而不是被更早的顶层 dirty 审计先行拦下。
 */
export function addSubmoduleFixture(fixture, { ignoreAll = false } = {}) {
  const source = makeSubmoduleSource(fixture);
  git(fixture.repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'vendor/sub']);
  if (ignoreAll) git(fixture.repo, ['config', '-f', '.gitmodules', 'submodule.vendor/sub.ignore', 'all']);
  git(fixture.repo, ['add', '.gitmodules', 'vendor/sub']);
  git(fixture.repo, ['commit', '-m', 'chore: add submodule fixture']);
}

/** `git worktree add` 不会自动初始化 submodule，测试里需要显式补一步。 */
export function initSubmoduleInWorktree(worktree) {
  git(worktree, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init']);
}

/** 树私有的 submodule 元数据目录：$GIT_COMMON_DIR/worktrees/<id>/modules/。 */
export function submodulesModulesDir(worktree) {
  const gitDir = execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
  return join(gitDir, 'modules');
}

/**
 * 冲突矩阵 fixture：在同一 target 上造出四种关系——同 hunk 冲突、同文件相邻（能自动合但
 * 两支都改了）、结构性冲突（改/删）、完全正交。这正是 patchbay 那轮聚合里只有合到一半
 * 才暴露出来的那几类关系。
 */
export function makeConflictScanFixture(t) {
  const fixture = makeRemoteRepo();
  t.after(fixture.cleanup);
  writeFileSync(join(fixture.repo, 'shared.txt'), 'sentinel = base\nkeep\n');
  writeFileSync(
    join(fixture.repo, 'notes.txt'),
    Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join('\n') + '\n',
  );
  writeFileSync(join(fixture.repo, 'pnpm-lock.yaml'), 'lockfileVersion: 1\n');
  git(fixture.repo, ['add', 'shared.txt', 'notes.txt', 'pnpm-lock.yaml']);
  git(fixture.repo, ['commit', '-m', 'chore: conflict scan baseline']);
  git(fixture.repo, ['push', 'origin', 'HEAD:main']);
  git(fixture.repo, ['fetch', 'origin', 'main']);

  const prepare = (task, mutate) => {
    manager(fixture.repo, [
      'spawn',
      task,
      '--base',
      'origin/main',
      '--agent',
      'codex',
      '--agent-id',
      `${task}-thread`,
      '--purpose',
      '冲突矩阵 fixture',
    ]);
    const worktree = worktreeFor(fixture, task);
    mutate(worktree);
    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-m', `feat: ${task}`]);
    git(worktree, ['push', '-u', 'origin', 'HEAD']);
    manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--no-watch']);
    return worktree;
  };

  const notes = (mutate) => (worktree) => {
    const lines = readFileSync(join(worktree, 'notes.txt'), 'utf8').split('\n');
    mutate(lines);
    writeFileSync(join(worktree, 'notes.txt'), lines.join('\n'));
  };

  // alpha / beta：shared.txt 同一行两种改法（同 hunk），notes.txt 一头一尾（同文件相邻），
  // pnpm-lock.yaml 各自重生成（同 hunk + 产物类）。
  prepare('scan-alpha', (worktree) => {
    writeFileSync(join(worktree, 'shared.txt'), 'sentinel = alpha\nkeep\n');
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 2\n');
    notes((lines) => {
      lines[0] = 'line-1-alpha';
    })(worktree);
  });
  prepare('scan-beta', (worktree) => {
    writeFileSync(join(worktree, 'shared.txt'), 'sentinel = beta\nkeep\n');
    writeFileSync(join(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 3\n');
    notes((lines) => {
      lines[11] = 'line-12-beta';
    })(worktree);
  });
  // gamma：完全正交，只加自己的文件。
  prepare('scan-gamma', (worktree) => writeFileSync(join(worktree, 'only-gamma.txt'), 'gamma\n'));
  // delta：删掉 shared.txt，与 alpha/beta 构成 modify/delete 这类结构性冲突。
  prepare('scan-delta', (worktree) => rmSync(join(worktree, 'shared.txt')));
  return fixture;
}

/** 只判成败、不抛异常的 git 调用，用于 ancestor / config 探测。 */
export function gitOk(cwd, args) {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/** 期望命令失败，返回其 stderr。 */
export function managerStderr(cwd, args) {
  try {
    manager(cwd, args);
    assert.fail('command should exit non-zero');
  } catch (error) {
    if (error?.code === 'ERR_ASSERTION') throw error;
    return String(error.stderr ?? '').trim();
  }
}

/** 建立一个已 push、处于 ready_for_review 的批次输入 feature 树。 */
export function prepareBatchInput(fixture, task, file, content) {
  manager(fixture.repo, [
    'spawn',
    task,
    '--base',
    'origin/main',
    '--agent',
    'codex',
    '--agent-id',
    `batch-${task}`,
    '--purpose',
    `批次输入 ${task}`,
  ]);
  const worktree = worktreeFor(fixture, task);
  writeFileSync(join(worktree, file), content);
  git(worktree, ['add', file]);
  git(worktree, ['commit', '-m', `feat: ${task}`]);
  git(worktree, ['push', '-u', 'origin', 'HEAD']);
  manager(fixture.repo, ['touch', task, '--status', 'ready_for_review', '--no-watch']);
  return worktree;
}

export function freezePlan(fixture, tasks) {
  const plan = JSON.parse(manager(fixture.repo, ['plan-batch', ...tasks, '--target', 'origin/main', '--json']));
  const planPath = join(fixture.sandbox, `plan-${tasks.join('-')}.json`);
  writeFileSync(planPath, JSON.stringify(plan));
  return { plan, planPath };
}

export function batchEvidence(fixture, name = 'device-suite', outcome = 'passed', options = {}) {
  const path = join(fixture.sandbox, `evidence-${name}-${outcome}.json`);
  const manifest = {
    schema_version: 1,
    checks: [
      {
        name,
        environment: options.environment ?? { platform: 'ios', device: 'simulator', os_version: 'test' },
        argv: ['dart', 'test'],
        outcome,
        exit_code: outcome === 'passed' ? 0 : 1,
        evidence_refs: [{ kind: 'report', id: `MR !fixture/${name}`, digest: `sha256:${'b'.repeat(64)}` }],
      },
    ],
  };
  if (!options.omitContract) {
    manifest.contract_digest = Object.hasOwn(options, 'contractDigest')
      ? options.contractDigest
      : `sha256:${'a'.repeat(64)}`;
  }
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}
