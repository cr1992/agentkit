// @ts-check
// 回放驱动器：读预录的观测 JSONL，不起任何会话、不产生任何模型费用。
//
// 自测与 CI 只用它。它和无头驱动器共用同一份观测记录格式，因此过了回放自测的分类器，
// 拿到真实会话的记录时行为一致。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseObservation } from '../lib/observation.mjs';

/**
 * @param {{ dir: string }} options
 * @returns {import('./index.mjs').Driver}
 */
export function createReplayDriver({ dir }) {
  return {
    name: 'replay',
    /** 回放不具备宿主信息；元数据取自录制文件自己写下的那份。 */
    meta: { driver: 'replay', replay_dir: dir },
    needsFixture: false,
    async runSession({ evalCase, runIndex, attempt = 1 }) {
      // `attempt` 参与查找是为了能回放「第 1 次无效、重试后有效」这类序列：
      // 录一份 `run-<n>-attempt-1.jsonl` 放故障，再录 `run-<n>.jsonl` 放正常会话即可。
      const candidates = [
        join(dir, `case-${evalCase.id}`, `run-${runIndex}-attempt-${attempt}.jsonl`),
        join(dir, `case-${evalCase.id}`, `run-${runIndex}.jsonl`),
        join(dir, `attempt-${attempt}.jsonl`),
        join(dir, `case-${evalCase.id}.jsonl`),
        join(dir, 'default.jsonl'),
      ];
      const path = candidates.find((candidate) => existsSync(candidate));
      if (!path) throw new Error(`回放目录缺少用例 ${evalCase.id} 的记录，找过：\n- ${candidates.join('\n- ')}`);
      return { ...parseObservation(readFileSync(path, 'utf8')), source: path };
    },
  };
}
