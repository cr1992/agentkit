import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { resolveGitContext } from './worktree-profile.mjs';
import {
  WorktreeTraceError,
  appendTraceEvent,
  initializeTraceStore,
  inspectRecordLock,
  readEventChain,
  readRecordCache,
  rebuildRecordCache,
  recoverRecordLock,
  traceLayout,
} from './worktree-trace.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeTraceFixture() {
  const sandbox = mkdtempSync(join(tmpdir(), 'worktree-trace-test-'));
  const repo = join(sandbox, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'trunk']);
  git(repo, ['config', 'user.name', 'Trace Test']);
  git(repo, ['config', 'user.email', 'trace-test@example.invalid']);
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'chore: init']);
  const context = resolveGitContext(repo);
  initializeTraceStore(context);
  return {
    sandbox,
    repo,
    context,
    cleanup() {
      rmSync(sandbox, { recursive: true, force: true });
    },
  };
}

/** @param {string} commonDir @param {string} worktreeId */
function createRecord(commonDir, worktreeId) {
  return appendTraceEvent({
    commonDir,
    worktreeId,
    eventType: 'created',
    actor: { host: 'test', id: 'creator' },
    mutate(current) {
      assert.equal(current, null);
      return { schema_version: 1, worktree_id: worktreeId, counter: 0, task_status: 'active' };
    },
  });
}

/** @param {string[]} args */
function runWorker(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(TEST_DIR, 'worktree-trace-test-worker.mjs'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`worker exit=${code}\nstdout=${stdout}\nstderr=${stderr}`));
    });
  });
}

test('真实多进程并发 append 不丢 event 且 chain 不分叉', async (t) => {
  const fixture = makeTraceFixture();
  t.after(fixture.cleanup);
  const worktreeId = randomUUID();
  createRecord(fixture.context.common_dir, worktreeId);

  const workerCount = 6;
  const eventsPerWorker = 12;
  await Promise.all(
    Array.from({ length: workerCount }, (_, index) =>
      runWorker([
        fixture.context.common_dir,
        worktreeId,
        String(eventsPerWorker),
        `worker-${index}`,
      ]),
    ),
  );

  const chain = readEventChain(fixture.context.common_dir, worktreeId);
  const record = readRecordCache(fixture.context.common_dir, worktreeId);
  assert.equal(chain.length, 1 + workerCount * eventsPerWorker);
  assert.equal(new Set(chain.map((event) => event.event_id)).size, chain.length);
  assert.equal(record.counter, workerCount * eventsPerWorker);
  assert.equal(record.event_count, chain.length);
  for (let index = 1; index < chain.length; index++) {
    assert.equal(chain[index].previous_event_id, chain[index - 1].event_id);
  }
});

test('同主机死亡 PID 的 stale lock 被接管并写审计 event', (t) => {
  const fixture = makeTraceFixture();
  t.after(fixture.cleanup);
  const worktreeId = randomUUID();
  createRecord(fixture.context.common_dir, worktreeId);
  const lockDir = join(traceLayout(fixture.context.common_dir).locks, `${worktreeId}.lock`);
  mkdirSync(lockDir);
  writeFileSync(
    join(lockDir, 'owner.json'),
    JSON.stringify({
      pid: 99999999,
      hostname: hostname(),
      created_at: new Date(0).toISOString(),
      command: 'crashed-worker',
      token: randomUUID(),
    }),
  );

  appendTraceEvent({
    commonDir: fixture.context.common_dir,
    worktreeId,
    eventType: 'resumed',
    actor: { host: 'test', id: 'recovery' },
    mutate: (current) => ({ ...current, task_status: 'active' }),
  });
  const chain = readEventChain(fixture.context.common_dir, worktreeId);
  assert.deepEqual(chain.slice(-2).map((event) => event.event_type), ['stale_lock_recovered', 'resumed']);
  assert.equal(inspectRecordLock(fixture.context.common_dir, worktreeId).state, 'absent');
});

test('存活进程持锁时 append 超时而不破坏 lock', (t) => {
  const fixture = makeTraceFixture();
  t.after(fixture.cleanup);
  const worktreeId = randomUUID();
  createRecord(fixture.context.common_dir, worktreeId);
  const lockDir = join(traceLayout(fixture.context.common_dir).locks, `${worktreeId}.lock`);
  mkdirSync(lockDir);
  writeFileSync(
    join(lockDir, 'owner.json'),
    JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      created_at: new Date().toISOString(),
      command: 'live-holder',
      token: randomUUID(),
    }),
  );

  assert.throws(
    () =>
      appendTraceEvent({
        commonDir: fixture.context.common_dir,
        worktreeId,
        eventType: 'should_not_write',
        waitTimeoutMs: 40,
        mutate: (current) => ({ ...current }),
      }),
    (error) => error instanceof WorktreeTraceError && error.code === 'LOCK_BUSY',
  );
  assert.equal(inspectRecordLock(fixture.context.common_dir, worktreeId).state, 'held');
  rmSync(lockDir, { recursive: true });
});

test('malformed lock 只有显式 force 才能恢复', (t) => {
  const fixture = makeTraceFixture();
  t.after(fixture.cleanup);
  const worktreeId = randomUUID();
  const lockDir = join(traceLayout(fixture.context.common_dir).locks, `${worktreeId}.lock`);
  mkdirSync(lockDir);
  assert.equal(inspectRecordLock(fixture.context.common_dir, worktreeId).state, 'malformed');
  assert.throws(
    () => recoverRecordLock(fixture.context.common_dir, worktreeId),
    (error) => error instanceof WorktreeTraceError && error.code === 'LOCK_MALFORMED',
  );
  const recovered = recoverRecordLock(fixture.context.common_dir, worktreeId, { forceMalformed: true });
  assert.equal(recovered.recovered, true);
  assert.equal(existsSync(lockDir), false);
});

test('record cache 损坏后可从 chain 重建', (t) => {
  const fixture = makeTraceFixture();
  t.after(fixture.cleanup);
  const worktreeId = randomUUID();
  createRecord(fixture.context.common_dir, worktreeId);
  appendTraceEvent({
    commonDir: fixture.context.common_dir,
    worktreeId,
    eventType: 'updated',
    mutate: (current) => ({ ...current, counter: 7 }),
  });
  const recordPath = join(traceLayout(fixture.context.common_dir).records, `${worktreeId}.json`);
  writeFileSync(recordPath, '{broken');
  assert.throws(
    () => readRecordCache(fixture.context.common_dir, worktreeId),
    (error) => error instanceof WorktreeTraceError && error.code === 'RECORD_CACHE_INVALID',
  );
  const rebuilt = rebuildRecordCache(fixture.context.common_dir, worktreeId);
  assert.equal(rebuilt.counter, 7);
  assert.equal(rebuilt.event_count, 2);
});

test('event 文件名乱序不影响 previous_event_id 权威顺序', (t) => {
  const fixture = makeTraceFixture();
  t.after(fixture.cleanup);
  const worktreeId = randomUUID();
  createRecord(fixture.context.common_dir, worktreeId);
  appendTraceEvent({
    commonDir: fixture.context.common_dir,
    worktreeId,
    eventType: 'updated',
    mutate: (current) => ({ ...current, counter: 1 }),
  });
  const dir = join(traceLayout(fixture.context.common_dir).events, worktreeId);
  const files = readdirSync(dir).map((name) => join(dir, name));
  renameSync(files[0], join(dir, `9999-${randomUUID()}.json`));
  renameSync(files[1], join(dir, `0000-${randomUUID()}.json`));
  assert.deepEqual(readEventChain(fixture.context.common_dir, worktreeId).map((event) => event.event_type), [
    'created',
    'updated',
  ]);
});
