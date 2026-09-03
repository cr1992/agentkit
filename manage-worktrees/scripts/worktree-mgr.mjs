#!/usr/bin/env node
// @ts-check

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as core from './worktree-core.mjs';
import * as mergePreview from './worktree-merge-preview.mjs';
import * as profile from './worktree-profile.mjs';
import * as provider from './worktree-provider-gitlab.mjs';
import * as trace from './worktree-trace.mjs';
import { createCommands as createArchiveCommands } from './worktree-archive.mjs';
import { createCommands as createArtifactCommands } from './worktree-artifact.mjs';
import { createCommands as createBatchIntegrateCommands } from './worktree-batch-integrate.mjs';
import { createCommands as createBatchPlanCommands } from './worktree-batch-plan.mjs';
import { createCommands as createBatchResultCommands } from './worktree-batch-result.mjs';
import { createCommands as createDoctorCommands } from './worktree-doctor.mjs';
import { createCommands as createHistoryCommands } from './worktree-history.mjs';
import { createCommands as createLearningCommands } from './worktree-learning.mjs';
import { createCommands as createLifecycleCommands } from './worktree-lifecycle.mjs';
import { createCommands as createReclaimCommands } from './worktree-reclaim.mjs';
import { createCommands as createReviewRefreshCommands } from './worktree-review-refresh.mjs';
import { createCommands as createReviewWatchCommands } from './worktree-review-watch.mjs';

export { runFileCapture, runFileTry } from './worktree-process.mjs';
export {
  classifyPairState,
  mergeTreeScanSupported,
  parseGitVersion,
  predictReviewRefresh,
  regeneratedPathKind,
} from './worktree-merge-preview.mjs';
export {
  canonicalJson,
  codegraphStdio,
  deliverReclaimNotification,
  normalizeCodegraphMode,
  processIsAlive,
  refreshTargetRefCached,
  worktreeSkillDigest,
} from './worktree-core.mjs';

const {
  PREFIX,
  die,
  parseArgs,
  rejectUnknownFlags,
  worktreeSkillDigest,
} = core;
const { WorktreeProfileError } = profile;
const { GitlabSubmitError } = provider;
const { WorktreeTraceError } = trace;
const managerScript = fileURLToPath(import.meta.url);

const dependencies = {
  spawn,
  createHash,
  randomUUID,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  tmpdir,
  basename,
  dirname,
  join,
  resolve,
  fileURLToPath,
  managerScript,
  ...mergePreview,
  ...profile,
  ...provider,
  ...trace,
  ...core,
};

/// 依赖袋按构造顺序累积，而各工厂在被调用的瞬间就把依赖解构完毕：下面的构造顺序与键名
/// 都是承重契约（例如 lifecycle 依赖 history/reclaim/review-watch 先注入）。assignNew 把
/// 「后来的工厂静默覆盖既有同名依赖」变成加载期硬错误，避免同名 helper 在不同模块间
/// 悄悄分叉；初始字面量里 core 有意最后展开、覆盖同名基础导出，不受此守卫约束。
function assignNew(bag, additions, source) {
  for (const key of Object.keys(additions)) {
    if (Object.hasOwn(bag, key)) throw new Error(`依赖袋键冲突: ${source} 重复提供 ${key}`);
  }
  return Object.assign(bag, additions);
}

const historyCommands = createHistoryCommands(dependencies);
assignNew(dependencies, historyCommands, 'worktree-history');
const reclaimCommands = createReclaimCommands(dependencies);
assignNew(dependencies, reclaimCommands, 'worktree-reclaim');
const reviewWatchCommands = createReviewWatchCommands(dependencies);
assignNew(dependencies, reviewWatchCommands, 'worktree-review-watch');
const reviewRefreshCommands = createReviewRefreshCommands(dependencies);
assignNew(dependencies, reviewRefreshCommands, 'worktree-review-refresh');
const reviewCommands = { ...reviewWatchCommands, ...reviewRefreshCommands };
const lifecycleCommands = createLifecycleCommands(dependencies);
assignNew(dependencies, lifecycleCommands, 'worktree-lifecycle');
const archiveCommands = createArchiveCommands(dependencies);
assignNew(dependencies, archiveCommands, 'worktree-archive');
const batchPlanCommands = createBatchPlanCommands(dependencies);
assignNew(dependencies, batchPlanCommands, 'worktree-batch-plan');
const batchIntegrateCommands = createBatchIntegrateCommands(dependencies);
assignNew(dependencies, batchIntegrateCommands, 'worktree-batch-integrate');
const batchResultCommands = createBatchResultCommands(dependencies);
assignNew(dependencies, batchResultCommands, 'worktree-batch-result');
const batchCommands = { ...batchPlanCommands, ...batchIntegrateCommands, ...batchResultCommands };
const artifactCommands = createArtifactCommands(dependencies);
assignNew(dependencies, artifactCommands, 'worktree-artifact');
const learningCommands = createLearningCommands(dependencies);
assignNew(dependencies, learningCommands, 'worktree-learning');
const doctorCommands = createDoctorCommands(dependencies);

export const batchFingerprint = batchCommands.batchFingerprint;
export const verifyArtifactEnvelope = artifactCommands.verifyArtifactEnvelope;

function cmdCapabilities(args) {
  rejectUnknownFlags(args.flags, ['json']);
  console.log(JSON.stringify({ skill: 'manage-worktrees', runtime_version: '1.3.0', contracts: { worktree_binding: [1], artifact_ref: [1], reflection_record: [1], improvement_proposal: [1], batch_result: [1] }, features: ['git-common-dir-ledger', 'ownership-epochs', 'artifact-verification', 'incident-reflection', 'proposed-only-improvement', 'batch-integrate', 'batch-conflict-scan', 'declared-post-integrate-steps', 'batch-result', 'evidence-archive-reclaim', 'durable-pushed-ref-proof', 'auto-armed-review-watch', 'review-target-advance-prediction', 'explicit-review-refresh', 'managed-history-rewrite', 'stack-parent-attribution', 'structured-change-registration'], content_digest: worktreeSkillDigest() }, null, 2));
}

function usage() {
  console.log(`${PREFIX} portable multi-Agent worktree manager

spawn <task> --agent <host> --agent-id <id> --purpose <text> [--owner <name>] [--base <ref> --base-reason <text>] [--root <path>] [--codegraph auto|on|off]
  同会话已有未回收树时默认拒绝；独立并行加 --parallel-reason <text>；替代加 --supersedes <selector> --replacement-reason <text>
adopt <path> --agent <host> --agent-id <id> --purpose <text> [--task <slug>] [--base <ref> --base-reason <text>]
list [--json] [--all] [--present] [--archived]
  --present：只列目录仍然存在的 record（TRACKED/UNTRACKED/MAIN 分类不变），隐藏全部历史记录
  --archived：历史记录里额外显示已 archive 的 record（标 [ARCHIVED]），默认隐藏
plan-batch <selector> <selector> [...] [--target <ref>] [--scan-conflicts] [--json]
  --scan-conflicts：冻结前两两 merge-tree 干跑，输出冲突矩阵（不动工作区/index/ref，不改指纹）
batch-integrate --plan <plan.json> | <selector> <selector> [...] --agent <host> --agent-id <id>
  [--candidate-task <slug>] [--target <ref>] [--abort-on-conflict] [--no-rerere]
  [--recompose --recompose-head <exact-current-head>] [--json]
  按冻结顺序合成精确 SHA；冲突 fail-closed 停在冲突处；不执行任何门禁命令
batch-step <candidate-selector> --step <name> --state done|skipped|failed [--note <text>] [--json]
batch-result <candidate-selector> --state passed|failed|stale --candidate <exact-object-id>
  [--evidence <json>] [--reason <text>] [--json]
  passed/failed 必须给结构化 evidence；stale 必须给 reason；终态结果不可覆盖
touch <selector> [--status <status>] [--note <text>] [--mr <http-url>] [--watch-target <ref>] [--id <uuid>]
  --status ready_for_review 默认自动武装 watch；退出用 --no-watch
rebase <selector> --onto <ref> --expected-head <sha> --reason <text> [--continue|--abort] [--id <uuid>]
  manager 原子登记 intent、撤防旧 watcher、执行/恢复 rebase，并刷新 base、父分支和 ownership epoch；pending 恢复只需 selector + --continue
refresh-review <selector> [--target <ref>] [--reason <text>] [--pause-before-push] [--continue|--abort] [--id <uuid>]
  显式刷新 ready_for_review 分支：managed rebase、精确 force-with-lease push、重冻结并重启 watcher；--pause-before-push 允许插入项目门禁
retarget <selector> --base <ref> --expected-head <sha> --reason <text> [--id <uuid>]
  仅当新 base 已是 HEAD 祖先时更新验证/MR 目标；不会改写 Git 历史
supersede <old-selector> --by <replacement-selector> --reason <text> [--id <uuid>] [--by-id <uuid>]
handoff <selector> --to-agent <host> --to-agent-id <id> --note <text> [--id <uuid>]
audit <selector> [--json] [--id <uuid>]
doctor [--json] [--verbose]
  非 json 文本模式默认把目录已消失 record 的 WORKTREE_MISSING/BASE_OVERRIDE/EPHEMERAL_WORKTREE
  三类 warning 折叠成一行 [summary]；--verbose 逐条展开；--json 输出的 findings 始终完整不折叠
rebuild [<selector>] [--id <uuid>] [--recover-lock]
watch <selector> [--target <remote/ref>] [--interval-ms <ms>] [--change-ref <text>] [--notify auto|off] [--id <uuid>]
submit <selector> [--title <text>] [--description <text>] [--target <branch>] [--remote <name>] [--interval-ms <ms>] [--notify auto|off] [--id <uuid>]
resume-all [--json]
unwatch <selector> [--id <uuid>]
reclaim <selector> --pushed <sha> [--id <uuid>]
reclaim <selector> --superseded-by <replacement-selector> [--discard <exact-old-head>] [--id <uuid>] [--replacement-id <uuid>]
reclaim <selector> --archive-evidence <exact-candidate-head> --reason <text> [--id <uuid>]
archive <selector> --reason <text> [--id <uuid>]
  只接受目录已不存在、分支已删除或已合入、且未武装监听的历史 record；只追加一条 archived
  event，不删除分支、不删除目录、不改任何 ref；默认从 list/doctor 隐藏，list --archived 可见
binding <selector> [--id <uuid>] [--json]
artifact <selector> [--id <uuid>] [--json]
verify-artifact <artifact.json> [--json]
incident <selector> --input <json> [--id <uuid>]
propose-improvement --reflection <uuid> --input <json>
capabilities [--json]

所有命令支持 --config <path>；默认 Profile 固定从 primary worktree 读取。`);
}


function main() {
  const argv = process.argv.slice(2);
  if (!argv[0] || ['--help', '-h', 'help'].includes(argv[0])) {
    usage();
    process.exit(argv[0] ? 0 : 1);
  }
  const subcommand = argv[0];
  const args = parseArgs(argv.slice(1));
  const commands = {
    spawn: lifecycleCommands.cmdSpawn,
    adopt: lifecycleCommands.cmdAdopt,
    list: lifecycleCommands.cmdList,
    'plan-batch': batchCommands.cmdPlanBatch,
    'batch-integrate': batchCommands.cmdBatchIntegrate,
    'batch-step': batchCommands.cmdBatchStep,
    'batch-result': batchCommands.cmdBatchResult,
    touch: lifecycleCommands.cmdTouch,
    rebase: historyCommands.cmdRebase,
    'refresh-review': reviewCommands.cmdRefreshReview,
    retarget: historyCommands.cmdRetarget,
    supersede: lifecycleCommands.cmdSupersede,
    handoff: lifecycleCommands.cmdHandoff,
    audit: lifecycleCommands.cmdAudit,
    doctor: doctorCommands.cmdDoctor,
    rebuild: lifecycleCommands.cmdRebuild,
    submit: reviewCommands.cmdSubmit,
    watch: reviewCommands.cmdWatch,
    'resume-all': reviewCommands.cmdResumeAll,
    unwatch: reviewCommands.cmdUnwatch,
    'watch-worker': reviewCommands.cmdWatchWorker,
    reclaim: reclaimCommands.cmdReclaim,
    archive: archiveCommands.cmdArchive,
    binding: artifactCommands.cmdBinding,
    artifact: artifactCommands.cmdArtifact,
    'verify-artifact': artifactCommands.cmdVerifyArtifact,
    incident: learningCommands.cmdIncident,
    'propose-improvement': learningCommands.cmdProposeImprovement,
    capabilities: cmdCapabilities,
  };
  if (!commands[subcommand]) die(`未知子命令: ${subcommand}`, 2);
  commands[subcommand](args);
}

/// 本文件是否被当作 CLI 入口直接执行。
///
/// 必须按 **realpath** 比对：skill 常以软链安装（`~/.claude/skills/<name>` →
/// 团队仓真实目录）。软链下 `import.meta.url` 是 Node 解析后的真实路径，而
/// `process.argv[1]` 保留调用时的软链路径，字符串比对永不相等——main() 不跑、
/// 进程以 0 退出、**stdout/stderr 全空**，调用方只看到「命令成功但没有输出」，
/// 极难归因。realpath 两端归一后两种装法都成立。
export function isCliEntry(argv1 = process.argv[1], selfUrl = import.meta.url) {
  if (!argv1) return false;
  const self = fileURLToPath(selfUrl);
  const entry = resolve(argv1);
  if (self === entry) return true;
  try {
    return realpathSync(self) === realpathSync(entry);
  } catch {
    // 任一端不存在（罕见：入口被删/权限）——退回字符串比对结论。
    return false;
  }
}

if (isCliEntry()) {
  try {
    main();
  } catch (error) {
    if (error instanceof WorktreeProfileError || error instanceof WorktreeTraceError || error instanceof GitlabSubmitError) {
      die(`${error.code}: ${error.message}`);
    }
    throw error;
  }
}
