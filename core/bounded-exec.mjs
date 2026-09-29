// @ts-check

// runBoundedSync：同步执行一个 check，返回与 spawnSync 兼容的 { status, signal, stdout, stderr, error }。
// 相比裸 spawnSync 的两点行为差异（见 core/bounded-exec-supervisor.mjs 与架构文档 §8.2）：
//   1. 超时回收整个进程组（不仅是直接子进程），孤儿后台进程不会存活污染后续 L0；
//   2. check 正常退出后仍占着管道的后台进程被回收，退出码按 check 自身计，不再误判为超时。
//
// 整个 CLI 与 withLock 回调都是同步的，所以这里坚持同步：由 spawnSync 启动一个同包内的 Node
// supervisor（process.execPath + bounded-exec-supervisor.mjs），经 stdin 传 JSON 规格。supervisor
// 自身以最小 env 运行，check 的 env 严格等于调用方传入的 env，不泄漏父进程环境。

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPERVISOR = join(dirname(fileURLToPath(import.meta.url)), 'bounded-exec-supervisor.mjs');
const DEFAULT_MAX_BUFFER = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2000;
// 外层 spawnSync 只是兜底：正常路径由 supervisor 在 timeoutMs+grace 内自行返回；兜底须给足余量，
// 避免把「supervisor 正常回收中」误判成外层超时。
const FALLBACK_MARGIN_MS = 5000;

/** @param {string|undefined} code @param {string} message */
function makeError(code, message) {
  const error = /** @type {NodeJS.ErrnoException} */ (new Error(message));
  if (code) error.code = code;
  return error;
}

/**
 * @param {string} executable
 * @param {string[]} [args]
 * @param {{cwd?:string, env?:Record<string,string>, timeoutMs?:number|null, maxBuffer?:number, killGraceMs?:number}} [options]
 * @returns {{status:number|null, signal:NodeJS.Signals|null, stdout:string, stderr:string, error:NodeJS.ErrnoException|null}}
 */
export function runBoundedSync(executable, args = [], options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? {};
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const timeoutMs = options.timeoutMs == null ? null : options.timeoutMs;

  const spec = { executable, args, cwd, env, timeoutMs, maxBuffer, killGraceMs };
  const fallbackTimeout = (Number.isFinite(timeoutMs) ? Number(timeoutMs) : 0) + killGraceMs + FALLBACK_MARGIN_MS;
  // stdout / stderr 各自 base64（约 4/3 膨胀）再包进 JSON，外层缓冲给两路各留 2 倍 + 固定 overhead。
  const outerMaxBuffer = maxBuffer * 4 + 1024 * 1024;

  const outer = spawnSync(process.execPath, [SUPERVISOR], {
    input: JSON.stringify(spec),
    // supervisor 自身用空 env：check 只看到 spec.env，父进程环境不经由 supervisor 泄漏。
    env: {},
    encoding: 'utf8',
    maxBuffer: outerMaxBuffer,
    timeout: fallbackTimeout,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let parsed = null;
  if (typeof outer.stdout === 'string' && outer.stdout.length > 0) {
    try {
      parsed = JSON.parse(outer.stdout);
    } catch {
      parsed = null;
    }
  }

  if (!parsed) {
    // supervisor 没能给出结果：兜底把外层错误透传（外层超时 → ETIMEDOUT）。
    const fallbackError = outer.error
      ? /** @type {NodeJS.ErrnoException} */ (outer.error)
      : makeError('ESUPERVISOR', 'bounded-exec supervisor 未返回结果');
    return {
      status: typeof outer.status === 'number' ? outer.status : null,
      signal: outer.signal ?? null,
      stdout: '',
      stderr: typeof outer.stderr === 'string' ? outer.stderr : '',
      error: fallbackError,
    };
  }

  const stdout = Buffer.from(parsed.stdout ?? '', 'base64').toString('utf8');
  const stderr = Buffer.from(parsed.stderr ?? '', 'base64').toString('utf8');
  const error = parsed.error ? makeError(parsed.error.code, parsed.error.message) : null;
  return {
    status: typeof parsed.status === 'number' ? parsed.status : null,
    signal: parsed.signal ?? null,
    stdout,
    stderr,
    error,
  };
}
