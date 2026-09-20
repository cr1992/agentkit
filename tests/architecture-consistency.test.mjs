import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BUDGETS, DESCRIPTION_LIMIT_PER_SKILL, DESCRIPTION_LIMIT_TOTAL, TOTAL_BUDGET } from './skill-budgets.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARCHITECTURE = resolve(ROOT, 'docs', 'architecture', 'skill-system-architecture.md');
const ARCHITECTURE_DIR = dirname(ARCHITECTURE);

/** 取出某个 `### n.n 标题` 小节的正文，到下一个同级或更高级标题为止。 */
function section(heading) {
  const text = readFileSync(ARCHITECTURE, 'utf8');
  const start = text.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `架构真源缺少小节：${heading}`);
  const body = text.slice(start + heading.length + 2);
  const end = body.search(/^#{2,3} /mu);
  return end === -1 ? body : body.slice(0, end);
}

/** 解析小节里第一张 Markdown 表格，返回按单元格切开的数据行（不含表头与分隔行）。 */
function tableRows(body) {
  const lines = body.split('\n').filter((line) => line.trimStart().startsWith('|'));
  assert.ok(lines.length > 2, '小节里没有可解析的 Markdown 表格');
  return lines.slice(2).map((line) => line.trim().replace(/^\||\|$/gu, '').split('|').map((cell) => cell.trim()));
}

/** 单元格里反引号包起来的记号，按出现顺序返回。 */
function codeSpans(cell) {
  return [...cell.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
}

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

// 反查：架构真源 §6.2 不再手抄一份 capabilities 载荷，而是记录「哪个字段出现在哪些域」。
// 判据是双向的：表里写的出现范围必须与 `agentkit capabilities --json` 的真实输出逐域相等，
// 真实输出里出现过的字段也必须在表里有行——任何一边先动，测试都失败（issue #38）。
const SKILL_NAMES = ['orchestrate-subagents', 'manage-worktrees', 'verify-agent-output', 'run-agent-verify-loop'];

function liveCapabilities() {
  const stdout = execFileSync(process.execPath, [resolve(ROOT, 'bin', 'agentkit.mjs'), 'capabilities', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

test('架构真源 §6.2 的 capabilities 字段表与真实输出双向一致', () => {
  const body = section('### 6.2 能力发现');
  const live = liveCapabilities();

  assert.deepEqual(Object.keys(live).sort(), ['cli', 'cli_version', 'runtime_bundle_digest', 'skills']);
  for (const key of Object.keys(live)) assert.ok(body.includes(`\`${key}\``), `§6.2 未记录顶层字段 ${key}`);
  assert.deepEqual(Object.keys(live.skills).sort(), [...SKILL_NAMES].sort());

  const documented = new Map();
  for (const row of tableRows(body)) {
    const [field] = codeSpans(row[0]);
    assert.ok(field, `§6.2 字段表有一行没写字段名：${row.join(' | ')}`);
    const scope = row[1] === '四域' ? [...SKILL_NAMES] : codeSpans(row[1]);
    assert.ok(scope.length, `§6.2 字段 ${field} 没写出现范围`);
    documented.set(field, scope.sort());
  }

  for (const [field, scope] of documented) {
    const actual = SKILL_NAMES.filter((name) => Object.hasOwn(live.skills[name], field)).sort();
    assert.deepEqual(actual, scope, `§6.2 记录 ${field} 出现在 ${scope.join('、')}，实际是 ${actual.join('、') || '（无）'}`);
  }

  const actualFields = new Set(SKILL_NAMES.flatMap((name) => Object.keys(live.skills[name])));
  assert.deepEqual(
    [...actualFields].filter((field) => !documented.has(field)).sort(),
    [],
    '§6.2 字段表漏掉了 capabilities 实际输出里的字段',
  );
});

// 反查：架构真源 §6.3 里出现的 extensions 键必须都是 schema 定义过的，schema 定义过的也必须都被
// 记录；provider 取值与 schema / validateContract 的取值域逐项相等。
test('架构真源 §6.3 的合同 provider 字段与 schema、validateContract 一致', async () => {
  const body = section('### 6.3 Provider 选择');
  const contractSchema = JSON.parse(readFileSync(resolve(ROOT, 'schemas', 'task-contract-v1.schema.json'), 'utf8'));
  const extensionKeys = Object.keys(contractSchema.properties.extensions.properties).sort();

  // 全文口径：任何一节重新引入 `extensions.orchestration` 这类不存在的键都会被这里抓到。
  const mentioned = new Set([...readFileSync(ARCHITECTURE, 'utf8').matchAll(/extensions\.([a-z_]+)/gu)].map((match) => match[1]));
  assert.deepEqual(
    [...mentioned].filter((key) => !extensionKeys.includes(key)).sort(),
    [],
    `架构真源提到了 schema 未定义的 extensions 键；schema 只有 ${extensionKeys.join('、')}`,
  );
  for (const key of extensionKeys) assert.ok(body.includes(`\`${key}\``), `§6.3 未记录 extensions 键 ${key}`);

  const rows = new Map(tableRows(body).map((row) => [codeSpans(row[0])[0], codeSpans(row[1]).sort()]));
  assert.deepEqual(
    rows.get('extensions.verification.provider'),
    [...contractSchema.properties.extensions.properties.verification.properties.provider.enum].sort(),
  );
  assert.deepEqual(
    rows.get('skill_set[].provider_mode'),
    [...contractSchema.properties.skill_set.items.properties.provider_mode.enum].sort(),
  );

  // environment.isolation 的取值域只存在于运行时校验里，schema 把 environment 留成了自由对象，
  // 所以真源是 validateContract 的那条字面量；再用一次真实校验确认文档写的值确实被接受。
  const source = readFileSync(resolve(ROOT, 'domains', 'orchestrate', 'contract-tool.mjs'), 'utf8');
  const literal = /\[([^\]]+)\]\.includes\(contract\.environment\?\.isolation\)/u.exec(source);
  assert.ok(literal, 'contract-tool.mjs 里找不到 environment.isolation 的取值域字面量');
  const isolation = literal[1].split(',').map((item) => item.trim().replace(/^'|'$/gu, '')).sort();
  assert.deepEqual(rows.get('environment.isolation'), isolation);

  const { validateContract } = await import('../domains/orchestrate/contract-tool.mjs');
  const contract = (value) => ({
    schema_version: 1,
    contract_id: 'isolation-probe',
    objective: '验证 environment.isolation 取值域',
    scope: { include: ['src/'], exclude: [] },
    acceptance: [{ contract_item_id: 'tests', requirement: '测试通过' }],
    permissions: { mode: 'write', writable_paths: ['src/'] },
    environment: { repository: 'none', isolation: value },
    skill_set: [],
    stop_conditions: [],
    extensions: {},
  });
  for (const value of isolation) assert.doesNotThrow(() => validateContract(contract(value), { requireDigest: false }), value);
  assert.throws(() => validateContract(contract('managed_worktree'), { requireDigest: false }), /environment/u);
});

// 反查：架构真源 §13 不再手抄用例清单，只声明门禁入口与用例所在目录。三条判据都能被文件系统
// 或 package.json 证伪（issue #38）。
const TEST_GLOBS = ['tests/*.test.mjs', 'domains/*/*.test.mjs', 'scripts/*.test.mjs', 'evals/*/tests/*.test.mjs'];

function testFiles(dir = ROOT, prefix = '') {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...testFiles(join(dir, entry.name), path));
    else if (entry.name.endsWith('.test.mjs')) found.push(path);
  }
  return found;
}

function globToRegExp(glob) {
  return new RegExp(`^${glob.replace(/[.]/gu, '\\.').replace(/\*/gu, '[^/]+')}$`, 'u');
}

test('架构真源 §13.1 的 glob 表与 package.json 的 test 脚本逐字相同', () => {
  const body = section('### 13.1 门禁入口');
  const script = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).scripts.test;
  assert.ok(script.includes('tools/validate-skills.mjs'), 'test 脚本不再先跑 validate-skills');
  assert.deepEqual(tableRows(body).map((row) => codeSpans(row[0])[0]), TEST_GLOBS);
  for (const glob of TEST_GLOBS) assert.ok(script.includes(glob), `test 脚本缺少 glob ${glob}`);
  assert.deepEqual(script.slice(script.indexOf('--test')).trim().split(/\s+/u).slice(1), TEST_GLOBS, 'test 脚本的 glob 集合与 §13.1 不一致');
});

test('架构真源 §13.2 指向全部含用例的目录，且没有跑不到的用例文件', () => {
  const files = testFiles();
  assert.ok(files.length > 0, '仓库里找不到任何 *.test.mjs');

  const patterns = TEST_GLOBS.map(globToRegExp);
  assert.deepEqual(
    files.filter((path) => !patterns.some((pattern) => pattern.test(path))).sort(),
    [],
    '这些用例文件落在 npm test 的 glob 之外，门禁永远跑不到',
  );

  const body = section('### 13.2 覆盖面按目录反查');
  const linked = new Set(relativeLinkTargets().map(({ resolved }) => resolved));
  const missing = [...new Set(files.map((path) => path.slice(0, path.lastIndexOf('/'))))]
    .filter((dir) => !(body.includes(`\`${dir}/\``) && linked.has(resolve(ROOT, dir))))
    .sort();
  assert.deepEqual(missing, [], `§13.2 缺少指向这些用例目录的指针：${missing.join('、')}`);
});

test('架构真源 §13.3 的评测用例数量与 cases.mjs 一致', async () => {
  const body = section('### 13.3 协议路由评测');
  const { CASES, POSITIVE_CASES, FORBIDDEN_CASES } = await import('../evals/protocol-routing/cases.mjs');
  assert.ok(body.includes(`共 \`${CASES.length}\` 条`), `§13.3 的用例总数应为 ${CASES.length}`);
  assert.ok(body.includes(`正向\n\`${POSITIVE_CASES.length}\` 条`) || body.includes(`正向 \`${POSITIVE_CASES.length}\` 条`), `§13.3 的正向用例数应为 ${POSITIVE_CASES.length}`);
  assert.ok(body.includes(`禁止 \`${FORBIDDEN_CASES.length}\` 条`), `§13.3 的禁止用例数应为 ${FORBIDDEN_CASES.length}`);
  assert.equal(POSITIVE_CASES.length + FORBIDDEN_CASES.length, CASES.length);
});
