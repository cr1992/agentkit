// @ts-check
// Task Contract 与 Verification Profile 的实质性检查。
//
// 形状校验只能说明结构合法。scaffold 原样生成的契约和 profile 结构完全合法，却什么也没断言，
// 这样的输入一路走到 Evidence 签发，整条 fail-closed 链就退化成了 fail-open。本模块负责在冻结的
// 那一刻把这类输入拦下来。
//
// 调用约定：
// - 只在创建入口调用：contract validate、ledger init、verify preflight/init/prepare-run、loop init；
// - 续跑与恢复入口只做形状校验，否则升级前已冻结的状态在续跑或崩溃恢复时会失败；
// - 各入口直接使用这里给出的原因字符串，只套各自的错误类型，不改写措辞。
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
  return Array.isArray(argv) && argv.length === SCAFFOLD_ARGV.length && argv.every((item, index) => item === SCAFFOLD_ARGV[index]);
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
      errors.push(`acceptance[${index}].requirement = ${quote(SCAFFOLD_REQUIREMENT)}：仍是 scaffold 占位文本，需写明可观察的验收要求`);
    }
  });
  const include = Array.isArray(contract?.scope?.include) ? contract.scope.include : [];
  include.forEach((item, index) => {
    if (item === SCAFFOLD_SCOPE_ITEM) errors.push(`scope.include[${index}] = ${quote(SCAFFOLD_SCOPE_ITEM)}：仍是 scaffold 占位，需列出本次任务的真实范围`);
  });
  return { errors, warnings: [] };
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
    if (check?.check_id === SCAFFOLD_CHECK_ID) errors.push(`l0_checks[${index}].check_id = ${quote(SCAFFOLD_CHECK_ID)}：这是 scaffold 占位检查的标识，需替换为真实检查`);
  });
  if (checks.length > 0 && checks.every((check) => isScaffoldArgv(check?.argv))) {
    errors.push(`l0_checks[*].argv 全部为 ${quote(SCAFFOLD_ARGV)}：只证明运行环境存在，没有检查本次 Artifact`);
  }
  return { errors, warnings: [] };
}

/** @param {string[]} errors */
export function formatSubstanceErrors(errors) {
  return `实质性检查失败（${errors.length} 项）:\n- ${errors.join('\n- ')}`;
}
