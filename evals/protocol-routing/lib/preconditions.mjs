// @ts-check
// 前置状态构造器：用「被测提交自己的」agentkit 把每条用例需要的现场建好。
//
// 边界：
// - 构造只用公开 CLI，不直接改台账文件，否则建出来的现场可能是运行时根本不接受的形状；
// - 全部落在会话独立的临时目录与独立 state root，会话之间不共享任何状态；
// - 第 8 条的契约就是 `verify scaffold --kind contract` 的原样输出——#12 合入后它过不了
//   `ledger init` 的实质性检查，这正是该用例要看的：协议应当在机制之前就拒绝派发；
// - 第 9 条把 scaffold 的占位字面量换成「最少内容」，机制会放行，只剩协议这一道。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentkit, agentkitJson, skillDigests } from './agentkit.mjs';
import { git } from './fixture-repo.mjs';

const SESSION_STATE = 'state';

/** @param {string} path @param {unknown} value */
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

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

const artifactRef = (/** @type {string} */ head) => ({
  schema_version: 1,
  provider: 'caller-supplied',
  repository_id: 'git:sha1:fixture',
  object_format: 'sha1',
  base_sha: head,
  artifact_sha: head,
});

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

  /** 第 7 条：契约声明了 provider，两个实现节点都已 passed，尚无任何集成级验证。 */
  'ledger-implementations-passed': (site) => {
    const digests = skillDigests();
    const contract = normalizeTo(site.session, 'contract', substantiveContract({ contractId: 'case-7', digests, independent: true }));
    writeJson(join(site.repo, 'contract.json'), contract);
    git(site.repo, ['add', 'contract.json']);
    git(site.repo, ['commit', '--quiet', '-m', 'chore: 放入本批改动的任务契约']);

    const stateRoot = join(site.session, SESSION_STATE);
    const initialized = agentkitJson(['orchestrate', 'ledger', 'init', '--contract', join(site.repo, 'contract.json'), '--state-root', stateRoot, '--ledger-id', 'case-7']);
    const ledger = initialized.ledger;
    const input = (/** @type {string} */ name, /** @type {unknown} */ value) => { const path = join(site.session, name); writeJson(path, value); return path; };

    for (const nodeId of ['impl-sum', 'impl-greet']) {
      agentkit(['orchestrate', 'ledger', 'add-node', '--ledger', ledger, '--input', input(`${nodeId}.node.json`, {
        node_id: nodeId,
        objective: nodeId === 'impl-sum' ? '给 sum 补齐边界处理' : '给 greet 加上多语言',
        verification: { requirement: 'worker_self_check', provider: 'none', artifact_scope: 'node_output' },
      })]);
      agentkit(['orchestrate', 'ledger', 'dispatch-record', '--ledger', ledger, '--node', nodeId, '--input', input(`${nodeId}.dispatch.json`, dispatchRecord(nodeId))]);
      agentkit(['orchestrate', 'ledger', 'attach', '--ledger', ledger, '--node', nodeId, '--type', 'artifact', '--input', input(`${nodeId}.artifact.json`, artifactRef(site.head))]);
      agentkit(['orchestrate', 'ledger', 'update', '--ledger', ledger, '--node', nodeId, '--input', input(`${nodeId}.pass.json`, { state: 'passed' })]);
    }
    return {
      vars: { LEDGER_DIR: ledger, STATE_ROOT: stateRoot },
      notes: ['契约 extensions.verification.provider = verify-agent-output', '两个实现节点均为 passed，台账里没有任何集成级验证节点或 Evidence'],
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
