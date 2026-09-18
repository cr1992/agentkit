// agentkit 顶层路由。P1 只解析前缀，argv 其余部分原样转发给现有入口：
// 转发路径上 stdout、stderr 分类与退出码必须与直接调用旧入口逐字节等价，
// 因此一律用 stdio: 'inherit' 直通，不做任何包装、重排或补充输出。
// CLI 自身的输出（help、version、capabilities 聚合、docs、doctor 汇总）不受该约束，
// 但任何迁移提示只写 stderr，避免污染可被管道消费的 stdout。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertPublicCommandCompatibility,
  RuntimeBundleError,
  runtimeBundleDigest,
  validateShellManifest,
} from '../core/runtime-bundle.mjs';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));  // bin/ 的上一级即包根

// 一级域：前缀之后的 argv 直接交给同一个脚本。
const DOMAINS = {
  worktree: { domain: 'worktree', skill: 'manage-worktrees', script: 'worktree-mgr.mjs', verbs: { scan: 'worktree-scan.mjs' } },
  contract: { domain: 'orchestrate', skill: 'orchestrate-subagents', script: 'contract-tool.mjs' },
  verify: { domain: 'verify', skill: 'verify-agent-output', script: 'verification-runtime.mjs' },
  loop: { domain: 'loop', skill: 'run-agent-verify-loop', script: 'loop-runtime.mjs' },
};

// 二级域：四个 orchestrate 工具都有 capabilities，preflight 与 contract 都有 normalize，
// 扁平化会让同名动词互相遮蔽，因此保留工具名这一级，动词本身一个都不改。
const GROUPS = {
  orchestrate: {
    ledger: { domain: 'orchestrate', skill: 'orchestrate-subagents', script: 'orchestration-ledger.mjs' },
    preflight: { domain: 'orchestrate', skill: 'orchestrate-subagents', script: 'worker-capability-preflight.mjs' },
    'review-budget': { domain: 'orchestrate', skill: 'orchestrate-subagents', script: 'review-budget.mjs' },
    reflection: { domain: 'orchestrate', skill: 'orchestrate-subagents', script: 'orchestration-reflection.mjs' },
  },
  host: {
    cache: { domain: 'orchestrate', skill: 'orchestrate-subagents', script: 'host_capability_cache.mjs' },
    'model-policy': { domain: 'orchestrate', skill: 'orchestrate-subagents', script: 'resolve_model_policy.mjs' },
  },
};

// capabilities 与安装级 doctor 的成员入口。域级 doctor 需要 ledger/run/loop 等状态选择器，
// 顶层 doctor 只检查安装和能力发现，不能把“未指定某次运行”误报成不健康。
const CAPABILITY_TARGETS = [
  { domain: 'orchestrate', skill: 'orchestrate-subagents', script: 'orchestration-ledger.mjs' },
  { domain: 'worktree', skill: 'manage-worktrees', script: 'worktree-mgr.mjs' },
  { domain: 'verify', skill: 'verify-agent-output', script: 'verification-runtime.mjs' },
  { domain: 'loop', skill: 'run-agent-verify-loop', script: 'loop-runtime.mjs' },
];
const DOCTOR_TARGETS = CAPABILITY_TARGETS;

// docs 路由：参考文档按域收在包根 docs/<域>/ 下。
const DOC_DOMAINS = { orchestrate: 'orchestrate', worktree: 'worktree', verify: 'verify', loop: 'loop' };

function packageVersion() {
  try { return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version; }
  catch { return 'unknown'; }
}

function scriptPath(target) {
  // 运行时住在 domains/ 下；Skill 目录只剩 SKILL.md、参考文档与 1.x 兼容 stub。
  return join(PACKAGE_ROOT, 'domains', target.domain, target.script);
}

function missing(target) {
  process.stderr.write(`agentkit: 未找到 domains/${target.domain}/${target.script}，该 Skill 未随本安装分发\n`);
  return 127;
}

// 直通转发：子进程直接继承本进程的 stdio，父进程不碰任何一个字节。
function forward(target, args) {
  const path = scriptPath(target);
  if (!existsSync(path)) return missing(target);
  try {
    assertPublicCommandCompatibility({ skill: target.skill, entryName: target.script, command: args[0] });
  } catch (error) {
    if (!(error instanceof RuntimeBundleError)) throw error;
    process.stderr.write(`agentkit runtime compatibility error: ${error.message}\n`);
    return 3;
  }
  const result = spawnSync(process.execPath, [path, ...args], { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(`agentkit: 执行 ${target.script} 失败：${result.error.message}\n`);
    return 1;
  }
  if (result.signal) {
    // facade 若吞掉子进程信号并改写为 exit 1，就不再满足“退出语义一致”。
    try { process.kill(process.pid, result.signal); } catch { return 1; }
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

// 捕获式调用：只用于 CLI 自己要解析子进程输出的聚合命令。
function capture(target, args) {
  const path = scriptPath(target);
  if (!existsSync(path)) return null;
  const result = spawnSync(process.execPath, [path, ...args], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

function helpText() {
  const lines = [
    `agentkit ${packageVersion()}`,
    '',
    '用法: agentkit <域> <命令> [选项]',
    '',
    '域：',
    '  worktree <命令>              Git worktree 隔离与生命周期（含 worktree scan）',
    '  contract <命令>              任务契约 scaffold、访谈、规范化、校验、摘要与投影',
    '  orchestrate <工具> <命令>    ledger | preflight | review-budget | reflection',
    '  host <工具> <命令>           cache | model-policy',
    '  verify <命令>                冻结 Artifact 的一次性独立验收',
    '  loop <命令>                  有界的实现—验收循环',
    '',
    '跨域命令：',
    '  capabilities [--json]        汇总四个 Skill 的能力发现结果',
    '  status [--json]              从当前仓库的 ledger 指针发现未终态 ledger 并给出下一步',
    '  doctor [--json]              检查 Node、Git、安装完整性与各域能力发现',
    '  docs [<域>] [<主题>]         输出参考文档原文；缺主题时只列索引',
    '  --version                    打印版本',
    '',
    '域与工具之后的参数原样转发给对应入口，输出与退出码保持一致。',
  ];
  return `${lines.join('\n')}\n`;
}

function runCapabilities(args) {
  const json = args.includes('--json');
  const skills = {};
  for (const target of CAPABILITY_TARGETS) {
    const payload = capture(target, ['capabilities', '--json']);
    if (payload) skills[target.skill] = payload;
  }
  if (!Object.keys(skills).length) {
    process.stderr.write('agentkit: 没有任何 Skill 能力可发现\n');
    return 1;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ cli: 'agentkit', cli_version: packageVersion(), runtime_bundle_digest: runtimeBundleDigest(), skills }, null, 2)}\n`);
    return 0;
  }
  for (const [skill, payload] of Object.entries(skills)) {
    process.stdout.write(`${skill} runtime ${payload.runtime_version ?? '?'}\n`);
  }
  return 0;
}

function runDoctor(args) {
  const unknown = args.filter((arg) => arg !== '--json');
  if (unknown.length) {
    process.stderr.write(`agentkit doctor: 未知选项「${unknown[0]}」；状态检查请使用对应域的 doctor 并传入 ledger/run/loop\n`);
    return 2;
  }
  const json = args.includes('--json');
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  const node = { healthy: Number.isSafeInteger(nodeMajor) && nodeMajor >= 22, version: process.versions.node, required: '>=22' };
  const gitResult = spawnSync('git', ['--version'], { encoding: 'utf8' });
  const git = {
    healthy: gitResult.status === 0,
    version: gitResult.status === 0 ? gitResult.stdout.trim().replace(/^git version\s+/u, '') : null,
    error: gitResult.status === 0 ? null : (gitResult.error?.message ?? gitResult.stderr?.trim() ?? 'unavailable'),
  };
  let manifest;
  try {
    const value = validateShellManifest();
    manifest = { healthy: true, package_name: value.package_name, package_version: value.package_version, error: null };
  } catch (error) {
    manifest = { healthy: false, package_name: null, package_version: null, error: error instanceof Error ? error.message : String(error) };
  }
  const skills = {};
  let installed = 0;
  for (const target of DOCTOR_TARGETS) {
    if (!existsSync(scriptPath(target))) {
      skills[target.skill] = { installed: false, healthy: null, state_doctor: 'not_run' };
      continue;
    }
    installed += 1;
    const capabilities = capture(target, ['capabilities', '--json']);
    skills[target.skill] = {
      installed: true,
      healthy: capabilities !== null,
      runtime_version: capabilities?.runtime_version ?? null,
      content_digest: capabilities?.content_digest ?? null,
      state_doctor: 'requires_explicit_state',
    };
  }
  const healthy = node.healthy && git.healthy && manifest.healthy && installed > 0
    && Object.values(skills).filter((item) => item.installed).every((item) => item.healthy);
  const result = { cli: 'agentkit', cli_version: packageVersion(), runtime_bundle_digest: runtimeBundleDigest(), healthy, checks: { node, git, manifest }, skills };
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`agentkit ${packageVersion()} doctor: ${healthy ? 'healthy' : 'unhealthy'}\n`);
    process.stdout.write(`node ${node.version} (${node.healthy ? 'ok' : `需要 ${node.required}`})\n`);
    process.stdout.write(`git ${git.version ?? git.error} (${git.healthy ? 'ok' : 'unavailable'})\n`);
    process.stdout.write(`shell manifest ${manifest.package_version ?? manifest.error} (${manifest.healthy ? 'ok' : 'invalid'})\n`);
    for (const [skill, check] of Object.entries(skills)) {
      process.stdout.write(`${skill}: ${check.installed ? (check.healthy ? `runtime ${check.runtime_version ?? '?'} ok` : 'capabilities failed') : 'not installed'}\n`);
    }
  }
  if (!installed) return 127;
  return healthy ? 0 : 1;
}

// ── agentkit status ───────────────────────────────────────────────────────────
// 顶层状态发现：从 cwd 找 git common dir，读仓级指针，回读各 state root，筛出未终态的 ledger。
// 这是 bin 层同时读 orchestrate（ledger 状态）与 worktree（record 里的 ledger 绑定）两个域的地方——
// 域与域之间不互相 import，跨域聚合只发生在这一层。
const LEDGER_TARGET = GROUPS.orchestrate.ledger;
const PHASE_LABELS = {
  empty: '空 ledger（还没有任何节点）',
  not_started: '未开始',
  in_progress: '进行中',
  blocked: '阻塞',
  ready_to_close: '待收口',
};

function ledgerPhase(status) {
  const nodes = Object.values(status.nodes ?? {});
  if (!nodes.length) return 'empty';
  if (status.summary?.completion_ready) return 'ready_to_close';
  if (nodes.some((node) => node.state === 'blocked')) return 'blocked';
  if (nodes.some((node) => ['running', 'awaiting_verification'].includes(node.state))) return 'in_progress';
  if (nodes.every((node) => node.state === 'pending')) return 'not_started';
  return 'in_progress';
}

// drift 的 ledger 不给续跑命令：冻结的协议已经不成立，只剩记为放弃或换当前 runtime 重签。
function nextCommands(entry) {
  if (entry.skill_drift) {
    return [
      `agentkit orchestrate ledger close --ledger ${entry.ledger_dir} --abandon --reason <text>`,
      're-contract：用当前 runtime 重签 Task Contract，再 agentkit orchestrate ledger init --contract <contract.json> --state-root <仓外路径>',
    ];
  }
  if (entry.phase === 'ready_to_close') return [`agentkit orchestrate ledger close --ledger ${entry.ledger_dir}`];
  if (entry.phase === 'empty') return [`agentkit orchestrate ledger add-node --ledger ${entry.ledger_dir} --input <node.json>`];
  if (entry.phase === 'blocked') {
    return [
      `agentkit orchestrate ledger status --ledger ${entry.ledger_dir}`,
      `agentkit orchestrate ledger update --ledger ${entry.ledger_dir} --node <node> --input <state.json>`,
    ];
  }
  return [`agentkit orchestrate ledger status --ledger ${entry.ledger_dir}`];
}

async function worktreeRecords(commonDir) {
  try {
    const { listRecordCacheEntries } = await import('../domains/worktree/worktree-trace.mjs');
    return listRecordCacheEntries(commonDir)
      .map((entry) => entry.record)
      .filter((record) => record && record.worktree_state !== 'reclaimed' && record.worktree_state !== 'archived');
  } catch {
    // worktree 域没装或 trace store 不可读时，status 仍然要能靠仓级指针工作。
    return [];
  }
}

function currentWorktreePath() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const top = result.stdout.trim();
  if (!top) return null;
  try { return realpathSync(top); } catch { return top; }
}

function worktreeSummary(record) {
  return {
    worktree_id: record.worktree_id,
    task: record.task,
    branch: record.branch ?? null,
    path: record.path,
    agent: record.agent ? `${record.agent.host}/${record.agent.id}` : null,
    task_status: record.task_status ?? null,
    worktree_state: record.worktree_state ?? null,
  };
}

// ledger 目录不在这里重新推导：它由 core 的 ledgerDirectory 算出后传进来，避免第二份推导规则。
function describeLedger(pointer, ledgerDir, status, records) {
  const nodes = Object.values(status.nodes ?? {});
  const entry = {
    ledger_id: status.ledger_id,
    ledger_dir: ledgerDir,
    state_root: pointer.state_root,
    revision: status.revision,
    contract_digest: status.contract_digest,
    // 指针里的摘要只用于交叉核对与展示：不一致说明指针陈旧，状态仍以 state root 为准。
    pointer_contract_digest_matches: status.contract_digest === pointer.contract_digest,
    skill_drift: Boolean(status.skill_drift),
    skill_drift_remediation: status.skill_drift_remediation ?? null,
    recovery_needed: Boolean(status.recovery_needed),
    summary: {
      pending: status.summary?.pending ?? 0,
      active: status.summary?.active ?? 0,
      terminal: status.summary?.terminal ?? 0,
      completion_ready: Boolean(status.summary?.completion_ready),
    },
    blockers: [
      ...nodes.filter((node) => node.state === 'blocked').map((node) => `${node.node_id} blocked：${node.reason ?? '未记录原因'}`),
      ...nodes.filter((node) => node.state === 'failed' && node.required !== false).map((node) => `${node.node_id} failed：${node.reason ?? '未记录原因'}`),
    ],
    uncovered_implementation_nodes: status.summary?.uncovered_implementation_nodes ?? [],
    unmet_completion_conditions: status.summary?.unmet_completion_conditions ?? [],
    worktrees: records.filter((record) => record.ledger === status.ledger_id).map(worktreeSummary),
  };
  entry.phase = ledgerPhase(status);
  entry.next_commands = nextCommands(entry);
  return entry;
}

function collectLedgers(pointers, pointerApi, records) {
  const active = [];
  const drifted = [];
  const terminal = [];
  const dangling = [];
  for (const item of pointers) {
    if (item.error) {
      dangling.push({ pointer_path: item.path, ledger_id: item.ledger_id, state: 'malformed', detail: item.error });
      continue;
    }
    const pointer = item.pointer;
    const dir = pointerApi.ledgerDirectory(pointer);
    if (!existsSync(join(dir, 'events.ndjson'))) {
      dangling.push({ pointer_path: item.path, ledger_id: pointer.ledger_id, state: 'dangling_state_root', detail: `state_root ${pointer.state_root} 下找不到 ledger 事件链 ${join(dir, 'events.ndjson')}` });
      continue;
    }
    const status = capture(LEDGER_TARGET, ['status', '--ledger', dir]);
    if (!status) {
      dangling.push({ pointer_path: item.path, ledger_id: pointer.ledger_id, state: 'unreadable', detail: `ledger 目录 ${dir} 无法读取状态；用 agentkit orchestrate ledger doctor --ledger ${dir} 查看` });
      continue;
    }
    if (status.lifecycle) {
      terminal.push({ pointer_path: item.path, ledger_id: pointer.ledger_id, ledger_dir: dir, lifecycle_state: status.lifecycle.state, closed_at: status.lifecycle.closed_at });
      continue;
    }
    const entry = { ...describeLedger(pointer, dir, status, records), pointer_path: item.path };
    (entry.skill_drift ? drifted : active).push(entry);
  }
  return { active, drifted, terminal, dangling };
}

function renderStatusText(report) {
  const lines = [`agentkit ${report.cli_version} status`];
  lines.push(`当前工作树: ${report.worktree_root ?? '(未知)'}  git common dir: ${report.git_common_dir}`);
  lines.push(`指针目录: ${report.pointer_dir}`);
  if (report.scope === 'worktree') {
    lines.push(`当前 worktree 绑定 ledger=${report.worktree_binding.ledger_id}（record ${report.worktree_binding.worktree_id.slice(0, 8)}），已收窄到该 ledger。`);
  } else if (report.worktree_binding) {
    lines.push(`当前 worktree 的 record 绑定 ledger=${report.worktree_binding.ledger_id}，但该 ledger 没有可用指针；下面列出全部未终态 ledger。`);
  }

  const groups = [['未终态 ledger', report.ledgers], ['skill_drift ledger（不能续跑）', report.drifted_ledgers]];
  if (!report.ledgers.length && !report.drifted_ledgers.length) {
    lines.push('');
    lines.push('未发现 ledger。');
    lines.push(`  在本仓 init 过的 ledger 会在 ${report.pointer_dir} 留下指针；升级前 init 的 ledger 没有指针，需要手传 --ledger <ledger 目录>。`);
    lines.push('  新建：agentkit orchestrate ledger init --contract <contract.json> --state-root <仓外路径>');
  }
  for (const [title, entries] of groups) {
    if (!entries.length) continue;
    lines.push('');
    lines.push(`${title}：${entries.length} 个`);
    for (const entry of entries) {
      lines.push(`  [${entry.ledger_id}] 阶段=${PHASE_LABELS[entry.phase] ?? entry.phase} revision=${entry.revision} 节点 pending/active/terminal=${entry.summary.pending}/${entry.summary.active}/${entry.summary.terminal}`);
      lines.push(`    ledger: ${entry.ledger_dir}`);
      lines.push(`    活跃 worktree: ${entry.worktrees.length ? entry.worktrees.map((item) => `${item.task}@${item.path}`).join('、') : '无'}`);
      lines.push(`    阻塞项: ${entry.blockers.length ? entry.blockers.join('；') : '无'}`);
      lines.push(`    未覆盖节点: ${entry.uncovered_implementation_nodes.length ? entry.uncovered_implementation_nodes.join('、') : '无'}`);
      if (entry.skill_drift) lines.push(`    skill_drift: ${entry.skill_drift_remediation ?? '冻结的 runtime 与当前不一致'}`);
      lines.push('    下一步:');
      for (const command of entry.next_commands) lines.push(`      ${command}`);
    }
  }
  if (report.dangling_pointers.length) {
    lines.push('');
    lines.push(`悬空指针：${report.dangling_pointers.length} 个（state root 已不存在或指针损坏）`);
    for (const item of report.dangling_pointers) lines.push(`  [${item.ledger_id}] ${item.state}：${item.detail}`);
    lines.push(`  回收：agentkit orchestrate ledger reclaim-pointers --repository ${report.worktree_root ?? report.git_common_dir}`);
  }
  if (report.terminal_pointers.length) {
    lines.push('');
    lines.push(`已终态但指针仍在：${report.terminal_pointers.length} 个`);
    for (const item of report.terminal_pointers) lines.push(`  [${item.ledger_id}] ${item.lifecycle_state} @ ${item.closed_at}`);
    lines.push(`  回收：agentkit orchestrate ledger reclaim-pointers --repository ${report.worktree_root ?? report.git_common_dir}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runStatus(args) {
  const unknown = args.filter((arg) => arg !== '--json');
  if (unknown.length) {
    process.stderr.write(`agentkit status: 未知选项「${unknown[0]}」；本命令只接受 --json，作用域由当前工作目录所属的 git 仓库决定\n`);
    return 2;
  }
  const pointerApi = await import('../core/ledger-pointer.mjs');
  const found = pointerApi.resolveGitCommonDir(process.cwd());
  if (!found.common_dir) {
    process.stderr.write(`agentkit status: ${found.reason}；status 从当前工作目录所属的 git 仓库读取仓级 ledger 指针，请在仓库内运行\n`);
    return 2;
  }
  const commonDir = found.common_dir;
  const records = await worktreeRecords(commonDir);
  const here = currentWorktreePath();
  const bound = here ? records.find((record) => record.path === here && record.ledger) ?? null : null;
  const collected = collectLedgers(pointerApi.listLedgerPointers(commonDir), pointerApi, records);

  // 受管 worktree 里优先用 record 的 ledger 字段收窄；收窄不到就退回全量，并说明原因，不做猜测。
  const narrowed = bound ? [...collected.active, ...collected.drifted].filter((entry) => entry.ledger_id === bound.ledger) : [];
  const scope = narrowed.length ? 'worktree' : 'repository';
  const report = {
    cli: 'agentkit',
    cli_version: packageVersion(),
    // 当前工作树（可能是 linked worktree）；reclaim-pointers 的 --repository 接受该仓的任意工作树。
    worktree_root: here,
    git_common_dir: commonDir,
    pointer_dir: pointerApi.pointerDirectory(commonDir),
    scope,
    worktree_binding: bound ? { ledger_id: bound.ledger, worktree_id: bound.worktree_id, task: bound.task, path: bound.path } : null,
    ledgers: scope === 'worktree' ? narrowed.filter((entry) => !entry.skill_drift) : collected.active,
    drifted_ledgers: scope === 'worktree' ? narrowed.filter((entry) => entry.skill_drift) : collected.drifted,
    dangling_pointers: collected.dangling,
    terminal_pointers: collected.terminal,
  };
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(renderStatusText(report));
  return 0;
}

function docsIndex(domain) {
  const dir = join(PACKAGE_ROOT, 'docs', DOC_DOMAINS[domain]);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.md')).map((name) => basename(name, '.md')).sort();
}

function runDocs(args) {
  const [domain, topic] = args;
  if (!domain) {
    process.stdout.write(`${Object.keys(DOC_DOMAINS).sort().join('\n')}\n`);
    return 0;
  }
  if (!DOC_DOMAINS[domain]) {
    process.stderr.write(`agentkit: 未知文档域「${domain}」，可选：${Object.keys(DOC_DOMAINS).sort().join(', ')}\n`);
    return 2;
  }
  const topics = docsIndex(domain);
  if (!topic) {
    if (!topics.length) { process.stderr.write(`agentkit: ${domain} 没有可用参考文档\n`); return 127; }
    process.stdout.write(`${topics.join('\n')}\n`);
    return 0;
  }
  if (!topics.includes(topic)) {
    // 主题不存在时只列索引，不猜测最相近的文档。
    process.stderr.write(`agentkit: ${domain} 没有主题「${topic}」\n`);
    process.stdout.write(`${topics.join('\n')}\n`);
    return 2;
  }
  process.stdout.write(readFileSync(join(PACKAGE_ROOT, 'docs', DOC_DOMAINS[domain], `${topic}.md`), 'utf8'));
  return 0;
}

export async function main(argv) {
  const [head, ...rest] = argv;

  if (!head || head === '--help' || head === '-h' || head === 'help') {
    process.stdout.write(helpText());
    return 0;
  }
  if (head === '--version' || head === '-v') {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  if (head === 'capabilities') return runCapabilities(rest);
  if (head === 'status') return runStatus(rest);
  if (head === 'doctor') return runDoctor(rest);
  if (head === 'docs') return runDocs(rest);

  const domain = DOMAINS[head];
  if (domain) {
    const override = domain.verbs?.[rest[0]];
    if (override) return forward({ ...domain, script: override }, rest);
    return forward(domain, rest);
  }

  const group = GROUPS[head];
  if (group) {
    const [tool, ...args] = rest;
    if (!tool || !group[tool]) {
      process.stderr.write(`agentkit ${head}: 需要工具名，可选：${Object.keys(group).join(', ')}\n`);
      return 2;
    }
    return forward(group[tool], args);
  }

  process.stderr.write(`agentkit: 未知域「${head}」\n`);
  process.stderr.write(helpText());
  return 2;
}
