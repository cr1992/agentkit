#!/usr/bin/env node
// @ts-check

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isHelpRequest, renderCliHelp } from '../../core/cli-help.mjs';
import { createDigestKit } from '../../core/digest.mjs';
import { contractSubstance, formatSubstanceErrors } from '../../core/contract-substance.mjs';
import { buildScaffoldContract } from '../../core/contract-scaffold.mjs';
import { ORCHESTRATION_RUNTIME_VERSION, skillContentDigest } from './orchestration-metadata.mjs';
import {
  InterviewError,
  MAX_ROUNDS,
  answer as interviewAnswer,
  ask as interviewAsk,
  assertFreezable,
} from './contract-interview.mjs';

export class ContractError extends Error {}

// strict=false：本 Skill 此前不校验代理对、也不拒绝非有限 number，保持原样。
// envelopeDigest 的默认摘要字段仍是 contract_digest。
export const { canonicalJson, envelopeDigest, sha256 } = createDigestKit({
  ValidationError: ContractError,
  strict: false,
  defaultDigestField: 'contract_digest',
});

class Parser {
  constructor(text) {
    this.text = text;
    this.index = 0;
  }
  ws() {
    while (/\s/u.test(this.text[this.index] ?? '')) this.index += 1;
  }
  parse() {
    const value = this.value();
    this.ws();
    if (this.index !== this.text.length) throw new ContractError(`JSON 尾部非法 at ${this.index}`);
    return value;
  }
  value() {
    this.ws();
    const char = this.text[this.index];
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"') return this.string();
    if (char === '-' || /[0-9]/u.test(char ?? '')) return this.number();
    for (const [token, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ])
      if (this.text.startsWith(token, this.index)) {
        this.index += token.length;
        return value;
      }
    throw new ContractError(`JSON 值非法 at ${this.index}`);
  }
  object() {
    this.index += 1;
    this.ws();
    const value = Object.create(null);
    const keys = new Set();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return value;
    }
    for (;;) {
      this.ws();
      if (this.text[this.index] !== '"') throw new ContractError(`JSON key 非字符串 at ${this.index}`);
      const key = this.string();
      if (keys.has(key)) throw new ContractError(`JSON duplicate key: ${key}`);
      keys.add(key);
      this.ws();
      if (this.text[this.index] !== ':') throw new ContractError(`JSON 缺冒号 at ${this.index}`);
      this.index += 1;
      value[key] = this.value();
      this.ws();
      if (this.text[this.index] === '}') {
        this.index += 1;
        return value;
      }
      if (this.text[this.index] !== ',') throw new ContractError(`JSON 缺逗号 at ${this.index}`);
      this.index += 1;
    }
  }
  array() {
    this.index += 1;
    this.ws();
    const value = [];
    if (this.text[this.index] === ']') {
      this.index += 1;
      return value;
    }
    for (;;) {
      value.push(this.value());
      this.ws();
      if (this.text[this.index] === ']') {
        this.index += 1;
        return value;
      }
      if (this.text[this.index] !== ',') throw new ContractError(`JSON array 缺逗号 at ${this.index}`);
      this.index += 1;
    }
  }
  string() {
    const start = this.index++;
    let escaped = false;
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (!escaped && char === '"') {
        this.index += 1;
        const value = JSON.parse(this.text.slice(start, this.index));
        if (/\p{Surrogate}/u.test(value)) throw new ContractError('JSON string 含未配对 surrogate');
        return value;
      }
      escaped = !escaped && char === '\\';
      this.index += 1;
    }
    throw new ContractError('JSON string 未闭合');
  }
  number() {
    const match = this.text.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) throw new ContractError('JSON number 非法');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new ContractError('JSON number 必须有限');
    return value;
  }
}

export function parseJsonStrict(text) {
  return new Parser(text).parse();
}
// substance 只由创建入口打开（contract validate、ledger init）。add-node、doctor、投影等
// 在已冻结契约上的操作保持形状校验：契约冻结后不可变，实质性只在冻结那一刻判定一次；
// doctor 这类只读回看路径还会读到判据出现之前冻结的 ledger，在那里拒绝等于让历史结论随
// runtime 版本变化。
// warnings 是出参数组：warning 不改变 valid 结论也不改变退出码，只能由调用方带进输出，
// 因此不能走抛异常这条路，也不适合改 validateContract 的返回值（返回的是契约本身）。
export function validateContract(contract, { requireDigest = true, substance = false, warnings = null } = {}) {
  const required = [
    'schema_version',
    'contract_id',
    'objective',
    'scope',
    'acceptance',
    'permissions',
    'environment',
    'skill_set',
    'stop_conditions',
    'extensions',
  ];
  if (contract?.schema_version !== 1) throw new ContractError('Task Contract schema_version 必须为 1');
  for (const field of required)
    if (!Object.hasOwn(contract, field)) throw new ContractError(`Task Contract 缺少 ${field}`);
  if (
    !contract.contract_id ||
    !contract.objective ||
    !Array.isArray(contract.scope?.include) ||
    !Array.isArray(contract.scope?.exclude) ||
    [...contract.scope.include, ...contract.scope.exclude].some((item) => typeof item !== 'string' || !item)
  )
    throw new ContractError('Task Contract identity/scope 无效');
  if (!Array.isArray(contract.acceptance) || !contract.acceptance.length)
    throw new ContractError('acceptance 不能为空');
  const ids = new Set();
  for (const item of contract.acceptance) {
    if (!item?.contract_item_id || !item?.requirement || ids.has(item.contract_item_id))
      throw new ContractError('acceptance ID 缺失或重复');
    ids.add(item.contract_item_id);
  }
  if (
    !['read_only', 'write'].includes(contract.permissions?.mode) ||
    !Array.isArray(contract.permissions?.writable_paths) ||
    contract.permissions.writable_paths.some((item) => typeof item !== 'string' || !item)
  )
    throw new ContractError('permissions 无效');
  if (contract.permissions.mode === 'read_only' && contract.permissions.writable_paths.length)
    throw new ContractError('read_only 合同不能声明 writable_paths');
  if (
    typeof contract.environment?.repository !== 'string' ||
    !contract.environment.repository ||
    !['shared_tree', 'worktree', 'caller_supplied'].includes(contract.environment?.isolation)
  )
    throw new ContractError('environment 无效');
  if (
    !Array.isArray(contract.stop_conditions) ||
    !contract.extensions ||
    typeof contract.extensions !== 'object' ||
    Array.isArray(contract.extensions)
  )
    throw new ContractError('stop_conditions/extensions 无效');
  const verification = contract.extensions.verification;
  if (
    verification !== undefined &&
    (!verification ||
      typeof verification !== 'object' ||
      Array.isArray(verification) ||
      !['none', 'verify-agent-output', 'run-agent-verify-loop'].includes(verification.provider))
  )
    throw new ContractError('extensions.verification 无效');
  const reviewPolicy = contract.extensions.review_policy;
  if (reviewPolicy !== undefined) {
    const expected = [
      'max_escalation_reviews_per_artifact',
      'max_primary_reviews_per_artifact',
      'max_review_input_tokens',
      'require_distinct_lens',
      'review_only_after_smoke_pass',
      'schema_version',
    ];
    const keys =
      reviewPolicy && typeof reviewPolicy === 'object' && !Array.isArray(reviewPolicy)
        ? Object.keys(reviewPolicy).sort()
        : [];
    if (
      reviewPolicy?.schema_version !== 1 ||
      JSON.stringify(keys) !== JSON.stringify(expected) ||
      !Number.isSafeInteger(reviewPolicy.max_primary_reviews_per_artifact) ||
      reviewPolicy.max_primary_reviews_per_artifact < 0 ||
      !Number.isSafeInteger(reviewPolicy.max_escalation_reviews_per_artifact) ||
      reviewPolicy.max_escalation_reviews_per_artifact < 0 ||
      !Number.isSafeInteger(reviewPolicy.max_review_input_tokens) ||
      reviewPolicy.max_review_input_tokens < 1 ||
      typeof reviewPolicy.require_distinct_lens !== 'boolean' ||
      typeof reviewPolicy.review_only_after_smoke_pass !== 'boolean'
    )
      throw new ContractError('extensions.review_policy 无效');
  }
  if (!Array.isArray(contract.skill_set)) throw new ContractError('skill_set 必须是数组');
  const skills = new Set();
  for (const skill of contract.skill_set) {
    if (
      !skill?.name ||
      skills.has(skill.name) ||
      !/^sha256:[0-9a-f]{64}$/u.test(String(skill.content_digest ?? '')) ||
      !['primary', 'optional'].includes(skill.provider_mode)
    )
      throw new ContractError('skill_set entry 无效或重复');
    skills.add(skill.name);
  }
  const common = new Set(required.concat('contract_digest'));
  for (const key of Object.keys(contract.extensions))
    if (common.has(key)) throw new ContractError(`extension 覆盖公共字段: ${key}`);
  if (
    requireDigest &&
    (!/^sha256:[0-9a-f]{64}$/u.test(String(contract.contract_digest ?? '')) ||
      envelopeDigest(contract) !== contract.contract_digest)
  )
    throw new ContractError('contract_digest 无效');
  if (substance) {
    const report = contractSubstance(contract);
    if (report.errors.length) throw new ContractError(formatSubstanceErrors(report.errors));
    if (warnings) warnings.push(...report.warnings);
  }
  return contract;
}

export function normalizeContract(contract) {
  const normalized = structuredClone(contract);
  delete normalized.contract_digest;
  validateContract(normalized, { requireDigest: false });
  normalized.contract_digest = envelopeDigest(normalized);
  return normalized;
}

export function acceptanceItemDigest(item) {
  return sha256(Buffer.from(canonicalJson(item), 'utf8'));
}

// 合同投影：从公共父合同切出节点级、产物专属的验证合同。acceptance 条目逐字节 verbatim 拷贝，
// 其余公共字段原样继承，血缘写入 extensions.projection 供 ledger 校验。
export function projectContract(parent, itemIds, { contractId = null } = {}) {
  validateContract(parent);
  if (!Array.isArray(itemIds) || !itemIds.length) throw new ContractError('projection items 不能为空');
  if (itemIds.some((id) => typeof id !== 'string' || !id)) throw new ContractError('projection item id 无效');
  if (new Set(itemIds).size !== itemIds.length) throw new ContractError('projection items 重复');
  const byId = new Map(parent.acceptance.map((item) => [item.contract_item_id, item]));
  const acceptance = itemIds.map((id) => {
    const item = byId.get(id);
    if (!item) throw new ContractError(`projection item 不在 parent acceptance 中: ${id}`);
    return structuredClone(item);
  });
  if (contractId !== null && (typeof contractId !== 'string' || !contractId))
    throw new ContractError('contract-id 无效');
  // 以 parent 展开为基底：只有 contract_id / acceptance / extensions / contract_digest 允许改动，
  // 其余顶层字段（含 parent 自带的扩展字段）原样继承，ledger 侧会逐字段核对全等。
  const projected = {
    ...structuredClone(parent),
    contract_id: contractId ?? `${parent.contract_id}--proj-${randomBytes(4).toString('hex')}`,
    acceptance,
    extensions: {
      ...structuredClone(parent.extensions),
      projection: { parent_contract_digest: parent.contract_digest, projected_item_ids: [...itemIds] },
    },
  };
  projected.contract_digest = envelopeDigest(projected);
  return validateContract(projected);
}

// scaffold 别名：骨架本身住在 core/contract-scaffold.mjs，与 verify scaffold --kind contract 同源。
// 两边只有 skill_set 不同——各自冻结自己域的 content digest：ledger init 要求契约里有当前
// orchestrate-subagents 的摘要，verify 侧则绑 verify-agent-output。把对方的摘要算进来就得跨域取路径，
// 所以这一条差异是有意的，其余字段逐字段一致，由测试钉住。
export function scaffoldContract({ workdir = process.cwd() } = {}) {
  const contract = buildScaffoldContract({
    workdir,
    contractId: randomUUID(),
    skillSet: [
      {
        name: 'orchestrate-subagents',
        version: ORCHESTRATION_RUNTIME_VERSION,
        content_digest: skillContentDigest(),
        provider_mode: 'primary',
      },
    ],
  });
  validateContract(contract, { requireDigest: false });
  contract.contract_digest = envelopeDigest(contract);
  return contract;
}

export function contractDiff(left, right) {
  const changed = [];
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort())
    if (canonicalJson(left[key]) !== canonicalJson(right[key])) changed.push(key);
  const resign = changed.some((key) => key !== 'contract_digest');
  return {
    changed_fields: changed,
    requires_resign: resign,
    old_digest: left.contract_digest ?? null,
    new_digest: right.contract_digest ?? null,
  };
}

// CLI 命令与参数的唯一真源：`--help` 清单和未知命令错误信息都从这里推导。
const CLI_SPEC = {
  scaffold: { optional: ['workdir'] },
  normalize: { required: ['input'] },
  validate: { required: ['input'] },
  digest: { required: ['input'] },
  'review-view': { required: ['input'] },
  diff: { required: ['left', 'right'] },
  project: { required: ['input', 'items'], optional: ['contract-id'] },
  'interview-ask': { required: ['input'] },
  'interview-answer': { required: ['input', 'answers'] },
  'interview-freeze': { required: ['input'] },
  capabilities: {},
};
const CLI_NOTES = [
  '--items 是逗号分隔的 acceptance contract_item_id 列表，投影合同只能收窄这些条目。',
  'interview 是"多次调用、文件往返"的状态机：ask 出题 → 你把选项填进题目并交给用户选 → answer 回填 → freeze 冻结。',
  'interview-answer 的 --answers 是 { "answers": [...] } 或裸数组；每题 2–4 个互不相同的非空选项，selected 为下标或 "custom"。',
  'permissions / objective / acceptance 必须由用户在选项中作答；只有 scope.include / scope.exclude / stop_conditions 可以 deferred，assumed 会原样写进字段。',
  '轮次与作答记录写在契约草稿自己的 extensions.interview 里，会进入 contract_digest；上限 3 轮。',
  '用法与完成判据见 agentkit docs orchestrate contract-interview。',
];
function parseCli(argv) {
  const command = argv[0];
  const options = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) throw new ContractError('参数必须是 --name value');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  return { command, options };
}
function read(path) {
  return parseJsonStrict(readFileSync(resolve(path), 'utf8'));
}
export function main(argv = process.argv.slice(2)) {
  if (isHelpRequest(argv)) return { help: renderCliHelp('contract-tool.mjs', CLI_SPEC, CLI_NOTES) };
  const { command, options } = parseCli(argv);
  if (command === 'scaffold') return scaffoldContract({ workdir: options.workdir ?? process.cwd() });
  if (command === 'normalize') return normalizeContract(read(options.input));
  if (command === 'validate') {
    const warnings = [];
    const value = validateContract(read(options.input), { substance: true, warnings });
    return {
      valid: true,
      contract_id: value.contract_id,
      contract_digest: value.contract_digest,
      ...(warnings.length ? { warnings } : {}),
    };
  }
  if (command === 'digest') return { contract_digest: envelopeDigest(read(options.input)) };
  if (command === 'review-view') {
    const value = validateContract(read(options.input));
    return {
      schema_version: 1,
      contract_id: value.contract_id,
      objective: value.objective,
      scope: value.scope,
      acceptance: value.acceptance,
      contract_permissions: value.permissions,
      reviewer_permissions: { mode: 'read_only', writable_paths: [] },
      environment: value.environment,
      contract_digest: value.contract_digest,
    };
  }
  if (command === 'diff') return contractDiff(read(options.left), read(options.right));
  if (command === 'project')
    return projectContract(
      read(options.input),
      String(options.items ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      { contractId: options['contract-id'] ?? null },
    );
  // interview 的三个入口都先做形状校验、不要求 digest：草稿在往返途中是未签名的，
  // 只有 freeze 那一次才重新签名。实质性判据由 interview 自己按完成判据取用，不在这里提前拒绝。
  if (command === 'interview-ask') {
    const draft = read(options.input);
    validateContract(draft, { requireDigest: false });
    return interviewAsk(draft);
  }
  if (command === 'interview-answer') {
    const draft = read(options.input);
    validateContract(draft, { requireDigest: false });
    const payload = read(options.answers);
    const entries = Array.isArray(payload) ? payload : payload?.answers;
    const { contract, status } = interviewAnswer(draft, entries);
    const signed = normalizeContract(contract);
    return {
      round: signed.extensions.interview.round,
      max_rounds: MAX_ROUNDS,
      complete: status.complete,
      remaining_criteria: status.missing,
      warnings: status.warnings,
      next: status.complete ? null : interviewAsk(signed),
      contract: signed,
    };
  }
  if (command === 'interview-freeze') {
    const draft = read(options.input);
    validateContract(draft, { requireDigest: false });
    assertFreezable(draft);
    const frozen = normalizeContract(draft);
    const warnings = [];
    validateContract(frozen, { substance: true, warnings });
    return {
      frozen: true,
      contract_id: frozen.contract_id,
      contract_digest: frozen.contract_digest,
      ...(warnings.length ? { warnings } : {}),
      contract: frozen,
    };
  }
  if (command === 'capabilities')
    return {
      tool: 'contract-tool',
      runtime_version: '1.2.0',
      task_contract_versions: [1],
      features: [
        'strict-json',
        'canonical-digest',
        'review-view',
        'resign-diff',
        'contract-projection',
        'contract-scaffold',
        'contract-interview',
      ],
    };
  throw new ContractError(`命令必须是 ${Object.keys(CLI_SPEC).join('/')}`);
}

function isEntry() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url;
  }
}
export function runCli(argv = process.argv.slice(2)) {
  try {
    const result = main(argv);
    process.stdout.write(typeof result?.help === 'string' ? result.help : `${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    // interview 的拒绝不是"契约非法"，而是"还没问完 / 这轮作答不合规"，单独标记以便调用方分流。
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof InterviewError ? 'interview_rejected' : 'invalid_contract', message: error.message })}\n`,
    );
    return 2;
  }
}
if (isEntry()) process.exitCode = runCli();
