import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARCHITECTURE = resolve(ROOT, 'docs', 'architecture', 'skill-system-architecture.md');

test('架构真源中的相对 Markdown 链接都指向现存文件', () => {
  const text = readFileSync(ARCHITECTURE, 'utf8');
  const broken = [];
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = match[1].trim();
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    const path = decodeURIComponent(target.split('#')[0]);
    if (!existsSync(resolve(dirname(ARCHITECTURE), path))) broken.push(target);
  }
  assert.deepEqual(broken, []);
});

test('架构真源描述当前 package/domain/docs 布局，不再引用已迁走的 references runtime', () => {
  const text = readFileSync(ARCHITECTURE, 'utf8');
  for (const current of [
    'domains/orchestrate/',
    'domains/verify/',
    'domains/loop/',
    'docs/orchestrate/',
    'docs/verify/',
    'docs/loop/',
    'agentkit doctor',
    'shell-manifest.json',
    'runtime_bundle_digest',
  ]) assert.ok(text.includes(current), `架构真源缺少当前边界：${current}`);
  assert.doesNotMatch(text, /(?:orchestrate-subagents|verify-agent-output|run-agent-verify-loop|manage-worktrees)\/references\//u);
  assert.doesNotMatch(text, /run-agent-verify-loop\/scripts\/loop-runtime\.mjs/u);
});
