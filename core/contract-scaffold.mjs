// @ts-check
// Task Contract 骨架的唯一构造出处。
//
// 骨架此前只长在 verify 域的 scaffold 里。orchestrate 域要提供 `contract scaffold` 别名，
// 而 domains/ 之间禁止互相 import，照抄一份骨架就会出现两个各自漂移的真源：
// 一边补了字段、另一边没补，interview 出的题和 verify 的占位判据就会对不上。
// 因此把骨架本身下沉到 core，两个域各自注入自己的 skill 绑定与签名口径。
//
// 这里只负责"形状"，不负责"内容"：占位字面量仍以 core/contract-substance.mjs 为唯一出处，
// 本模块只引用，不重新声明——否则 #12 的占位判据会静默失效。
// 摘要也不在这里算：verify 与 orchestrate 的 canonicalJson 严格度不同（见 core/digest.mjs），
// 由调用方用自己的 kit 签名，本模块返回未签名的对象。
import { resolve } from 'node:path';

import { SCAFFOLD_OBJECTIVE, SCAFFOLD_REQUIREMENT, SCAFFOLD_SCOPE_ITEM } from './contract-substance.mjs';

/** scaffold 默认 acceptance 条目的 ID。interview 回填第一条要求时复用它，不另起编号。 */
export const SCAFFOLD_ACCEPTANCE_ID = 'acceptance-1';

/**
 * @param {{ workdir: string, contractId: string, skillSet: { name: string, version: string, content_digest: string, provider_mode: string }[] }} options
 * @returns {Record<string, any>} 未签名的契约骨架；字段顺序即两个域 scaffold 输出的字段顺序。
 */
export function buildScaffoldContract({ workdir, contractId, skillSet }) {
  return {
    schema_version: 1,
    contract_id: contractId,
    objective: SCAFFOLD_OBJECTIVE,
    scope: { include: [SCAFFOLD_SCOPE_ITEM], exclude: [] },
    acceptance: [{ contract_item_id: SCAFFOLD_ACCEPTANCE_ID, requirement: SCAFFOLD_REQUIREMENT }],
    permissions: { mode: 'read_only', writable_paths: [] },
    environment: { repository: resolve(workdir), isolation: 'caller_supplied' },
    skill_set: skillSet.map((skill) => ({ ...skill })),
    stop_conditions: [],
    extensions: {},
  };
}
