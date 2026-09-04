---
name: orchestrate-subagents
description: "编排实际派生的多个子 Agent，负责拆分、并发、派发契约、运行控制和验收。仅在用户明确要求子 Agent、并行或委派，或任务已确定需要多个 Agent 时使用；单 Agent 和单 Artifact 一次性验收不适用。"
metadata:
  requires:
    bins: ["agentkit"]
---

# orchestrate-subagents：子 Agent 编排控制协议

提供宿主无关的拆解、派发、控制和验收协议。最强适配模型持续担任 controller，掌握
`Plan → Delegate → Observe → Re-plan → Verify → Finish`；不得派生另一个 agent 接管控制面或最终判断。

## 组合协议

本 skill 是组合栈的控制面。先建立任务图，再按已确认的事实启用专项能力：

| 条件 | 动作 |
|---|---|
| 固定单一 Artifact、单个只读 reviewer、只验一次 | 不启动本 skill；直接使用 `verify-agent-output`，由当前 controller 消费 Evidence |
| reviewer 是多节点任务图的一部分，或需要并发、不同权限、多个 critic | 本 skill 建任务图；节点的一次性 Evidence 可由 `verify-agent-output` 提供 |
| 用户明确要求实现者与验收者反复收敛，或 freeze 前已经能合理预期“验收失败→修复→新 Artifact”会发生多轮且修复已获授权 | `run-agent-verify-loop` 可用时用它执行有界循环；Loop 内的一次性验证只作为 provider 调用，不再创建第二个全局 orchestrator |
| 已确认同仓存在多个并行写入者、写路径碰撞，或写入归属不明且相交 / 丢失代价高，或用户明确要求 worktree | `manage-worktrees` 可用时用它建立和维护隔离；不可用时执行第 3 节安全下限 |
| 只有一个写入者，其他 Agent 只读 | 共享树，不使用 `manage-worktrees` |
| 普通批量、仓库 dirty、理论上可能并发 | 不足以启用其他专项 skill |

controller 只维护一份公共合同和台账；专项 skill 分别只提供 Evidence、Loop 状态或隔离/Artifact 身份，
不得重建任务图、改变授权或夺取最终判断。按**收敛对象**路由：固定 SHA 一次裁决走 verify；同一目标
连续产生新 Artifact 才走 Loop；多个独立任务才走本 skill。terminal Evidence 不得覆盖；后获修复授权时
保留旧 Evidence，另冻 Loop limits 和新 iteration。

## 控制面不变量与派发台账

controller 始终拥有闭环对象、完成标准、任务图、依赖/barrier、文件与资源 owner、执行配置、权限、
隔离、预算、重试、re-plan、集成和最终裁决。定修复方向前先查缺陷登记、决策记录或计划真源；偏离先例
必须说明理由并交用户裁决。worker 只做有界执行，返回结构化结论、证据和 commit/MR、制品或稳定报告；
没有稳定产物不得验收，高风险结论可交独立 critic 证伪但不能下放最终判断。

派生后维护“活跃 Agent”“本批已完成”，存在并行时再维护“工作进展”；在派发、批次收口、用户询问
和最终答复时更新，无活跃 worker 明示为 0，不虚构百分比。字段与状态变换见
[编排运行时](../docs/orchestrate/orchestration-runtime.md)「派发台账的三张表」。台账也是回收清单：收口前
确认没有孤儿 worker/worktree/运行时资源。任务图与台账只写仓库外会话状态；完整档用 mechanical
ledger，轻量档用单一 JSON 快照，闭环后清理。

### 档位无关的有效能力预检

先列每个节点真正需要的 `required_capabilities`，再用 `agentkit orchestrate preflight check` 校验；
只有 `allowed` 可用。输入已随合同完整提供、节点不依赖额外宿主能力时 requirements 可为空，
此时记 `not_required` 及依据即可。同机、本地或过去恒过都不构成豁免。探针只在比 controller 自做或
缩小节点更便宜时派发，并计入 worker 与 Token 预算。能力键前缀、binding 与复用规则、反应矩阵见
[编排运行时](../docs/orchestrate/orchestration-runtime.md)「Worker 有效能力预检」。

### 显式轻量档

`orchestration_mode: lightweight` 只用于不超过 3 个互相独立的只读 worker：单 stage、无 barrier/Loop/
递归/重试，不创建 worktree 或其他待回收资源，不执行发布、部署、消息或外部写入，controller 能在当前
上下文验收全部输出，且所需能力已有本轮事实或新鲜且 binding 匹配的记录证明。

轻量档仍冻结每个节点的目标、范围、事实/假设、输出合同、验收、证据和停止条件，并在仓库外维护
单一 JSON 快照；它只记录事实，不伪造 journal。资格失效时停止新派发，把现状和产物收养进完整 ledger。
Reflection 使用 `agentkit orchestrate reflection record/propose`，通用 Skill 缺口不得写入宿主能力缓存。
快照 schema、收养步骤和 Reflection 约束见 [编排运行时](../docs/orchestrate/orchestration-runtime.md)。

### 完整档机械台账工具

不满足轻量档时使用 `orchestration_mode: full`。先用 `agentkit contract normalize / validate / digest /
review-view / diff` 固定公共 Task Contract，再以仓库外 state root 初始化 `agentkit orchestrate ledger`。
脚本不直接派发 Agent，controller 把宿主回执写入 `dispatch-record`。节点必须选择
`worker_self_check`、`controller_recheck`、`independent_evidence`，只读 critic/scout 用
`not_applicable`；依赖/barrier 未通过不派下游。命令、schema、`--expected-revision`、state root 信任
边界和批级熔断见 [编排运行时](../docs/orchestrate/orchestration-runtime.md)。
Reflection 只记证据化观察，Improvement Proposal 永远保持 `proposed`，不能改变当前运行。

## 1. 先过闸门

**默认单干。** 只有广度超出单上下文/串行成本、关键结论需要独立证伪，或大批同构工作需要流水线时
才编排；单文档、单函数、单点事实和小机械修改不编排。先服从用户与宿主授权：少量轻量只读任务可在
授权内并行；大 pool、结构化 Workflow、递归派生，以及超预期成本、写入或外部动作必须明确 opt-in。

## 2. 规模从结构推导

规模来自真正独立且单个上下文装不下的工作块，不来自话题数；删掉不影响答案的节点。常规盘点/审计
一轮总 Agent 数 `≤10`。扫描与核验配比、
合并判据与各档规模见 [任务类型剧本](../docs/orchestrate/task-playbooks.md)。

## 3. 派发前决定环境

多数宿主默认共享文件系统、Git index、进程和外部服务；`writable_paths` 是契约，不是物理沙箱。先只读扫描当前树、已有 worktree、分支占用、近期改动和任务认领；发现目标路径相交时直接选 worktree，不得自动 stash、reset、checkout 或覆盖用户改动。

派发新写 worker 前先清点历史 worktree / 分支，按下文“回收”红线判断能否回收；无归属标记的一律按来源不明处理，只清点报告 `KEEP + 原因`、不回收——全 KEEP 是预期行为，不是判断失败。

| 场景 | 环境决策 |
|---|---|
| 只读侦察、审阅、核验 | 共享当前树，`read_only` |
| 同一目标仓仅 1 个写 worker；无人同时写；树归本任务；改动小、路径清楚、容易重做 | 可共享当前树，只允许指定路径 |
| 同仓存在多个并行写入者；人或 controller 同时写；目标文件与非本任务 dirty change 重叠；目标分支被另一活动任务占用 | 每个写 worker 一棵 worktree |
| 写入 owner 或现有改动归属无法确认，且目标路径确实相交或丢失代价高 | 选 worktree |

仓库 dirty、任务大或包含新文件本身都不足以要求隔离；先确认第二写入者、归属冲突或路径相交。
裁决隔离后使用 `manage-worktrees`，它不改变任务图、权限或验收。不可用时必须先读
[无 manage-worktrees 时的隔离下限](../docs/orchestrate/isolation-fallback.md)。

共享树中 worker 不得切换分支，只按路径 stage / commit；禁止 `git add -A`、`git commit -am`、裸 `stash`、`reset --hard`、`checkout -- .` 和并发 merge，controller 是唯一 integrator。

## 4. 选择编排方式

2-3 个独立任务用宿主轻量并行；循环、条件、逐项管线或预算驱动才使用结构化编排。多 stage 默认逐条
pipeline，只有跨条去重、聚合、比较或早退才设 barrier。截断、采样或不重试必须披露覆盖缺口。
barrier、critic 面板与 loop-until-dry 的具体用法见
[编排运行时](../docs/orchestrate/orchestration-runtime.md)「编排原语选择」。具体 API 服从宿主编排工具说明。

## 5. 派发可验收的任务契约

按“可独立验收的责任”拆分，不按宽泛话题拆分。每个节点至少冻结 `objective / scope / inputs（已知事实
与允许假设分栏）/ output_contract / acceptance / evidence / required_capabilities / verification /
stop_conditions`；写任务再冻结权限、精确仓库/workdir/branch 和 writable paths。worker 返回
`status / conclusion / evidence / changes / risks / next_action`，发现合同事实与现场矛盾时升级，不替
controller 圆场。

派发写 worker、完整档、独立 Evidence 或失败后重派前，必须读取
[节点派发合同](../docs/orchestrate/dispatch-contract.md) 并使用完整 envelope。轻量只读节点可只使用上述最小合同。

## 6. 控制运行态与升级

用户可见台账只用 `运行中 / 阻塞 / 待验收`；`partial` 由 controller 决定继续、转阻塞或停止后判
未通过。只有 controller 能给出 `通过 / 未通过 / 取消`。台账术语不进用户汇报，对外说法见
[面向用户的汇报词表](../docs/orchestrate/user-facing-reporting.md)。

只在结论交付、需要输入、scope/写入冲突、预算将尽、新依赖、失败或置信不足时介入；“等待中”不是
状态包。能力故障、业务失败、中断与 contract gap 分开处理，不按失败次数机械升档。失败、重派、中断
或 controller 接手时读取[失败路由与恢复](../docs/orchestrate/failure-routing-and-recovery.md)。合同失真、
新授权、不可逆动作、资源/结论冲突或重试耗尽必须升级，不得自行扩 scope。

## 7. 验证、收敛与停止

回收后依次 `normalize → deduplicate → validate → synthesize`。研究要求直达来源，代码要求文件 / 符号证据，实现要求 diff 与约定测试；关键 claim 由 controller 用外部可观察证据重验，不采信 worker 自述。

四种保证不能混写：`worker_self_check` 只证明稳定输出；`controller_recheck` 绑定覆盖当前稳定输出的
复核记录；`independent_evidence` 绑定唯一 Artifact 与标准 Evidence；只读 critic/scout 用
`not_applicable`，附一份 report 即收口。失败、不可判定、安全阻塞、
human gate 或错绑 Evidence 均不能通过。节点专属验收合同只能用 `agentkit contract project` 从公共
合同切出 acceptance 子集；完整门禁见 [编排运行时](../docs/orchestrate/orchestration-runtime.md)「合同投影」。

快速演进分支的迭代期只读 review 最多算 `controller_recheck`；到 RC/合入候选才冻结唯一 Artifact，
运行 `verify-agent-output` 生成 `independent_evidence`。

聚合状态可能掩蔽条目失败，验收必须下钻到最小可观察单元。critic 必须主动寻找反例：多数判假可作为淘汰信号，多数判真仍不是接受证明。**处方核验**：finding 的事实核验不等于处方核验——采信任何「要求改变现状」的 finding 前，controller 先从裁决真源独立推导预期态，推不出或与处方矛盾时处方不进契约、升级人裁；finding 自己的证据已解释掉大部分偏差而结论未降级的，按证伪信号处理。验收比对对象永远是真源，不是修复目标、MR 描述或契约里转抄的处方。完成但缺少 acceptance 证据时，worker 状态保持 `partial`；停止重试后只有 controller 可判 `未通过`。

必要节点全部验收通过、连续 K 轮无新增、剩余工作不会改变决策、需要新授权 / 外部状态变化，或预算耗尽且已披露覆盖缺口时停止；不要把预算耗尽伪装成全面完成。

### Reviewer 与 Token 预算

独立 reviewer 是高成本资源，不与 worker 1:1 配对。对同一 Artifact 默认只允许一次 primary review；
第二次必须由 `undecidable`、证据冲突或协议歧义触发，使用不同 lens 且可能改变处置。smoke 未通过、
同 lens 重复、输入超出预算或已有 `blocked_safety` 时不派。考虑任何 critic/reviewer 时必须读取
[Reviewer 数量与 Token 预算](../docs/orchestrate/review-budget.md)，冻结 `extensions.review_policy`，并在派发前运行
`agentkit orchestrate review-budget evaluate`。提高 reviewer 数量或输入上限属于 re-contract。

最终答复前用 `闭环项 / 标准 / 证据 / 结果` 审计：闭环对象与外部状态已重查；必要节点已验收且活跃
子 Agent 为 0；自建资源已回收；外部资源列 `KEEP + owner + 原因`；剩余事项明确归类。需要新授权或
外部状态变化时只能报告“已完成可自主部分，整体未闭环”，并给出唯一解阻动作。

## 8. 模型路由与宿主自适配

controller 持续掌握目标、任务图、re-plan、失败分类和最终验收；worker 不自选模型或下一次配置。
派发、首次建 tier、失败后调档或切模型时读[模型路由](../docs/orchestrate/model-routing-config.md)，按任务类型
选档再读[任务剧本](../docs/orchestrate/task-playbooks.md)：使用本地配置中最低可靠 tier，model/effort 只取
用户配置与实时 schema，每次保存精确配置、attempt lineage、理由和预算；扩大授权或显著增费先确认。

`agents/openai.yaml` 和缓存都不是能力证明。runtime/path/tool 要求先做有效能力预检；能力快照的创建、
刷新和复用读[宿主能力缓存](../docs/orchestrate/host-capability-cache.md)。实时 schema 优先，unknown 不能被
缓存补成 allowed，缓存不能扩大授权。`protocol_version`、`runtime_version`、`content_digest` 分别表示
协议兼容性、实现版本和精确安装内容，不得互相替代。
