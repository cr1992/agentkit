// @ts-check
// Task Contract 与 Verification Profile 的实质性检查。
//
// 形状校验只能说明结构合法。scaffold 原样生成的契约和 profile 结构完全合法，却什么也没断言，
// 这样的输入一路走到 Evidence 签发，整条 fail-closed 链就退化成了 fail-open。本模块负责在冻结的
// 那一刻把这类输入拦下来。
//
// 调用约定：
// - 只在创建入口调用：contract validate、ledger init、verify preflight/init/prepare-run、loop init；
// - 续跑与恢复入口只做形状校验，不重判实质性，理由有两条：
//   (a) 契约冻结后不可变，实质性只在冻结那一刻判定一次，再判一次不会得到新信息；
//   (b) verify validate、loop validate、adopt-root、各域 doctor 这些只读回看路径不经过 mutate，
//       会读到本判据出现之前冻结的状态；在这些路径上拒绝，等于让历史 Evidence 的审计结论随
//       runtime 版本变化；
// - mutate 路径不需要这层保护：三个域的 mutate 都先比对 skill_provenance.content_digest，
//   摘要范围含 core/ 与 schemas/。跨版本的在途状态在到达校验器之前就已经以 skill_drift 终止，
//   同版本内的在途状态则已经过了创建入口；
// - 三个域的 doctor 用 substanceWarnings 把同一批判据整体降级成 warning，不改变 healthy；
// - 各入口直接使用这里给出的原因字符串，只套各自的错误类型，不改写措辞。
//
// error 与 warning 的分界：只做存在性检查的判据一律只给 warning。"write 模式没写 exclude" 说明
// 边界没划出来，但划不划得对本模块判断不了，拿它拒绝创建就是把没有信息量的检查当门禁。
//
// scaffold 的占位字面量以这里为唯一出处，verify scaffold 直接引用。两边一旦各自漂移，判据就会静默失效。

export const SCAFFOLD_OBJECTIVE = 'TODO: describe the frozen artifact objective';
export const SCAFFOLD_REQUIREMENT = 'TODO: replace with an observable requirement';
export const SCAFFOLD_SCOPE_ITEM = 'TODO';
export const SCAFFOLD_CHECK_ID = 'replace-with-real-check';
export const SCAFFOLD_ARGV = Object.freeze(['node', '--version']);

/** @typedef {{ errors: string[], warnings: string[] }} SubstanceReport */

const quote = (/** @type {unknown} */ value) => JSON.stringify(value);

/** @param {unknown} argv */
function isScaffoldArgv(argv) {
  return (
    Array.isArray(argv) &&
    argv.length === SCAFFOLD_ARGV.length &&
    argv.every((item, index) => item === SCAFFOLD_ARGV[index])
  );
}

/**
 * 契约层判据。只依赖契约本身，任何创建入口都能执行。
 * 输入可能尚未通过形状校验，所以每个字段都按不可信数据读取。
 * @param {any} contract
 * @returns {SubstanceReport}
 */
export function contractSubstance(contract) {
  const errors = [];
  if (contract?.objective === SCAFFOLD_OBJECTIVE) {
    errors.push(`objective = ${quote(SCAFFOLD_OBJECTIVE)}：仍是 scaffold 占位文本，需写明本次任务的真实目标`);
  }
  const acceptance = Array.isArray(contract?.acceptance) ? contract.acceptance : [];
  acceptance.forEach((item, index) => {
    if (item?.requirement === SCAFFOLD_REQUIREMENT) {
      errors.push(
        `acceptance[${index}].requirement = ${quote(SCAFFOLD_REQUIREMENT)}：仍是 scaffold 占位文本，需写明可观察的验收要求`,
      );
    }
  });
  const include = Array.isArray(contract?.scope?.include) ? contract.scope.include : [];
  include.forEach((item, index) => {
    if (item === SCAFFOLD_SCOPE_ITEM)
      errors.push(
        `scope.include[${index}] = ${quote(SCAFFOLD_SCOPE_ITEM)}：仍是 scaffold 占位，需列出本次任务的真实范围`,
      );
  });
  const warnings = [];
  // 只读合同越界由 permissions 本身兜住；写入合同则全靠 scope.exclude 与 stop_conditions 划边界，
  // 两处都空等于把"改哪里、什么时候停"完全交给执行方判断。
  if (contract?.permissions?.mode === 'write') {
    if (!(Array.isArray(contract?.scope?.exclude) ? contract.scope.exclude : []).length) {
      warnings.push(
        'permissions.mode = "write" 且 scope.exclude 为空：写入型合同没有划出任何不可触碰的面，改动跑偏时没有范围边界可对照',
      );
    }
    if (!(Array.isArray(contract?.stop_conditions) ? contract.stop_conditions : []).length) {
      warnings.push(
        'permissions.mode = "write" 且 stop_conditions 为空：写入型合同没有声明任何终止条件，执行失控时没有机械停机点',
      );
    }
  }
  return { errors, warnings };
}

/**
 * profile 层判据。只有同时拿到 profile 的入口才能执行。
 * 两个分支各自独立触发：只改 check_id、或只换 argv，都绕不过去。
 * @param {any} profile
 * @returns {SubstanceReport}
 */
export function profileSubstance(profile) {
  const errors = [];
  const checks = Array.isArray(profile?.l0_checks) ? profile.l0_checks : [];
  checks.forEach((check, index) => {
    if (check?.check_id === SCAFFOLD_CHECK_ID)
      errors.push(
        `l0_checks[${index}].check_id = ${quote(SCAFFOLD_CHECK_ID)}：这是 scaffold 占位检查的标识，需替换为真实检查`,
      );
  });
  if (checks.length > 0 && checks.every((check) => isScaffoldArgv(check?.argv))) {
    errors.push(`l0_checks[*].argv 全部为 ${quote(SCAFFOLD_ARGV)}：只证明运行环境存在，没有检查本次 Artifact`);
  }
  return { errors, warnings: [] };
}

/**
 * 契约 × profile 的覆盖判据。只有同时拿到两份文件的入口才能执行。
 * 现有 profile 校验只做单向绑定（拒绝 L1 引用不存在的 acceptance），反向不成立：
 * 一条 acceptance 可以一次都不被审，签出来的 Evidence 照样是"全部通过"。
 *
 * 这里只保证每条 acceptance 都被 L1 审过，不保证被 L0 测到：l0_checks 条目没有
 * contract_item_id 字段，schema 又是 additionalProperties: false，无从建立对应关系。
 * @param {any} contract @param {any} profile
 * @returns {SubstanceReport}
 */
export function coverageSubstance(contract, profile) {
  const errors = [];
  const reviewed = new Set(
    (Array.isArray(profile?.l1_review) ? profile.l1_review : [])
      .map((item) => item?.contract_item_id)
      .filter((id) => typeof id === 'string' && id),
  );
  const acceptance = Array.isArray(contract?.acceptance) ? contract.acceptance : [];
  acceptance.forEach((item, index) => {
    const id = item?.contract_item_id;
    // ID 缺失或非字符串是形状问题，交给形状校验报，这里不重复报一遍。
    if (typeof id !== 'string' || !id || reviewed.has(id)) return;
    errors.push(`acceptance[${index}].contract_item_id = ${quote(id)}：未被任何 l1_review 条目引用`);
  });
  return { errors, warnings: [] };
}

/**
 * doctor 口径：把手上能执行的全部判据整体降级成 warning。
 * doctor 是只读回看路径，会读到本判据出现之前冻结的状态；在这里判 unhealthy，
 * 等于让同一份 Evidence 的审计结论随 runtime 版本变化。profile 传 null 时只出契约层判据。
 * @param {any} contract @param {any} [profile]
 * @returns {string[]}
 */
export function substanceWarnings(contract, profile = null) {
  const report = contractSubstance(contract);
  const findings = [...report.errors];
  if (profile) findings.push(...profileSubstance(profile).errors, ...coverageSubstance(contract, profile).errors);
  return [...findings, ...report.warnings];
}

/** @param {string[]} errors */
export function formatSubstanceErrors(errors) {
  return `实质性检查失败（${errors.length} 项）:\n- ${errors.join('\n- ')}`;
}
