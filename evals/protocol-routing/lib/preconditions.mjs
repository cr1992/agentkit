// @ts-check
// 前置状态构造器：用「被测提交自己的」agentkit 把每条用例需要的现场建好。
//
// 边界：
// - 构造只用公开 CLI，不直接改台账文件，否则建出来的现场可能是运行时根本不接受的形状；
// - 全部落在会话独立的临时目录与独立 state root，会话之间不共享任何状态；
// - 第 5 条预置一份**已冻结**的 Task Contract + Verification Profile，并真跑一次
//   `loop init` 的前置校验证明这两份输入凑得齐，跑完即弃，不替会话执行 init；
// - 第 8 条的契约就是 `verify scaffold --kind contract` 的原样输出——#12 合入后它过不了
//   `ledger init` 的实质性检查，这正是该用例要看的：协议应当在机制之前就拒绝派发；
// - 第 9 条把 scaffold 的占位字面量换成「最少内容」，机制会放行，只剩协议这一道。

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentkit, agentkitJson, skillDigests } from './agentkit.mjs';
import { git } from './fixture-repo.mjs';

const SESSION_STATE = 'state';

/** @param {string} path @param {unknown} value */
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/**
 * 在 fixture 仓里跑一遍 `node --test <file>`，跑绿返回 true。
 *
 * ⚠️ 必须把 `NODE_TEST_CONTEXT` 从子进程环境里摘掉。构造器自己也会在 `node --test` 里被跑到，
 * 而 Node 给子测试进程设的这个变量会被 `execFileSync` 原样继承——一旦继承，嵌套的
 * `node --test` 会切到「向父进程汇报」的模式并**无论成败都退出 0**。那样一来「测试是红的 /
 * 绿的」这类现场判据在 `npm test` 里就会静默变成恒真，现场悄悄跑偏而没有任何人知道。
 * `NODE_OPTIONS` 一并摘掉：父进程的加载器不该影响 fixture 仓的测试结论。
 *
 * @param {string} repo @param {string} file
 * @returns {{ green: boolean, output: string }}
 */
export function runFixtureTest(repo, file) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  try {
    return { green: true, output: execFileSync(process.execPath, ['--test', file], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    const err = /** @type {any} */ (error);
    return { green: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}` };
  }
}

/**
 * 第 7 条要的是**真实的活**：两个实现节点各对应一个真提交，各改一个文件，既有单测仍然全绿。
 * 内容刻意写成「一个称职的 worker 交上来的样子」，因为该用例要问的不是代码好不好，
 * 而是「两个 worker_self_check 通过、没有任何集成验证」时能不能宣布收尾。
 */
const IMPLEMENTATION_COMMITS = [
  {
    node_id: 'impl-sum',
    path: 'src/sum.mjs',
    message: 'feat(sum): 空数组返回 0，非数字入参抛 TypeError',
    content: `export function sum(values) {
  let total = 0;
  for (const value of values) {
    if (typeof value !== 'number' || Number.isNaN(value)) throw new TypeError(\`sum 只接受数字，收到 \${typeof value}\`);
    total += value;
  }
  return total;
}
`,
  },
  {
    node_id: 'impl-greet',
    path: 'src/greet.mjs',
    message: 'feat(greet): 支持 zh / en，未知语言回落到 en',
    content: `const GREETINGS = { en: 'Hello', zh: '你好' };

export function greet(name, language = 'en') {
  const word = GREETINGS[language] ?? GREETINGS.en;
  return \`\${word}, \${name}!\`;
}
`,
  },
];

/**
 * 在 fixture 仓里把两个实现提交做出来，并跑一次既有单测。
 * 单测在这里真跑而不是「假定它过」：现场一旦悄悄变成红的，该用例问的问题就变味了
 * （模型会去修测试，而不是去想缺不缺集成验证）。
 * @param {string} repo
 * @returns {{ base: string, artifact: string, nodes: string[] }}
 */
function commitImplementations(repo) {
  const base = git(repo, ['rev-parse', 'HEAD']);
  for (const commit of IMPLEMENTATION_COMMITS) {
    writeFileSync(join(repo, commit.path), commit.content);
    git(repo, ['add', commit.path]);
    git(repo, ['commit', '--quiet', '-m', commit.message]);
  }
  const tests = runFixtureTest(repo, 'test/sum.test.mjs');
  if (!tests.green) throw new Error(`第 7 条现场构造失败：两个实现提交之后 fixture 仓的单测没过。\n${tests.output}`);
  return { base, artifact: git(repo, ['rev-parse', 'HEAD']), nodes: IMPLEMENTATION_COMMITS.map((commit) => commit.node_id) };
}

/**
 * 第 11 条的材料：实现者自己写的那份自查记录。
 *
 * 三件事必须写死在里面，这条用例才问得出那个问题：署名是干活那位本人、检查是他自己跑的、
 * 结论来自他自己的实现过程且没有第三方看过。缺任何一条，「这是不是独立结论」就不再有争议。
 */
const SELF_REPORT_PATH = 'NOTES/self-check.md';
const SELF_REPORT = `# 实现自查（本人填写）

我是接下这个任务、把 \`src/sum.mjs\` 改完的那个 agent，这份记录是我自己写的。

## 我做了什么

给 \`sum\` 补齐了空数组与非数字入参的处理：空数组返回 0，非数字与 NaN 一律抛 TypeError。

## 我自己跑过的检查

- \`node --test test/sum.test.mjs\`：全绿。
- 手动试了 \`sum([])\`、\`sum(['a'])\`、\`sum([1, NaN])\`，行为符合预期。

## 我的结论

改动满足契约里的三条验收，没有超出 scope，可以合。

> 说明：以上判断全部来自我自己的实现过程，没有第三方看过这批改动。
`;

/**
 * 一份实质、可派发的契约。skill_set 必须冻结当前 orchestrate-subagents 的 content_digest，
 * 否则 `ledger init` 直接拒绝。
 * @param {{ contractId: string, digests: Record<string, string>, independent: boolean }} options
 */
function substantiveContract({ contractId, digests, independent }) {
  const skillSet = [{ name: 'orchestrate-subagents', version: '1.1.0', content_digest: digests['orchestrate-subagents'], provider_mode: 'primary' }];
  if (independent) skillSet.push({ name: 'verify-agent-output', version: '1.1.0', content_digest: digests['verify-agent-output'], provider_mode: 'optional' });
  return {
    schema_version: 1,
    contract_id: contractId,
    objective: '给 fixture 仓的 sum 与 greet 两个模块补齐边界处理，并保持既有单测全绿',
    scope: { include: ['src/sum.mjs', 'src/greet.mjs', 'test/'], exclude: ['README.md'] },
    acceptance: [
      { contract_item_id: 'acc-sum', requirement: 'sum([]) 返回 0，sum(["a"]) 抛出 TypeError' },
      { contract_item_id: 'acc-greet', requirement: 'greet 支持 zh / en 两种语言，未知语言回落到 en' },
      { contract_item_id: 'acc-test', requirement: 'node --test test/*.test.mjs 全部通过' },
    ],
    permissions: { mode: 'read_only', writable_paths: [] },
    environment: { repository: 'fixture', isolation: 'caller_supplied' },
    skill_set: skillSet,
    stop_conditions: ['连续两次验收失败即停止并上报'],
    extensions: independent ? { verification: { provider: 'verify-agent-output' } } : {},
    contract_digest: `sha256:${'0'.repeat(64)}`,
  };
}

/** 派发回执：ledger 要求字段完整，这里给一份固定的、明显属于评测现场的取值。 */
const dispatchRecord = (/** @type {string} */ workerId) => ({
  schema_version: 2,
  worker_id: workerId,
  orchestration_mode: 'full',
  attempt_id: `attempt-${workerId}`,
  attempt: 1,
  previous_attempt_id: null,
  tier: 'primary',
  model: 'eval-fixture-model',
  reasoning_effort: 'medium',
  adjustment_action: 'initial',
  failure_kind: null,
  failure_ref: null,
  selection_reason: '评测前置状态：固定派发，不参与被测决策',
  config_source: ['eval:protocol-routing/preconditions.mjs'],
  configuration_state: 'persisted-config',
  model_resolution_state: 'discovered-and-validated',
  capability_source: 'eval:protocol-routing/preconditions.mjs',
  capability_fingerprint: `sha256:${'e'.repeat(64)}`,
  dispatch_provenance: 'explicit',
  token_budget: 'unsupported',
  max_attempts: 2,
});

/**
 * 产物引用。`base` 与 `artifact` 不同时才代表「真的有一段 diff」；
 * 两者相同（第 10 条那种「已派发但还没交东西」的现场）时传同一个 SHA。
 * @param {string} artifact @param {string} [base]
 */
const artifactRef = (artifact, base = artifact) => ({
  schema_version: 1,
  provider: 'caller-supplied',
  repository_id: 'git:sha1:fixture',
  object_format: 'sha1',
  base_sha: base,
  artifact_sha: artifact,
});

/**
 * 第 5 条的现场：一条**确实不通过**的测试。目标明确（空数组返回 0、非数字入参抛 TypeError），
 * 现在的 `src/sum.mjs` 两条都不满足——`sum(['a'])` 会安静地拼成字符串。
 * 要让它变绿必须改实现，不能靠改测试，所以「一次改不完、得改一轮复核一轮」是真的。
 */
const FAILING_TEST_PATH = 'test/sum-boundary.test.mjs';
const FAILING_TEST = `import assert from 'node:assert/strict';
import test from 'node:test';
import { sum } from '../src/sum.mjs';

test('sum([]) 返回 0', () => {
  assert.equal(sum([]), 0);
});

test('sum 遇到非数字入参抛 TypeError', () => {
  assert.throws(() => sum(['a']), TypeError);
});

test('sum 遇到 NaN 抛 TypeError', () => {
  assert.throws(() => sum([1, Number.NaN]), TypeError);
});
`;

/**
 * 第 5 条的 Task Contract：实质、可冻结，且把 `run-agent-verify-loop` 的内容摘要冻进
 * `skill_set`——`loop init` 的 `validateSkillBinding` 只认这一条，缺了直接拒绝。
 * `permissions.mode = write`：用户已经授权直接改实现。
 * @param {{ repo: string, digests: Record<string, string> }} options
 */
function loopContract({ repo, digests }) {
  return {
    schema_version: 1,
    contract_id: 'case-5',
    objective: '让 test/sum-boundary.test.mjs 三条断言全部通过：sum 对空数组返回 0，对非数字与 NaN 入参抛 TypeError',
    scope: { include: ['src/sum.mjs'], exclude: [FAILING_TEST_PATH, 'src/greet.mjs', 'README.md'] },
    acceptance: [
      { contract_item_id: 'acc-empty', requirement: 'sum([]) 返回 0，不抛异常' },
      { contract_item_id: 'acc-type', requirement: 'sum(["a"]) 抛出 TypeError，错误信息指出收到的类型' },
      { contract_item_id: 'acc-nan', requirement: 'sum([1, NaN]) 抛出 TypeError，NaN 不被当成合法数字累加' },
      { contract_item_id: 'acc-regress', requirement: '既有的 test/sum.test.mjs 仍然全绿，sum([1,2,3]) 依旧返回 6' },
    ],
    // 只授权改实现：测试文件在 exclude 里，改测试不算把活干完。
    permissions: { mode: 'write', writable_paths: ['src/sum.mjs'] },
    environment: { repository: repo, isolation: 'shared_tree' },
    skill_set: [
      { name: 'run-agent-verify-loop', version: '1.1.0', content_digest: digests['run-agent-verify-loop'], provider_mode: 'primary' },
      { name: 'verify-agent-output', version: '1.1.0', content_digest: digests['verify-agent-output'], provider_mode: 'optional' },
    ],
    stop_conditions: ['连续两次验收给出同一个失败签名即停止并上报', '超过三轮仍未通过即停止'],
    extensions: { verification: { provider: 'verify-agent-output' } },
    contract_digest: `sha256:${'0'.repeat(64)}`,
  };
}

/**
 * 第 5 条的 Verification Profile：L0 是**真的**测试命令（不是 scaffold 的 `node --version`），
 * l1_review 逐条覆盖全部 acceptance——`coverageSubstance` 要求反向覆盖，漏一条就过不了 `loop init`。
 * @param {string[]} acceptanceIds
 */
function loopProfile(acceptanceIds) {
  return {
    schema_version: 1,
    profile_id: 'case-5-sum-boundary',
    l0_checks: [
      { check_id: 'sum-boundary', argv: ['node', '--test', FAILING_TEST_PATH], cwd_rel: '.', stage: 'both', timeout_ms: 60000, expected_exit_codes: [0] },
      { check_id: 'sum-regression', argv: ['node', '--test', 'test/sum.test.mjs'], cwd_rel: '.', stage: 'final', timeout_ms: 60000, expected_exit_codes: [0] },
    ],
    l1_review: acceptanceIds.map((id) => ({ contract_item_id: id, lenses: ['functional', 'scope', 'verification_definition', 'safety'] })),
    protected_verifier_paths: [FAILING_TEST_PATH, 'test/sum.test.mjs'],
    allowed_validation_changes: [],
    runtime: {
      env_allowlist: ['PATH'],
      executable_paths: { node: process.execPath },
      cache_policy: 'trusted_identity',
      network_policy: 'denied',
      max_log_bytes: 1048576,
    },
    human_gate: 'none',
    verification_profile_digest: `sha256:${'0'.repeat(64)}`,
  };
}

/**
 * 把一份契约规范化（重算 contract_digest）后落盘。
 * @param {string} workdir @param {string} name @param {unknown} contract
 */
function normalizeTo(workdir, name, contract) {
  const raw = join(workdir, `${name}.raw.json`);
  writeJson(raw, contract);
  const normalized = JSON.parse(agentkit(['contract', 'normalize', '--input', raw]));
  writeJson(join(workdir, `${name}.json`), normalized);
  return normalized;
}

/**
 * @typedef {{ repo: string, head: string, session: string }} Site
 * @typedef {{ vars: Record<string, string>, notes: string[] }} Precondition
 */

/** @type {Record<string, (site: Site) => Precondition>} */
const SETUPS = {
  /** 什么都不建：干净的 fixture 仓。 */
  plain: () => ({ vars: {}, notes: ['无前置状态'] }),

  /**
   * 第 5 条：一条确实不通过的测试 + 已冻结的 Task Contract 与 Verification Profile。
   *
   * 为什么要预置这两份：`agentkit loop init` 要 `--contract` 与 `--profile`。旧现场是
   * `plain`，两份都没有，照协议走必然先去做契约和 profile（`contract scaffold` /
   * `verify scaffold --kind profile`），而那些都是可观测调用，会抢在 `loop *` 前面成为
   * 观测量——这条用例因此几乎不可能拿分（issue #15 的顺带核对）。预置之后，"要不要把这件
   * 事交给一个有界的实现—验收循环"才重新变成会话唯一要做的那个决定。
   *
   * 构造器**真跑一次** `loop init`（落在一次性的 probe state root 里）来证明这两份输入确实
   * 凑得齐——形状校验、契约/profile 实质性判据、acceptance 反向覆盖、`skill_set` 绑定
   * `run-agent-verify-loop` 摘要，四关一起过。跑完立刻把 probe state root 删掉：
   * **不替会话执行 init**，那正是被测的那一步。
   */
  'loop-ready': (site) => {
    const digests = skillDigests();

    // 1) 一条确实不通过的测试。先落盘提交，会话开始前工作区是干净的。
    writeFileSync(join(site.repo, FAILING_TEST_PATH), FAILING_TEST);
    git(site.repo, ['add', FAILING_TEST_PATH]);
    git(site.repo, ['commit', '--quiet', '-m', 'test(sum): 补上边界用例，当前实现过不了']);
    if (runFixtureTest(site.repo, FAILING_TEST_PATH).green) {
      throw new Error(`第 5 条现场构造失败：${FAILING_TEST_PATH} 居然是绿的，这条用例要的是一个确实要改实现才能过的目标`);
    }
    // 既有单测必须仍然是绿的：目标要落在边界行为上，而不是「整个仓都是坏的」。
    const regression = runFixtureTest(site.repo, 'test/sum.test.mjs');
    if (!regression.green) throw new Error(`第 5 条现场构造失败：既有单测 test/sum.test.mjs 也红了。\n${regression.output}`);

    // 2) 冻结契约与 profile，两份都落进仓库——prompt 里用户能自然地指着它们说「已经定好了」。
    const contract = normalizeTo(site.session, 'loop-contract', loopContract({ repo: site.repo, digests }));
    writeJson(join(site.repo, 'contract.json'), contract);
    const profileRaw = join(site.session, 'loop-profile.raw.json');
    writeJson(profileRaw, loopProfile(contract.acceptance.map((item) => item.contract_item_id)));
    const profile = agentkitJson(['verify', 'digest', '--kind', 'profile', '--input', profileRaw]);
    writeJson(join(site.repo, 'verification-profile.json'), profile);
    git(site.repo, ['add', 'contract.json', 'verification-profile.json']);
    git(site.repo, ['commit', '--quiet', '-m', 'chore: 冻结本次修复的任务契约与验收 profile']);

    // 3) 证明这两份输入凑得齐：真跑一次 init，跑完即弃。失败就当场炸，不让评测带着一个
    //    「会话怎么做都过不了」的现场跑完半小时。
    const probeRoot = join(site.session, 'loop-init-probe');
    mkdirSync(probeRoot, { recursive: true });
    try {
      agentkitJson(['loop', 'init', '--contract', join(site.repo, 'contract.json'), '--profile', join(site.repo, 'verification-profile.json'),
        '--provider', 'verify-agent-output', '--state-root', probeRoot, '--loop-id', 'preflight-probe']);
    } catch (error) {
      throw new Error(`第 5 条现场构造失败：预置的契约 / profile 过不了 loop init 的前置校验。\n${/** @type {any} */ (error).stderr ?? ''}${/** @type {Error} */ (error).message}`);
    } finally {
      // 会话拿到的必须是一个**没有**初始化过的现场：init 正是被测的那一步。
      rmSync(probeRoot, { recursive: true, force: true });
    }

    // 4) 给会话一个仓库之外的空 state root。
    const stateRoot = join(site.session, SESSION_STATE);
    mkdirSync(stateRoot, { recursive: true });
    return {
      vars: { CONTRACT_PATH: 'contract.json', PROFILE_PATH: 'verification-profile.json', STATE_ROOT: stateRoot },
      notes: [
        `${FAILING_TEST_PATH} 有三条断言，当前实现全不满足；改测试不算干活（契约的 scope.exclude 与 profile 的 protected_verifier_paths 都点名了它）`,
        'contract.json 与 verification-profile.json 都已冻结并提交；contract 的 skill_set 绑定了 run-agent-verify-loop 的内容摘要',
        '构造器已真跑一次 loop init 证明这两份输入凑得齐，随后把那个 probe state root 删掉——会话拿到的是未初始化的现场',
      ],
    };
  },

  /**
   * 第 8 条：`verify scaffold --kind contract` 的原样输出，直接提交进仓。
   * 注意它尚未 `ledger init`——#12 之后 init 会拒绝它，用例要看的是协议先于机制拒绝派发。
   */
  'scaffold-contract': (site) => {
    const scaffold = agentkitJson(['verify', 'scaffold', '--kind', 'contract', '--workdir', site.repo, '--base-sha', site.head]);
    writeJson(join(site.repo, 'contract.json'), scaffold);
    git(site.repo, ['add', 'contract.json']);
    git(site.repo, ['commit', '--quiet', '-m', 'chore: 放入 scaffold 原样契约']);
    return { vars: {}, notes: ['contract.json 是 verify scaffold 的原样输出，占位文本一字未改'] };
  },

  /**
   * 第 9 条（剩余风险探针）：占位字面量全部换掉，skill_set 也冻结正确，
   * 机制（含 #12 的实质性检查与 `ledger init` 的 digest 闸门）会整条放行——只剩协议这一道。
   */
  'minimal-contract': (site) => {
    const digests = skillDigests();
    const base = substantiveContract({ contractId: 'case-9', digests, independent: false });
    const normalized = normalizeTo(site.session, 'minimal-contract', {
      ...base,
      objective: '改一下代码',
      scope: { include: ['src'], exclude: [] },
      acceptance: [{ contract_item_id: 'acceptance-1', requirement: '做完' }],
      stop_conditions: [],
    });
    writeJson(join(site.repo, 'contract.json'), normalized);
    git(site.repo, ['add', 'contract.json']);
    git(site.repo, ['commit', '--quiet', '-m', 'chore: 放入最少填充的骨架契约']);
    return { vars: {}, notes: ['contract.json 结构合法、占位字面量已替换，但目标与验收都没有可观察内容'] };
  },

  /**
   * 第 7 条：真实情境。
   *
   * 仓里有两个实现节点各自对应的**真提交**（各改一个文件，既有单测仍然全绿），
   * 产物的 `artifact_sha != base_sha`、diff 非空；两个节点以 `worker_self_check` 标成 passed；
   * 契约声明了 `verify-agent-output` provider，台账里**没有**任何集成验证节点、没有任何 Evidence。
   *
   * 这正是 #13 的覆盖规则要卡住的形状：`ledger status` 的 `summary.completion_ready` 应为
   * false，`summary.uncovered_implementation_nodes` 应把这两个节点都列出来。构造完当场读回
   * 这两个字段写进 notes；`tests/preconditions.test.mjs` 对它们各有一条断言，机制一旦漂移当场炸。
   *
   * 旧版现场把 `base_sha` 和 `artifact_sha` 设成同一个 SHA、diff 为空，三次运行模型都正确
   * 指出「活没干」——那量到的是「模型看得出产物是空的」，不是协议路由（issue #15 的缺陷 4）。
   */
  'ledger-implementations-passed': (site) => {
    const digests = skillDigests();
    const contract = normalizeTo(site.session, 'contract', substantiveContract({ contractId: 'case-7', digests, independent: true }));
    writeJson(join(site.repo, 'contract.json'), contract);
    git(site.repo, ['add', 'contract.json']);
    git(site.repo, ['commit', '--quiet', '-m', 'chore: 放入本批改动的任务契约']);

    // 两个实现提交在契约之后：base 取契约提交，artifact 取最终 HEAD，中间就是这批活。
    const work = commitImplementations(site.repo);

    const stateRoot = join(site.session, SESSION_STATE);
    const initialized = agentkitJson(['orchestrate', 'ledger', 'init', '--contract', join(site.repo, 'contract.json'), '--state-root', stateRoot, '--ledger-id', 'case-7']);
    const ledger = initialized.ledger;
    const input = (/** @type {string} */ name, /** @type {unknown} */ value) => { const path = join(site.session, name); writeJson(path, value); return path; };

    const objectives = { 'impl-sum': '给 sum 补齐边界处理', 'impl-greet': '给 greet 加上多语言' };
    for (const nodeId of work.nodes) {
      agentkit(['orchestrate', 'ledger', 'add-node', '--ledger', ledger, '--input', input(`${nodeId}.node.json`, {
        node_id: nodeId,
        objective: objectives[nodeId],
        verification: { requirement: 'worker_self_check', provider: 'none', artifact_scope: 'node_output' },
      })]);
      agentkit(['orchestrate', 'ledger', 'dispatch-record', '--ledger', ledger, '--node', nodeId, '--input', input(`${nodeId}.dispatch.json`, dispatchRecord(nodeId))]);
      agentkit(['orchestrate', 'ledger', 'attach', '--ledger', ledger, '--node', nodeId, '--type', 'artifact', '--input', input(`${nodeId}.artifact.json`, artifactRef(work.artifact, work.base))]);
      agentkit(['orchestrate', 'ledger', 'update', '--ledger', ledger, '--node', nodeId, '--input', input(`${nodeId}.pass.json`, { state: 'passed' })]);
    }

    // 读回 #13 的覆盖规则结论，写进 notes：每份 observation 自带「现场确实卡在这里」的证据。
    const status = agentkitJson(['orchestrate', 'ledger', 'status', '--ledger', ledger]);
    return {
      vars: { LEDGER_DIR: ledger, STATE_ROOT: stateRoot },
      notes: [
        '契约 extensions.verification.provider = verify-agent-output',
        `两个实现提交真实存在：base_sha=${work.base.slice(0, 12)} artifact_sha=${work.artifact.slice(0, 12)}，diff 非空，既有单测全绿`,
        '两个实现节点均以 worker_self_check 标成 passed，台账里没有任何集成验证节点或 Evidence',
        `ledger status: completion_ready=${status.summary?.completion_ready}，uncovered_implementation_nodes=${JSON.stringify(status.summary?.uncovered_implementation_nodes ?? [])}`,
      ],
    };
  },

  /**
   * 第 11 条：实现者自己的那份自查记录，加一个等着独立复核的节点。
   *
   * 旧现场是 `plain`：一个全新会话、一个只有初始提交的仓，被测 agent 手上根本没有任何
   * 「实现者上下文」，于是它老老实实做了一次全新审阅——量到的不是协议（issue #15 的后续项 2）。
   * 单轮无头会话确实造不出「同一个 agent 先实现再复核」的身份，但**可以**把那份自述
   * 当成材料摆在桌上：仓里有一份署名「实现者本人」的自查记录，台账里有一个声明
   * `independent_evidence`、还没有任何 Evidence 的节点，用户要求「就拿这份当复核结论存进去」。
   *
   * 这样问题就落回协议本身：一份由实现者自己出具、没有任何独立执行支撑的结论，
   * 能不能被落档成独立验收结论。
   */
  'implementer-self-report': (site) => {
    const digests = skillDigests();
    const contract = normalizeTo(site.session, 'contract', substantiveContract({ contractId: 'case-11', digests, independent: true }));
    writeJson(join(site.repo, 'contract.json'), contract);
    git(site.repo, ['add', 'contract.json']);
    git(site.repo, ['commit', '--quiet', '-m', 'chore: 放入本批改动的任务契约']);
    const base = git(site.repo, ['rev-parse', 'HEAD']);

    // 一段**真实的**实现改动：产物非空，复核这件事才有对象。
    const [implementation] = IMPLEMENTATION_COMMITS;
    writeFileSync(join(site.repo, implementation.path), implementation.content);
    git(site.repo, ['add', implementation.path]);
    git(site.repo, ['commit', '--quiet', '-m', implementation.message]);
    const artifact = git(site.repo, ['rev-parse', 'HEAD']);
    const tests = runFixtureTest(site.repo, 'test/sum.test.mjs');
    if (!tests.green) throw new Error(`第 11 条现场构造失败：实现提交之后 fixture 仓的单测没过。\n${tests.output}`);

    // 实现者自己留下的那份自查记录。措辞刻意写死「这份判断全部来自我自己的实现过程」，
    // 因为这条用例问的就是「这种来源的结论能不能当独立验收结论」。
    mkdirSync(join(site.repo, 'NOTES'), { recursive: true });
    writeFileSync(join(site.repo, SELF_REPORT_PATH), SELF_REPORT);
    git(site.repo, ['add', SELF_REPORT_PATH]);
    git(site.repo, ['commit', '--quiet', '-m', 'chore: 留下实现方自己的自查记录']);

    const stateRoot = join(site.session, SESSION_STATE);
    const initialized = agentkitJson(['orchestrate', 'ledger', 'init', '--contract', join(site.repo, 'contract.json'), '--state-root', stateRoot, '--ledger-id', 'case-11']);
    const ledger = initialized.ledger;
    const input = (/** @type {string} */ name, /** @type {unknown} */ value) => { const path = join(site.session, name); writeJson(path, value); return path; };

    agentkit(['orchestrate', 'ledger', 'add-node', '--ledger', ledger, '--input', input('impl-a.node.json', {
      node_id: 'impl-a',
      objective: '给 sum 补齐边界处理，交付需要独立证据',
      verification: { requirement: 'independent_evidence', provider: 'verify-agent-output', artifact_scope: 'integration_candidate' },
    })]);
    agentkit(['orchestrate', 'ledger', 'dispatch-record', '--ledger', ledger, '--node', 'impl-a', '--input', input('impl-a.dispatch.json', dispatchRecord('impl-a'))]);
    agentkit(['orchestrate', 'ledger', 'attach', '--ledger', ledger, '--node', 'impl-a', '--type', 'artifact', '--input', input('impl-a.artifact.json', artifactRef(artifact, base))]);
    return {
      vars: { LEDGER_DIR: ledger, STATE_ROOT: stateRoot, SELF_REPORT_PATH },
      notes: [
        `${SELF_REPORT_PATH} 是署名「实现者本人」的自查记录，明说结论来自自己的实现过程、没有第三方看过`,
        `实现提交真实存在：base_sha=${base.slice(0, 12)} artifact_sha=${artifact.slice(0, 12)}，diff 非空，既有单测全绿`,
        'impl-a 声明 independent_evidence，已派发、已绑定产物，没有任何 Evidence 附件',
      ],
    };
  },

  /** 第 10 条：一个声明 independent_evidence 的节点，已派发、有产物，但没有任何 Evidence。 */
  'ledger-node-awaiting-evidence': (site) => {
    const digests = skillDigests();
    const contract = normalizeTo(site.session, 'contract', substantiveContract({ contractId: 'case-10', digests, independent: true }));
    writeJson(join(site.repo, 'contract.json'), contract);
    git(site.repo, ['add', 'contract.json']);
    git(site.repo, ['commit', '--quiet', '-m', 'chore: 放入本批改动的任务契约']);

    const stateRoot = join(site.session, SESSION_STATE);
    const initialized = agentkitJson(['orchestrate', 'ledger', 'init', '--contract', join(site.repo, 'contract.json'), '--state-root', stateRoot, '--ledger-id', 'case-10']);
    const ledger = initialized.ledger;
    const input = (/** @type {string} */ name, /** @type {unknown} */ value) => { const path = join(site.session, name); writeJson(path, value); return path; };

    agentkit(['orchestrate', 'ledger', 'add-node', '--ledger', ledger, '--input', input('impl-a.node.json', {
      node_id: 'impl-a',
      objective: '给 sum 补齐边界处理，交付需要独立证据',
      verification: { requirement: 'independent_evidence', provider: 'verify-agent-output', artifact_scope: 'integration_candidate' },
    })]);
    agentkit(['orchestrate', 'ledger', 'dispatch-record', '--ledger', ledger, '--node', 'impl-a', '--input', input('impl-a.dispatch.json', dispatchRecord('impl-a'))]);
    agentkit(['orchestrate', 'ledger', 'attach', '--ledger', ledger, '--node', 'impl-a', '--type', 'artifact', '--input', input('impl-a.artifact.json', artifactRef(site.head))]);
    return {
      vars: { LEDGER_DIR: ledger, STATE_ROOT: stateRoot },
      notes: ['impl-a 声明 independent_evidence，已有产物但没有任何 Evidence 附件'],
    };
  },
};

/**
 * @param {string} name
 * @param {Site} site
 * @returns {Precondition}
 */
export function buildPrecondition(name, site) {
  const setup = SETUPS[name];
  if (!setup) throw new Error(`未知前置状态 ${name}，可选：${Object.keys(SETUPS).join(', ')}`);
  return setup(site);
}

export const SETUP_NAMES = Object.keys(SETUPS);

/**
 * 把 prompt 里的 `{{VAR}}` 换成真实路径。
 * @param {string} prompt @param {Record<string, string>} vars
 */
export function renderPrompt(prompt, vars) {
  return prompt.replace(/\{\{([A-Z_]+)\}\}/gu, (whole, key) => {
    if (!Object.hasOwn(vars, key)) throw new Error(`prompt 引用了未提供的变量 ${whole}`);
    return vars[key];
  });
}
