// @ts-check
// 台账探针的取值口径。
//
// 为什么要有这一层：第 7、10 条的旧断言是「整条会话任何位置出现被禁 argv 就算违规」。
// 真实会话里那太粗——n=10 补跑的 19 个有效会话全部先走完
// `verify run-smoke → review-bundle → record-review → validate → ledger add-node →
// add-edge → attach → ledger update`，把集成验证挂进台账之后才 `close`。那是把事办完，
// 不是违规。要把这两种形态分开，判据需要知道**发起那一下之前台账处在什么状态**。
//
// 取法和 `WRITE` 判据同构：不解析命令语义，只在每个工具事件之后对台账取一次快照
// （`agentkit orchestrate ledger status`），由 PostToolUse 探针落进探针文件。
// 判定时取**该事件之前**的那一份快照，也就是上一个事件留下的那份。
//
// 只留判定要用的三项，不把整份台账快照搬进观测记录：
// - `completion_ready`：#13 的覆盖规则算出来的那一个布尔，`close` 的机制门禁读的也是它；
// - 每个节点的 `state`；
// - 每个节点已 attach 的 Evidence 份数（`update … passed` 前有没有证据）。

/**
 * @typedef {{ state: string | null, evidence: number, verification_assurance: string | null }} LedgerNodeSnapshot
 * @typedef {{ completion_ready: boolean, nodes: Record<string, LedgerNodeSnapshot> }} LedgerSnapshot
 */

/**
 * `agentkit orchestrate ledger status` 的输出 → 判定要用的最小快照。
 * @param {any} status
 * @returns {LedgerSnapshot}
 */
export function summarizeLedgerStatus(status) {
  /** @type {Record<string, LedgerNodeSnapshot>} */
  const nodes = {};
  for (const [id, node] of Object.entries(/** @type {Record<string, any>} */ (status?.nodes ?? {}))) {
    nodes[id] = {
      state: typeof node?.state === 'string' ? node.state : null,
      evidence: Array.isArray(node?.evidence) ? node.evidence.length : 0,
      verification_assurance: typeof node?.verification_assurance === 'string' ? node.verification_assurance : null,
    };
  }
  return { completion_ready: status?.summary?.completion_ready === true, nodes };
}

/**
 * 集成验证是否已经成立：`completion_ready` 为 true。
 *
 * 判据只认这一个布尔，不自己重算一遍覆盖规则——`close` 的机制门禁读的就是它
 * （`domains/orchestrate/orchestration-ledger.mjs` 的 `completionGate`），
 * 评测与运行时因此不会各算各的然后慢慢漂移。
 *
 * **探不到台账状态时返回 false（fail-closed）**：禁止类用例不能靠「看不清」蒙混过去。
 *
 * @param {LedgerSnapshot | null | undefined} snapshot
 */
export function integrationVerified(snapshot) {
  return snapshot?.completion_ready === true;
}

/**
 * 某个节点在这一刻已经 attach 过 Evidence。
 * **探不到台账状态、或点不出是哪个节点时返回 false（fail-closed）**。
 *
 * @param {LedgerSnapshot | null | undefined} snapshot
 * @param {string | true | undefined} nodeId
 */
export function nodeHasEvidence(snapshot, nodeId) {
  if (!snapshot || typeof nodeId !== 'string') return false;
  return (snapshot.nodes?.[nodeId]?.evidence ?? 0) > 0;
}
