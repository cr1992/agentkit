# 失败路由与 Controller 恢复

只在能力故障、业务验收失败、worker 中断、重派或 controller 接手时读取。正常 happy path 不加载。

## 能力故障

先归一为：

- `allowed`
- `denied_by_policy`
- `unavailable_or_unproven`
- `approval_channel_fault`
- `execution_fault`

错误字符串只作证据。策略拒绝后缩小 scope 或交 controller；审批通道故障停止同类派发并交人；执行
故障先诊断环境。不得扩大 scope、拿替代样本冒充目标对象，或用更强模型掩盖能力问题。

## 验收失败与重派

业务失败分为 `implementation_defect / reasoning_gap / context_gap / strategy_gap / environment_fault /
contract_gap / safety / undecidable`。前四类可在已授权的本地 envelope 内选择 `retry_same /
raise_effort / switch_model / promote_tier / fresh_context / change_strategy`；其余分别诊断环境、
re-contract、停止或升级。

每次重派创建新 attempt 和新 ledger 节点。前序先附稳定失败 report/Evidence 并进入 `failed`；新派发
绑定直接前序 `attempt_id`、连续序号、`failure_kind`、`failure_ref` 与新的选择理由。达到
`max_attempts`、连续同因熔断或需要越过已授权模型/effort envelope 时停止并交用户。模型动作的完整
约束见 [model-routing-config.md](model-routing-config.md)。

## Worker 中断

宿主标记 `interrupted` 后，先要求原 worker 只读回报原任务、进度、产物、改动和中断原因，不继续
业务写入。有稳定产物则验收并收养；无产物或不能恢复才判取消/未通过。模型与 effort 以 controller
保存的派发参数和宿主回执为准，不要求 worker 自省。

## Controller 接手

接手按“重建 → 收养 → 重派”：

1. 从仓库外快照、资源归属和宿主留痕重建任务图；冲突时以可观察证据为准。
2. 有产物的节点重新验收后收养，不采信旧台账中的待验收/通过叙述；无法对账的资源保持
   `KEEP + owner + 原因`。
3. 无产物或验收失败的节点视为未派发，按现行合同创建新 attempt。
4. 收养的 worktree、分支、进程与外部资源进入当前回收清单，继续服从原安全边界。

递归派生默认禁止；只有 controller 明确给出目标、预算和最大深度时才允许，通常不超过两层。
