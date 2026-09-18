#!/usr/bin/env node
// @ts-check
// 容器自检的一环：证明 skill 安装命令在容器里能跑通。
//
// 装的是**容器内那份仓库拷贝**（skill-install.mjs 的 REPO_ROOT 由自身路径推出，
// 在容器里就是 /work/repo），装进一个临时的隔离配置目录，装完即弃。
// 需要出网（`npx -y skills`）。不发起任何模型会话。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../lib/agentkit.mjs';
import { SKILL_NAMES, installSkills } from '../lib/skill-install.mjs';

const base = mkdtempSync(join(tmpdir(), 'protocol-routing-skill-'));
try {
  const home = join(base, 'home');
  const result = installSkills({ configDir: join(home, '.claude'), home });
  const installed = result.skills.map((item) => item.name).sort();
  const missing = SKILL_NAMES.filter((name) => !installed.includes(name));
  if (missing.length) throw new Error(`skill 安装不完整，缺少：${missing.join(', ')}`);
  process.stdout.write(`skill 源：${REPO_ROOT}\n`);
  process.stdout.write(`已装入隔离配置目录：${installed.join(', ')}\n`);
  // 安装器退出码不参与判定（见 lib/skill-install.mjs），但要打出来，免得它悄悄从 1 变成别的。
  process.stdout.write(`安装器退出码：${result.installer.exit_code}（只留档，不作判据）\n`);
  for (const [name, digest] of Object.entries(result.content_digests)) process.stdout.write(`  ${name}: ${digest}\n`);
  process.stdout.write('OK: 容器内 skill 安装通过\n');
} finally {
  rmSync(base, { recursive: true, force: true });
}
