#!/usr/bin/env node
// @ts-check

// Bounded-exec supervisor：由 core/bounded-exec.mjs 通过 spawnSync 以最小 env 启动，经 stdin 读取一份
// JSON 规格，把待执行的 check 放进独立进程组执行，按字节收集 stdout/stderr，并在超时 / 输出超限 /
// check 退出后统一回收整组残留进程，最后把结果以单个 JSON 写回 stdout。
//
// 进程组语义（POSIX）：spawn(detached:true) 让 check 成为新进程组组长（pgid == child.pid），
// process.kill(-pgid, signal) 因此能覆盖 check fork 出来的后台子孙。已知边界：check 自己 setsid /
// 另起进程组的子孙不在回收范围；supervisor 被 SIGKILL 时也无法执行任何清理。

import { spawn } from 'node:child_process';

const CLOSE_FALLBACK_MS = 2000;

/** @returns {Promise<string>} */
function readStdin() {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/** @param {Buffer[]} chunks @param {number} limit */
function collect(chunks, limit) {
  const joined = Buffer.concat(chunks);
  return joined.length > limit ? joined.subarray(0, limit) : joined;
}

async function main() {
  const spec = JSON.parse(await readStdin());
  const { executable, args, cwd, env, timeoutMs, maxBuffer, killGraceMs } = spec;

  let settled = false;
  let timedOut = false;
  let overflow = false;
  /** @type {ReturnType<typeof setTimeout>|null} */ let killTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let graceTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let closeTimer = null;

  /** @type {Buffer[]} */ const outChunks = [];
  /** @type {Buffer[]} */ const errChunks = [];
  let outBytes = 0;
  let errBytes = 0;
  let exitCode = /** @type {number|null} */ (null);
  let exitSignal = /** @type {string|null} */ (null);

  /** @param {{status:number|null,signal:string|null,stdout:Buffer,stderr:Buffer,error:{code:string,message:string}|null}} result */
  function writeResult(result) {
    const payload = {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout.toString('base64'),
      stderr: result.stderr.toString('base64'),
      error: result.error,
    };
    process.stdout.write(JSON.stringify(payload), () => process.exit(0));
  }

  let child;
  try {
    child = spawn(executable, args, { cwd, env, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const err = /** @type {NodeJS.ErrnoException} */ (error);
    writeResult({
      status: null,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      error: { code: err.code || 'UNKNOWN', message: err.message },
    });
    return;
  }

  const pgid = child.pid;

  /** @param {NodeJS.Signals|number} signal */
  function killGroup(signal) {
    if (!Number.isInteger(pgid) || Number(pgid) <= 0) return;
    try {
      process.kill(-Number(pgid), signal);
    } catch {
      // ESRCH（组已消失）等一律忽略：回收是尽力而为。
    }
  }

  /** @param {{status:number|null,signal:string|null,stdout:Buffer,stderr:Buffer,error:{code:string,message:string}|null}} result */
  function finish(result) {
    if (settled) return;
    settled = true;
    if (killTimer) clearTimeout(killTimer);
    if (graceTimer) clearTimeout(graceTimer);
    if (closeTimer) clearTimeout(closeTimer);
    writeResult(result);
  }

  function onClose() {
    let error = null;
    if (overflow) error = { code: 'ENOBUFS', message: `output exceeded ${maxBuffer} bytes` };
    else if (timedOut) error = { code: 'ETIMEDOUT', message: `check timed out after ${timeoutMs} ms` };
    finish({
      status: exitCode,
      signal: exitSignal,
      stdout: collect(outChunks, maxBuffer),
      stderr: collect(errChunks, maxBuffer),
      error,
    });
  }

  function onOverflow() {
    if (overflow) return;
    overflow = true;
    killGroup('SIGKILL');
  }

  child.stdout?.on('data', (chunk) => {
    outBytes += chunk.length;
    if (outBytes <= maxBuffer) outChunks.push(chunk);
    else onOverflow();
  });
  child.stderr?.on('data', (chunk) => {
    errBytes += chunk.length;
    if (errBytes <= maxBuffer) errChunks.push(chunk);
    else onOverflow();
  });

  child.on('error', (error) => {
    const err = /** @type {NodeJS.ErrnoException} */ (error);
    finish({
      status: null,
      signal: null,
      stdout: collect(outChunks, maxBuffer),
      stderr: collect(errChunks, maxBuffer),
      error: { code: err.code || 'UNKNOWN', message: err.message },
    });
  });

  child.on('exit', (code, signal) => {
    exitCode = code;
    exitSignal = signal;
    // check 自身已退出：立即对整组补一刀，清掉仍占着管道 / 端口的后台子孙，再有界等待 'close'。
    killGroup('SIGKILL');
    closeTimer = setTimeout(onClose, CLOSE_FALLBACK_MS);
  });

  child.on('close', onClose);

  if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
    killTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      graceTimer = setTimeout(() => killGroup('SIGKILL'), killGraceMs);
    }, timeoutMs);
  }

  for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGHUP'])) {
    process.on(signal, () => {
      killGroup('SIGKILL');
      process.exit(1);
    });
  }
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: { code: 'ESUPERVISOR', message: error instanceof Error ? error.message : String(error) },
    }),
    () => process.exit(1),
  );
});
