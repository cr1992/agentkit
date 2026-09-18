// @ts-check
// `agentkit contract interview-*`：由拒绝清单驱动提问、由自己的完成判据决定何时冻结的状态机。
//
// 本模块不调用任何模型，也不对自然语言做启发式判定。它只做三件事：
// 出题（哪些字段还缺、按什么顺序问）、校验回填（选项合规、写进对应字段）、判定冻结。
// 选项由调用它的模型填，选哪个由用户定——命令既不生成选项，也不替用户选。
//
// 为什么"问什么"和"什么时候算问完"不能合一：
// core/contract-substance.mjs 的 error 只匹配 scaffold 的字面量，任意填一轮文字就能通过。
// 拿它当结束条件，interview 就退化成一张一次性表单。所以实质性判据只负责"还缺哪些字段"，
// 结束条件另立三条完成判据（见 completion）。
//
// 交互形态是多次调用、文件往返，不是 TTY 交互：轮次状态就写在契约草稿自己的
// extensions.interview 里，不另建状态目录——草稿在哪里，进度就在哪里，换机器、换会话都不丢。
// extensions.interview 会进入 contract_digest，这是预期的：作答记录是契约的一部分，冻结后不可变。
//
// 命令检查不了的事：source: "user" 的真伪。它只能检查记录是否存在、是否与字段当前值自洽。
import { contractSubstance } from '../../core/contract-substance.mjs';

/** 一轮 = 一次"出题 → 回填 → 校验"。第 3 轮回填后仍不满足完成判据就退出，建议拆分任务。 */
export const MAX_ROUNDS = 3;
/** 一批最多 4 题：再多，模型给出的选项质量和用户的分辨力都会掉下去。 */
export const MAX_QUESTIONS_PER_ROUND = 4;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

/**
 * 提问顺序是固定的，不按"哪条判据先报"排。
 * permissions 必问且最先问：exclude / stop_conditions 两条判据只在 write 模式下生效，而 scaffold 默认 read_only，
 * 能悄无声息地通过校验。不先问权限，一个写任务走完整个 interview 也不会被问到边界和刹车。
 */
const FIELD_ORDER = ['permissions', 'objective', 'acceptance', 'scope.include', 'scope.exclude', 'stop_conditions'];
const READ_ONLY_REQUIRED = ['permissions', 'objective', 'acceptance', 'scope.include'];
const WRITE_REQUIRED = [...READ_ONLY_REQUIRED, 'scope.exclude', 'stop_conditions'];

/** 字段语义：随题一起发给用户，让选项可被判断。不含任何可照抄的合规值。 */
const FIELD_SEMANTICS = {
  permissions: 'permissions.mode 决定本次任务能不能写仓库。read_only 只允许读与报告；write 允许改动，并会追加边界与刹车两道必问题。',
  objective: 'objective 是冻结产物要达成的目标，一句话说清"做完是什么样"，不是过程描述。',
  acceptance: 'acceptance[].requirement 是可观察的验收要求：第三方只看仓库与命令输出就能判定通过或不通过。',
  'scope.include': 'scope.include 是本次任务允许触碰的面，按路径或模块写。',
  'scope.exclude': 'scope.exclude 是明确不可触碰的面。它不是"没想到的地方"，而是"想到了并且禁止"。',
  stop_conditions: 'stop_conditions 是机械停机点：命中即停止并上报，不由执行方自行判断要不要继续。',
};

/** 题面。出题词只描述要决定什么，不暗示答案。 */
const FIELD_QUESTION = {
  permissions: '本次任务需要写仓库吗？',
  objective: '本次任务要冻结的产物目标是什么？',
  acceptance: '用什么可观察的事实判定本次任务做完了？',
  'scope.include': '允许触碰哪些面？',
  'scope.exclude': '哪些面明确不可触碰？',
  stop_conditions: '命中什么条件就必须停下来上报？',
};

/**
 * 判据本身留在 core/contract-substance.mjs，这里只把它的 finding 路由到一道题上。
 * 路由键取 finding 里稳定的字段路径前缀，措辞部分不参与匹配。
 * 新增判据而这里没跟上时，routeFinding 返回 null，由测试钉死"没有 finding 落空"。
 */
const FINDING_ROUTES = [
  { field: 'objective', match: /^objective = /u },
  { field: 'acceptance', match: /^acceptance\[\d+\]\.requirement = /u },
  { field: 'scope.include', match: /^scope\.include\[\d+\] = /u },
  { field: 'scope.exclude', match: /scope\.exclude 为空/u },
  { field: 'stop_conditions', match: /stop_conditions 为空/u },
];

/** @param {string} finding @returns {string|null} */
export function routeFinding(finding) {
  return FINDING_ROUTES.find((route) => route.match.test(finding))?.field ?? null;
}

export const INTERVIEW_ANSWER_SPEC = [
  `每题必须给出 ${MIN_OPTIONS}–${MAX_OPTIONS} 个互不相同的非空选项；0 或 1 个选项按开放式问题拒绝。`,
  '选项由你根据用户诉求和仓库现状生成，命令不生成选项，也不替用户选。',
  'selected 是选项下标，或者 "custom" 配 custom_value 写用户原话；source 只能是 "user"。',
  '用户回答"都行"或拒答时不要替他选：把该题写成 { field, options, deferred: true, assumed }，字段保留当前默认值，命令记进 assumptions[]。',
  '"无所谓"不等于"排除"：deferred 不会往 scope.exclude 写任何内容。',
];

/** 单值字段：再次作答会替换上一条记录，而不是并存——并存会让完成判据第 3 条必然不成立。 */
const SINGLE_VALUED = new Set(['permissions', 'objective']);

const quote = (/** @type {unknown} */ value) => JSON.stringify(value);

/**
 * 读出草稿里的 interview 状态。缺失即视为尚未开始。
 * 这里按不可信数据读：草稿可能是手写的，也可能被手改过。
 * @param {any} contract
 */
export function readInterviewState(contract) {
  const raw = contract?.extensions?.interview;
  const round = Number.isSafeInteger(raw?.round) && raw.round >= 0 ? raw.round : 0;
  return {
    schema_version: 1,
    round,
    answers: Array.isArray(raw?.answers) ? raw.answers : [],
    assumptions: Array.isArray(raw?.assumptions) ? raw.assumptions : [],
  };
}

/** @param {any} contract @returns {string[]} 本次权限模式下的必问题清单 */
export function requiredFields(contract) {
  return contract?.permissions?.mode === 'write' ? [...WRITE_REQUIRED] : [...READ_ONLY_REQUIRED];
}

/** 一条作答记录选中的内容。deferred 记录不落在这里，它进 assumptions。 */
function selectedText(answer) {
  if (answer?.selected === 'custom') return typeof answer.custom_value === 'string' ? answer.custom_value : null;
  const options = Array.isArray(answer?.options) ? answer.options : [];
  return Number.isSafeInteger(answer?.selected) && answer.selected >= 0 && answer.selected < options.length ? options[answer.selected] : null;
}

/**
 * 完成判据第 3 条：记录的 field 在契约里的当前值要与 selected 对应的内容一致。
 * 列表字段按"包含"判定：同一字段可以多轮追加，每条记录各自对应一个元素。
 */
function fieldHolds(contract, field, text) {
  if (text === null) return false;
  if (field === 'permissions') return contract?.permissions?.mode === text;
  if (field === 'objective') return contract?.objective === text;
  if (field === 'acceptance') return (Array.isArray(contract?.acceptance) ? contract.acceptance : []).some((item) => item?.requirement === text);
  if (field === 'scope.include') return (Array.isArray(contract?.scope?.include) ? contract.scope.include : []).includes(text);
  if (field === 'scope.exclude') return (Array.isArray(contract?.scope?.exclude) ? contract.scope.exclude : []).includes(text);
  if (field === 'stop_conditions') return (Array.isArray(contract?.stop_conditions) ? contract.stop_conditions : []).includes(text);
  return false;
}

/**
 * 三条完成判据，同时满足才允许冻结：
 * 1. core/contract-substance.mjs 的创建入口判据 error 为零（warning 允许保留：用户可以明确回答"没有要排除的"）；
 * 2. 每道必问题都有 source: "user" 的作答记录，或一条 assumption；
 * 3. 每条作答记录的 field 在契约里的当前值与 selected 对应内容一致——事后手改字段而不更新记录则不成立。
 * @param {any} contract
 */
export function completion(contract) {
  const report = contractSubstance(contract);
  const state = readInterviewState(contract);
  const missing = [];

  for (const finding of report.errors) {
    missing.push({ criterion: 'substance_error', field: routeFinding(finding), detail: finding });
  }

  const answeredFields = new Set();
  for (const answer of state.answers) if (answer?.source === 'user' && typeof answer?.field === 'string') answeredFields.add(answer.field);
  for (const assumption of state.assumptions) if (typeof assumption?.field === 'string') answeredFields.add(assumption.field);
  for (const field of requiredFields(contract)) {
    if (!answeredFields.has(field)) {
      missing.push({ criterion: 'missing_answer', field, detail: `${field}：缺少 source: "user" 的作答记录，也没有 user_deferred 的 assumption` });
    }
  }

  state.answers.forEach((answer, index) => {
    if (answer?.source !== 'user' || typeof answer?.field !== 'string') {
      missing.push({ criterion: 'answer_invalid', field: answer?.field ?? null, detail: `extensions.interview.answers[${index}]：source 必须是 "user"，field 必须是字段路径` });
      return;
    }
    const text = selectedText(answer);
    if (text === null) {
      missing.push({ criterion: 'answer_invalid', field: answer.field, detail: `extensions.interview.answers[${index}].selected 无法解析为选项内容` });
      return;
    }
    if (!fieldHolds(contract, answer.field, text)) {
      missing.push({ criterion: 'answer_field_mismatch', field: answer.field, detail: `extensions.interview.answers[${index}]：选中内容 ${quote(text)} 与 ${answer.field} 的当前值不一致，记录与契约已经脱钩` });
    }
  });

  return { complete: missing.length === 0, missing, warnings: report.warnings, round: state.round };
}

/**
 * 本轮该问哪些字段：必问题里尚未作答的，并上实质性判据仍在报的字段（含 warning 指向的字段）。
 * 已有作答记录但判据仍然报错的字段会被重新问一遍——填了一轮文字不等于问完了。
 * @param {any} contract
 */
export function outstandingFields(contract) {
  const state = readInterviewState(contract);
  const report = contractSubstance(contract);
  const answered = new Set();
  for (const answer of state.answers) if (answer?.source === 'user' && typeof answer?.field === 'string') answered.add(answer.field);
  for (const assumption of state.assumptions) if (typeof assumption?.field === 'string') answered.add(assumption.field);

  const pending = new Set(requiredFields(contract).filter((field) => !answered.has(field)));
  // error 指向的字段一律重问：填了一轮文字不等于问完了，占位还在就说明这道题没答。
  for (const finding of report.errors) { const field = routeFinding(finding); if (field) pending.add(field); }
  // warning 指向的字段若已有作答记录就不再问：用户可以明确回答"没有要排除的"，
  // 这时"write 模式 exclude 为空"的 warning 仍在，但该字段已经问过了。
  for (const finding of report.warnings) { const field = routeFinding(finding); if (field && !answered.has(field)) pending.add(field); }
  return FIELD_ORDER.filter((field) => pending.has(field));
}

export class InterviewError extends Error {}

/**
 * 出题：输入一份契约草稿（可以是原样 scaffold），输出本轮问题批。
 * 选项槽是空的——命令不生成选项。
 * @param {any} contract
 */
export function ask(contract) {
  const state = readInterviewState(contract);
  const status = completion(contract);
  if (state.round >= MAX_ROUNDS) {
    throw new InterviewError(renderExhausted(status, state.round));
  }
  const fields = outstandingFields(contract).slice(0, MAX_QUESTIONS_PER_ROUND);
  return {
    schema_version: 1,
    round: state.round + 1,
    max_rounds: MAX_ROUNDS,
    permissions_mode: contract?.permissions?.mode ?? null,
    required_fields: requiredFields(contract),
    complete: status.complete,
    questions: fields.map((field) => ({
      field,
      question: FIELD_QUESTION[field],
      field_semantics: FIELD_SEMANTICS[field],
      options: [],
      selected: null,
      source: 'user',
    })),
    answer_spec: [...INTERVIEW_ANSWER_SPEC],
    remaining_criteria: status.missing,
    warnings: status.warnings,
  };
}

/** 选项校验：只看形状，不对自然语言做判定。 */
function validateOptions(entry, index) {
  const options = entry?.options;
  if (!Array.isArray(options)) throw new InterviewError(`answers[${index}].options 缺失：每题必须带上当时给出的选项原文`);
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw new InterviewError(`answers[${index}].options 有 ${options.length} 项：必须是 ${MIN_OPTIONS}–${MAX_OPTIONS} 个选项，0 或 1 个是开放式问题`);
  }
  const cleaned = options.map((option, position) => {
    if (typeof option !== 'string' || !option.trim()) throw new InterviewError(`answers[${index}].options[${position}] 为空：选项必须是非空字符串`);
    return option.trim();
  });
  if (new Set(cleaned).size !== cleaned.length) throw new InterviewError(`answers[${index}].options 存在重复项：选项必须互不相同，否则这道题没有在做选择`);
  return options;
}

/** permissions 是唯一取值受限的字段：它决定后续必问题清单，不能是自由文本。 */
function applyPermissions(contract, text, index) {
  if (!['read_only', 'write'].includes(text)) {
    throw new InterviewError(`answers[${index}] 选中 ${quote(text)}：permissions 的选项内容必须恰好是 permissions.mode 的取值之一，当前值为 ${quote(contract?.permissions?.mode ?? null)}`);
  }
  contract.permissions.mode = text;
  if (text === 'read_only') contract.permissions.writable_paths = [];
}

/** 把选中的内容写进对应字段。列表字段追加，已存在则不重复写。 */
function applyToField(contract, field, text, index) {
  if (field === 'permissions') return applyPermissions(contract, text, index);
  if (field === 'objective') { contract.objective = text; return; }
  if (field === 'acceptance') {
    // 占位条目由 core/contract-substance.mjs 的判据识别，这里不自己比对字面量：
    // 占位文本改了而这里没跟上，就会变成"在占位条目旁边再加一条"，实质性判据依旧报错。
    const placeholder = contract.acceptance.findIndex((item) => contractSubstance({ acceptance: [item] }).errors.length > 0);
    if (placeholder >= 0) { contract.acceptance[placeholder].requirement = text; return; }
    if (contract.acceptance.some((item) => item?.requirement === text)) return;
    const ids = new Set(contract.acceptance.map((item) => item?.contract_item_id));
    let ordinal = contract.acceptance.length + 1;
    while (ids.has(`acceptance-${ordinal}`)) ordinal += 1;
    contract.acceptance.push({ contract_item_id: `acceptance-${ordinal}`, requirement: text });
    return;
  }
  if (field === 'scope.include') {
    // 占位条目在 core/contract-substance.mjs 的判据里，这里靠它识别，不自己比对字面量。
    const placeholders = contract.scope.include.filter((item) => contractSubstance({ scope: { include: [item] } }).errors.length > 0);
    contract.scope.include = contract.scope.include.filter((item) => !placeholders.includes(item));
    if (!contract.scope.include.includes(text)) contract.scope.include.push(text);
    return;
  }
  if (field === 'scope.exclude') { if (!contract.scope.exclude.includes(text)) contract.scope.exclude.push(text); return; }
  if (field === 'stop_conditions') { if (!contract.stop_conditions.includes(text)) contract.stop_conditions.push(text); return; }
  throw new InterviewError(`answers[${index}].field = ${quote(field)}：不是本命令认识的字段路径，可选：${FIELD_ORDER.join(' / ')}`);
}

/**
 * 回填：输入草稿 + 本轮作答，把选中内容写进对应字段，追加作答记录，重新校验。
 * 返回更新后的草稿（未签名，签名交给调用方的 normalize）与下一批问题或冻结判定。
 * @param {any} draft @param {any[]} answers
 */
export function answer(draft, answers) {
  const contract = structuredClone(draft);
  const state = readInterviewState(contract);
  if (state.round >= MAX_ROUNDS) {
    throw new InterviewError(renderExhausted(completion(contract), state.round));
  }
  if (!Array.isArray(answers) || !answers.length) throw new InterviewError('本轮作答为空：--answers 必须是 answers 数组或 { answers: [...] }');
  if (answers.length > MAX_QUESTIONS_PER_ROUND) throw new InterviewError(`本轮作答有 ${answers.length} 条：一轮最多 ${MAX_QUESTIONS_PER_ROUND} 题`);

  const nextAnswers = [...state.answers.map((item) => structuredClone(item))];
  const nextAssumptions = [...state.assumptions.map((item) => structuredClone(item))];
  const seen = new Set();

  answers.forEach((entry, index) => {
    const field = entry?.field;
    if (typeof field !== 'string' || !FIELD_ORDER.includes(field)) {
      throw new InterviewError(`answers[${index}].field = ${quote(field ?? null)}：不是本命令认识的字段路径，可选：${FIELD_ORDER.join(' / ')}`);
    }
    if (seen.has(field)) throw new InterviewError(`answers[${index}].field = ${quote(field)}：同一轮里重复作答同一个字段`);
    seen.add(field);
    validateOptions(entry, index);

    if (entry.deferred === true) {
      // 不替用户选：字段保留当前默认值，只记一条 assumption。
      // "无所谓"不等于"排除"，所以这里一个字都不往字段里写。
      if (typeof entry.assumed !== 'string' || !entry.assumed.trim()) {
        throw new InterviewError(`answers[${index}].assumed 为空：deferred 必须写明保留下来的默认值是什么，否则 assumption 无从复核`);
      }
      const existing = nextAssumptions.findIndex((item) => item?.field === field);
      const record = { field, assumed: entry.assumed.trim(), reason: 'user_deferred' };
      if (existing >= 0) nextAssumptions[existing] = record; else nextAssumptions.push(record);
      return;
    }

    if (entry.source !== 'user') throw new InterviewError(`answers[${index}].source = ${quote(entry?.source ?? null)}：只接受 "user"；命令检查不了它的真伪，但不接受别的取值`);
    const text = selectedText(entry);
    if (text === null) {
      throw new InterviewError(`answers[${index}].selected = ${quote(entry?.selected ?? null)}：必须是 options 的下标，或 "custom" 配非空 custom_value`);
    }
    applyToField(contract, field, text, index);
    const record = { field, options: entry.options.map((option) => option), selected: entry.selected, source: 'user' };
    if (entry.selected === 'custom') record.custom_value = text;
    // 单值字段再次作答替换旧记录：两条记录只有一条能与字段当前值一致，留着另一条只会让判据 3 永远不成立。
    const duplicate = SINGLE_VALUED.has(field) ? nextAnswers.findIndex((item) => item?.field === field) : -1;
    if (duplicate >= 0) nextAnswers[duplicate] = record; else nextAnswers.push(record);
    // 字段被真正作答后，之前的 deferral 不再成立。
    const deferred = nextAssumptions.findIndex((item) => item?.field === field);
    if (deferred >= 0) nextAssumptions.splice(deferred, 1);
  });

  contract.extensions.interview = { schema_version: 1, round: state.round + 1, answers: nextAnswers, assumptions: nextAssumptions };
  const status = completion(contract);
  if (!status.complete && contract.extensions.interview.round >= MAX_ROUNDS) {
    throw new InterviewError(renderExhausted(status, contract.extensions.interview.round));
  }
  return { contract, status };
}

/** @param {{ missing: { criterion: string, field: string|null, detail: string }[] }} status @param {number} round */
function renderExhausted(status, round) {
  const lines = status.missing.map((item) => `- ${item.detail}`);
  return [
    `interview 已用满 ${round}/${MAX_ROUNDS} 轮，完成判据仍未满足（${status.missing.length} 项）:`,
    ...lines,
    '建议把任务拆开：一份契约要问到第 4 轮还定不下来，通常说明它同时在做两件事。',
  ].join('\n');
}

/**
 * 冻结判定。满足三条完成判据才返回，否则抛出并列出仍缺的判据。
 * 真正的签名交给调用方的 normalize：摘要口径只有一个出处。
 * @param {any} contract
 */
export function assertFreezable(contract) {
  const status = completion(contract);
  if (status.complete) return status;
  throw new InterviewError([
    `interview 完成判据未满足（${status.missing.length} 项），不能冻结:`,
    ...status.missing.map((item) => `- ${item.detail}`),
  ].join('\n'));
}
