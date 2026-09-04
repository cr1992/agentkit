// @ts-check
// 1.x 兼容入口的唯一实现。Skill 目录下的旧入口只允许调用它，不得包含任何自己的逻辑。
//
// domain 模块已经被兼容入口的 `export *` 加载；直接复用其 runCli，避免父子进程各加载一次。
// 不打印迁移提示：本阶段的门禁是新旧入口完全等价，提示会污染 stderr 比对。
import { realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertPublicCommandCompatibility, RuntimeBundleError } from './runtime-bundle.mjs';

/** @param {string} moduleUrl 调用方的 import.meta.url */
export function isProcessEntry(moduleUrl) {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl)); }
  catch { return false; }
}

/**
 * 作为进程入口被直接执行时转发给 domain 运行时；被 import 时什么都不做。
 * @param {string} moduleUrl @param {(argv:string[]) => number|undefined} runCli
 * @returns {number|undefined}
 */
export function forwardLegacyEntry(moduleUrl, runCli) {
  if (!isProcessEntry(moduleUrl)) return undefined;
  const argv = process.argv.slice(2);
  const entryPath = fileURLToPath(moduleUrl);
  const skill = basename(dirname(dirname(entryPath)));
  const entryName = basename(entryPath);
  try {
    assertPublicCommandCompatibility({ skill, entryName, command: argv[0] });
  } catch (error) {
    if (!(error instanceof RuntimeBundleError)) throw error;
    process.stderr.write(`agentkit runtime compatibility error: ${error.message}\n`);
    return 3;
  }
  return runCli(argv);
}
