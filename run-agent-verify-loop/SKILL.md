---
name: run-agent-verify-loop
description: "运行 Agent 独立验收闭环：由 implementer 迭代修改、隔离上下文的 verifier 主动证伪，并通过确定性检查、状态台账、熔断和人工门推进收敛。当用户明确要求闭环执行、一个 Agent 实现另一个验收、独立 reviewer 持续验收、反复迭代并由独立 Agent 验证直到通过，或建立可恢复的高风险批量执行流水线时使用。普通批量修改、按清单逐项处理、实现者自己修复后跑测试、单 Agent 可直接验证的任务不适用。"
---

# run-agent-verify-loop：Agent 独立验收闭环

元工作流 skill：只提供执行协议，不含领域知识。具体工作（写代码、改文档、写表格）由对应领域 skill 或宿主原生能力完成。

## 组合位置

本 skill 只拥有“怎么独立验收并循环收敛”，不拥有 Agent 派发、模型选择或 worktree 生命周期：

- 需要派生 implementer / verifier 且 `orchestrate-subagents` 可用时，用它建立任务图、派发契约和运行台账；未安装时直接使用宿主原生子 Agent 机制，或按末尾“宿主适配”降级，不伪造缺失的编排能力。
- 已确认多个写入者并发修改同一仓库，或编排层因写入归属不明且路径相交 / 丢失代价高而裁决需要隔离时，由 `orchestrate-subagents` 再使用 `manage-worktrees` 建立隔离。
- 与 `orchestrate-subagents` 同时启用时只维护一份任务契约：controller 持有公共字段，本 skill 增补 `l0_checks / l1_review / human_gate / on_failure / max_iterations` 等验证字段，不另建第二份目标、scope 或状态台账。

三个 skill 可以组合使用，但不得因为“批量”“仓库 dirty”或理论上可能并发就全部加载。

## 第零步：判断要不要开闭环

依次问三个问题，任一不满足就不开：

1. **够大吗？** 单步、单文件、一条命令能验证的任务：不开闭环，直接做，跑一次确定性检查收尾。
2. **能验证吗？** 成功条件表达不成命令、数据断言、审查清单或人工确认的：降级为 research / plan，先帮用户把验收条件补出来。
3. **范围能锁吗？** 允许改动的边界说不清的：先和用户锁边界，锁不了不开。

三问都过，按风险选强度：

| 风险 | 特征 | 配置 |
|------|------|------|
| 中 | 多文件改动、有回归面、小批量 | 内环 + 每个 work item 一轮独立验证 |
| 高 | 不可逆写入、发布、权限变更、大批量 | 全嵌套 + 人工门；必要时多个 verifier 独立证伪 |

## 为什么验收权必须外移

实现者给自己验收有三个结构性失效源：上下文污染（带着「已经做对」的叙事重读只会自我确认）、目标耦合（完成欲吃掉验证严格性，表现为改弱测试、无证据宣布通过）、上下文退化（长循环后期验证变敷衍）。提示词作用在倾向层，消不掉结构层的失效源。因此验收判定要么下沉给确定性机器，要么交给上下文隔离的独立 verifier；实现者的自查永远不算数。

## 验证强度分级

| 级别 | 手段 | 用途 |
|------|------|------|
| L0 | 测试 / lint / schema 校验 / 退出码 / 写后回读比对 | 验收主力，不可被说服。能表达成 L0 的验收标准必须表达成 L0 |
| L1 | 独立 verifier agent：新上下文 + 证伪框架 + 强制取证 | L0 盖不住的部分：需求缺口、语义正确性、视觉、文案 |
| L2 | 实现者同上下文自查 | 只用于内环迭代加速，永不产生验收效力 |
| H | 人工确认门 | 正交的放行门：高风险、不可逆、主观验收动作，按契约 human_gate 声明 |

## 任务契约

进入闭环前先成契约。契约签署后属于验证定义，implementer 不可自改；要改 = 停机、重签、留记录。

与 `orchestrate-subagents` 组合时使用其字段名，不另造同义字段：

| 闭环概念 | 公共契约字段 |
|---|---|
| 允许范围 / 禁止范围 | `scope.include / scope.exclude` |
| 成功与熔断条件 | `stop_conditions` |
| implementer | `role: worker` + `extensions.verification.actor: implementer` |
| verifier | `role: critic` + `extensions.verification.actor: verifier` |
| ledger 位置与验证参数 | `extensions.verification.*` |

standalone 使用时也沿用同一 schema：

```yaml
objective: 要完成什么
role: worker | critic
scope:
  include: 允许写入的文件、数据、对象边界
  exclude: 禁止触碰的范围
inputs: 输入来源（仓库、文档、表格、issue、任务队列）
output_contract: 结论格式与稳定交付物
acceptance: 可观察完成标准
evidence: 最终必须回传的证据
permissions:
  mode: read_only | write
  writable_paths: []
environment:
  repository: 目标仓绝对路径
  isolation: shared_tree | worktree
  workdir: 实际工作目录绝对路径
  branch: 已确认分支；只读任务无分支时写 none
stop_conditions: 成功判定 + 熔断条件
extensions:
  verification:
    provider: run-agent-verify-loop
    actor: implementer | verifier
    state: ledger 位置（选择规则见「状态外置」）
    l0_checks: 确定性验证命令与断言清单
    l1_review: 独立验证覆盖范围（没有则显式写 none）
    protected_verifier_paths: 验证定义路径清单，默认对 implementer 只读
    allowed_validation_changes: 允许修改的验证定义；默认 none
    human_gate: 必须人工确认的动作；没有则 none
    on_failure: 重试 | 回滚 | 换策略 | 停
    max_iterations: 内环迭代上限；批量任务另加批级熔断阈值
    escalation: 何时必须停下问用户
```

## 嵌套闭环

- **内环（实现环）**：implementer 对单个 work item 迭代，用 l0_checks 自查加速收敛，直到自认为通过。整环 L2 性质，不产生验收效力。
- **中环（验证环）**：每轮新开独立 verifier。进入中环前必须读取 [references/verifier-protocol.md](references/verifier-protocol.md)，并按其中 schema 组装 verifier 输入与核验输出。输入只给四样：契约、产物、验证入口、verifier_view。必须在最终产物上亲自重跑 l0_checks，不采信 implementer 的自跑结果。任务框架是证伪。输出三态：`fail`（附复现证据）/ `no-defect-found`（附取证记录）/ `undecidable`。
- **外环（调度环）**：orchestrator 只做路由和熔断，全走确定性规则：`fail` 带证据回内环；`no-defect-found` 且 L0 全绿则完成或过 H 门；达到 max_iterations、连续同因失败、验证定义被越权改动则停机升级。
- **人工门**：human_gate 声明的动作、`undecidable`、熔断触发，停下等用户。

done 的定义 = L0 全绿（verifier 或 orchestrator 在最终产物上重跑得出）+ verifier `no-defect-found` +（human_gate 非 none 时）人工确认。三者缺一不宣布完成。

## 角色隔离硬规则

1. **信息隔离**：verifier 不读实现过程对话与实现者叙事；每轮新实例，不复用。
2. **写权限分离**：protected_verifier_paths 默认只读；任务目标本身是改验证定义的（补测试、更新 schema、重烤基线）走 allowed_validation_changes 显式授权，且该改动是 verifier 重点审查对象——核对与契约目标一致，不是变相弱化验收；orchestrator 每轮 diff 检查越权改动。
3. **证伪框架**：verifier 的任务永远是「找出不满足契约的证据」；无取证的通过无效，直接打回。
4. **裁决收窄**：verifier 没有「保证正确」这个输出；done 按上面三条件合成。
5. **熔断确定性**：停机由计数器和规则触发，不由任何 LLM 裁量。

## 状态外置（ledger）

- 任务已有 tracker（任务清单文件、issue、表格）：复用它，不另起。
- 没有现成 tracker：临时 ledger 落系统临时目录或宿主 scratchpad；跨 agent 交接时把路径写进交接信息。
- 要在仓库内新建 ledger 文件：需用户同意，任务结束后清理。
- 当前会话本身永远不算状态外置。

ledger 至少记录：当前 work item、执行结果、验证结果与证据指针、下一步、阻塞条件。

**verifier_view**：tracker 里常混着实现者的自述、判断和过程备注，直接递给 verifier 会污染信息隔离。orchestrator 必须提取只含契约、产物指针、逐项状态、证据指针的视图交给 verifier，不把原始 tracker 整个递过去。

## 批量队列

- ledger 逐项三态：`pending` / `done` / `failed`（附原因），必须支持断点续跑——中断后重启从 ledger 恢复，跳过已完成项。
- 单项失败记录后继续，不污染整批。
- 批级熔断：连续 3 项同一原因失败即系统性问题，停批升级，不许硬跑完剩余项。

## 防护栏

- 验收永不采信实现者自述；无取证的通过无效。
- 写入限于 scope；「修到通过」不解释为任意修改；发现需扩 scope = 停机重签契约并记录。
- 删除、重置、覆盖用户或业务数据，以及发布动作必须过 H 门。controller 自建、已登记且通过回收审计的临时 ledger、worktree、临时分支和进程可按预先声明的生命周期自动回收；契约另有 human_gate 时仍须停门。
- 验证不可判定输出 `undecidable` 并升级，不许猜。
- 连续失败按 on_failure 总结失败模式换策略，禁止重复同一动作。
- 必须设 max_iterations、时间或预算上限。

## 宿主适配

最低要求是「能开新上下文的执行单元」：

- 有 subagent 机制的宿主（Claude Code、Kiro、Codex 等）：由 `orchestrate-subagents` 派发 implementer / verifier（新上下文天然满足信息隔离），主会话持续担任 controller；只有多个写入者并发时才使用 `manage-worktrees` 或等效隔离。
- 无 subagent 的宿主：降级为双会话协议，用户在两个会话间中继契约和产物。
- 再降级为单 agent + 防护栏时，验收强度只有 L2，必须向用户显式声明，不得假装等效。

本 skill 不含 headless / 无人值守模板；被这类需求触发时只做 loop 结构设计并说明限制。
