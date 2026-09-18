import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BUDGETS, DESCRIPTION_LIMIT_PER_SKILL, DESCRIPTION_LIMIT_TOTAL, TOTAL_BUDGET } from './skill-budgets.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARCHITECTURE = resolve(ROOT, 'docs', 'architecture', 'skill-system-architecture.md');
const ARCHITECTURE_DIR = dirname(ARCHITECTURE);

// 架构文档不再复述 schema 字段和命令表，只保留指向真源的导航。判据因此不是"某个字符串出现过"
// ——那只能证明文档抄过一遍——而是"指针能解析，并且覆盖现状"：文件系统里新增一个域或一份域文档，
// 文档没跟上就失败；真源文件改名或搬走，链接断掉也失败。
function relativeLinkTargets() {
  const text = readFileSync(ARCHITECTURE, 'utf8');
  const targets = [];
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
    const target = match[1].trim();
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    const path = decodeURIComponent(target.split('#')[0]);
    targets.push({ target, resolved: resolve(ARCHITECTURE_DIR, path) });
  }
  return targets;
}

function directoryNames(path) {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test('架构真源中的相对 Markdown 链接都指向现存文件', () => {
  const broken = relativeLinkTargets().filter(({ resolved }) => !existsSync(resolved)).map(({ target }) => target);
  assert.deepEqual(broken, []);
});

test('架构真源为每个 domain 与其操作文档留下可解析的指针', () => {
  const linked = new Set(relativeLinkTargets().map(({ resolved }) => resolved));
  const missing = [];
  for (const domain of directoryNames(resolve(ROOT, 'domains'))) {
    const runtime = resolve(ROOT, 'domains', domain);
    if (!linked.has(runtime)) missing.push(relative(ROOT, runtime));
    const docs = resolve(ROOT, 'docs', domain);
    if (existsSync(docs) && !linked.has(docs)) missing.push(relative(ROOT, docs));
  }
  assert.deepEqual(missing, [], `架构真源缺少指向这些真源的相对链接：${missing.join('、')}`);
});

test('跨域运行时概念指向各自的真源文件，而不是在文档里复述', () => {
  const text = readFileSync(ARCHITECTURE, 'utf8');
  const linked = new Set(relativeLinkTargets().map(({ resolved }) => resolved));
  for (const [concept, source] of [
    ['agentkit doctor', ['bin', 'cli.mjs']],
    ['shell-manifest.json', ['shell-manifest.json']],
    ['runtime_bundle_digest', ['core', 'runtime-bundle.mjs']],
  ]) {
    assert.ok(text.includes(concept), `架构真源缺少当前边界：${concept}`);
    const resolved = resolve(ROOT, ...source);
    assert.ok(existsSync(resolved), `真源文件不存在：${source.join('/')}`);
    assert.ok(linked.has(resolved), `${concept} 未链接到真源：${source.join('/')}`);
  }
});

test('架构真源不再引用已迁走的 references runtime', () => {
  const text = readFileSync(ARCHITECTURE, 'utf8');
  assert.doesNotMatch(text, /(?:orchestrate-subagents|verify-agent-output|run-agent-verify-loop|manage-worktrees)\/references\//u);
  assert.doesNotMatch(text, /run-agent-verify-loop\/scripts\/loop-runtime\.mjs/u);
});

// 反查：架构真源 §3.8 预算表里写的每个数字，都必须和 tests/skill-budgets.mjs 里真正起约束作用的
// BUDGETS 一致——防止两边再次分叉（issue #14）。BUDGETS 抽成独立模块而不是从
// skill-context-budget.test.mjs 导出，是因为 node:test 下 import 一个测试文件会连带执行它的用例。
test('架构真源 §3.8 预算表的数字与 BUDGETS 真源一致', () => {
  const text = readFileSync(ARCHITECTURE, 'utf8');

  for (const [name, budget] of Object.entries(BUDGETS)) {
    assert.ok(text.includes(`\`${name} <= ${budget}\``), `架构真源里 ${name} 的预算应为 ${budget}`);
  }

  assert.ok(text.includes(`<= ${TOTAL_BUDGET}\``), `架构真源里的合计预算应为 ${TOTAL_BUDGET}`);

  const skillCount = Object.keys(BUDGETS).length;
  assert.ok(text.includes(`\`<= ${DESCRIPTION_LIMIT_PER_SKILL}\``), `架构真源里 description 单项上限应为 ${DESCRIPTION_LIMIT_PER_SKILL}`);
  assert.ok(
    text.includes(`${skillCount} × ${DESCRIPTION_LIMIT_PER_SKILL} = ${DESCRIPTION_LIMIT_TOTAL}`),
    `架构真源里 description 合计上限应为 ${skillCount} × ${DESCRIPTION_LIMIT_PER_SKILL} = ${DESCRIPTION_LIMIT_TOTAL}`,
  );
});
