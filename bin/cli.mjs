// agentkit 顶层路由。P1 只解析前缀，argv 其余部分原样转发给现有入口：
// 转发路径上 stdout、stderr 分类与退出码必须与直接调用旧入口逐字节等价，
// 因此一律用 stdio: 'inherit' 直通，不做任何包装、重排或补充输出。
// CLI 自身的输出（help、version、capabilities 聚合、docs、doctor 汇总）不受该约束，
// 但任何迁移提示只写 stderr，避免污染可被管道消费的 stdout。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
    '  contract <命令>              任务契约规范化、校验、摘要与投影',
    '  orchestrate <工具> <命令>    ledger | preflight | review-budget | reflection',
    '  host <工具> <命令>           cache | model-policy',
    '  verify <命令>                冻结 Artifact 的一次性独立验收',
    '  loop <命令>                  有界的实现—验收循环',
    '',
    '跨域命令：',
    '  capabilities [--json]        汇总四个 Skill 的能力发现结果',
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
