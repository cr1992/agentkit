---
name: orchestrate-subagents
description: "编排实际派生的多个子 Agent，负责拆分、并发、派发契约、运行控制和验收。仅在用户明确要求子 Agent、并行或委派，或任务已确定需要多个 Agent 时使用；单 Agent 和单 Artifact 一次性验收不适用。"
---

# orchestrate-subagents：子 Agent 编排控制协议

提供“是否编排、如何拆解、怎样派发、如何控制、何时验收”的宿主无关协议，不含领域知识。最强适配模型运行当前会话并持续担任 controller，掌握 `Plan → Delegate → Observe → Re-plan → Verify → Finish`；不要派生另一个 agent 接管控制面或下放全局完成判断。

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

controller 只维护一份公共任务契约和一份运行台账。`verify-agent-output` 只返回一次性 Evidence；
`run-agent-verify-loop` 只维护循环状态；`manage-worktrees` 只回填隔离与 Artifact 身份。专项 skill
不得重建任务图、改变授权或夺取最终完成判断。

路由按**收敛对象**而不是当前命令数决定：固定 SHA 的一次裁决走 `verify-agent-output`；同一目标预计
产生连续新 Artifact 并反复验收走 `run-agent-verify-loop`；多个彼此独立的任务才走本 skill。一次性
Evidence 已经 terminal 后不得在原 run 上修复或覆盖；若随后获得多轮修复授权，保留旧 Evidence，
冻结 Loop limits，并把修复后的新 Artifact 作为 Loop 的新 iteration 输入。

## 控制面不变量与派发台账

controller 亲自完成：

- 声明本轮闭环对象、完成标准和非目标；`MR 已创建 / 已合入 / 已发布 / consumer 已升级` 分别核验。
- 设计依赖、并发、barrier、文件和资源 owner。
- 为修复 / 设计类节点定方向前，先查裁决真源（缺陷登记表、决策记录、计划文档）有无同类先例；有先例沿先例，偏离必须写明理由并交用户裁决。
- 为每个节点选择角色、执行配置（精确模型、reasoning effort、选择理由、预算、重试上限）、权限、隔离方式和停止条件。
- 根据证据追问、改派、修订计划或停止；验证关键证据、集成写入、处理冲突并回收环境。

把搜索、盘点、格式整理和同构修改交给 worker，只回收结构化结论与证据；高风险方案执行前可加独立 critic 尝试证伪，但最终裁决仍归 controller。

实际派生 worker 后维护“活跃 Agent”和“本批已完成”两表；存在并行时再维护“工作进展”。派发后、
批次收口、用户询问和最终答复时更新：活跃表记录任务、精确执行配置、仓库/隔离、写范围、三态
`运行中 / 阻塞 / 待验收` 与可观察检查点；完成表记录结果、稳定产物、证据和环境收尾；进展表必须
包含 controller 自己的集成、提交、发布与回收工作。无活跃 worker 时明确写 `当前活跃子 Agent：0`。
不虚构百分比，不用 worker 自述代替稳定交付物。

实现节点只有提供 commit/MR、tag/制品或稳定报告等可复核产物后才能验收；没有稳定产物就保持进行中
或阻塞。只读审计可用状态包与证据指针收口，但不能冒充实现交付。

台账同时是回收清单：会话结束前确认没有孤儿 worker、孤儿 worktree 或遗留运行时资源；端口、数据库等只在确实使用时作为环境备注。若用户明确要求表格汇报，即使没有派生 worker，也用“工作进展”表呈现 controller 工作。

每次更新把任务图和表同步到仓库外会话状态：完整档写 mechanical ledger，轻量档写单一 JSON 快照；
闭环审计后随本轮临时资源清理，不进项目仓。

### 档位无关的有效能力预检

先列每个节点真正需要的 `required_capabilities`，再用
`scripts/worker-capability-preflight.mjs check` 校验当轮事实或新鲜、binding 匹配的 Effective Worker
Capability；只有 `allowed` 可用。能力键一律 `worker.` 前缀（如 `worker.read.cwd`），其他前缀直接拒绝。输入已随合同完整提供、节点不依赖额外宿主能力时 requirements 可为空，
此时不调用 preflight 脚本，在快照或 ledger 中记录 `not_required` 及依据即可。非空 requirements 必须
取得绑定当前 host、worker profile、接口指纹与 session / 配置摘要的 `allowed`；同机、本地或过去恒过
都不构成豁免。相同 binding 与 requirements 的当轮有效结果可以复用，不做形式化重复调用。探针只在
比 controller 自做或缩小节点更便宜时派发，并计入 worker 与 Token 预算。完整结构和反应矩阵见
[编排运行时](references/orchestration-runtime.md)。

### 显式轻量档

同时满足以下条件时使用 `orchestration_mode: lightweight`，无需完整 capability cache、模型路由解析器或
`orchestration-ledger.mjs`：

- 总 worker 数不超过 3，全部只读且互相独立；
- 单 stage，无 barrier、Loop、递归派生、批级熔断或自动重试；
- 不创建 worktree，不拥有端口、数据库、凭证或其他待回收资源；
- 不执行发布、部署、发消息、写外部系统等副作用；
- controller 能在当前上下文内直接验收全部输出。
- 每个节点要求的有效 worker 能力均已由本轮事实或新鲜、binding 匹配的记录证明。

轻量档仍冻结每个节点的目标、范围、事实/假设、输出合同、验收、证据和停止条件，并在仓库外维护
单一 JSON 快照；它只记录事实，不伪造 journal。资格失效时停止新派发，把现状和产物收养进完整 ledger。
Reflection 使用 `orchestration-reflection.mjs record/propose`，通用 Skill 缺口不得写入宿主能力缓存。
快照 schema、收养步骤和 Reflection 约束见 [编排运行时](references/orchestration-runtime.md)。

### 完整档机械台账工具

不满足轻量档时使用 `orchestration_mode: full`。先用 `contract-tool.mjs normalize / validate / digest /
review-view / diff` 固定公共 Task Contract，再以仓库外 state root 初始化 `orchestration-ledger.mjs`。
脚本不直接派发 Agent，controller 把宿主回执写入 `dispatch-record`：

```text
capabilities
init --contract <json> --state-root <dir>
add-node / add-edge / dispatch-record / update / attach
batch-init / batch-record / batch-status / batch-fuse
record-reflection / propose-improvement
status / inspect / rebuild / doctor
```

所有修改命令支持 `--expected-revision`。节点必须选择 `worker_self_check`、`controller_recheck`、
`independent_evidence`，只读 critic/scout 用 `not_applicable`；依赖/barrier 未通过时不派发下游。批任务为每项建独立 Loop，再由 batch ledger
按稳定 failure key 熔断。完整 schema、命令与边界见 [编排运行时](references/orchestration-runtime.md)。
Reflection 只记证据化观察，Improvement Proposal 永远保持 `proposed`，不能改变当前运行。

### 台账信任边界

state root 只由 controller/operator 与 runtime 写。journal digest chain 可发现损坏并恢复，但不是
数字签名或外部不可变日志；拥有完整写权限的进程仍能重写历史，不得描述成抗恶意 writer 的保证。

## 1. 先过闸门

**默认单干。** 仅在命中以下至少一类时考虑子 agent / Workflow：

- **广度**：需横扫大量文件、目录或来源，单个上下文装不下或串行过慢。
- **信心**：高风险 finding / 决策需要独立视角主动证伪。
- **规模**：迁移、审计或大批同构条目需要逐项流水。

单文档、单函数、单点事实、概念问答和一处小机械改动直接单干；宽度看任务本身，不看“想不想显得充分”。

先服从宿主与用户授权。宿主允许自主派生时，命中闸门的少量轻量只读任务可直接并行；大 pool、结构化 Workflow、递归派生，或超出用户预期的成本、写入和外部动作需要明确 opt-in。

## 2. 规模从结构推导

- 扫描数等于真正独立、单个上下文装不下的工作块数；两个 scope 重叠过半就合并。
- 核验数从风险推导，只核“错误会改变最终决策”的条目，不与扫描任务 1:1 配对；若核验大多只是确认并补细节、很少推翻，说明核多了。
- 快速看一眼用 2-3 个；常规盘点 / 审计一轮总 Agent 数 `≤10`，其中扫描任务合并后通常 `4-6` 个；几十个只用于大规模同构 pipeline。
- 逐个问“砍掉它，最终答案会变吗？”不会就砍；用户要求的深度优先。

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
[无 manage-worktrees 时的隔离下限](references/isolation-fallback.md)。

共享树中 worker 不得切换分支，只按路径 stage / commit；禁止 `git add -A`、`git commit -am`、裸 `stash`、`reset --hard`、`checkout -- .` 和并发 merge，controller 是唯一 integrator。

## 4. 选择编排方式

- 2-3 个独立任务用宿主轻量并行；循环、条件、逐项管线或预算驱动才使用结构化编排。
- 多 stage 默认逐条 pipeline；只有跨条去重、聚合、比较或早退才设 barrier。
- 高风险 finding 用不同 lens 的证伪 critic；解空间宽才使用 judge 面板。
- 未知规模使用 loop-until-dry，对累计已见集合去重，必要时末尾加 completeness critic；截断、采样或不重试必须披露覆盖缺口。

具体原语和 API 服从宿主编排工具说明。

## 5. 派发可验收的任务契约

按“可独立验收的责任”拆分，不按宽泛话题拆分。每个节点至少冻结 `objective / scope / inputs（已知事实
与允许假设分栏）/ output_contract / acceptance / evidence / required_capabilities / verification /
stop_conditions`；写任务再冻结权限、精确仓库/workdir/branch 和 writable paths。worker 返回
`status / conclusion / evidence / changes / risks / next_action`，发现合同事实与现场矛盾时升级，不替
controller 圆场。

派发写 worker、完整档、独立 Evidence 或失败后重派前，必须读取
[节点派发合同](references/dispatch-contract.md) 并使用完整 envelope。轻量只读节点可只使用上述最小合同。

## 6. 控制运行态与升级

用户可见台账只用 `运行中 / 阻塞 / 待验收`；`partial` 由 controller 决定继续、转阻塞或停止后判
未通过。只有 controller 能给出 `通过 / 未通过 / 取消`。

事件驱动监控，只在结论交付、需要输入、scope / 写入冲突、预算将尽、新依赖、失败或置信度不足时介入。“等待中”不是状态包；要求 worker 交完整结果或报 blocked + 卡点。

能力故障、业务失败、worker 中断与 contract gap 分开处理；不按失败次数机械升档，不让 worker 自选
下一次模型。出现任一失败、重派、中断或 controller 接手时，先读取
[失败路由与 Controller 恢复](references/failure-routing-and-recovery.md)。

遇到合同失真、新授权、不可逆动作、资源/结论冲突、重试耗尽或改变全局方案的新事实时，worker 必须
升级回 controller，不得自行扩 scope。

### 面向用户汇报的词表

台账术语只留在仓库外状态文件，不进用户汇报；对外一律白话：critic→独立挑错评审、
scout→前期摸底、worker→实现者、controller recheck→我方复核、independent evidence→独立验收证据、
产物冻结→固定到某个提交 SHA、awaiting_verification→待验收、partial→做了一半。
术语首次出现就当场解释，不要把台账原词直接抛给用户。

## 7. 验证、收敛与停止

回收后依次 `normalize → deduplicate → validate → synthesize`。研究要求直达来源，代码要求文件 / 符号证据，实现要求 diff 与约定测试；关键 claim 由 controller 用外部可观察证据重验，不采信 worker 自述。

四种保证不能混写：`worker_self_check` 只证明稳定输出；`controller_recheck` 绑定覆盖当前稳定输出的
复核记录；`independent_evidence` 绑定唯一 Artifact 与标准 Evidence；只读 critic/scout 用
`not_applicable`，附一份 report 即收口。失败、不可判定、安全阻塞、
human gate 或错绑 Evidence 均不能通过。节点专属验收合同只能用 `contract-tool.mjs project` 从公共
合同切出 acceptance 子集；完整门禁见 [编排运行时](references/orchestration-runtime.md)「合同投影」。

分支仍在快速演进、review 后会立即修复时，可派新上下文做迭代期只读 review，但它属于 controller 的
决策辅助：最多登记为 `controller_recheck`，不得声称已生成 `independent_evidence`。到 RC / 合入候选等
需要一锤定音的边界时，再冻结唯一 Artifact 并运行 `verify-agent-output` 全流程。

聚合状态可能掩蔽条目失败，验收必须下钻到最小可观察单元。critic 必须主动寻找反例：多数判假可作为淘汰信号，多数判真仍不是接受证明。**处方核验**：finding 的事实核验不等于处方核验——采信任何「要求改变现状」的 finding 前，controller 先从裁决真源独立推导预期态，推不出或与处方矛盾时处方不进契约、升级人裁；finding 自己的证据已解释掉大部分偏差而结论未降级的，按证伪信号处理。验收比对对象永远是真源，不是修复目标、MR 描述或契约里转抄的处方。完成但缺少 acceptance 证据时，worker 状态保持 `partial`；停止重试后只有 controller 可判 `未通过`。

必要节点全部验收通过、连续 K 轮无新增、剩余工作不会改变决策、需要新授权 / 外部状态变化，或预算耗尽且已披露覆盖缺口时停止；不要把预算耗尽伪装成全面完成。

### Reviewer 与 Token 预算

独立 reviewer 是高成本资源，不与 worker 1:1 配对。对同一 Artifact 默认只允许一次 primary review；
第二次必须由 `undecidable`、证据冲突或协议歧义触发，使用不同 lens 且可能改变处置。smoke 未通过、
同 lens 重复、输入超出预算或已有 `blocked_safety` 时不派。考虑任何 critic/reviewer 时必须读取
[Reviewer 数量与 Token 预算](references/review-budget.md)，冻结 `extensions.review_policy`，并在派发前运行
`scripts/review-budget.mjs evaluate`。提高 reviewer 数量或输入上限属于 re-contract。

最终答复前用 `闭环项 / 标准 / 证据 / 结果` 审计：闭环对象与外部状态已重查；必要节点已验收且活跃
子 Agent 为 0；自建资源已回收；外部资源列 `KEEP + owner + 原因`；剩余事项明确归类。需要新授权或
外部状态变化时只能报告“已完成可自主部分，整体未闭环”，并给出唯一解阻动作。

## 8. 本地 tier 与 Controller 动态路由

最强适配模型持续担任 Controller，掌握目标解释、任务图、re-plan、失败分类、动态重路由和最终验收。
Worker 只执行被分配节点，不自选模型或下一次配置。涉及派发配置、首次建立 host tier、验收失败后的
动态调整或模型切换时，完整读取 [本地模型路由与动态调整](references/model-routing-config.md)；按任务类型
选档时再读 [任务类型剧本](references/task-playbooks.md)。核心不变量只有三条：选择本地配置中最低可靠
tier；具体 model/effort 只来自用户配置与实时 schema；每次派发保存精确配置、attempt lineage、理由与
token budget。超出已授权 envelope、宿主候选不可验证或显著增加成本时先确认，不按失败次数机械升档。

## 9. 宿主自适配与配置加载

本 Skill 不内置宿主静态能力，`agents/openai.yaml` 也不是能力证明。节点有 runtime/path/tool 要求时先
做第 2 节有效能力预检；需要创建、刷新、复用或记录宿主能力快照时，完整读取
[宿主能力缓存协议](references/host-capability-cache.md)。实时 schema 永远优先，unknown 不能由缓存补成
allowed，缓存不能扩大授权。轻量档只记录当轮事实；完整档把 fingerprint、来源与复核结果写入台账。
host 模型配置与能力快照职责分离，写权限不足时继续用实时事实并如实标记 write-blocked。

运行时版本、协议版本与精确内容身份是三条不同轴：`orchestration-ledger.mjs capabilities` 输出
`protocol_version`、`runtime_version` 与 `content_digest`。协议版本只在兼容语义变化时更新，runtime
版本标识脚本实现，content digest 精确标识当前安装树；不得用 frontmatter、mtime 或 runtime 版本
替代内容摘要。
