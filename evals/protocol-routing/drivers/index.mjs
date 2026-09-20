// @ts-check
// 会话驱动器接口。
//
// 驱动器只负责「起一次会话并产出一份观测记录」。判定、计分、报告都不在这里，
// 因此换宿主只要新写一个驱动器，评测口径一个字都不用改。

/**
 * @typedef {{
 *   evalCase: import('../cases.mjs').EvalCase,
 *   runIndex: number,
 * }} SessionSpec
 *
 * @typedef {import('../lib/observation.mjs').Observation & { source?: string }} SessionResult
 *
 * @typedef {{
 *   name: string,
 *   meta: Record<string, any>,
 *   needsFixture: boolean,
 *   prepare?: () => Promise<Record<string, any> | null>,
 *   runSession: (spec: SessionSpec) => Promise<SessionResult>,
 * }} Driver
 *
 * `prepare()` 是开跑前的一次性准备，`run.mjs` 在进用例循环之前调用一次，返回的字段并进报告
 * 元数据。它里面抛出的错误**不被捕获**：整轮准备不成就当场停，不要表现成逐会话丢样本。
 * 无头驱动器用它每轮装一次 skill（见 lib/skill-install.mjs）；回放驱动器不需要。
 */

export { createReplayDriver } from './replay.mjs';
export { createHeadlessClaudeDriver } from './claude-headless.mjs';
