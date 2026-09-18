// @ts-check
// 把被测提交的四个 skill 装进该会话的隔离配置目录。
//
// 用的是 README 记载的正式安装方式（`npx skills add … -g --agent '*'`），只改三件事：
// - package 传本地 checkout 路径而不是 GitHub URL——评测要测的是**被测提交**，不是远端 main；
// - `HOME` 与 `CLAUDE_CONFIG_DIR` 指向会话独立目录，`-g` 于是落进该目录而不是用户全局配置；
// - `--copy` 而不是软链，避免会话读到的是仓库工作区的实时内容。
//
// ⚠️ 判「装没装上」只看文件系统，不看安装器的退出码。原因是实测出来的：
// `--agent '*'` 会把 skill 铺给安装器认识的全部 79 个 agent，其中只要有一个不支持全局安装
// （2026-09 实测：`Eve does not support global skill installation`），安装器就整体退出码 1、
// 且把四个 skill 都标成 `failed`——而 `CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md` 四份全都在。
// 拿退出码当判据的话，每一个会话都会在这里假失败，整套评测一条都跑不出来。
// 真正要成立的只有一件事：被测会话的配置目录里有那四份 SKILL.md。安装器的原始回报
// （退出码 + JSON）一并记进结果，供事后追责，但不参与判定。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, skillDigests } from './agentkit.mjs';

export const SKILL_NAMES = ['manage-worktrees', 'orchestrate-subagents', 'run-agent-verify-loop', 'verify-agent-output'];

/** 安装器的 JSON 回报；解析不出来就当没有——它不参与判定。 */
function parseInstallerReport(stdout) {
  const start = stdout.indexOf('[');
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/**
 * @param {{ configDir: string, home: string, source?: string, timeoutMs?: number }} options
 * @returns {{
 *   config_dir: string,
 *   skills: Array<{ name: string, path: string }>,
 *   content_digests: Record<string, string>,
 *   installer: { exit_code: number | null, report: unknown[] },
 * }}
 */
export function installSkills({ configDir, home, source = REPO_ROOT, timeoutMs = 300000 }) {
  mkdirSync(configDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  // 用 spawnSync 而不是 execFileSync：退出码非零时也要拿到 stdout / stderr，
  // 否则「安装其实成功了、只是某个无关 agent 报错」这种情形连日志都留不下。
  const result = spawnSync('npx', ['-y', 'skills', 'add', source, '-g', '--agent', '*', '--skill', '*', '-y', '--copy', '--json'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: join(home, '.config') },
  });
  if (result.error) throw new Error(`skill 安装命令没跑起来：${/** @type {Error} */ (result.error).message}`);

  // 唯一的判据：四份 SKILL.md 在不在隔离配置目录里。
  const missing = SKILL_NAMES.filter((name) => !existsSync(join(configDir, 'skills', name, 'SKILL.md')));
  if (missing.length) {
    const stderr = String(result.stderr ?? '').trim().slice(-2000);
    throw new Error(`skill 安装不完整，缺少：${missing.join(', ')}（安装器退出码 ${result.status}）${stderr ? `\n${stderr}` : ''}`);
  }

  return {
    config_dir: configDir,
    skills: SKILL_NAMES.map((name) => ({ name, path: join(configDir, 'skills', name) })),
    // content_digest 取自被测提交的运行时本身，是结果里唯一可回溯到源码的锚点。
    content_digests: skillDigests(),
    // 安装器的原始回报：只留档，不参与判定。
    installer: { exit_code: result.status, report: parseInstallerReport(String(result.stdout ?? '')) },
  };
}
