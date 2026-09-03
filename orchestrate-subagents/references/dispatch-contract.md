# 节点派发合同

在派发写 worker、使用完整档、要求独立 Evidence，或进行失败后重派时读取。简单的轻量只读节点只需
使用 `SKILL.md` 中的最小合同，不必加载本文件。

## 完整节点 envelope

```yaml
objective: 唯一目标
role: scout | worker | critic | judge
scope:
  include: 允许范围
  exclude: 明确不处理的行动
inputs: 已知事实、依赖产物与允许假设
output_contract: 结论格式与交付物
acceptance: 可观察完成标准
evidence: 文件、测试、来源或复现步骤
permissions:
  mode: read_only | write
  writable_paths: []
environment:
  repository: 主仓绝对路径
  isolation: shared_tree | worktree
  workdir: worker 工作目录绝对路径
  branch: controller 已确认的分支
  runtime: 按需填写共享资源
dependencies: 前置节点与下游消费者
required_capabilities: []
verification:
  requirement: worker_self_check | controller_recheck | independent_evidence | not_applicable
  provider: none | verify-agent-output
  artifact_scope: node_output | integration_candidate | not_applicable
extensions:
  verification:
    provider: none | verify-agent-output | run-agent-verify-loop
  worktree:
    provider: none | manage-worktrees
execution:
  orchestration_mode: lightweight | full
  attempt_id: 不透明唯一 ID
  attempt: 从 1 开始
  previous_attempt_id: 首次为 null
  tier: 本地 tier | host-default
  model: 精确模型 ID | inherited | host-default
  reasoning_effort: 精确值 | inherited | unsupported
  adjustment_action: initial | retry_same | raise_effort | switch_model | promote_tier | fresh_context | change_strategy
  failure_kind: null | implementation_defect | reasoning_gap | context_gap | strategy_gap
  failure_ref: null | 前序稳定失败证据摘要
  selection_reason: 模型、强度与节点需求的匹配理由
  config_source: [session | user-host:<path> | host-default]
  configuration_state: user-explicit | session-inferred | session-confirmed | persisted-config | host-default
  model_resolution_state: discovered-and-validated | user-explicit-unverifiable | host-default-unexposed
  capability_source: live-schema | live-schema+effective:<ref> | cache:<path>+live-validation
  capability_fingerprint: 当前宿主能力描述 sha256
  effective_capability_ref: 匹配当前 binding 的记录 | null
  capability_cache_status: fresh | refreshed | absent-write-blocked | stale-write-blocked | not-required-lightweight
  dispatch_provenance: explicit | inherited-controller | host-default
  token_budget: 明确预算 | unsupported
  max_attempts: 包含首次派发的最大尝试数
stop_conditions: 阻塞、中止和预算退出条件
```

完整档先通过 `contract-tool.mjs normalize / validate / digest / review-view / diff` 冻结公共 Task
Contract，再把实际宿主派发回执写入 `dispatch-record`。schema 和 runtime 命令见
[orchestration-runtime.md](orchestration-runtime.md)。

## 合同不变量

- `objective / scope / output_contract / acceptance / evidence / verification` 不得缺失；写任务还必须有
  `permissions / writable_paths / environment`。
- `inputs` 中的已知事实必须由 controller 亲自核实并能指出证据；单一来源解析、模式匹配或记忆值属于
  允许假设，并注明 worker 使用前必须验证。
- `exclude` 禁止未申报行动，不禁止带理由上报越界方案；外部可变状态在动作前重查。
- `not_applicable` 只给 `role: critic | scout` 的只读评审节点，必须搭配 `provider: none` 与
  `artifact_scope: not_applicable`；这类节点验收时附一份 report 即可，不冒充实现交付。
- `independent_evidence` 只使用 `verify-agent-output`，且 provider 与 Skill identity 必须在公共合同
  freeze 前声明。通常只对最终冻结的高风险候选启用，不给普通 worker 预先升级。
- 修复类 acceptance 写从裁决真源推导的预期态，不把 reviewer 处方或修复手段本身当标准。
- 重派的 `attempt` 连续，绑定直接前序 attempt 与稳定失败证据，不得覆盖旧节点。

## Worker 状态包

```yaml
status: completed | partial | blocked
conclusion: 核心结论
evidence: 可核验证据
changes: 实际变更
risks: 未解决风险
next_action: 建议后续动作
```

该状态包只是 controller 的验收输入，不是业务交付，也不能自行宣布全局完成。
