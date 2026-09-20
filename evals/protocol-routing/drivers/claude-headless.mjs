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
import { AGENTKIT_BIN, agentkitJson } from '../lib/agentkit.mjs';
import { createAgentkitShim, prependToPath } from '../lib/agentkit-shim.mjs';
import { classify } from '../lib/classifier.mjs';
import { createFixtureRepo, repoSummary } from '../lib/fixture-repo.mjs';
import { summarizeLedgerStatus } from '../lib/ledger-probe.mjs';
import { buildPrecondition, renderPrompt } from '../lib/preconditions.mjs';
import { installSkills, prepareSkillCache } from '../lib/skill-install.mjs';
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

/**
 * 最终文本只留有界前缀：它唯一的用途是「无效运行」判据与报告里那一行原因摘要
 * （见 lib/run-validity.mjs）。不留全文——会话输出属于敏感材料，报告是要贴进 issue 的。
 */
const FINAL_TEXT_PREFIX_LIMIT = 200;

/**
 * 从 stream-json 里按出现顺序取 tool_use 块，并取回宿主自己的 result 事件。
 * result 事件是判「这次会话算不算数据点」的唯一可靠信号，字段口径见 lib/run-validity.mjs。
 */
function parseStream(text) {
  /** @type {Array<{ id: string | null, tool_name: string, tool_input: any }>} */
  const uses = [];
  let model = null;
  let sessionId = null;
  /** @type {import('../lib/run-validity.mjs').HostResult | null} */
  let hostResult = null;
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
    if (record.type === 'result') {
      hostResult = {
        subtype: record.subtype ?? null,
        is_error: typeof record.is_error === 'boolean' ? record.is_error : null,
        num_turns: typeof record.num_turns === 'number' ? record.num_turns : null,
        api_error_status: typeof record.api_error_status === 'number' ? record.api_error_status : null,
        final_text_prefix: typeof record.result === 'string' ? record.result.slice(0, FINAL_TEXT_PREFIX_LIMIT) : null,
      };
    }
  }
  return { uses, model, sessionId, hostResult };
}

/**
 * 增量扫描 stream-json：边收边把 `tool_use` 块攒出来，用于「正向断言成立就终止会话」。
 *
 * 为什么不复用 `parseStream()`：那个吃整份文本，会话每来一个 chunk 就整份重解一次，
 * 长会话上是平方级。这里只处理**新到的完整行**，半行留在缓冲里等下一个 chunk。
 *
 * @returns {{ uses: Array<{ id: string | null, tool_name: string, tool_input: any }>, push: (chunk: string) => number }}
 */
export function createToolUseScanner() {
  let pending = '';
  /** @type {Array<{ id: string | null, tool_name: string, tool_input: any }>} */
  const uses = [];
  return {
    uses,
    push(chunk) {
      pending += chunk;
      let added = 0;
      let index = pending.indexOf('\n');
      while (index >= 0) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
        if (!line.startsWith('{')) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.type !== 'assistant' || !Array.isArray(record.message?.content)) continue;
        for (const block of record.message.content) {
          if (block?.type === 'tool_use') { uses.push({ id: block.id ?? null, tool_name: block.name, tool_input: block.input }); added += 1; }
        }
      }
      return added;
    },
  };
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
    out.events.push({ seq: index + 1, tool_name: use.tool_name, tool_input: use.tool_input, repo: probe.repo, ledger: probe.ledger ?? null });
  });
  return out;
}

/**
 * 这条用例能不能在断言成立之后提前终止会话。
 *
 * 只有**正向、且只看第一个观测量**的用例可以：那类用例的判定在第一个可观测动作出现的
 * 那一刻就已经定死，后面再跑什么都改不了结论，继续跑纯属烧时间和额度
 * （用例 4 在第 8 个事件就出分，之后还要跑 4–8 分钟，issue #15 的后续项 4）。
 *
 * 禁止类**必须看完整条会话**——违规可能发生在任何一个事件上，提前收手等于把失守洗掉。
 * 标了 `assert_scope: 'whole_session'` 的正向用例（第 5 条）同理不终止：
 * 它的断言就是「整条会话里出现过」，现在没出现不代表后面不会出现。
 *
 * @param {{ category: string, assert_scope?: string }} evalCase
 */
export function canTerminateEarly(evalCase) {
  return evalCase.category === 'positive' && evalCase.assert_scope !== 'whole_session';
}

/**
 * 会话开始前的台账快照。没有台账的现场返回 null。
 * 和探针用的是同一个口径函数，所以「第一个事件之前」与「第 n 个事件之前」形状一致。
 * @param {string | undefined} ledgerDir
 */
function initialLedgerSnapshot(ledgerDir) {
  if (!ledgerDir) return null;
  try { return summarizeLedgerStatus(agentkitJson(['orchestrate', 'ledger', 'status', '--ledger', ledgerDir])); }
  catch { return null; }
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
  /** @type {import('../lib/skill-install.mjs').SkillCache | null} */
  let skillCache = null;
  return {
    name: 'claude-headless',
    meta: { driver: 'claude-headless', host: 'claude-code', host_version: version, model },
    needsFixture: true,
    /**
     * 开跑前的一次性准备。**每轮只装一次 skill**，各会话从缓存复制（见 lib/skill-install.mjs）。
     * 装不上就在这里抛：`run.mjs` 还没进用例循环，整轮当场停，不会表现成「跑到一半丢样本」。
     */
    async prepare() {
      skillCache = prepareSkillCache({ cacheDir: join(outDir, 'skill-cache') });
      return { skill_cache: { dir: skillCache.dir, reused: skillCache.reused, installer_exit_code: skillCache.installer?.exit_code ?? null } };
    },
    async runSession({ evalCase, runIndex, attempt = 1 }) {
      // 正常路径上 run.mjs 已经调过 prepare()；这里兜底，让驱动器单独被调用时也成立。
      if (!skillCache) skillCache = prepareSkillCache({ cacheDir: join(outDir, 'skill-cache') });
      // 重试落在自己的目录里，不覆盖上一次的留档——无效运行的现场是排障材料，不能被冲掉。
      // 第 1 次尝试仍然叫 `run-<n>`，README 里那几条冒烟检查命令因此不用改。
      const session = join(outDir, 'sessions', `case-${evalCase.id}`, attempt > 1 ? `run-${runIndex}-attempt-${attempt}` : `run-${runIndex}`);
      mkdirSync(session, { recursive: true });
      const { repo, head } = createFixtureRepo({ parent: session });
      const precondition = buildPrecondition(evalCase.setup, { repo, head, session });

      const home = join(session, 'home');
      const configDir = join(home, '.claude');
      const installation = installSkills({ configDir, home, cache: skillCache });
      // PATH 上的 `agentkit`：四个 SKILL.md 通篇指示调用它，真实安装态下由 `npm i -g` 提供，
      // 评测现场没有。垫片转发到**被测 checkout** 的 bin/agentkit.mjs，见 lib/agentkit-shim.mjs。
      const shim = createAgentkitShim({ dir: join(session, 'bin') });

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
      const initialLedger = initialLedgerSnapshot(precondition.vars.LEDGER_DIR);

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
        // PATH 是白名单里**继承**来的一项，所以垫片只能在覆盖项里拼回去（覆盖项优先级最高）。
        PATH: prependToPath(shim.dir, process.env.PATH),
        HOME: home,
        CLAUDE_CONFIG_DIR: configDir,
        XDG_CONFIG_HOME: join(home, '.config'),
        PROTOCOL_ROUTING_REPO: repo,
        PROTOCOL_ROUTING_PROBE: probeFile,
        // 探针要对台账取快照的现场（第 7、10、11 条）才有这两项；没有台账时探针写 null。
        ...(precondition.vars.LEDGER_DIR ? { PROTOCOL_ROUTING_LEDGER: precondition.vars.LEDGER_DIR, PROTOCOL_ROUTING_AGENTKIT: AGENTKIT_BIN } : {}),
      });
      // 留档只记键名，不记取值——ANTHROPIC_API_KEY 之类的值不进会话目录。
      writeFileSync(join(session, 'command.json'), `${JSON.stringify({ bin, args, cwd: repo, env_keys: Object.keys(env).sort() }, null, 2)}\n`);

      // 提前终止：正向且只看第一个观测量的用例，判定一旦成立就没有再跑下去的理由。
      // 判据和最终判定**用的是同一个 assert**，只是喂给它一份截止到此刻的分类结果。
      const earlyEligible = canTerminateEarly(evalCase);
      const run = await new Promise((resolvePromise) => {
        const child = spawn(bin, args, {
          cwd: repo,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        /** @type {{ at_seq: number, reason: string } | null} */
        let early = null;
        const scanner = createToolUseScanner();
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        /** @type {NodeJS.Timeout | null} */
        let hardKill = null;
        const finish = (/** @type {number | null} */ code, /** @type {string} */ extraStderr = '') => {
          clearTimeout(timer);
          if (hardKill) clearTimeout(hardKill);
          resolvePromise({ code, stdout, stderr: `${stderr}${extraStderr}`, early });
        };
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          if (!earlyEligible || early || scanner.push(String(chunk)) === 0) return;
          // 探针文件按事件追加；还没落盘的 tool_use 在这里配不上，下一个 chunk 再看。
          let probes = [];
          try { probes = readFileSync(probeFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
          catch { return; }
          const paired = pairEvents(scanner.uses, probes);
          if (!paired.events.length) return;
          const verdict = evalCase.assert(classify({ initial_repo: initialRepo, initial_ledger: initialLedger, events: paired.events }), {});
          if (!verdict.satisfied) return;
          early = { at_seq: paired.events.at(-1).seq, reason: verdict.reason };
          // 先 SIGTERM 给宿主一个收尾的机会（它要写自己的会话记录），再补一刀。
          child.kill('SIGTERM');
          hardKill = setTimeout(() => child.kill('SIGKILL'), 5000);
        });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => { finish(code); });
        child.on('error', (error) => { finish(null, `\n${error.message}`); });
      });
      writeFileSync(join(session, 'stream.jsonl'), run.stdout);
      if (run.stderr) writeFileSync(join(session, 'stderr.log'), run.stderr);

      const { uses, model: reportedModel, sessionId, hostResult } = parseStream(run.stdout);
      const probes = readFileSync(probeFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const paired = pairEvents(uses, probes);

      const observation = {
        meta: {
          case_id: evalCase.id,
          run: runIndex,
          attempt,
          host: 'claude-code',
          host_version: version,
          model: reportedModel ?? model,
          requested_model: model,
          host_session_id: sessionId,
          skills: installation.content_digests,
          installed_skills: installation.skills,
          // 安装器自己的回报（退出码 + JSON）：只留档。判「装没装上」看的是文件系统，
          // 见 lib/skill-install.mjs 顶部那段「不看退出码」的理由。
          // 本轮只装一次，这里记的是那一次的回报；`skill_source` 记这个会话是从哪拿到的。
          skill_installer: installation.installer,
          skill_source: installation.source,
          setup: evalCase.setup,
          setup_notes: precondition.notes,
          setup_vars: precondition.vars,
          repo,
          session_dir: session,
          // 垫片留档：会话 PATH 最前的那个 agentkit 到底指向哪一份 checkout。
          agentkit_shim: { dir: shim.dir, path: shim.path, target: shim.target },
          pairing: paired.pairing,
          unpaired_tool_uses: paired.unpaired,
          // 这条用例允许不允许提前终止（禁止类与 whole_session 的正向类都不允许）。
          early_termination_eligible: earlyEligible,
        },
        initial_repo: initialRepo,
        // 会话开始前的台账快照：第 7、10、11 条判「发起那一下之前台账什么状态」的起点。
        initial_ledger: initialLedger,
        events: paired.events,
        payloads: collectPayloads(paired.events),
        // host_result 是「这次算不算数据点」的唯一可靠信号，见 lib/run-validity.mjs。
        // early_terminated 非空时这次会话是被 harness 主动掐掉的，不是故障——
        // 那种情况下拿不到 result 事件，退出码也不是 0，判据必须先看它。
        end: { exit_code: run.code, error: run.stderr ? run.stderr.slice(0, 2000) : null, host_result: hostResult, early_terminated: run.early ?? null },
      };
      writeFileSync(join(session, 'observation.jsonl'), serializeObservation(observation));
      return { ...observation, source: join(session, 'observation.jsonl') };
    },
  };
}
