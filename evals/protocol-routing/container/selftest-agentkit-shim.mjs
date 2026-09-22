#!/usr/bin/env node
// @ts-check
// 容器自检的一环：证明**被测会话的环境里** PATH 上有 `agentkit`，且它就是被测 checkout 那一份。
//
// 这条是 issue #15 缺陷 1 的容器侧闸门。四个 SKILL.md 通篇指示调用 PATH 上的 `agentkit`，
// 真实安装态下由 `npm i -g` 提供，镜像里**故意没有**装（评测要测的是挂进来的那份 checkout，
// 不是镜像构建时烘进去的某个版本）。所以垫片必须由驱动器建，并且在容器里也成立。
//
// 走的是和 drivers/claude-headless.mjs 完全一样的两步：建垫片 → buildSessionEnv 里拼 PATH。
// 不发起任何模型会话，不需要网络。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { AGENTKIT_BIN, REPO_ROOT } from '../lib/agentkit.mjs';
import { createAgentkitShim, prependToPath } from '../lib/agentkit-shim.mjs';
import { buildSessionEnv } from '../lib/session-env.mjs';

const expected = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
const base = mkdtempSync(join(tmpdir(), 'protocol-routing-shim-'));
try {
  const shim = createAgentkitShim({ dir: join(base, 'bin') });
  const env = buildSessionEnv(process.env, {
    PATH: prependToPath(shim.dir, process.env.PATH),
    HOME: join(base, 'home'),
  });

  const resolved = execFileSync('sh', ['-c', 'command -v agentkit'], { env, encoding: 'utf8' }).trim();
  if (resolved !== shim.path)
    throw new Error(`会话环境里 command -v agentkit 解析到 ${resolved}，期望垫片 ${shim.path}`);
  if (!env.PATH.startsWith(`${shim.dir}${delimiter}`)) throw new Error('垫片目录不在会话 PATH 最前');

  const version = execFileSync('sh', ['-c', 'agentkit --version'], { env, encoding: 'utf8' }).trim();
  if (version !== expected) throw new Error(`PATH 上的 agentkit 版本是 ${version}，期望被测 checkout 的 ${expected}`);

  process.stdout.write(`被测 checkout：${REPO_ROOT}\n`);
  process.stdout.write(`垫片：${shim.path} → ${AGENTKIT_BIN}\n`);
  process.stdout.write(`会话环境里 command -v agentkit → ${resolved}\n`);
  process.stdout.write(`OK: 会话环境里 agentkit 可解析且版本正确（${version}）\n`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
