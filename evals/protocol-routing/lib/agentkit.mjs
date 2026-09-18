// @ts-check
// 调用「被测提交」自己的 agentkit——不是全局安装的那个。
// 前置状态必须由被测提交的运行时构造，否则构造出来的现场和会话里看到的机制对不上。

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** evals/protocol-routing/lib → 仓库根 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const AGENTKIT_BIN = join(REPO_ROOT, 'bin', 'agentkit.mjs');

/**
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {string}
 */
export function agentkit(args, options = {}) {
  return execFileSync(process.execPath, [AGENTKIT_BIN, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // 显式管住 stderr：构造器会故意去撞机制的拒绝（第 8、10 条），
    // 那些错误是预期结果，不该直接喷到调用方的终端上。
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** @param {string[]} args */
export function agentkitJson(args, options = {}) {
  return JSON.parse(agentkit(args, options));
}

/** 四个 skill 的 content_digest：写进契约的 skill_set，也写进结果元数据。 */
export function skillDigests() {
  const payload = agentkitJson(['capabilities', '--json']);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(/** @type {any} */ (payload).skills)) {
    out[name] = /** @type {any} */ (value).content_digest;
  }
  return out;
}
