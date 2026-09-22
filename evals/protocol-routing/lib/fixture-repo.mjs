// @ts-check
// fixture 仓生成器：每个会话一份全新的临时 git 仓，会话之间不共享任何状态。
//
// 内容只要撑得起 11 条情境即可：两个互不相交的小模块、一份测试、一份 README。
// 刻意保持极小——评测要看的是路由决策，不是模型能不能读懂一个大仓。

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FILES = {
  'README.md': `# fixture

一个用于协议路由评测的最小仓库。

- \`src/greet.mjs\`：问候语
- \`src/sum.mjs\`：求和
- \`test/sum.test.mjs\`：求和的单测
`,
  'src/greet.mjs': `export function greet(name) {
  return \`Hello, \${name}!\`;
}
`,
  'src/sum.mjs': `export function sum(values) {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
`,
  'test/sum.test.mjs': `import assert from 'node:assert/strict';
import test from 'node:test';
import { sum } from '../src/sum.mjs';

test('sum 累加数组', () => {
  assert.equal(sum([1, 2, 3]), 6);
});
`,
  'package.json': `{
  "name": "fixture",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test test/*.test.mjs" }
}
`,
};

/** @param {string} cwd @param {string[]} args */
export function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd },
  }).trim();
}

/**
 * fixture 仓的摘要：`git status --porcelain` + `HEAD`。`WRITE` 判据只看它。
 * @param {string} repo
 * @returns {{ status: string, head: string }}
 */
export function repoSummary(repo) {
  return {
    status: git(repo, ['status', '--porcelain']),
    head: git(repo, ['rev-parse', 'HEAD']),
  };
}

/**
 * 建一份全新 fixture 仓。
 * @param {{ parent?: string }} [options]
 * @returns {{ repo: string, head: string }}
 */
export function createFixtureRepo(options = {}) {
  const parent = options.parent ?? mkdtempSync(join(tmpdir(), 'protocol-routing-'));
  const repo = join(parent, 'repo');
  mkdirSync(repo, { recursive: true });
  for (const [path, content] of Object.entries(FILES)) {
    const full = join(repo, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  git(repo, ['init', '--quiet', '--initial-branch', 'main']);
  git(repo, ['config', 'user.name', 'protocol-routing-eval']);
  git(repo, ['config', 'user.email', 'eval@example.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '--quiet', '-m', 'chore: fixture 初始提交']);
  return { repo, head: git(repo, ['rev-parse', 'HEAD']) };
}
