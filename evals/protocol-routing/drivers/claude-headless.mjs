// @ts-check
// 宿主 CLI 无头驱动器（Claude Code）。
//
// 会话怎么起：
//   claude -p <prompt> --output-format stream-json --verbose --model <id>
//          --permission-mode bypassPermissions --settings <会话 settings.json>
//          --add-dir <会话根>   （cwd = fixture 仓）
//   stdout 完整落盘为 stream.jsonl；工具事件从其中的 tool_use 块按出现顺序取。
//
// 现场：每个会话一份全新 fixture 仓、独立 state root、独立 HOME 与 CLAUDE_CONFIG_DIR。
// skill 怎么装：见 lib/skill-install.mjs（README 记载的 `npx skills add … -g --agent '*'`）。
// WRITE 怎么判：PostToolUse hook 逐事件落一行仓库摘要，判据见 lib/classifier.mjs。
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

const PROBE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'probe.mjs');

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
 * @param {{ bin?: string, model: string, outDir: string, timeoutMs?: number, budgetUsd?: number | null, extraArgs?: string[] }} options
 * @returns {import('./index.mjs').Driver}
 */
export function createHeadlessClaudeDriver({ bin = 'claude', model, outDir, timeoutMs = 900000, budgetUsd = null, extraArgs = [] }) {
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
      writeFileSync(join(session, 'command.json'), `${JSON.stringify({ bin, args, cwd: repo }, null, 2)}\n`);

      const run = await new Promise((resolvePromise) => {
        const child = spawn(bin, args, {
          cwd: repo,
          env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir, XDG_CONFIG_HOME: join(home, '.config'), PROTOCOL_ROUTING_REPO: repo, PROTOCOL_ROUTING_PROBE: probeFile },
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
