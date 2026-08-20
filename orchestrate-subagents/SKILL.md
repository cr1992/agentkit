---
name: orchestrate-subagents
description: "编排子 Agent：决定任务拆分、角色、并发、派发契约、模型、权限、运行控制和最终验收。仅当用户明确要求子 Agent、多 Agent、并行或委派，或者当前任务已经确定需要实际派生至少一个子 Agent 时使用。普通 Workflow、单 Agent 闭环、单点查询、单文档审查、小型修改，以及固定单一 Artifact、单个只读 reviewer 的一次性独立验收不适用；后者应直接使用 verify-agent-output。"
---

# orchestrate-subagents：子 Agent 编排控制协议

提供“是否编排、如何拆解、怎样派发、如何控制、何时验收”的宿主无关协议，不含领域知识。最强适配模型运行当前会话并持续担任 controller，掌握 `Plan → Delegate → Observe → Re-plan → Verify → Finish`；不要派生另一个 agent 接管控制面或下放全局完成判断。

## 组合协议

本 skill 是组合栈的控制面。先建立任务图，再按已确认的事实启用专项能力：

| 条件 | 动作 |
|---|---|
| 固定单一 Artifact、单个只读 reviewer、只验一次 | 不启动本 skill；直接使用 `verify-agent-output`，由当前 controller 消费 Evidence |
| reviewer 是多节点任务图的一部分，或需要并发、不同权限、多个 critic | 本 skill 建任务图；节点的一次性 Evidence 可由 `verify-agent-output` 提供 |
| 用户明确要求实现者与验收者反复收敛 | `run-agent-verify-loop` 可用时用它执行有界循环；Loop 内的一次性验证只作为 provider 调用，不再创建第二个全局 orchestrator |
| 已确认同仓存在多个并行写入者、写路径碰撞，或写入归属不明且相交 / 丢失代价高，或用户明确要求 worktree | `manage-worktrees` 可用时用它建立和维护隔离；不可用时执行第 3 节安全下限 |
| 只有一个写入者，其他 Agent 只读 | 共享树，不使用 `manage-worktrees` |
| 普通批量、仓库 dirty、理论上可能并发 | 不足以启用其他专项 skill |

controller 只维护一份公共任务契约和一份运行台账。`verify-agent-output` 只返回一次性 Evidence；
`run-agent-verify-loop` 只维护循环状态；`manage-worktrees` 只回填隔离与 Artifact 身份。专项 skill
不得重建任务图、改变授权或夺取最终完成判断。

## 控制面不变量与派发台账

controller 亲自完成：

- 解释用户目标，先声明本轮**闭环对象**（如“形成 MR”“合入主干”“完成部署”），并定义全局完成标准与非目标；不得把“MR 已创建”冒充“已合入”，也不得在闭环对象尚未达成时只写“完成”。
- 设计任务依赖、并发、barrier、文件 / 资源 owner。
- 为修复 / 设计类节点定方向前，先查裁决真源（缺陷登记表、决策记录、计划文档）有无同类先例；有先例沿先例，偏离必须写明理由并交用户裁决。
- 为每个节点选择角色、执行配置（精确模型、reasoning effort、选择理由、预算、重试上限）、权限、隔离方式和停止条件。
- 根据证据追问、改派、升级模型、修订计划或提前停止。
- 验证关键证据、串行集成写入、处理冲突、回收环境，并对最终结果负责。

把搜索、盘点、格式整理和同构修改交给 worker，只回收结构化结论与证据；高风险方案执行前可加独立 critic 尝试证伪，但最终裁决仍归 controller。

实际派生过 worker 的运行必须维护两张 Agent 台账；有并行 worker 时还须维护工作进展表。三张表在派发后、批次收口、用户询问进度和最终答复时更新，不用散文代替：

- **活跃 Agent**：`编号 / 任务 / 执行配置（本地 tier / model / effort / attempt / 配置状态 / 选择理由）/ 目标仓 / 隔离位置（共享树或 worktree + 分支）/ 可写范围 / 状态 / 检查点或阻塞原因`。`tier` 写本地配置中的实际名称；`model` 写宿主调用使用的精确 ID，继承主会话时写 `inherited`，宿主未暴露 ID 时写 `host-default（ID 未暴露）`。`effort` 写精确值；继承或宿主不支持时分别写 `inherited` / `unsupported`，不得省略。状态只用 `运行中 / 阻塞 / 待验收`，按 `阻塞 → 待验收 → 运行中` 排序；不用虚构百分比，优先写 `8/12 文件`、`3/5 测试` 等可观察检查点。最终答复没有活跃 worker 时仍写 `当前活跃子 Agent：0`。
- **本批已完成**：验收后立即从活跃表移入，保留原编号，记录 `编号 / 任务 / 执行配置（model / effort）/ 结果（通过 / 未通过 / 取消）/ 稳定交付物 / 关键证据 / 环境收尾`。日常可只显示最近几项，批次收口展示完整表。
- **工作进展**：`工作项 / owner / 产出或范围 / 状态 / 稳定交付物 / 验收证据 / 收尾`。状态写 `待执行 / 进行中 / 已完成 / 已阻塞 / 已取消`；每行必须能对上任务图节点或 controller 自己的集成工作，不能只汇报 worker 而漏掉 controller 的提交、发布、合并与回收工作。

worker 状态包是 controller 的验收输入，不是面向用户的业务交付。代码、包、文档或部署节点标记
`已完成` 时必须给出可复核的稳定交付物：如 commit SHA + MR/PR 链接、tag/version + peeled SHA +
pipeline/制品链接，或稳定报告路径。只读审计可以状态包 + 证据指针收口，但不得冒充实现交付；没有
稳定交付物的实现节点继续记 `进行中` 或 `已阻塞`。`MR 已创建`、`已合入`、`包已发布`、`consumer
已升级` 是不同状态，必须查询外部现状后分别报告。

台账同时是回收清单：会话结束前确认没有孤儿 worker、孤儿 worktree 或遗留运行时资源；端口、数据库等只在确实使用时作为环境备注。若用户明确要求表格汇报，即使没有派生 worker，也用“工作进展”表呈现 controller 工作。

台账活在对话里，但每次更新时点须把任务图与三张表同步到仓库外的会话临时位置。完整档写入
mechanical ledger；轻量档写单一 JSON 快照。controller 失效后它是接手协议（见第 6 节）的台账输入，
闭环审计通过后随本轮临时资源一并清理，不进项目仓。

### 档位无关的有效能力预检

先为每个节点列出它实际需要的 `required_capabilities`，再选轻量档或完整档。工具 schema 只能证明
派发接口和参数，不能证明 worker 能执行命令、读取哪些路径或完成审批往返；这类运行时能力必须由
当轮事实、与当前宿主接口指纹及 worker 配置绑定的新鲜 Effective Worker Capability，或最小范围探针
证明。使用 `scripts/worker-capability-preflight.mjs check` 机械判断；只有 `allowed` 能满足需求，未知、
缺失、过期或 binding 不匹配都不能当作可用。

不固定为每次运行派一个探针。节点没有运行时工具 / 路径需求、输入已完整随契约提供时，
`required_capabilities` 可以为空；否则先复用当前 session 或配置摘要绑定的有效记录，仅在缺少必要事实且
探针成本低于 controller 自做或缩小节点范围时探测。探针本身是实际 worker，计入 worker 总数、预算和
台账。无法证明时缩小节点、留给 controller，或停止；升级为完整档只增加控制与恢复能力，不会扩大
worker 权限。

### 显式轻量档

同时满足以下条件时使用 `orchestration_mode: lightweight`，无需完整 capability cache、模型路由解析器或
`orchestration-ledger.mjs`：

- 总 worker 数不超过 3，全部只读且互相独立；
- 单 stage，无 barrier、Loop、递归派生、批级熔断或自动重试；
- 不创建 worktree，不拥有端口、数据库、凭证或其他待回收资源；
- 不执行发布、部署、发消息、写外部系统等副作用；
- controller 能在当前上下文内直接验收全部输出。
- 每个节点要求的有效 worker 能力均已由本轮事实或新鲜、binding 匹配的记录证明。

轻量档仍保留每个节点的 `objective / scope / inputs（事实与假设分栏）/ output_contract /
acceptance / evidence / stop_conditions`，并把以下单一快照写到仓库外：

```json
{
  "schema_version": 1,
  "protocol_version": "1.1.0",
  "mode": "lightweight",
  "contract_digest": "sha256:...",
  "nodes": [{"node_id":"s1","worker_id":"opaque","state":"running","required_capabilities":[],"effective_capability_ref":null,"attempt_id":"opaque","attempt":1,"previous_attempt_id":null,"tier":"host-default","model":"host-default","reasoning_effort":"unsupported","adjustment_action":"initial","failure_kind":null,"failure_ref":null,"configuration_state":"host-default","model_resolution_state":"host-default-unexposed","dispatch_provenance":"host-default","selection_reason":"输入随契约提供，不需要运行时工具能力；宿主未暴露精确派发参数","checkpoint":null}],
  "updated_at": "RFC3339"
}
```

快照只记录当前事实，不伪造 journal 或 hash chain。任一资格失效时，停止新增派发，将现有状态和产物
收养进完整 ledger 后再继续；不得继续轻量档并登记“偏离”。

轻量运行发现合同、路由、验收或 Skill 缺口时，用 `scripts/orchestration-reflection.mjs record`
把 Reflection 直接绑定到仓库外快照、worker 输出或诊断文件；需要提案时再用 `propose`。这条路径
不依赖 ledger journal，仍校验证据摘要、只追加并保持 Proposal 为 `proposed`。只有宿主能力事实才写
`observations/<host>/`；通用 `skill_gap / routing_gap / verification_gap` 不得污染能力缓存。

### 完整档机械台账工具

不满足轻量档时使用 `orchestration_mode: full`。先用 `contract-tool.mjs normalize / validate / digest / review-view / diff` 固定公共 Task Contract；
再以仓库外 state root 初始化 `orchestration-ledger.mjs`。脚本不直接派发 Agent，controller 把宿主
派发回执写入 `dispatch-record`：

```text
capabilities
init --contract <json> --state-root <dir>
add-node / add-edge / dispatch-record / update / attach
batch-init / batch-record / batch-status / batch-fuse
record-reflection / propose-improvement
status / inspect / rebuild / doctor
```

所有修改命令支持 `--expected-revision`。新节点必须显式选择 `worker_self_check`、
`controller_recheck` 或 `independent_evidence` 验收档位；ledger 按档位机械检查稳定产物、
Controller Recheck Record 或标准 Evidence，并把实际保证等级写入节点后才能进入 `passed`。依赖和
barrier 未通过时不能派发下游。批量任务由 orchestrator 为每个 work item 建立独立 Loop，并在 batch
ledger 按稳定 failure key 做连续同因熔断；Loop 本身不维护批队列。
完整命令和边界见 [编排运行时](references/orchestration-runtime.md)。

Reflection 只记录合同、路由、并行、资源或批级异常的证据化观察；完整档由 ledger 登记，轻量档由
独立 reflection 工具追加。Improvement Proposal 永远是 `proposed`，当前执行面不读取它，也不自动
改变模型路由、授权或验收规则。

### 台账信任边界

orchestration state root 只应由 controller/operator 与 ledger runtime 写入。journal digest chain
用于发现部分、追加、乱序和意外损坏并支持恢复，不是数字签名或外部不可变审计日志；拥有完整写权限
的进程可重写整条自洽历史。跨 run/Loop 的 Artifact safety、Evidence 和失败记忆只有在该受信 writer
边界内才是持久台账，不得把本地 hash chain 描述成对恶意 state-root writer 的保证。

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

仓库 dirty、任务大或包含新文件本身都不是充分条件；先确认是否存在第二个写入者、归属冲突或目标路径相交。命中任一隔离行即选择 worktree；只有未命中任何隔离条件时，共享树行才成立。裁决隔离后才使用 `manage-worktrees`，复用其扫描、建树、合回和回收等机械流程；它不改变任务图、权限或验收。该 skill 不可用时不阻塞，执行下面的内置安全下限。

共享树中 worker 不得切换分支，只按路径 stage / commit；禁止 `git add -A`、`git commit -am`、裸 `stash`、`reset --hard`、`checkout -- .` 和并发 merge，controller 是唯一 integrator。

没有专项能力时遵守五条 worktree 红线：

- **建树**：controller 先 fetch，再基于 `origin/<主干>` 在仓库外的会话临时位置创建 durable worktree 和独立分支；已有目录 / 分支先判定并复用，禁 `rm -rf` 重建；宿主临时树语义不明时不用它。
- **worker 边界**：契约写死目标仓、workdir、分支和可写路径；worker 只在指定树提交，不换目录，不 merge / stash / push / 建 MR；环境异常立即报 `blocked`（阻塞）。
- **隔离边界**：worktree 只隔离工作目录和 index，不隔离 refs、端口、进程、数据库或外部服务；共享资源按需分配并记账。
- **验收集成**：controller 先在 worker 树内复跑门禁，再在已确认 checkout 主干的集成树中串行合回并重验；重验使用合并基线到 `HEAD` 的 diff range（如 `origin/<主干>...HEAD`），不得依赖 merge 后为空的 staged；merge clean 不代表语义兼容，push / MR 仍受用户授权约束。
- **回收**：唯一判据是台账能同时对上任务、worktree 路径和分支，树干净（含 untracked），成果已验收合入，且仓库无 stash；四项全过才 `git worktree remove`（禁 `--force`）并清理已合并分支，否则 `KEEP + 原因`。

## 4. 选择编排方式

- 2-3 个独立任务用宿主轻量并行；循环、条件、逐项管线或预算驱动才使用结构化编排。
- 多 stage 默认逐条 pipeline；只有跨条去重、聚合、比较或早退才设 barrier。
- 高风险 finding 用不同 lens 的证伪 critic；解空间宽才使用 judge 面板。
- 未知规模使用 loop-until-dry，对累计已见集合去重，必要时末尾加 completeness critic；截断、采样或不重试必须披露覆盖缺口。

具体原语和 API 服从宿主编排工具说明。

## 5. 派发可验收的任务契约

按“可独立验收的责任”拆分，不按宽泛话题拆分：

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
  repository: 主仓绝对路径（git 元数据归属）
  isolation: shared_tree | worktree
  workdir: worker 工作目录绝对路径；shared_tree 时等同 repository，worktree 时为隔离树路径
  branch: controller 已确认的分支；worker 禁止切换
  runtime: 按需填写共享资源，不用则省略
dependencies: 前置节点与下游消费者
required_capabilities: 该节点真正需要的 worker.* 运行时能力；没有则 []
verification:
  requirement: worker_self_check | controller_recheck | independent_evidence
  provider: none | verify-agent-output
  artifact_scope: node_output | integration_candidate | not_applicable
extensions:
  verification:
    provider: none | verify-agent-output | run-agent-verify-loop
  worktree:
    provider: none | manage-worktrees
execution:
  orchestration_mode: lightweight | full
  attempt_id: 本次派发的不透明唯一 ID
  attempt: 从 1 开始，不能超过本地 max_attempts
  previous_attempt_id: 首次为 null；重派时绑定直接前序 attempt
  tier: 本地 host 配置中的实际 tier 名称 | host-default
  model: 宿主调用使用的精确模型 ID | inherited | host-default
  reasoning_effort: 宿主调用使用的精确值 | inherited | unsupported
  adjustment_action: initial | retry_same | raise_effort | switch_model | promote_tier | fresh_context | change_strategy
  failure_kind: 首次为 null；重派时为 implementation_defect | reasoning_gap | context_gap | strategy_gap
  failure_ref: 首次为 null；重派时绑定前序稳定失败证据摘要
  selection_reason: 该 model + effort 与节点决策杠杆、上下文和工具需求的匹配理由
  config_source: [session | user-host:<path> | host-default]
  configuration_state: user-explicit | session-inferred | session-confirmed | persisted-config | host-default
  model_resolution_state: discovered-and-validated | user-explicit-unverifiable | host-default-unexposed
  capability_source: live-schema | live-schema+effective:<ref> | cache:<path>+live-validation
  capability_fingerprint: 当前宿主能力描述的 sha256
  effective_capability_ref: 与当前 host / worker tier / 接口指纹 / session 或配置 binding 匹配的记录；无需运行时能力时为 null
  capability_cache_status: fresh | refreshed | absent-write-blocked | stale-write-blocked | not-required-lightweight
  dispatch_provenance: explicit | inherited-controller | host-default
  token_budget: 明确预算；宿主未提供该能力时写 unsupported
  max_attempts: 本地动态调整 envelope 的最大尝试数，包含首次派发
stop_conditions: 阻塞、中止和预算退出条件
```

不得省略 `objective / scope / output_contract / acceptance / evidence / verification`；写任务还必须有 `permissions / writable_paths / environment`。`independent_evidence` 只能选择 `verify-agent-output`，且公共 Task Contract 的 `extensions.verification.provider` 和 `skill_set` 必须在 freeze 前同时声明它；普通 worker 不因“以后也许要 review”而一律升级，通常只把最终冻结的高风险集成候选设为该档。修复 / 还原类节点的 `acceptance` 必须写裁决真源推导的预期值（设计稿几何、协议字段、计划口径），不得把上游 review 的处方或修复手段本身当验收标准——处方进契约前先过第 7 节的处方核验。`exclude` 禁止未申报行动，不禁止思考或带理由上报越界方案；外部可变状态在动作前重查现值。

`inputs` 分栏是硬边界：写进「已知事实」的每一条必须是 controller 亲自核实且能给出证据指路的；单一来源解析、模式匹配、凭记忆的值一律写进「允许假设」并标注「worker 使用前必须验证」。worker 发现契约事实与现场矛盾时按第 6 节升级路径回报，不得替 controller 圆场。

要求 worker 返回紧凑状态包：

```yaml
status: completed | partial | blocked
conclusion: 核心结论
evidence: 可核验证据
changes: 实际变更
risks: 未解决风险
next_action: 建议后续动作
```

## 6. 控制运行态与升级

用户可见台账只用三态：执行中为 `运行中`；worker 报 `blocked`、等待输入或外部条件统一记为 `阻塞` 并写清原因；worker 返回 `completed` 后为 `待验收`。`partial` 由 controller 决定继续运行、带明确卡点转为阻塞，或停止重试后判 `未通过`，不新增状态。只有 controller 能给出 `通过 / 未通过 / 取消` 并归档。

事件驱动监控，只在结论交付、需要输入、scope / 写入冲突、预算将尽、新依赖、失败或置信度不足时介入。“等待中”不是状态包；要求 worker 交完整结果或报 blocked + 卡点。

运行失败先归一为 `allowed / denied_by_policy / unavailable_or_unproven / approval_channel_fault /
execution_fault`，具体错误串只作证据，不作为长期判据。`denied_by_policy` 是已知拒绝，不能记成
unknown 后继续派需要该能力的节点；应缩小范围或交 controller。`approval_channel_fault` 表示授权
往返环境故障，停止同类派发并升级给人；`execution_fault` 停止同类派发并先诊断环境。禁止让 worker
在能力故障后自行扩大 scope、拿替代样本冒充目标对象或绕过停止条件。

业务验收失败与能力故障分开处理。Controller 先把验收失败归一为
`implementation_defect / reasoning_gap / context_gap / strategy_gap / environment_fault / contract_gap /
safety / undecidable`，再决定是否重派。前四类可在本地配置 envelope 内选择 `retry_same / raise_effort /
switch_model / promote_tier / fresh_context / change_strategy`；后四类分别要求诊断环境、re-contract、
停止或升级，不得用更强模型掩盖。不要按失败次数机械加码，也不要让 worker 自己决定下一次模型。

每次实际重派都是新的 attempt 和新的 ledger 节点：前序节点先绑定稳定失败 report / Evidence 并进入
`failed`，新节点的 dispatch 必须绑定直接前序 `attempt_id`、连续序号、`failure_kind`、`failure_ref` 与
新选择理由。完整档由 ledger 校验 lineage；轻量档把同样字段追加到快照。达到本地 `max_attempts`、
连续同因熔断或需要超出本地模型/effort envelope 时停止并交回用户。详细配置与动作语义见
[本地模型路由与动态调整](references/model-routing-config.md)。

宿主把 worker 标为 `interrupted` 时，controller 先向原 worker 下发**只读状态恢复**：只回报原任务、
进度、产物、改动和中断原因，不继续业务写入；恢复包按第 7 节验收，有产物则收养，无产物或无法
恢复才判 `取消 / 未通过`。执行配置的权威证据是 controller 保存的宿主调用参数与回执，worker
不承担运行模型自省责任，不得仅因宿主没有自省接口而中止。

遇到契约失真、新授权、不可逆动作、资源 / 结论冲突、重试耗尽或改变全局方案的新事实时，worker 必须升级回 controller，不得自行扩 scope。默认禁止递归派生；只有 controller 明确授权目标、预算和最大深度时才允许，通常不超过两层。

**controller 失效与接手**：前任 controller 中断、台账随对话丢失时，接手不是恢复前任状态，而是重建 → 收养 → 重派：

- 继任 controller 从台账快照、资源归属登记和宿主留痕（编排 journal、worker 转写、产物路径）重建任务图与节点状态；来源互相印证，冲突时以可观察证据为准。
- 有产物的节点按第 7 节正常验收后收养；不采信前任台账中的 `待验收 / 通过` 记录，对不上任何登记或快照的资源维持 `KEEP + 原因`。
- 无产物或验收不过的节点视为从未派发，按现行契约重派；前任运行中的 worker 与未提交改动默认已丢失，不得假设其完成。
- 收养的 worktree、分支和运行时资源纳入本轮台账与回收清单，回收仍按第 3 节红线执行。

## 7. 验证、收敛与停止

回收后依次 `normalize → deduplicate → validate → synthesize`。研究要求直达来源，代码要求文件 / 符号证据，实现要求 diff 与约定测试；关键 claim 由 controller 用外部可观察证据重验，不采信 worker 自述。

完整档不得把三种保证混写：`worker_self_check` 只证明 worker 交付了稳定输出；`controller_recheck`
还必须附一份 `report_type: controller_recheck` 的记录，覆盖当时全部稳定输出 attachment digest；
`independent_evidence` 必须先附唯一 Artifact Ref，再附与公共合同及该 Artifact 绑定的标准 Evidence
Package。后两档执行 `update --state passed` 时必须用 `verification_ref` 指向被采信的 report / Evidence
attachment digest；失败、`undecidable`、`blocked_safety`、仍需 human gate 或错绑的 Evidence 均不能通过。
`status` 与最终汇总只能使用 ledger 返回的 `verification_assurance`，不得按叙述自行升级等级。
Evidence 的合同绑定缺省按**全等**校验（验证合同就是公共合同本身）；多节点图里需要节点级、产物
专属的验证合同时，用 `contract-tool.mjs project` 从公共合同切出条目子集，`attach --type contract`
登记后 Evidence 可绑定该投影合同摘要。投影只能收窄验收面：除 `contract_id`、`acceptance` 子集与
`extensions.projection` 外，其余字段必须与公共合同逐字段全等，改写任何一个（`objective`、`scope`、
`permissions`、`environment`、`skill_set`、`stop_conditions`、其他 `extensions` 键）都会被 ledger
指名拒收。用法与保证边界见
[编排运行时](references/orchestration-runtime.md)「合同投影」段。

聚合状态可能掩蔽条目失败，验收必须下钻到最小可观察单元。critic 必须主动寻找反例：多数判假可作为淘汰信号，多数判真仍不是接受证明。**处方核验**：finding 的事实核验不等于处方核验——采信任何「要求改变现状」的 finding 前，controller 先从裁决真源独立推导预期态，推不出或与处方矛盾时处方不进契约、升级人裁；finding 自己的证据已解释掉大部分偏差而结论未降级的，按证伪信号处理。验收比对对象永远是真源，不是修复目标、MR 描述或契约里转抄的处方。完成但缺少 acceptance 证据时，worker 状态保持 `partial`；停止重试后只有 controller 可判 `未通过`。

必要节点全部验收通过、连续 K 轮无新增、剩余工作不会改变决策、需要新授权 / 外部状态变化，或预算耗尽且已披露覆盖缺口时停止；不要把预算耗尽伪装成全面完成。

最终答复前必须做一次闭环审计，并用表格展示 `闭环项 / 标准 / 证据 / 结果`：

1. 闭环对象已达成；若只达成其中一段，明确写“未闭环”及缺失外部动作。
2. 必要节点均已由 controller 验收，活跃子 Agent 为 0；外部拥有的长期 Agent 只能写 `KEEP + owner + 原因`，不能算本轮活跃项。
3. 本轮自建 worktree、分支、进程和临时资源已回收；外部或归属不明的资源写 `KEEP + 原因`，不得擅自删除。
4. 提交、push、MR / PR、合并、部署等属于闭环对象的外部状态已重新查询，不以本地推断代替。
5. 剩余事项已归类为 `已完成 / 需要新授权而阻塞 / 超出本轮范围`，不能藏在“后续建议”里。

只有上述审计与声明的闭环对象一致时才使用“已闭环”。若需要用户授权、评审或外部状态变化才能继续，当前轮应报告“已完成可自主部分，整体未闭环”，给出唯一明确的解阻动作。

## 8. 本地 tier 与 Controller 动态路由

最强适配模型持续担任 Controller，掌握目标解释、任务图、re-plan、失败分类、动态重路由和最终验收。
Worker 只执行被分配的节点，不自选下一次模型。Controller 按推理深度、需求模糊度、爆炸半径和
上下文集成度选择**本地配置中最低可靠的 tier**；若错误容易由测试、Lint 或格式校验发现，可以用
较低 tier，难察觉且易扩散则使用较高 tier或独立验收。常见节点模式见
[任务类型剧本](references/task-playbooks.md)。

Skill 不规定 tier 数量、名称和具体模型，也不再提供 `economy / balanced / quality` 预算模式或
role→profile→alias 多层路由。用户在单一 `hosts/<host>.json` 中定义 tier 顺序、模型候选和每个 tier
允许的 effort 范围；较便宜的模型也可以使用较高 effort。具体模型 ID、effort 枚举、通道、价格和
上下文能力只来自本地配置与当前宿主实时 schema，文档值均为非规范性占位示例。

本地配置不存在时，Controller 根据实时 schema 提出紧凑候选映射和目标路径，获得用户确认后再保存；
不得凭记忆写型号。已有合法配置就是用户授权的动态调整 envelope：在候选模型、effort 范围、动作
集合和 `max_attempts` 内可自主调整；增加模型、提高上限、延长尝试数或显著增加成本时先确认。

每次派发都落成精确 `tier / model / reasoning_effort / attempt / adjustment_action / selection_reason /
configuration_state / model_resolution_state / token_budget / max_attempts`。验收失败后先按第 6 节分类，
再由 Controller 选择保持配置、提高 effort、切模型、提升 tier、换干净上下文或改变策略；不采用
“第 N 次必升档”的固定规则。用 `resolve_model_policy.mjs` 验证本地 envelope、宿主实时候选、前序
attempt 与失败摘要，完整说明见 [本地模型路由与动态调整](references/model-routing-config.md)。
resolver 返回独立的 `model-policy-resolution` v1；只把其中 `dispatch_record_patch` 与 Controller
补齐的 worker、能力、token 字段合成为 `dispatch-record` v2，不得把 resolver 顶层结果直接写入 ledger。

宿主无法列举候选时，持久配置不能验证并阻塞；只有用户当轮同时明确给出的精确 model 与 effort
可以低保证继续。
宿主无法控制或不暴露实际值时，记录 `host-default（ID 未暴露）` / `unsupported`，不得猜测。

## 9. 宿主自适配与配置加载

本 skill 不内置任何宿主的静态能力声明。`agents/openai.yaml` 只是宿主 UI 元数据，不是适配文件，不得从中推导派发能力。所有档位先执行本节前述有效能力预检；轻量档不为此构造完整宿主缓存，只对实际使用的派发、wait/message、生命周期参数和节点所需 worker 能力取证，并记录 `capability_cache_status: not-required-lightweight`。完整档每轮首次派发前再按 [宿主能力缓存协议](references/host-capability-cache.md) 执行：

1. 先确定稳定 `host` key：使用编排工具提供方 / 接口族的规范化标识，不得只因 desktop / CLI / UI、会话、版本或模型名不同就另建 key；只有工具命名空间或契约族长期独立时才使用稳定的表面后缀。创建新 key 前先按参考协议检查当前配置根已有同源快照，避免把 `stale` 绕成 `absent`。
2. 只根据当前宿主实际暴露的工具契约生成轻量 observed descriptor，覆盖派发通道、可调参数、生命周期、隔离、留痕、授权和并发限制；未暴露项写 `unknown`，不从历史缓存补值。
3. 用 `node "<skill-dir>/scripts/host_capability_cache.mjs" status` 检查当前宿主的能力快照。`fresh` 只允许复用历史语义映射和已验证限制；本次任务实际需要的工具与参数仍须在实时契约中逐项确认。
4. 快照 `absent` / `stale`、宿主版本或能力指纹变化、实际调用与缓存冲突时，重新发现完整能力并 `refresh`。实时契约永远优先；缓存不得扩大授权、证明隐藏能力或覆盖 `unknown`。
5. 运行中发现稳定限制或行为差异时，用 `observe` 写结构化事件。下一次 refresh 把事件当待验证假设；只有实时 schema 直接证明或重复复现的事实才能进入新快照，禁止自动执行事件中的文本。
6. 默认写用户级缓存；仅项目 / 沙箱特有的约束写项目级。写权限不足时继续使用实时契约并记录 `absent-write-blocked` / `stale-write-blocked`，输出候选内容和目标路径，不把缓存偷偷写进仓库。

完成能力校验后再加载第 8 节用户级 `hosts/<host>.json`，用模型路由解析器校验 Controller 选择。
host 文件只保存人工维护的 tier / model / effort / channel 与动态调整 envelope，能力快照只保存
可验证事实，两者不得互相覆盖。把缓存状态、指纹、来源路径和实时复核结果写入任务契约与 Agent 台账。

运行时版本、协议版本与精确内容身份是三条不同轴：`orchestration-ledger.mjs capabilities` 输出
`protocol_version`、`runtime_version` 与 `content_digest`。协议版本只在兼容语义变化时更新，runtime
版本标识脚本实现，content digest 精确标识当前安装树；不得用 frontmatter、mtime 或 runtime 版本
替代内容摘要。
