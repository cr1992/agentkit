// @ts-check
// 会话 PATH 上的 `agentkit` 垫片。
//
// 为什么必须有：四个 SKILL.md 通篇指示调用 **PATH 上的** `agentkit`。真实安装态下那份由
// `npm i -g` 提供；评测现场没有任何全局安装，于是被测会话 `command -v agentkit` 落空，
// 要么降级手搓、要么自己摸到 `node <checkout>/bin/agentkit.mjs`。两种都不是协议失守，
// 但会被记成「没路由到 agentkit」。第一次真实运行的正向第 3–7 条整体被这件事污染
// （issue #15 的缺陷 1）。
//
// 怎么补：给每个会话建一个只含这一个可执行文件的目录，内容是转发到**被测 checkout**
// 的 `bin/agentkit.mjs`，再把该目录拼到会话 PATH 最前。这一层放在驱动器里而不是
// Dockerfile 里，因为容器内外（本机容器、GitHub Actions runner、直接跑）都要生效，
// 而且垫片必须指向那一次评测真正挂进来的 checkout，不是镜像构建时烘进去的某份。
//
// 为什么不 `npm i -g` 被测 checkout：全局安装会写进镜像 / runner 的共享前缀，
// 会话之间不再隔离，且要求网络与写权限；垫片是一个 60 字节的文件，零依赖、零副作用。

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { AGENTKIT_BIN } from './agentkit.mjs';

/** 极简 POSIX shell 单引号转义：路径里出现空格或引号时垫片仍然成立。 */
const quote = (/** @type {string} */ value) => `'${String(value).replace(/'/gu, `'\\''`)}'`;

/**
 * 垫片脚本正文。`exec` 掉自己，所以被测会话看到的退出码、信号与 stdio
 * 和直接跑 `node <checkout>/bin/agentkit.mjs` 完全一致。
 * @param {{ nodePath: string, binPath: string }} options
 */
export function shimScript({ nodePath, binPath }) {
  return `#!/bin/sh\n# 协议路由评测：把 PATH 上的 agentkit 指向被测 checkout。\nexec ${quote(nodePath)} ${quote(binPath)} "$@"\n`;
}

/**
 * 在 `dir` 下建一个可执行的 `agentkit`，返回该目录与文件路径。
 *
 * @param {{ dir: string, binPath?: string, nodePath?: string }} options
 * @returns {{ dir: string, path: string, target: string, node: string }}
 */
export function createAgentkitShim({ dir, binPath = AGENTKIT_BIN, nodePath = process.execPath }) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'agentkit');
  writeFileSync(path, shimScript({ nodePath, binPath }));
  chmodSync(path, 0o755);
  return { dir, path, target: binPath, node: nodePath };
}

/**
 * 把垫片目录拼到 PATH 最前。
 *
 * 注意 `lib/session-env.mjs` 是白名单机制：PATH 由父环境继承而来，所以垫片目录不能
 * 另立一个变量，只能在**覆盖项**里把拼好的 PATH 交回去（覆盖项优先级最高）。
 *
 * @param {string} dir
 * @param {string | undefined} parentPath
 * @returns {string}
 */
export function prependToPath(dir, parentPath) {
  return parentPath ? `${dir}${delimiter}${parentPath}` : dir;
}
