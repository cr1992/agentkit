// @ts-check
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runBoundedSync } from '../core/bounded-exec.mjs';

const CORE = join(dirname(dirname(fileURLToPath(import.meta.url))), 'core');
const SUPERVISOR = join(CORE, 'bounded-exec-supervisor.mjs');
const SHELL = '/bin/sh';

/** @param {number} pid */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/** @param {number} pid @param {number} timeoutMs 有界等待 pid 消失，返回 true 表示已回收。 */
async function waitDead(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return !pidAlive(pid);
}

/** @param {string} path @param {number} timeoutMs 有界等待文件出现。 */
async function waitFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, 'utf8').trim()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return existsSync(path);
}

/** @param {(dir: string) => Promise<void>} body */
async function withSandbox(body) {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-exec-test-'));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('超时回收整个进程组：孙进程（后台 sleep）不再存活', async () => {
  await withSandbox(async (dir) => {
    const pidFile = join(dir, 'pid');
    const started = Date.now();
    const result = runBoundedSync(SHELL, ['-c', `sleep 30 & echo $! > ${pidFile}; echo started; wait`], {
      cwd: dir,
      env: {},
      timeoutMs: 800,
      killGraceMs: 500,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.error?.code, 'ETIMEDOUT', 'timeout 必须以 ETIMEDOUT 上报');
    assert.ok(elapsed < 4000, `超时应及时返回，实际 ${elapsed}ms`);
    assert.ok(await waitFile(pidFile, 1000), '后台进程应已写下 pid');
    const bgPid = Number(readFileSync(pidFile, 'utf8').trim());
    const reaped = await waitDead(bgPid, 3000);
    if (!reaped) {
      try {
        process.kill(bgPid, 'SIGKILL');
      } catch {
        // 兜底清理，避免测试留下孤儿。
      }
    }
    assert.ok(reaped, '超时后孙进程必须被回收');
  });
});

test('正常退出但后台占住 stdout：快速返回、status 0、未超时、后台被回收', async () => {
  await withSandbox(async (dir) => {
    const pidFile = join(dir, 'pid');
    const started = Date.now();
    // 后台 sleep 继承 stdout 管道；裸 spawnSync 会等满 timeout 并误判 ETIMEDOUT。
    const result = runBoundedSync(SHELL, ['-c', `sleep 30 & echo $! > ${pidFile}; echo ok; exit 0`], {
      cwd: dir,
      env: {},
      timeoutMs: 3000,
      killGraceMs: 500,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.status, 0, 'check 自身退出码应为 0');
    assert.equal(result.error, null, '不应误判为超时或其他错误');
    assert.ok(elapsed < 2500, `应在 check 退出后立即返回，实际 ${elapsed}ms`);
    assert.match(result.stdout, /ok/);
    const bgPid = Number(readFileSync(pidFile, 'utf8').trim());
    const reaped = await waitDead(bgPid, 3000);
    if (!reaped) {
      try {
        process.kill(bgPid, 'SIGKILL');
      } catch {
        // 兜底清理。
      }
    }
    assert.ok(reaped, '正常退出后残留的后台进程必须被回收');
  });
});

test('可执行文件不存在时保留 spawn 的 ENOENT', () => {
  const result = runBoundedSync('/no/such/executable-xyz-agentkit', [], { timeoutMs: 1000 });
  assert.equal(result.error?.code, 'ENOENT');
  assert.equal(result.status, null);
});

test('输出超过 maxBuffer 时报 ENOBUFS 且整组被回收', async () => {
  await withSandbox(async (dir) => {
    const pidFile = join(dir, 'pid');
    const script = `sleep 30 & echo $! > ${pidFile}; head -c 200000 /dev/zero; wait`;
    const result = runBoundedSync(SHELL, ['-c', script], {
      cwd: dir,
      env: {},
      timeoutMs: 5000,
      maxBuffer: 1000,
      killGraceMs: 500,
    });
    assert.equal(result.error?.code, 'ENOBUFS');
    assert.ok(await waitFile(pidFile, 1000), '后台进程应已写下 pid');
    const bgPid = Number(readFileSync(pidFile, 'utf8').trim());
    const reaped = await waitDead(bgPid, 3000);
    if (!reaped) {
      try {
        process.kill(bgPid, 'SIGKILL');
      } catch {
        // 兜底清理。
      }
    }
    assert.ok(reaped, '输出超限后整组必须被回收');
  });
});

test('env 隔离：check 只看到调用方给的 env，看不到父进程哨兵变量', () => {
  process.env.BOUNDED_EXEC_SENTINEL = 'leaked-from-parent';
  try {
    const isolated = runBoundedSync(SHELL, ['-c', 'printf "%s" "${BOUNDED_EXEC_SENTINEL:-absent}"'], {
      env: {},
      timeoutMs: 1000,
    });
    assert.equal(isolated.stdout, 'absent', '父进程哨兵不应泄漏给 check');
    const passthrough = runBoundedSync(SHELL, ['-c', 'printf "%s" "$BOUNDED_EXEC_SENTINEL"'], {
      env: { BOUNDED_EXEC_SENTINEL: 'explicit' },
      timeoutMs: 1000,
    });
    assert.equal(passthrough.stdout, 'explicit', '调用方显式给的 env 必须透传');
  } finally {
    delete process.env.BOUNDED_EXEC_SENTINEL;
  }
});

test('退出码与信号透传', () => {
  const code = runBoundedSync(SHELL, ['-c', 'exit 3'], { timeoutMs: 1000 });
  assert.equal(code.status, 3);
  assert.equal(code.signal, null);
  assert.equal(code.error, null);

  const signal = runBoundedSync(SHELL, ['-c', 'kill -TERM $$'], { timeoutMs: 1000 });
  assert.equal(signal.signal, 'SIGTERM');
  assert.equal(signal.status, null);
});

test('supervisor 收到 SIGTERM 时先回收整组再退出', async () => {
  await withSandbox(async (dir) => {
    const pidFile = join(dir, 'pid');
    const spec = {
      executable: SHELL,
      args: ['-c', `sleep 30 & echo $! > ${pidFile}; echo ready; wait`],
      cwd: dir,
      env: {},
      timeoutMs: 60000,
      maxBuffer: 1024 * 1024,
      killGraceMs: 500,
    };
    const supervisor = spawn(process.execPath, [SUPERVISOR], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    supervisor.stdin.end(JSON.stringify(spec));
    assert.ok(await waitFile(pidFile, 5000), '后台进程应已写下 pid');
    const bgPid = Number(readFileSync(pidFile, 'utf8').trim());
    supervisor.kill('SIGTERM');
    const reaped = await waitDead(bgPid, 5000);
    if (!reaped) {
      try {
        process.kill(bgPid, 'SIGKILL');
      } catch {
        // 兜底清理。
      }
    }
    assert.ok(reaped, 'supervisor 被 SIGTERM 后必须先回收整组');
  });
});
