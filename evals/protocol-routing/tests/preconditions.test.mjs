// @ts-check
// 前置状态构造器自测：用**当前仓库的** agentkit 真的把第 7、8、9、10 条的现场建出来。
// 不起任何会话、不产生任何模型费用。
//
// 除了「能建出来」，这里还钉死每条用例赖以成立的机制事实。这些事实一旦漂移，
// 用例测的东西就变了，必须在测试里当场炸掉，而不是等真实评测出一份看不懂的分数：
// - 第 8 条：原样 scaffold 契约过不了 `ledger init`（#12 的实质性检查）；
// - 第 9 条：最少填充的骨架**能**过 `ledger init`——机制放行，只剩协议这一道（剩余风险探针）；
// - 第 10 条：没有 Evidence 的 independent_evidence 节点标不成 passed。

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CASES } from '../cases.mjs';
import { agentkit } from '../lib/agentkit.mjs';
import { createFixtureRepo, repoSummary } from '../lib/fixture-repo.mjs';
import { SETUP_NAMES, buildPrecondition, renderPrompt } from '../lib/preconditions.mjs';

/** 建一份会话现场，返回其路径与前置状态。测试自己负责清理。 */
function site(setup) {
  const session = mkdtempSync(join(tmpdir(), `protocol-routing-test-${setup}-`));
  const { repo, head } = createFixtureRepo({ parent: session });
  const precondition = buildPrecondition(setup, { repo, head, session });
  return { session, repo, head, precondition, cleanup: () => rmSync(session, { recursive: true, force: true }) };
}

/** 跑一条 agentkit 命令，返回 { ok, message }，不抛。 */
function attempt(args) {
  try { return { ok: true, message: agentkit(args) }; }
  catch (error) { return { ok: false, message: `${/** @type {any} */ (error).stderr ?? ''}${/** @type {Error} */ (error).message}` }; }
}

test('每条用例声明的前置状态都有对应的构造器', () => {
  for (const item of CASES) assert.ok(SETUP_NAMES.includes(item.setup), `用例 ${item.id} 的前置状态 ${item.setup} 没有构造器`);
});

test('fixture 仓是独立的干净 git 仓，摘要可取', () => {
  const s = site('plain');
  try {
    assert.ok(existsSync(join(s.repo, '.git')));
    assert.ok(existsSync(join(s.repo, 'src', 'sum.mjs')));
    const summary = repoSummary(s.repo);
    assert.equal(summary.status, '');
    assert.match(summary.head, /^[0-9a-f]{40}$/u);
  } finally { s.cleanup(); }
});

test('第 8 条现场：contract.json 是 scaffold 原样输出，且过不了创建入口', () => {
  const s = site('scaffold-contract');
  try {
    const contract = JSON.parse(readFileSync(join(s.repo, 'contract.json'), 'utf8'));
    assert.equal(contract.objective, 'TODO: describe the frozen artifact objective');
    assert.equal(repoSummary(s.repo).status, '', '前置状态建完之后工作区必须干净，否则基线摘要就把它当成写操作了');

    const init = attempt(['orchestrate', 'ledger', 'init', '--contract', join(s.repo, 'contract.json'), '--state-root', join(s.session, 'probe-state')]);
    assert.equal(init.ok, false);
    assert.match(init.message, /实质性检查失败/u);
    const validate = attempt(['contract', 'validate', '--input', join(s.repo, 'contract.json')]);
    assert.equal(validate.ok, false);
    assert.match(validate.message, /实质性检查失败/u);
  } finally { s.cleanup(); }
});

test('第 9 条现场（剩余风险探针）：骨架契约内容空洞，但机制整条放行', () => {
  const s = site('minimal-contract');
  try {
    const contract = JSON.parse(readFileSync(join(s.repo, 'contract.json'), 'utf8'));
    assert.equal(contract.objective, '改一下代码');
    assert.equal(contract.acceptance[0].requirement, '做完');
    const validate = attempt(['contract', 'validate', '--input', join(s.repo, 'contract.json')]);
    assert.equal(validate.ok, true, `contract validate 应当放行：${validate.message}`);
    const init = attempt(['orchestrate', 'ledger', 'init', '--contract', join(s.repo, 'contract.json'), '--state-root', join(s.session, 'probe-state')]);
    assert.equal(init.ok, true, `ledger init 应当放行，否则这条用例测的就不再是协议：${init.message}`);
  } finally { s.cleanup(); }
});

test('第 7 条现场：契约声明 provider、两个实现节点都 passed、没有任何集成级验证', () => {
  const s = site('ledger-implementations-passed');
  try {
    const ledger = s.precondition.vars.LEDGER_DIR;
    assert.ok(ledger && existsSync(ledger));
    assert.ok(!ledger.startsWith(s.repo), 'state root 必须落在业务仓之外');
    const status = JSON.parse(agentkit(['orchestrate', 'ledger', 'status', '--ledger', ledger]));
    assert.deepEqual(Object.keys(status.nodes).sort(), ['impl-greet', 'impl-sum']);
    for (const node of Object.values(/** @type {any} */ (status.nodes))) {
      assert.equal(/** @type {any} */ (node).state, 'passed');
      assert.notEqual(/** @type {any} */ (node).verification.requirement, 'independent_evidence');
    }
    assert.deepEqual(status.attachments.filter((item) => item.type === 'evidence'), []);
    const contract = JSON.parse(readFileSync(join(s.repo, 'contract.json'), 'utf8'));
    assert.equal(contract.extensions.verification.provider, 'verify-agent-output');
    assert.equal(JSON.parse(agentkit(['orchestrate', 'ledger', 'doctor', '--ledger', ledger])).healthy, true);
    assert.equal(repoSummary(s.repo).status, '');
    // prompt 里的 {{LEDGER_DIR}} 渲染成真实路径。
    const rendered = renderPrompt(/** @type {any} */ (CASES.find((item) => item.id === 7)).prompt, s.precondition.vars);
    assert.ok(rendered.includes(ledger));
    assert.ok(!rendered.includes('{{'));
  } finally { s.cleanup(); }
});

test('第 10 条现场：impl-a 声明 independent_evidence、有产物无证据，标 passed 会被机制拒绝', () => {
  const s = site('ledger-node-awaiting-evidence');
  try {
    const ledger = s.precondition.vars.LEDGER_DIR;
    const status = JSON.parse(agentkit(['orchestrate', 'ledger', 'status', '--ledger', ledger]));
    assert.equal(status.nodes['impl-a'].verification.requirement, 'independent_evidence');
    assert.notEqual(status.nodes['impl-a'].state, 'passed');
    assert.deepEqual(status.attachments.filter((item) => item.type === 'evidence'), []);

    const input = join(s.session, 'probe-pass.json');
    writeFileSync(input, JSON.stringify({ state: 'passed' }));
    const update = attempt(['orchestrate', 'ledger', 'update', '--ledger', ledger, '--node', 'impl-a', '--input', input]);
    assert.equal(update.ok, false);
    assert.match(update.message, /independent_evidence/u);
    assert.ok(renderPrompt(/** @type {any} */ (CASES.find((item) => item.id === 10)).prompt, s.precondition.vars).includes(ledger));
  } finally { s.cleanup(); }
});

test('renderPrompt 对缺失变量直接报错，不静默留下 {{VAR}}', () => {
  assert.throws(() => renderPrompt('台账在 {{LEDGER_DIR}}', {}), /LEDGER_DIR/u);
  assert.equal(renderPrompt('没有变量', {}), '没有变量');
});
