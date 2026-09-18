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
 *   runSession: (spec: SessionSpec) => Promise<SessionResult>,
 * }} Driver
 */

export { createReplayDriver } from './replay.mjs';
export { createHeadlessClaudeDriver } from './claude-headless.mjs';
