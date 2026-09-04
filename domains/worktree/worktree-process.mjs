// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';

/**
 * 有界执行外部命令。所有 portable runtime 的同步子进程都经由这里收敛 timeout、stdio 与错误形态。
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?:string, timeoutMs?:number, stdio?:any, env?:NodeJS.ProcessEnv}} [options]
 */
export function runFileTry(command, args, options = {}) {
  try {
    const output = execFileSync(command, args, {
      cwd: options.cwd ?? process.cwd(),
      encoding: 'utf8',
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, out: typeof output === 'string' ? output.trim() : '' };
  } catch (error) {
    return {
      ok: false,
      out: error && typeof error === 'object' && 'stdout' in error ? String(error.stdout ?? '').trim() : '',
      error,
    };
  }
}

/**
 * 同时捕获 stdout/stderr，供 Git remote sideband（MR URL 通常写在 stderr）解析。
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?:string, timeoutMs?:number}} [options]
 */
export function runFileCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = String(result.stdout ?? '').trim();
  const stderr = String(result.stderr ?? '').trim();
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout,
    stderr,
    out: [stdout, stderr].filter(Boolean).join('\n'),
    error: result.error ?? null,
  };
}
