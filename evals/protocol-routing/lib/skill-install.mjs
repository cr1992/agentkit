// @ts-check
// 把被测提交的四个 skill 装进该会话的隔离配置目录。
//
// 分两步，理由在「每轮装一次」那一段：
//   1. `prepareSkillCache()`：**每轮一次**，真的跑一遍安装器，装进本轮的 skill 缓存；
//   2. `installSkills()`：**每个会话一次**，从缓存把目录复制进该会话的隔离配置目录，不触网。
//
// 用的是 README 记载的正式安装方式（`npx skills add … -g --agent '*'`），只改三件事：
// - package 传本地 checkout 路径而不是 GitHub URL——评测要测的是**被测提交**，不是远端 main；
// - `HOME` 与 `CLAUDE_CONFIG_DIR` 指向独立目录，`-g` 于是落进该目录而不是用户全局配置；
// - `--copy` 而不是软链，避免会话读到的是仓库工作区的实时内容。
//
// ⚠️ 判「装没装上」只看文件系统，不看安装器的退出码。原因是实测出来的：
// `--agent '*'` 会把 skill 铺给安装器认识的全部 79 个 agent，其中只要有一个不支持全局安装
// （2026-09 实测：`Eve does not support global skill installation`），安装器就整体退出码 1、
// 且把四个 skill 都标成 `failed`——而 `CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md` 四份全都在。
// 拿退出码当判据的话，每一个会话都会在这里假失败，整套评测一条都跑不出来。
// 真正要成立的只有一件事：配置目录里有那四份 SKILL.md。安装器的原始回报（退出码 + JSON）
// 一并记进结果，供事后追责，但不参与判定。
//
// ## 为什么要缓存（issue #15 的后续项 3）
//
// 旧实现每个会话都从 npm registry 重装一遍：一轮 33 个会话就是 33 次 `npx -y skills`。
// 既慢，网络一抖还丢样本——n=10 补跑里有 3 个会话因 `ECONNRESET` 记成会话失败。
// 现在每轮只装一次，各会话从缓存复制；复制是纯文件系统操作，**断网也成立**。
// 安装失败在开跑之前就抛（`run.mjs` 在进用例循环前调用 `driver.prepare()`），
// 不再表现成「跑到第几个会话突然丢一个样本」。

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, skillDigests } from './agentkit.mjs';

export const SKILL_NAMES = [
  'manage-worktrees',
  'orchestrate-subagents',
  'run-agent-verify-loop',
  'verify-agent-output',
];

/** 安装器的 JSON 回报；解析不出来就当没有——它不参与判定。 */
function parseInstallerReport(stdout) {
  const start = stdout.indexOf('[');
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 四份 SKILL.md 都在某个 `skills/` 目录下。这是「装上了」的唯一判据。 */
export function skillsComplete(skillsDir) {
  return SKILL_NAMES.every((name) => existsSync(join(skillsDir, name, 'SKILL.md')));
}

/** 默认安装器：真的跑一遍 `npx -y skills add …`。测试把它换成 spy，用来断言「缓存命中时不触网」。 */
function runSkillsInstaller({ source, configDir, home, timeoutMs }) {
  // 用 spawnSync 而不是 execFileSync：退出码非零时也要拿到 stdout / stderr，
  // 否则「安装其实成功了、只是某个无关 agent 报错」这种情形连日志都留不下。
  const result = spawnSync(
    'npx',
    ['-y', 'skills', 'add', source, '-g', '--agent', '*', '--skill', '*', '-y', '--copy', '--json'],
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: join(home, '.config') },
    },
  );
  if (result.error) throw new Error(`skill 安装命令没跑起来：${/** @type {Error} */ (result.error).message}`);
  return { exit_code: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

/**
 * @typedef {{
 *   dir: string,
 *   skills_dir: string,
 *   content_digests: Record<string, string>,
 *   installer: { exit_code: number | null, report: unknown[] } | null,
 *   reused: boolean,
 * }} SkillCache
 */

/**
 * 准备本轮的 skill 缓存：装一次，之后所有会话都从这里复制。
 *
 * **缓存已经完整时直接复用，一个子进程都不起**（`reused: true`）。这条是断网条件下
 * 还能起会话的全部理由，`tests/skill-install.test.mjs` 拿一个「一被调用就抛」的安装器钉着它。
 *
 * @param {{ cacheDir: string, source?: string, timeoutMs?: number, install?: typeof runSkillsInstaller }} options
 * @returns {SkillCache}
 */
export function prepareSkillCache({ cacheDir, source = REPO_ROOT, timeoutMs = 300000, install = runSkillsInstaller }) {
  const home = join(cacheDir, 'home');
  const configDir = join(home, '.claude');
  const skillsDir = join(configDir, 'skills');

  if (skillsComplete(skillsDir)) {
    return { dir: cacheDir, skills_dir: skillsDir, content_digests: skillDigests(), installer: null, reused: true };
  }

  mkdirSync(configDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const result = install({ source, configDir, home, timeoutMs });

  // 唯一的判据：四份 SKILL.md 在不在缓存里。
  const missing = SKILL_NAMES.filter((name) => !existsSync(join(skillsDir, name, 'SKILL.md')));
  if (missing.length) {
    const stderr = String(result.stderr ?? '')
      .trim()
      .slice(-2000);
    throw new Error(
      `skill 安装不完整，缺少：${missing.join(', ')}（安装器退出码 ${result.exit_code}）${stderr ? `\n${stderr}` : ''}`,
    );
  }

  return {
    dir: cacheDir,
    skills_dir: skillsDir,
    // content_digest 取自被测提交的运行时本身，是结果里唯一可回溯到源码的锚点。
    content_digests: skillDigests(),
    // 安装器的原始回报：只留档，不参与判定。
    installer: { exit_code: result.exit_code, report: parseInstallerReport(result.stdout) },
    reused: false,
  };
}

/**
 * 把缓存里的四个 skill 复制进某个会话的隔离配置目录。**不触网、不起任何子进程。**
 *
 * @param {{ configDir: string, home: string, cache: SkillCache }} options
 * @returns {{
 *   config_dir: string,
 *   skills: Array<{ name: string, path: string }>,
 *   content_digests: Record<string, string>,
 *   installer: { exit_code: number | null, report: unknown[] } | null,
 *   source: 'cache',
 * }}
 */
export function installSkills({ configDir, home, cache }) {
  if (!cache?.skills_dir)
    throw new Error('installSkills 需要 prepareSkillCache 产出的缓存；skill 每轮只装一次，会话从缓存复制');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const target = join(configDir, 'skills');
  for (const name of SKILL_NAMES) {
    const from = join(cache.skills_dir, name);
    if (!existsSync(join(from, 'SKILL.md'))) throw new Error(`skill 缓存不完整，缺少 ${name}：${from}`);
    // 每个会话拿到的必须是自己的一份拷贝：会话在 bypassPermissions 下能改自己的配置目录，
    // 共享一份（软链 / 硬链）会让一个会话的改动影响后面所有会话。
    rmSync(join(target, name), { recursive: true, force: true });
    cpSync(from, join(target, name), { recursive: true });
  }
  if (!skillsComplete(target)) throw new Error(`skill 复制后仍不完整：${target}`);

  return {
    config_dir: configDir,
    skills: SKILL_NAMES.map((name) => ({ name, path: join(target, name) })),
    content_digests: cache.content_digests,
    installer: cache.installer,
    source: 'cache',
  };
}
