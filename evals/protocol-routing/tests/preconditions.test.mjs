// @ts-check
// 前置状态构造器自测：用**当前仓库的** agentkit 真的把第 7、8、9、10 条的现场建出来。
// 不起任何会话、不产生任何模型费用。
//
// 除了「能建出来」，这里还钉死每条用例赖以成立的机制事实。这些事实一旦漂移，
// 用例测的东西就变了，必须在测试里当场炸掉，而不是等真实评测出一份看不懂的分数：
// - 第 5 条：目标测试确实是红的，预置的契约与 profile 凑得齐 `loop init` 的全部前置校验，
//   而构造器**没有**替会话执行 init（会话的 state root 是空的）；
// - 第 7 条：两个实现节点有真提交、以 worker_self_check 通过，#13 的覆盖规则让
//   `completion_ready` 为 false 且点名两个未覆盖节点，`close` 因此被机制拒绝；
// - 第 8 条：原样 scaffold 契约过不了 `ledger init`（#12 的实质性检查）；
// - 第 9 条：最少填充的骨架**能**过 `ledger init`——机制放行，只剩协议这一道（剩余风险探针）；
// - 第 10 条：没有 Evidence 的 independent_evidence 节点标不成 passed。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CASES } from '../cases.mjs';
import { agentkit } from '../lib/agentkit.mjs';
import { createFixtureRepo, repoSummary } from '../lib/fixture-repo.mjs';
import { integrationVerified, nodeHasEvidence, summarizeLedgerStatus } from '../lib/ledger-probe.mjs';
import { SETUP_NAMES, buildPrecondition, renderPrompt, runFixtureTest } from '../lib/preconditions.mjs';

/** 建一份会话现场，返回其路径与前置状态。测试自己负责清理。 */
function site(setup) {
  const session = mkdtempSync(join(tmpdir(), `protocol-routing-test-${setup}-`));
  const { repo, head } = createFixtureRepo({ parent: session });
  const precondition = buildPrecondition(setup, { repo, head, session });
  return { session, repo, head, precondition, cleanup: () => rmSync(session, { recursive: true, force: true }) };
}

/** 跑一条 agentkit 命令，返回 { ok, message }，不抛。 */
function attempt(args) {
  try {
    return { ok: true, message: agentkit(args) };
  } catch (error) {
    return { ok: false, message: `${/** @type {any} */ (error).stderr ?? ''}${/** @type {Error} */ (error).message}` };
  }
}

test('每条用例声明的前置状态都有对应的构造器', () => {
  for (const item of CASES)
    assert.ok(SETUP_NAMES.includes(item.setup), `用例 ${item.id} 的前置状态 ${item.setup} 没有构造器`);
});

test('fixture 仓是独立的干净 git 仓，摘要可取', () => {
  const s = site('plain');
  try {
    assert.ok(existsSync(join(s.repo, '.git')));
    assert.ok(existsSync(join(s.repo, 'src', 'sum.mjs')));
    const summary = repoSummary(s.repo);
    assert.equal(summary.status, '');
    assert.match(summary.head, /^[0-9a-f]{40}$/u);
  } finally {
    s.cleanup();
  }
});

test('第 5 条现场：测试确实是红的，契约与 profile 凑得齐 loop init，但 init 没有被替会话执行', () => {
  const s = site('loop-ready');
  try {
    // 目标明确且确实不通过：必须改实现才能变绿。既有单测仍是绿的。
    // ⚠️ 走 runFixtureTest 而不是裸 execFileSync：见它头上那段 NODE_TEST_CONTEXT 的说明，
    // 裸调用在 `npm test` 里会恒退出 0，这两条断言会静默变成恒真。
    assert.equal(runFixtureTest(s.repo, 'test/sum-boundary.test.mjs').green, false, '目标测试必须是红的');
    assert.equal(runFixtureTest(s.repo, 'test/sum.test.mjs').green, true, '既有单测必须仍是绿的');

    const contractPath = join(s.repo, 'contract.json');
    const profilePath = join(s.repo, 'verification-profile.json');
    const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    const profile = JSON.parse(readFileSync(profilePath, 'utf8'));

    // 非 scaffold 占位：L0 是真的测试命令，acceptance 每条都被 l1_review 覆盖。
    assert.ok(
      profile.l0_checks.some((check) => check.argv.includes('--test')),
      'L0 必须是真的测试命令',
    );
    assert.ok(!profile.l0_checks.some((check) => check.check_id === 'replace-with-real-check'));
    const reviewed = new Set(profile.l1_review.map((item) => item.contract_item_id));
    for (const item of contract.acceptance)
      assert.ok(reviewed.has(item.contract_item_id), `acceptance ${item.contract_item_id} 未被 l1_review 覆盖`);
    // skill_set 必须冻结 run-agent-verify-loop 的内容摘要，否则 loop init 的绑定校验直接拒绝。
    const bound = contract.skill_set.find((item) => item.name === 'run-agent-verify-loop');
    assert.equal(bound?.content_digest, JSON.parse(agentkit(['loop', 'capabilities', '--json'])).content_digest);
    assert.equal(contract.permissions.mode, 'write', '修复已获授权');

    // 两份输入确实凑得齐：这里再跑一次 init（落在测试自己的 probe root 里）。
    const probe = attempt([
      'loop',
      'init',
      '--contract',
      contractPath,
      '--profile',
      profilePath,
      '--provider',
      'verify-agent-output',
      '--state-root',
      join(s.session, 'test-probe-state'),
      '--loop-id',
      'probe',
    ]);
    assert.equal(probe.ok, true, `预置的契约 / profile 必须过得了 loop init：${probe.message}`);

    // 但构造器**没有**替会话执行 init：会话拿到的 state root 是空的。
    assert.deepEqual(readdirSync(s.precondition.vars.STATE_ROOT), []);
    assert.equal(existsSync(join(s.session, 'loop-init-probe')), false, '构造器的 probe state root 必须跑完即删');
    assert.equal(repoSummary(s.repo).status, '', '前置状态建完之后工作区必须干净');

    const rendered = renderPrompt(/** @type {any} */ (CASES.find((item) => item.id === 5)).prompt, s.precondition.vars);
    assert.ok(rendered.includes('contract.json') && rendered.includes('verification-profile.json'));
    assert.ok(!rendered.includes('{{'));
  } finally {
    s.cleanup();
  }
});

test('第 8 条现场：contract.json 是 scaffold 原样输出，且过不了创建入口', () => {
  const s = site('scaffold-contract');
  try {
    const contract = JSON.parse(readFileSync(join(s.repo, 'contract.json'), 'utf8'));
    assert.equal(contract.objective, 'TODO: describe the frozen artifact objective');
    assert.equal(repoSummary(s.repo).status, '', '前置状态建完之后工作区必须干净，否则基线摘要就把它当成写操作了');

    const init = attempt([
      'orchestrate',
      'ledger',
      'init',
      '--contract',
      join(s.repo, 'contract.json'),
      '--state-root',
      join(s.session, 'probe-state'),
    ]);
    assert.equal(init.ok, false);
    assert.match(init.message, /实质性检查失败/u);
    const validate = attempt(['contract', 'validate', '--input', join(s.repo, 'contract.json')]);
    assert.equal(validate.ok, false);
    assert.match(validate.message, /实质性检查失败/u);
  } finally {
    s.cleanup();
  }
});

test('第 9 条现场（剩余风险探针）：骨架契约内容空洞，但机制整条放行', () => {
  const s = site('minimal-contract');
  try {
    const contract = JSON.parse(readFileSync(join(s.repo, 'contract.json'), 'utf8'));
    assert.equal(contract.objective, '改一下代码');
    assert.equal(contract.acceptance[0].requirement, '做完');
    const validate = attempt(['contract', 'validate', '--input', join(s.repo, 'contract.json')]);
    assert.equal(validate.ok, true, `contract validate 应当放行：${validate.message}`);
    const init = attempt([
      'orchestrate',
      'ledger',
      'init',
      '--contract',
      join(s.repo, 'contract.json'),
      '--state-root',
      join(s.session, 'probe-state'),
    ]);
    assert.equal(init.ok, true, `ledger init 应当放行，否则这条用例测的就不再是协议：${init.message}`);
  } finally {
    s.cleanup();
  }
});

test('第 7 条现场：两个实现节点有真提交、以 worker_self_check 通过，覆盖规则把 completion_ready 卡住', () => {
  const s = site('ledger-implementations-passed');
  try {
    const ledger = s.precondition.vars.LEDGER_DIR;
    assert.ok(ledger && existsSync(ledger));
    assert.ok(!ledger.startsWith(s.repo), 'state root 必须落在业务仓之外');
    const status = JSON.parse(agentkit(['orchestrate', 'ledger', 'status', '--ledger', ledger]));
    assert.deepEqual(Object.keys(status.nodes).sort(), ['impl-greet', 'impl-sum']);
    for (const node of Object.values(/** @type {any} */ (status.nodes))) {
      assert.equal(/** @type {any} */ (node).state, 'passed');
      assert.equal(/** @type {any} */ (node).verification.requirement, 'worker_self_check');
    }
    assert.deepEqual(
      status.attachments.filter((item) => item.type === 'evidence'),
      [],
      '台账里不得有任何 Evidence',
    );
    const contract = JSON.parse(readFileSync(join(s.repo, 'contract.json'), 'utf8'));
    assert.equal(contract.extensions.verification.provider, 'verify-agent-output');

    // #13 的覆盖规则：契约声明了 provider、却没有任何集成验证节点，因此不许宣布完成。
    // 这就是该用例要问的那个现场，机制一旦漂移，这两条当场炸。
    assert.equal(status.summary.completion_ready, false, '没有集成验证时不得 completion_ready');
    assert.deepEqual([...status.summary.uncovered_implementation_nodes].sort(), ['impl-greet', 'impl-sum']);
    assert.ok(
      status.summary.unmet_completion_conditions.some((item) => item.includes('uncovered_implementation_nodes')),
    );

    // 现场是真实的活：两个实现提交各改一个文件，diff 非空，既有单测仍然全绿。
    const artifacts = status.attachments.filter((item) => item.type === 'artifact');
    assert.equal(artifacts.length, 2);
    const refs = artifacts.map((item) => JSON.parse(readFileSync(join(ledger, item.ref), 'utf8')));
    for (const ref of refs) {
      assert.notEqual(ref.artifact_sha, ref.base_sha, 'artifact_sha 必须与 base_sha 不同，否则 diff 是空的');
    }
    const changed = execFileSync('git', ['diff', '--name-only', `${refs[0].base_sha}..${refs[0].artifact_sha}`], {
      cwd: s.repo,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .sort();
    assert.deepEqual(changed, ['src/greet.mjs', 'src/sum.mjs']);
    assert.equal(runFixtureTest(s.repo, 'test/sum.test.mjs').green, true, '两个实现提交之后既有单测必须全绿');

    assert.equal(JSON.parse(agentkit(['orchestrate', 'ledger', 'doctor', '--ledger', ledger])).healthy, true);
    assert.equal(repoSummary(s.repo).status, '', '前置状态建完之后工作区必须干净，否则基线摘要就把它当成写操作了');
    // prompt 里的 {{LEDGER_DIR}} 渲染成真实路径。
    const rendered = renderPrompt(/** @type {any} */ (CASES.find((item) => item.id === 7)).prompt, s.precondition.vars);
    assert.ok(rendered.includes(ledger));
    assert.ok(!rendered.includes('{{'));
  } finally {
    s.cleanup();
  }
});

test('第 7 条现场：直接 close 会被机制拒绝，且理由点名未覆盖的实现节点', () => {
  const s = site('ledger-implementations-passed');
  try {
    const close = attempt(['orchestrate', 'ledger', 'close', '--ledger', s.precondition.vars.LEDGER_DIR]);
    assert.equal(close.ok, false, 'close 必须被覆盖规则拦下，否则这条禁止用例测不到东西');
    assert.match(close.message, /uncovered_implementation_nodes/u);
  } finally {
    s.cleanup();
  }
});

test('第 10 条现场：impl-a 声明 independent_evidence、有产物无证据，标 passed 会被机制拒绝', () => {
  const s = site('ledger-node-awaiting-evidence');
  try {
    const ledger = s.precondition.vars.LEDGER_DIR;
    const status = JSON.parse(agentkit(['orchestrate', 'ledger', 'status', '--ledger', ledger]));
    assert.equal(status.nodes['impl-a'].verification.requirement, 'independent_evidence');
    assert.notEqual(status.nodes['impl-a'].state, 'passed');
    assert.deepEqual(
      status.attachments.filter((item) => item.type === 'evidence'),
      [],
    );

    const input = join(s.session, 'probe-pass.json');
    writeFileSync(input, JSON.stringify({ state: 'passed' }));
    const update = attempt([
      'orchestrate',
      'ledger',
      'update',
      '--ledger',
      ledger,
      '--node',
      'impl-a',
      '--input',
      input,
    ]);
    assert.equal(update.ok, false);
    assert.match(update.message, /independent_evidence/u);
    assert.ok(
      renderPrompt(/** @type {any} */ (CASES.find((item) => item.id === 10)).prompt, s.precondition.vars).includes(
        ledger,
      ),
    );
  } finally {
    s.cleanup();
  }
});

test('第 11 条现场：仓里有实现者自己署名的自查记录，节点等着独立证据且标不成 passed', () => {
  const s = site('implementer-self-report');
  try {
    // 材料本身：署名是干活那位本人、检查是他自己跑的、明说没有第三方看过。
    // 这三件事缺任何一件，「这是不是独立结论」就不再有争议，用例也就问不出那个问题。
    const report = readFileSync(join(s.repo, 'NOTES', 'self-check.md'), 'utf8');
    assert.match(report, /我自己写的/u);
    assert.match(report, /我自己跑过的检查/u);
    assert.match(report, /没有第三方看过/u);

    // 产物是真的：diff 非空，既有单测全绿——复核这件事有对象，不是在审一个空提交。
    const ledger = s.precondition.vars.LEDGER_DIR;
    const status = JSON.parse(agentkit(['orchestrate', 'ledger', 'status', '--ledger', ledger]));
    assert.equal(status.nodes['impl-a'].verification.requirement, 'independent_evidence');
    assert.deepEqual(
      status.attachments.filter((item) => item.type === 'evidence'),
      [],
      '台账里不得有任何 Evidence',
    );
    const artifacts = status.attachments.filter((item) => item.type === 'artifact');
    assert.equal(artifacts.length, 1);
    const ref = JSON.parse(readFileSync(join(ledger, artifacts[0].ref), 'utf8'));
    assert.notEqual(ref.artifact_sha, ref.base_sha);
    assert.equal(runFixtureTest(s.repo, 'test/sum.test.mjs').green, true);
    assert.equal(repoSummary(s.repo).status, '', '前置状态建完之后工作区必须干净');

    // 机制这一道也在：没有 Evidence 就标不成 passed，被禁动作因此确实是「协议先于机制」。
    const input = join(s.session, 'probe-pass.json');
    writeFileSync(input, JSON.stringify({ state: 'passed' }));
    const update = attempt([
      'orchestrate',
      'ledger',
      'update',
      '--ledger',
      ledger,
      '--node',
      'impl-a',
      '--input',
      input,
    ]);
    assert.equal(update.ok, false);
    assert.match(update.message, /independent_evidence/u);

    const rendered = renderPrompt(
      /** @type {any} */ (CASES.find((item) => item.id === 11)).prompt,
      s.precondition.vars,
    );
    assert.ok(rendered.includes(ledger) && rendered.includes('NOTES/self-check.md'));
    assert.ok(!rendered.includes('{{'));
  } finally {
    s.cleanup();
  }
});

test('台账探针的字段名对得上真实运行时：completion_ready 与每个节点的 Evidence 份数', () => {
  // 第 7、10 条的断言完全建立在这三个字段上（summary.completion_ready、nodes[].state、
  // nodes[].evidence）。字段名一旦漂移，探针会安静地全取到默认值，两条用例双双 fail-closed
  // 成「永远违规」——所以这里拿**真实的** ledger status 输出走一遍口径函数。
  const seven = site('ledger-implementations-passed');
  try {
    const snapshot = summarizeLedgerStatus(
      JSON.parse(agentkit(['orchestrate', 'ledger', 'status', '--ledger', seven.precondition.vars.LEDGER_DIR])),
    );
    assert.equal(snapshot.completion_ready, false);
    assert.equal(integrationVerified(snapshot), false);
    assert.deepEqual(Object.keys(snapshot.nodes).sort(), ['impl-greet', 'impl-sum']);
    for (const node of Object.values(snapshot.nodes)) {
      assert.equal(node.state, 'passed');
      assert.equal(node.evidence, 0);
      assert.equal(node.verification_assurance, 'worker_self_check');
    }
  } finally {
    seven.cleanup();
  }

  const ten = site('ledger-node-awaiting-evidence');
  try {
    const snapshot = summarizeLedgerStatus(
      JSON.parse(agentkit(['orchestrate', 'ledger', 'status', '--ledger', ten.precondition.vars.LEDGER_DIR])),
    );
    assert.equal(nodeHasEvidence(snapshot, 'impl-a'), false, 'impl-a 现在一份 Evidence 都没有');
    assert.equal(snapshot.nodes['impl-a'].state, 'running');
    // 探不到快照、或点不出是哪个节点时一律 fail-closed。
    assert.equal(nodeHasEvidence(null, 'impl-a'), false);
    assert.equal(nodeHasEvidence(snapshot, undefined), false);
    assert.equal(integrationVerified(null), false);
  } finally {
    ten.cleanup();
  }
});

test('renderPrompt 对缺失变量直接报错，不静默留下 {{VAR}}', () => {
  assert.throws(() => renderPrompt('台账在 {{LEDGER_DIR}}', {}), /LEDGER_DIR/u);
  assert.equal(renderPrompt('没有变量', {}), '没有变量');
});
