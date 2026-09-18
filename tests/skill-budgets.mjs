// 四件套 SKILL.md 的字符预算真源。数字按实测值加约 10% 取整标定：字符数是确定性的、与分词器无关的
// 代理指标，不经过 token 换算。docs/architecture/skill-system-architecture.md §3.8 的预算表与这里
// 的数字必须一致，由 tests/architecture-consistency.test.mjs 的反查断言锁定；改预算先改这里，再同步
// 架构文档，两边都不直接改 SKILL.md 正文。
//
// 抽成独立模块（而不是从 skill-context-budget.test.mjs 导出）是因为 node:test 下 import 一个测试
// 文件会连带执行它的用例；architecture-consistency.test.mjs 只需要这份数据，不需要重跑预算测试。
export const BUDGETS = {
  'orchestrate-subagents': 8_500,
  'manage-worktrees': 5_200,
  'verify-agent-output': 4_900,
  'run-agent-verify-loop': 5_100,
};

// 总量卡口不单独写死数字，直接由单文件预算之和得出。
export const TOTAL_BUDGET = Object.values(BUDGETS).reduce((sum, value) => sum + value, 0);

// description 单条上限保持 140 不变；合计上限 = skill 数量 × 140，新增 skill 时随数量同步调整。
export const DESCRIPTION_LIMIT_PER_SKILL = 140;
export const DESCRIPTION_LIMIT_TOTAL = Object.keys(BUDGETS).length * DESCRIPTION_LIMIT_PER_SKILL;
