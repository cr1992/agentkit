#!/usr/bin/env node
// @ts-check
/**
 * worktree-scan — 本地 git 感知 + 重叠检查（DESIGN §2.1）
 *
 * 动手改某任务的文件之前调用，扫本机 git 汇集「在飞 + 近期改过」的文件集合：
 *   ① 遍历每棵 worktree（git worktree list --porcelain，路径可能含空格），
 *      git -C <dir> status --porcelain 取改动 + untracked 文件。
 *   ② git log --all --since='6 hours ago' --name-only 近期跨所有本地分支 commit 碰过的文件。
 *   ③ 扫 .kiro/specs 下各 spec 的 tasks.md 里标 [-]（实施中）的任务，提取其「影响文件或目录」字段并入
 *      （覆盖「认领了任务但还没动文件」git 扫不到的情况——母规范 race-2）。
 * 输出三者并集。
 *
 * 给了 --target（逗号分隔文件列表）就打印交集 + 结论（COLLIDE / CLEAR）；
 * 不给就打印整个在飞集合。
 *
 * 安全 / 范围：暂时只管本机、不 git fetch（DESIGN：本期只管本机并发）。
 * 纯只读，不改任何 git 状态。
 *
 * 用法:
 *   node tools/worktree/worktree-scan.mjs scan                       # 打印整个在飞集合
 *   node tools/worktree/worktree-scan.mjs scan --target a.tsx,b.css  # 打印交集 + COLLIDE/CLEAR
 *   node tools/worktree/worktree-scan.mjs --help
 *
 * 退出码: 0 成功（CLEAR 或纯列举）; 0 也用于 COLLIDE（重叠是「需要决策」的信息，不是脚本错误，
 *   决策由调用者/agent 做——脚本职责是如实报告）; 1 = 内部错误（不在 git 仓库等）。
 *
 * 纯 Node stdlib，无第三方依赖。中文注释 + 英文术语。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRepositoryProfile } from './worktree-profile.mjs';

const PREFIX = '[worktree-scan]';

// ───────────────────────────────────────────────────────────────────────────
// git helper：统一封装 execFileSync('git', ...)，失败由调用方按需 try/catch。
// ───────────────────────────────────────────────────────────────────────────
/**
 * @param {string[]} gitArgs
 * @param {{cwd?:string}} [opts]
 * @returns {string}
 */
function git(gitArgs, opts = {}) {
  return execFileSync('git', gitArgs, {
    cwd: opts.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

// ───────────────────────────────────────────────────────────────────────────
// CLI 解析
// ───────────────────────────────────────────────────────────────────────────
function usage() {
  console.log(`${PREFIX} 用法:
  node tools/worktree/worktree-scan.mjs scan
      汇集本机所有 worktree 在飞改动 + 近期 commit 文件 + tasks.md [-] 任务影响文件，打印并集。

  node tools/worktree/worktree-scan.mjs scan --target <逗号分隔文件列表>
      与上面的在飞集合取交集；交集非空 -> COLLIDE，空 -> CLEAR。
      路径以仓库根为基准（如 apps/web/src/...）。

  node tools/worktree/worktree-scan.mjs --help

退出码: 0 成功（含 COLLIDE，重叠是需决策的信息非脚本错误）; 1 内部错误。`);
}

export function runCli(argv = process.argv.slice(2)) {
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  usage();
  return 0;
}

const sub = argv[0];
if (sub !== 'scan') {
  console.error(`${PREFIX} 未知子命令 "${sub}"。`);
  usage();
  return 1;
}

// --target <list> 或 --target=<list>
let targetRaw = null;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--target') {
    targetRaw = argv[i + 1] ?? '';
    i++;
  } else if (a.startsWith('--target=')) {
    targetRaw = a.slice('--target='.length);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 仓库根（脚本可从任意 cwd 调用）
// ───────────────────────────────────────────────────────────────────────────
let ROOT;
let PROFILE;
try {
  ROOT = git(['rev-parse', '--show-toplevel']).trim();
  PROFILE = loadRepositoryProfile({ cwd: ROOT });
} catch {
  console.error(`${PREFIX} 无法加载 Git 仓库或 worktree Profile。`);
  return 1;
}

const SCAN_SOURCES = PROFILE.profile.scan.sources;
const HAS_WORKTREE_SOURCE = SCAN_SOURCES.includes('git_worktrees');
const HAS_RECENT_SOURCE = SCAN_SOURCES.includes('recent_commits');
const KIRO_TASK_SOURCE = SCAN_SOURCES.find(
  (source) => typeof source === 'object' && source !== null && source.type === 'kiro_tasks',
);

// ───────────────────────────────────────────────────────────────────────────
// 路径规范化：把各来源的路径统一成「仓库根为基准的 posix 相对路径」，便于取交集。
//   · worktree status --porcelain 给的是相对该 worktree 根的路径 -> 直接用（worktree 与主树同一仓库视图）。
//   · git log --name-only 给的是相对仓库根的路径 -> 直接用。
//   · tasks.md 影响文件字段写的多是相对 app 的路径（如 src/zones/...），无法可靠定位到仓库根，
//     原样保留（作为「在飞集合」的成员；交集匹配时调用者 --target 用同样写法即可命中，见 normalizeTarget）。
// 这里只做轻量清洗：去首尾空白、去引号、统一反斜杠为正斜杠、去 ./ 前缀、去尾部斜杠。
// ───────────────────────────────────────────────────────────────────────────
/** @param {string} p */
function cleanPath(p) {
  let s = p.trim();
  // 去掉包裹的引号（git status 对含特殊字符的路径会加双引号）
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  if (path.sep === '\\') s = s.replace(/\\/g, '/'); // Windows 分隔符 -> posix；POSIX 保留合法的反斜杠文件名
  s = s.replace(/^\.\//, ''); // 去 ./ 前缀
  s = s.replace(/\/+$/, ''); // 去尾部斜杠（影响目录的情形）
  return s.trim();
}

// ───────────────────────────────────────────────────────────────────────────
// ① 所有 worktree 在飞改动 + untracked
//   解析 git worktree list --porcelain：每条记录以 "worktree <path>" 行开头，
//   路径可能含空格 —— 取 "worktree " 之后的整行剩余（绝不用 awk '{print $2}'，M5）。
// ───────────────────────────────────────────────────────────────────────────
/** @returns {string[]} 各 worktree 绝对路径 */
function listWorktreeDirs() {
  let out;
  try {
    out = git(['worktree', 'list', '--porcelain'], { cwd: ROOT });
  } catch {
    return [];
  }
  const dirs = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      // 取前缀之后的全部，路径含空格也完整保留
      const p = line.slice('worktree '.length);
      if (p) dirs.push(p);
    }
  }
  return dirs;
}

/**
 * 解析单个 worktree 的 git status --porcelain，返回改动/untracked 的仓库相对路径集合。
 * porcelain 行格式：`XY <path>` 或重命名 `R  <old> -> <new>`。
 * @param {string} dir
 * @returns {string[]}
 */
function statusFiles(dir) {
  let out;
  try {
    out = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: dir });
  } catch {
    // 某棵 worktree 不可访问（已被删目录但元数据残留等）——跳过，不致命
    return [];
  }
  const files = [];
  const records = out.split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const target = record.slice(3);
    const cleaned = cleanPath(target);
    if (cleaned) files.push(cleaned);
    // -z 模式下 rename/copy 的当前路径在本条，下一条是原路径；原路径不属于当前写入目标。
    if (/[RC]/.test(status)) index++;
  }
  return files;
}

// ───────────────────────────────────────────────────────────────────────────
// ② 近期跨所有本地分支 commit 碰过的文件（git log --all --since='6 hours ago'）
// ───────────────────────────────────────────────────────────────────────────
/** @returns {string[]} */
function recentCommitFiles() {
  let out;
  try {
    out = git(
      ['log', '--all', '--since=6 hours ago', '--name-only', '-z', '--pretty=format:'],
      { cwd: ROOT },
    );
  } catch {
    return [];
  }
  const files = [];
  for (const line of out.split('\0')) {
    const cleaned = cleanPath(line);
    if (cleaned) files.push(cleaned);
  }
  return files;
}

// ───────────────────────────────────────────────────────────────────────────
// ③ tasks.md 中 [-]（实施中）任务的「影响文件或目录」字段
//   逐文件扫 .kiro/specs 下各 spec 的 tasks.md：
//     · 找 `- [-] ...` 任务行（标记实施中）。
//     · 在该任务块内（到下一个同级或更高级任务行为止）找 `**影响文件或目录**:` 字段。
//     · 从字段值里抽取 backtick 包裹的路径 token（真实 tasks.md 一律 `path` 反引号包裹，
//       含散文与 + / 逗号 / 大括号分隔）。大括号展开（brace expansion）一并处理。
// ───────────────────────────────────────────────────────────────────────────

/** 任务行：`- [x] ID. title`，x ∈ space/-/x。返回 marker 或 null。 */
function taskMarkerOf(line) {
  const m = line.match(/^\s*-\s*\[([ x\-])\]\s/);
  return m ? m[1] : null;
}

/** 字段行：`- **影响文件或目录**: ...` 或 `**影响文件或目录**: ...`（不同缩进）。 */
function impactFieldValue(line) {
  const m = line.match(/\*\*影响文件或目录\*\*\s*[:：]\s*(.*)$/);
  return m ? m[1] : null;
}

/**
 * 从「影响文件或目录」字段值里抽取 backtick 路径 token。
 * 处理大括号展开：`a/{x,y}.tsx` -> a/x.tsx, a/y.tsx。
 * @param {string} value
 * @returns {string[]}
 */
function extractImpactPaths(value) {
  const out = [];
  // 匹配所有 `...` 反引号片段
  const segments = value.match(/`[^`]+`/g) || [];
  for (const seg of segments) {
    const inner = seg.slice(1, -1).trim();
    // 一个反引号片段里可能有多个路径（逗号 / + 分隔）；先按这些分隔切，再各自 brace 展开
    const parts = inner
      .split(/[,+]/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const part of parts) {
      // 只收看起来像路径的（含 / 或常见源码扩展名），过滤掉散文性反引号（如 `N/A`、`[-]`）
      for (const expanded of expandBraces(part)) {
        const cleaned = cleanPath(expanded);
        if (!cleaned) continue;
        if (cleaned.includes('/') || /\.(tsx?|jsx?|css|mjs|cjs|json|go|py|md|ya?ml|proto)$/i.test(cleaned)) {
          out.push(cleaned);
        }
      }
    }
  }
  return out;
}

/**
 * 简易 brace expansion：仅展开单层 `{a,b,c}`。
 * `src/{A,B}.tsx` -> [src/A.tsx, src/B.tsx]；无大括号原样返回。
 * 多组 / 嵌套不展开（tasks.md 实际用法只有单层），原样返回避免误展开。
 * @param {string} s
 * @returns {string[]}
 */
function expandBraces(s) {
  const m = s.match(/^(.*?)\{([^{}]+)\}(.*)$/);
  if (!m) return [s];
  const [, pre, body, post] = m;
  const opts = body.split(',').map((o) => o.trim()).filter(Boolean);
  if (opts.length === 0) return [s];
  // 只递归展开 post 里可能的第二组（保守：post 再有一层也处理）
  const result = [];
  for (const o of opts) {
    for (const tail of expandBraces(post)) {
      result.push(`${pre}${o}${tail}`);
    }
  }
  return result;
}

/** @param {string} segment */
function globSegmentPattern(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replaceAll('*', '[^/]*').replaceAll('?', '[^/]')}$`);
}

/** @param {string} root @param {string} glob */
function expandRepositoryGlob(root, glob) {
  const segments = glob.replaceAll('\\', '/').split('/');
  const found = [];
  const visit = (directory, index) => {
    if (index === segments.length) {
      found.push(directory);
      return;
    }
    const segment = segments[index];
    if (segment === '**') {
      visit(directory, index + 1);
      let entries = [];
      try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) if (entry.isDirectory()) visit(path.join(directory, entry.name), index);
      return;
    }
    const pattern = globSegmentPattern(segment);
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!pattern.test(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (index === segments.length - 1) {
        if (entry.isFile()) found.push(candidate);
      } else if (entry.isDirectory()) {
        visit(candidate, index + 1);
      }
    }
  };
  visit(root, 0);
  return found;
}

/** @returns {string[]} 与 Profile glob 匹配的 tasks.md 路径 */
function findTasksFiles() {
  if (!KIRO_TASK_SOURCE) return [];
  return expandRepositoryGlob(
    PROFILE.context.primary_worktree ?? ROOT,
    String(KIRO_TASK_SOURCE.glob),
  );
}

/** @returns {string[]} 所有 [-] 任务的影响文件 token */
function inProgressTaskFiles() {
  const out = [];
  for (const tasksPath of findTasksFiles()) {
    let content;
    try {
      content = readFileSync(tasksPath, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    let inProgressBlock = false;
    for (const line of lines) {
      const marker = taskMarkerOf(line);
      if (marker !== null) {
        // 遇到任意任务行就切换块状态：是 [-] 则进入收集，否则退出收集
        inProgressBlock = marker === '-';
        continue;
      }
      if (!inProgressBlock) continue;
      const fieldVal = impactFieldValue(line);
      if (fieldVal !== null) {
        out.push(...extractImpactPaths(fieldVal));
      }
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 汇集并集
// ───────────────────────────────────────────────────────────────────────────
/** @typedef {{file:string, sources:Set<string>}} Entry */

/** @returns {Map<string,Set<string>>} file -> 来源标签集合 */
function buildInFlightSet() {
  /** @type {Map<string,Set<string>>} */
  const map = new Map();
  const add = (file, source) => {
    if (!file) return;
    if (!map.has(file)) map.set(file, new Set());
    map.get(file).add(source);
  };

  // ① worktree status
  if (HAS_WORKTREE_SOURCE) {
    for (const dir of listWorktreeDirs()) {
      const label = `worktree:${path.basename(dir) || dir}`;
      for (const f of statusFiles(dir)) add(f, label);
    }
  }
  // ② 近期 commit
  if (HAS_RECENT_SOURCE) for (const f of recentCommitFiles()) add(f, 'recent-commit');
  // ③ tasks.md [-]
  if (KIRO_TASK_SOURCE) for (const f of inProgressTaskFiles()) add(f, 'task:[-]');

  return map;
}

// ───────────────────────────────────────────────────────────────────────────
// target 规范化 + 交集
//   target 路径按仓库根为基准（与 worktree status / git log 同基准）。
//   只有 tasks.md adapter 来源可能是 app 相对路径，允许低置信度「后缀包含」兜底；Git 来源已经以
//   仓库根为基准，只做精确或祖先/后代匹配，避免 example/lib/main.dart 与 lib/main.dart 误报。
// ───────────────────────────────────────────────────────────────────────────
/** @param {string} raw @returns {string[]} */
function parseTargets(raw) {
  return raw
    .split(',')
    .map((s) => cleanPath(s))
    .filter(Boolean);
}

/**
 * 判定 target 是否与某在飞路径重叠并返回匹配依据。
 * @param {string} target
 * @param {string} inflight
 * @param {boolean} allowRelative
 */
function pathMatch(target, inflight, allowRelative) {
  if (target === inflight) return { kind: 'exact', confidence: 'high' };
  const prefixMatch = (parent, child) => child.startsWith(`${parent}/`);
  if (prefixMatch(target, inflight) || prefixMatch(inflight, target)) return { kind: 'ancestor', confidence: 'high' };
  if (!allowRelative) return null;

  // adapter 可能给 app 相对路径；尝试把短路径对齐到长路径的任一目录边界，再做祖先/后代判断。
  const relativeMatch = (long, short) => {
    const segments = long.split('/');
    for (let index = 1; index < segments.length; index++) {
      const suffix = segments.slice(index).join('/');
      if (suffix === short || prefixMatch(short, suffix) || prefixMatch(suffix, short)) return true;
    }
    return false;
  };
  if ((target.length > inflight.length && relativeMatch(target, inflight)) || (inflight.length > target.length && relativeMatch(inflight, target))) return { kind: 'suffix-relative', confidence: 'low' };
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// 主流程
// ───────────────────────────────────────────────────────────────────────────
const inFlight = buildInFlightSet();
const sortedFiles = [...inFlight.keys()].sort();

if (targetRaw === null) {
  // 纯列举模式
  console.log(`${PREFIX} 本机在飞 + 近期改过的文件集合（共 ${sortedFiles.length} 项）:`);
  if (sortedFiles.length === 0) {
    console.log(`${PREFIX}   (空)`);
  }
  for (const f of sortedFiles) {
    const sources = [...inFlight.get(f)].sort().join(', ');
    console.log(`  ${f}  [${sources}]`);
  }
  return 0;
}

// --target 交集模式
const targets = parseTargets(targetRaw);
if (targets.length === 0) {
  console.error(`${PREFIX} --target 为空，未给出任何文件。`);
  return 1;
}

/** @type {{target:string, inflight:string, sources:string, match_kind:string, confidence:string}[]} */
const collisions = [];
for (const t of targets) {
  for (const f of sortedFiles) {
    const sourceSet = inFlight.get(f);
    const match = pathMatch(t, f, [...sourceSet].some((source) => source === 'task:[-]'));
    if (match) {
      collisions.push({
        target: t,
        inflight: f,
        sources: [...sourceSet].sort().join(', '),
        match_kind: match.kind,
        confidence: match.confidence,
      });
    }
  }
}

console.log(`${PREFIX} 检查 ${targets.length} 个目标文件 vs 在飞集合（${sortedFiles.length} 项）:`);
if (collisions.length === 0) {
  console.log(`${PREFIX} 结论: CLEAR — 目标文件无人在动，可走当前分支并发。`);
  return 0;
}

console.log(`${PREFIX} 重叠明细:`);
for (const c of collisions) {
  if (c.target === c.inflight) {
    console.log(`  ${c.target}  [${c.sources}; match=${c.match_kind}; confidence=${c.confidence}]`);
  } else {
    console.log(`  ${c.target}  ~  ${c.inflight}  [${c.sources}; match=${c.match_kind}; confidence=${c.confidence}]`);
  }
}
console.log(
  `${PREFIX} 结论: COLLIDE — 目标文件有别人在动，建议开 worktree 隔离（DESIGN §2.1：会撞=开 worktree）。`,
);
// COLLIDE 仍以 0 退出：重叠是「需决策」的信息，不是脚本错误（决策由调用者/agent 做）。
return 0;
}

export function isCliEntry(argv1 = process.argv[1], selfUrl = import.meta.url) {
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(selfUrl)); }
  catch { return path.resolve(argv1) === path.resolve(fileURLToPath(selfUrl)); }
}

if (isCliEntry()) process.exitCode = runCli();
