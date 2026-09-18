// @ts-check
// 把被测提交的四个 skill 装进该会话的隔离配置目录。
//
// 用的是 README 记载的正式安装方式（`npx skills add … -g --agent '*'`），只改三件事：
// - package 传本地 checkout 路径而不是 GitHub URL——评测要测的是**被测提交**，不是远端 main；
// - `HOME` 与 `CLAUDE_CONFIG_DIR` 指向会话独立目录，`-g` 于是落进该目录而不是用户全局配置；
// - `--copy` 而不是软链，避免会话读到的是仓库工作区的实时内容。
//
// 已实测：`skills add <本地路径> -g` 在 CLAUDE_CONFIG_DIR 下生成 skills/<name>/SKILL.md 四份。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, skillDigests } from './agentkit.mjs';

export const SKILL_NAMES = ['manage-worktrees', 'orchestrate-subagents', 'run-agent-verify-loop', 'verify-agent-output'];

/**
 * @param {{ configDir: string, home: string, source?: string, timeoutMs?: number }} options
 * @returns {{ config_dir: string, skills: Array<{ name: string, path: string }>, content_digests: Record<string, string> }}
 */
export function installSkills({ configDir, home, source = REPO_ROOT, timeoutMs = 300000 }) {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const stdout = execFileSync('npx', ['-y', 'skills', 'add', source, '-g', '--agent', '*', '--skill', '*', '-y', '--copy', '--json'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: join(home, '.config') },
  });
  const installed = JSON.parse(stdout.slice(stdout.indexOf('[')));
  const missing = SKILL_NAMES.filter((name) => !existsSync(join(configDir, 'skills', name, 'SKILL.md')));
  if (missing.length) throw new Error(`skill 安装不完整，缺少：${missing.join(', ')}`);
  return {
    config_dir: configDir,
    skills: installed.map((/** @type {any} */ item) => ({ name: item.name, path: item.path })),
    // content_digest 取自被测提交的运行时本身，是结果里唯一可回溯到源码的锚点。
    content_digests: skillDigests(),
  };
}
