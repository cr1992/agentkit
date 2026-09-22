#!/usr/bin/env node
// @ts-check
// 容器自检的一环：证明 skill 安装命令在容器里能跑通，且缓存复用那条路走得通。
//
// 装的是**容器内那份仓库拷贝**（skill-install.mjs 的 REPO_ROOT 由自身路径推出，
// 在容器里就是 /work/repo），先装进一个临时缓存目录，再从缓存复制进一个会话配置目录，装完即弃。
// 第一段需要出网（`npx -y skills`）；第二、三段不触网——真实评测里 33 个会话走的都是第三段。
// 不发起任何模型会话。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../lib/agentkit.mjs';
import { SKILL_NAMES, installSkills, prepareSkillCache } from '../lib/skill-install.mjs';

const base = mkdtempSync(join(tmpdir(), 'protocol-routing-skill-'));
try {
  // 1) 每轮一次的真实安装。
  const cache = prepareSkillCache({ cacheDir: join(base, 'skill-cache') });
  if (cache.reused) throw new Error('全新缓存目录不该报 reused');
  process.stdout.write(`skill 源：${REPO_ROOT}\n`);
  // 安装器退出码不参与判定（见 lib/skill-install.mjs），但要打出来，免得它悄悄从 1 变成别的。
  process.stdout.write(`安装器退出码：${cache.installer?.exit_code}（只留档，不作判据）\n`);

  // 2) 第二次准备必须命中缓存：一个子进程都不该再起。安装器换成「一被调用就抛」的哨兵。
  const again = prepareSkillCache({
    cacheDir: join(base, 'skill-cache'),
    install: () => {
      throw new Error('缓存已完整时不该再调用安装器');
    },
  });
  if (!again.reused) throw new Error('第二次准备没有命中缓存');

  // 3) 会话侧：从缓存复制，不触网。
  const home = join(base, 'home');
  const result = installSkills({ configDir: join(home, '.claude'), home, cache });
  const installed = result.skills.map((item) => item.name).sort();
  const missing = SKILL_NAMES.filter((name) => !installed.includes(name));
  if (missing.length) throw new Error(`skill 安装不完整，缺少：${missing.join(', ')}`);
  process.stdout.write(`已从缓存装入隔离配置目录：${installed.join(', ')}\n`);
  for (const [name, digest] of Object.entries(result.content_digests)) process.stdout.write(`  ${name}: ${digest}\n`);
  process.stdout.write('OK: 容器内 skill 安装与缓存复用通过\n');
} finally {
  rmSync(base, { recursive: true, force: true });
}
