// @ts-check
// 宿主 CLI 无头驱动器（Claude Code）。
//
// 会话怎么起：
//   claude -p <prompt> --output-format stream-json --verbose --model <id>
//          --permission-mode bypassPermissions --settings <会话 settings.json>
//          [--add-dir <该会话的 state root>]   （cwd = fixture 仓）
//   stdout 完整落盘为 stream.jsonl；工具事件从其中的 tool_use 块按出现顺序取。
//
// 现场：每个会话一份全新 fixture 仓、独立 state root、独立 HOME 与 CLAUDE_CONFIG_DIR。
// skill 怎么装：见 lib/skill-install.mjs（README 记载的 `npx skills add … -g --agent '*'`）。
// WRITE 怎么判：PostToolUse hook 逐事件落一行仓库摘要，判据见 lib/classifier.mjs。
//
// ⚠️ 两条安全面，改动前先读 README「会话怎么起」：
// 1. `bypassPermissions` 必须显式开启（allowBypassPermissions）。重定向 HOME **不是沙箱**：
//    该模式下会话对运行者的整个文件系统有写权限，且不经确认就能执行任意命令。
//    只应在一次性环境（CI runner / 容器 / 虚拟机）里跑。
//    又不能换更弱的权限模式：被拒的写操作不会改变 git 摘要，`WRITE` 判据会失真——
//    一次「本该写却被门禁拦下」的会话会被记成 `NONE`，评测量到的就不再是协议行为。
// 2. 传给会话的环境变量走白名单（lib/session-env.mjs），不是 `...process.env`。
//
// ⚠️ 未经真实会话验证的部分见 README「已知盲区」：flag 组合、hook 载荷字段名、事件配对口径。

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureRepo, repoSummary } from '../lib/fixture-repo.mjs';
import { buildPrecondition, renderPrompt } from '../lib/preconditions.mjs';
import { installSkills } from '../lib/skill-install.mjs';
import { serializeObservation } from '../lib/observation.mjs';
import { buildSessionEnv } from '../lib/session-env.mjs';

const PROBE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'probe.mjs');

export const BYPASS_REFUSAL = [
  '拒绝启动真实会话：无头驱动器要用 --permission-mode bypassPermissions，必须显式同意。',
  '',
  '该模式下被测会话不经确认就能执行任意命令，并且对运行者的**整个文件系统**有写权限。',
  '本 harness 重定向了 HOME / CLAUDE_CONFIG_DIR 并给每个会话一份全新 fixture 仓，',
  '但那只是隔离评测现场，**不是沙箱**——越界的写操作照样落在运行者的机器上。',
  '所以只应在一次性环境（CI runner / 容器 / 虚拟机）里跑，不要在日常开发机上直接跑。',
  '',
  '也不能换一个更弱的权限模式：被门禁拒掉的写操作不会改变 fixture 仓的 git 摘要，',
  'WRITE 判据会失真——「本该写却被拦下」的会话会被记成 NONE，量到的就不再是协议行为。',
  '',
  '确认在一次性环境里，再加 --allow-bypass-permissions 重跑。',
].join('\n');

/** 宿主版本：只读一次，写进每份结果。 */
function hostVersion(bin) {
  try { return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim(); }
  catch (error) { throw new Error(`无法执行宿主 CLI「${bin}」：${/** @type {Error} */ (error).message}`); }
}

/** 从 stream-json 里按出现顺序取 tool_use 块。 */
function toolUsesFromStream(text) {
  /** @type {Array<{ id: string | null, tool_name: string, tool_input: any }>} */
  const uses = [];
  let model = null;
  let sessionId = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let record;
    try { record = JSON.parse(trimmed); } catch { continue; }
    if (record.type === 'system' && record.subtype === 'init') { model = record.model ?? model; sessionId = record.session_id ?? sessionId; }
    if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
      model = record.message.model ?? model;
      for (const block of record.message.content) {
        if (block?.type === 'tool_use') uses.push({ id: block.id ?? null, tool_name: block.name, tool_input: block.input });
      }
    }
  }
  return { uses, model, sessionId };
}

/**
 * 把 tool_use 序列与探针快照配对。
 * 有 tool_use_id 就按 id 配；没有就按顺序配——后者在并行工具调用时可能错位，属已知盲区。
 * @param {Array<{ id: string | null, tool_name: string, tool_input: any }>} uses
 * @param {Array<any>} probes
 */
function pairEvents(uses, probes) {
  const byId = new Map();
  for (const probe of probes) if (probe.tool_use_id) byId.set(probe.tool_use_id, probe);
  const positional = probes.filter((probe) => !probe.tool_use_id || !uses.some((use) => use.id === probe.tool_use_id));
  let cursor = 0;
  /** @type {{ events: any[], pairing: 'tool_use_id' | 'positional' | 'mixed', unpaired: number }} */
  const out = { events: [], pairing: byId.size ? (positional.length ? 'mixed' : 'tool_use_id') : 'positional', unpaired: 0 };
  uses.forEach((use, index) => {
    const probe = (use.id && byId.get(use.id)) || positional[cursor++];
    if (!probe) { out.unpaired += 1; return; }
    out.events.push({ seq: index + 1, tool_name: use.tool_name, tool_input: use.tool_input, repo: probe.repo });
  });
  return out;
}

/**
 * 会话结束后把 `--input` 一类参数指向的 JSON 文件内联进观测记录。
 * 第 7 条要判「声明了 independent_evidence 的 add-node」、第 10 条要判「改成 passed」，
 * 都得看载荷；内联一份是为了让 observation.jsonl 自带足够信息，离开这台机器也能复判。
 * 读不到就留空——正向用例因此不给分，禁止用例因此按违规处理（见 cases.mjs）。
 */
function collectPayloads(events) {
  /** @type {Record<string, unknown>} */
  const payloads = {};
  for (const event of events) {
    const command = typeof event.tool_input?.command === 'string' ? event.tool_input.command : '';
    for (const match of command.matchAll(/--(?:input|contract|profile|artifact|review)[=\s]+(\S+)/gu)) {
      const candidate = match[1].replace(/^['"]|['"]$/gu, '');
      if (Object.hasOwn(payloads, candidate) || !candidate.startsWith('/') || !existsSync(candidate)) continue;
      try { payloads[candidate] = JSON.parse(readFileSync(candidate, 'utf8')); } catch { /* 读不到就留空 */ }
    }
  }
  return payloads;
}

/**
 * @param {{ bin?: string, model: string, outDir: string, allowBypassPermissions?: boolean, timeoutMs?: number, budgetUsd?: number | null, extraArgs?: string[] }} options
 * @returns {import('./index.mjs').Driver}
 */
export function createHeadlessClaudeDriver({ bin = 'claude', model, outDir, allowBypassPermissions = false, timeoutMs = 900000, budgetUsd = null, extraArgs = [] }) {
  // 在建驱动器的时候就拒绝，而不是等第一个会话——那时已经建过 fixture 仓、装过 skill 了。
  if (!allowBypassPermissions) throw new Error(BYPASS_REFUSAL);
  const version = hostVersion(bin);
  return {
    name: 'claude-headless',
    meta: { driver: 'claude-headless', host: 'claude-code', host_version: version, model },
    needsFixture: true,
    async runSession({ evalCase, runIndex }) {
      const session = join(outDir, 'sessions', `case-${evalCase.id}`, `run-${runIndex}`);
      mkdirSync(session, { recursive: true });
      const { repo, head } = createFixtureRepo({ parent: session });
      const precondition = buildPrecondition(evalCase.setup, { repo, head, session });

      const home = join(session, 'home');
      const configDir = join(home, '.claude');
      const installation = installSkills({ configDir, home });

      const probeFile = join(session, 'probe.jsonl');
      writeFileSync(probeFile, '');
      const settingsPath = join(session, 'settings.json');
      writeFileSync(settingsPath, `${JSON.stringify({
        hooks: {
          PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${process.execPath} ${PROBE} ${repo} ${probeFile}` }] }],
        },
      }, null, 2)}\n`);

      const prompt = renderPrompt(evalCase.prompt, precondition.vars);
      writeFileSync(join(session, 'prompt.txt'), `${prompt}\n`);
      const initialRepo = repoSummary(repo);

      // --add-dir 只开到前置状态真正用到的 state root：会话不该顺手读到自己的 settings.json
      // 与 skill 安装目录，那会把探针本身变成上下文的一部分。
      const extraDirs = precondition.vars.STATE_ROOT ? ['--add-dir', precondition.vars.STATE_ROOT] : [];
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--model', model,
        '--permission-mode', 'bypassPermissions',
        '--settings', settingsPath,
        ...extraDirs,
        ...(budgetUsd === null ? [] : ['--max-budget-usd', String(budgetUsd)]),
        ...extraArgs,
      ];
      // 白名单环境：不把运行者手上的凭据（GH_TOKEN、NPM_TOKEN、云厂商 key……）
      // 交给一个在 bypassPermissions 下运行、且有网的会话。见 lib/session-env.mjs。
      const env = buildSessionEnv(process.env, {
        HOME: home,
        CLAUDE_CONFIG_DIR: configDir,
        XDG_CONFIG_HOME: join(home, '.config'),
        PROTOCOL_ROUTING_REPO: repo,
        PROTOCOL_ROUTING_PROBE: probeFile,
      });
      // 留档只记键名，不记取值——ANTHROPIC_API_KEY 之类的值不进会话目录。
      writeFileSync(join(session, 'command.json'), `${JSON.stringify({ bin, args, cwd: repo, env_keys: Object.keys(env).sort() }, null, 2)}\n`);

      const run = await new Promise((resolvePromise) => {
        const child = spawn(bin, args, {
          cwd: repo,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
        child.on('error', (error) => { clearTimeout(timer); resolvePromise({ code: null, stdout, stderr: `${stderr}\n${error.message}` }); });
      });
      writeFileSync(join(session, 'stream.jsonl'), run.stdout);
      if (run.stderr) writeFileSync(join(session, 'stderr.log'), run.stderr);

      const { uses, model: reportedModel, sessionId } = toolUsesFromStream(run.stdout);
      const probes = readFileSync(probeFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const paired = pairEvents(uses, probes);

      const observation = {
        meta: {
          case_id: evalCase.id,
          run: runIndex,
          host: 'claude-code',
          host_version: version,
          model: reportedModel ?? model,
          requested_model: model,
          host_session_id: sessionId,
          skills: installation.content_digests,
          installed_skills: installation.skills,
          setup: evalCase.setup,
          setup_notes: precondition.notes,
          setup_vars: precondition.vars,
          repo,
          session_dir: session,
          pairing: paired.pairing,
          unpaired_tool_uses: paired.unpaired,
        },
        initial_repo: initialRepo,
        events: paired.events,
        payloads: collectPayloads(paired.events),
        end: { exit_code: run.code, error: run.stderr ? run.stderr.slice(0, 2000) : null },
      };
      writeFileSync(join(session, 'observation.jsonl'), serializeObservation(observation));
      return { ...observation, source: join(session, 'observation.jsonl') };
    },
  };
}
