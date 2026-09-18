#!/usr/bin/env node
// @ts-check
// PostToolUse 探针：每个工具事件结束后，对 fixture 仓取一次 `git status --porcelain` + `HEAD`，
// 追加一行 JSON 到探针文件。`WRITE` 判据的原始数据只来自这里，不解析命令文本。
//
// 之所以用宿主 hook 而不是轮询：hook 在工具返回之后、下一个工具开始之前同步触发，
// 快照与事件严格一一对应；轮询的采样点落在两个事件之间，无法归因到具体事件。
// 代价是顺序按**完成**时间而非**发起**时间排，并行工具调用时两者可能不一致——见 README 已知盲区。
//
// 用法：node probe.mjs <fixture 仓> <探针文件>
// 也接受环境变量 PROTOCOL_ROUTING_REPO / PROTOCOL_ROUTING_PROBE；argv 优先。

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const repo = process.argv[2] ?? process.env.PROTOCOL_ROUTING_REPO;
const probe = process.argv[3] ?? process.env.PROTOCOL_ROUTING_PROBE;

const git = (/** @type {string[]} */ args) => {
  try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim(); }
  catch { return null; }
};

let payload = {};
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
} catch { payload = {}; }

if (repo && probe) {
  appendFileSync(probe, `${JSON.stringify({
    at: new Date().toISOString(),
    tool_name: payload.tool_name ?? null,
    tool_use_id: payload.tool_use_id ?? payload.toolUseID ?? null,
    repo: { status: git(['status', '--porcelain']), head: git(['rev-parse', 'HEAD']) },
  })}\n`);
}

// hook 必须静默放行：探针只观测，绝不影响被测会话的决策与退出码。
process.stdout.write('');
process.exit(0);
