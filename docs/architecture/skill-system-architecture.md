# Agent Skills 协作架构设计

> 状态：提案（Proposed）
>
> 范围：`orchestrate-subagents`、`manage-worktrees`、
> `verify-agent-output` 与 `run-agent-verify-loop`
>
> 核心目标：每个 Skill 可以独立安装、独立使用；组合使用时通过稳定契约产生能力联动，
> 但不互相侵入内部状态，也不把另一个 Skill 变成隐式硬依赖。

## 目录

- [1. 背景与核心判断](#1-背景与核心判断)
- [2. 目标与非目标](#2-目标与非目标)
- [3. 总体设计原则](#3-总体设计原则)
- [4. 四个 Skill 的职责边界](#4-四个-skill-的职责边界)
- [5. 每个 Skill 如何独立使用](#5-每个-skill-如何独立使用)
- [6. 组合使用时如何联动](#6-组合使用时如何联动)
- [7. 跨 Skill 数据契约](#7-跨-skill-数据契约)
- [8. 脚本化运行时设计](#8-脚本化运行时设计)
- [9. 验证、证据与安全内核](#9-验证证据与安全内核)
- [10. 典型工作流](#10-典型工作流)
- [11. 独立模式与组合模式的保证等级](#11-独立模式与组合模式的保证等级)
- [12. 版本、兼容与安装](#12-版本兼容与安装)
- [13. 测试策略](#13-测试策略)
- [14. 分阶段落地计划](#14-分阶段落地计划)
- [15. 反思、沉淀与受控改进](#15-反思沉淀与受控改进)
- [16. 暂不纳入 v1 的学习与进化平台](#16-暂不纳入-v1-的学习与进化平台)
- [17. 已确定的设计决策与待定 ADR](#17-已确定的设计决策与待定-adr)

## 1. 背景与核心判断

这个仓库中的能力不应该只是几份提示词协议。纯文档 Skill 可以告诉 Agent “应该怎样做”，
但很难可靠保证以下事情真的发生：

- 任务契约已经冻结，后续没有被偷偷改写；
- reviewer 与确定性检查针对的是同一个 Git commit；
- 两个 controller 没有同时推进同一份状态；
- 重试次数、熔断条件和人工门没有被绕过；
- Evidence 没有被覆盖，日志没有串到另一轮；
- worktree、分支、owner 和回收对象确实一一对应；
- 中断后恢复的是机器状态，而不是 Agent 根据聊天记录猜状态。

因此本架构采用明确分层：

> `SKILL.md` 负责触发条件、决策规则、角色边界和宿主编排；`scripts/` 负责状态、
> Git 身份、确定性执行、证据、锁、恢复和机械不变量。

四个 Skill 不是一套必须整体安装的“框架”。它们是四个可独立使用的能力模块：

1. `orchestrate-subagents`：控制面，决定是否拆分、派谁、何时收敛。
2. `manage-worktrees`：Git 隔离与产物身份面，管理并发写入和生命周期。
3. `verify-agent-output`：一次性独立验收面，对冻结产物做一次完整验证。
4. `run-agent-verify-loop`：显式循环收敛面，在实现与独立验收之间做有界迭代。

单独安装时，每个 Skill 使用自己的脚本和宿主能力完成本职工作；同时安装时，它们通过
版本化 JSON 契约和 CLI 输出联动，不通过跨目录 import、共享可变文件或隐藏调用耦合。

当用户明确要求反复修复与独立验收，或显式调用
`/run-agent-verify-loop + 目标` 时，controller 才选择 Loop 模式，并按第 5.5 节完成启动前置。
Loop 可以消费前三个 Skill 的能力，但它不是普通任务或一次性验收的默认入口，也不负责全局路由、
provider 选择和最终授权。

## 2. 目标与非目标

### 2.1 目标

1. 四个 Skill 均可独立安装、发现、触发和完成各自声明的任务。
2. 组合安装只增强能力，不改变单个 Skill 原有语义。
3. 能机械执行的规则尽量下沉到脚本，不依赖 Agent “记得遵守”。
4. 所有组合通过稳定数据契约连接，调用方可验证版本、来源和完整性。
5. Git 场景下把产物绑定到完整 commit object，而不是可移动的分支名。
6. 一次性验证与循环验证分开：失败一次不自动获得修改或反复重试权限。
7. 状态、证据和失败历史可恢复、可检查、可追溯。
8. 安全规则不参与加权投票，不能用其他分数抵消。
9. 保持宿主无关：Skill 不绑定某一家 Agent API；宿主适配留在编排边界。
10. 让 Agent 用证据反思 Skill、沉淀收敛经验并提出改进候选，但禁止任务内自我修改。

### 2.2 非目标

v1 不实现：

- 跨任务训练、Git 历史模型训练或 prompt 自动进化；
- Case / Rules / Wiki 检索平台；
- 自动修改 Skill 自身或安全策略；
- 通用工作流引擎；
- 非 Git 产物身份；
- runtime 内建的多 reviewer 复杂投票系统；高风险任务仍可由 orchestrator 发起多个彼此独立的
  verification run，但不做“多数通过即可接受”的加权裁决；
- Loop 自己维护批队列；
- 自动执行未获授权的 push、合并、发布、部署或删除；
- 让脚本替代 L1 语义判断；
- 让任意 Skill 自动安装另一个 Skill。

现行协议中的“高风险可开 N 个 verifier”迁移为 orchestrator 能力：每个 reviewer 必须形成独立
review run / Evidence，controller 按安全内核逐项裁决；verification runtime 和 Loop 不内建票决。
落地 v1 时须同步更新现有 protocol，不能保留“多数通过即可接受”的悬空承诺。

## 3. 总体设计原则

### 3.1 独立优先，组合增强

每个 Skill 必须定义：

- 自己的最小输入；
- 自己能单独交付的输出；
- 自己的脚本入口；
- 没有其他 Skill 时的适配方式；
- 组合能力可用时的增强路径；
- 无法提供的保证和必须披露的限制。

组合能力缺失不能让 Skill 假装成功，也不能让 Skill 完全不可用。正确做法是选择明确的
独立模式，并在输出中记录保证等级。

### 3.2 通过契约联动，不通过内部实现联动

禁止以下耦合：

- 从一个 Skill 的脚本直接 import 另一个 Skill 的内部模块；
- 假设兄弟目录存在；
- 多个 Skill 同时写同一份未加锁状态文件；
- 通过解析另一个 Skill 的人类可读终端文本获得关键状态；
- 用分支名、聊天消息或 Agent 自述代替稳定产物身份。

允许的联动方式：

- JSON stdin/stdout；
- 显式指定的状态文件或 Evidence 文件；
- 完整 Git object ID；
- 版本化 schema；
- CLI `capabilities --json` 的能力发现；
- 调用方显式选择 provider。

### 3.3 文档负责策略，脚本负责机械保证

| 问题 | 主要归属 |
| --- | --- |
| 是否需要子 Agent | Skill 策略 |
| 任务怎样拆、角色怎样分 | Skill 策略 + controller |
| revision 是否冲突 | 脚本 |
| worktree 是否干净、SHA 是否漂移 | 脚本 |
| reviewer 是否发现语义缺陷 | 独立 Agent |
| reviewer 输出是否符合 schema | 脚本 |
| L0 命令退出码与日志摘要 | 脚本 |
| 是否触发 max iterations / fuse | 脚本 |
| 是否满足最终业务完成定义 | controller / 用户 |

只要一条规则需要“每次都一致”“中断后可恢复”或“不能被说服”，就优先实现成脚本。

### 3.4 旧事实不可变，新状态用 superseded 表达

一次验证对某个 contract 和 artifact 成立后，它是历史事实。分支前移、合同变化或新尝试出现，
只会让旧结果变成 `superseded`，不会把旧 Evidence 从 pass 改成 stale。

### 3.5 人工门与验证通过正交

`pass` 只表示冻结产物通过冻结验证定义，不等于全局任务完成。涉及不可逆动作、主观确认或
显式保护决策时，即使验证通过，controller 仍必须等待 H gate。

### 3.6 相近状态术语

| 术语 | 所属层 | 含义 |
| --- | --- | --- |
| `superseded` | Evidence / Attempt | 新合同、Artifact 或尝试已出现；旧终态证据仍对原输入有效 |
| `stale_precondition` | Verification runtime | 非终态运行发现 workdir、HEAD 或冻结输入漂移，作为 abort code 停止 |
| `skill_drift` | Controller / runtime | 运行中实际 Skill tree digest 与冻结 `skill_set` 不一致，abort 并 re-contract |
| `stale` | Worktree batch integration | 冻结的 target、输入 SHA、顺序或批合同已变化，旧集成候选计划失效 |

三者不能互相改写：Git 计划 stale 不会修改旧 Evidence；旧 Evidence superseded 也不是运行时 abort。

### 3.7 Skill 是可质疑的版本化协议

Skill 不是业务真理，也不保证自身永远正确。每次运行冻结实际使用的 Skill 名称、版本和内容摘要，
Agent 必须执行当前冻结协议，同时持续审计以下冲突：

- Skill 与用户明确要求或更高优先级规则冲突；
- Skill 与仓库裁决真源、测试、schema 或可观察事实冲突；
- Skill 缺少必要步骤，只能依赖临时 workaround；
- Skill 导致稳定的误报、漏报、不可判定或重复失败；
- Skill 的 provider / runtime 假设与当前宿主不一致。

发现冲突时不得静默绕过，也不得由 implementer 在当前任务中修改 Skill 或验证标准。应记录证据，
根据影响选择继续执行不受影响部分、`undecidable`、`abort / re-contract` 或 H gate，并形成独立的
改进候选。改进只对后续发布版本生效，不能反向改写当前合同、旧 Evidence 或历史结论。

## 4. 四个 Skill 的职责边界

| Skill | 核心职责 | 独立交付 | 组合时提供 | 明确不拥有 |
| --- | --- | --- | --- | --- |
| `orchestrate-subagents` | 任务图、角色、权限、模型路由、进度、全局收敛 | 一份可执行任务图、派发契约和验收结论 | 向 worktree / verification / loop provider 传递公共契约 | Git 生命周期、具体 verifier 协议、业务实现 |
| `manage-worktrees` | Git 写入隔离、owner、分支、精确 SHA、交接与回收 | 可审计的 worktree 生命周期 | 输出标准 `artifact_ref` 与 isolation binding | 任务拆分、验证 verdict、循环策略 |
| `verify-agent-output` | 对冻结产物做一次 smoke L0 → L1 → final L0 | 一份不可变 Evidence Package | 给 orchestrator 或 Loop 提供标准验证结果 | 修改业务产物、重试循环、Agent 池 |
| `run-agent-verify-loop` | 显式实现—验收循环的有界收敛、恢复与熔断 | 一条可恢复的独立验证循环 | 消费 controller 冻结的 provider、Artifact / Evidence 并回报终态 | 全局任务图、provider 选择、全局授权、批队列 |

### 4.1 控制权规则

- controller 始终只有一个。
- `orchestrate-subagents` 存在时，它是全局控制面。
- 其他 Skill 只拥有自己的局部状态机，不能扩展 scope、修改用户授权或宣布全局完成。
- 没有 orchestrator 时，各 Skill 可以直接由当前会话 controller 使用。
- 多 Skill 组合只维护一份公共 Task Contract。controller 必须在 freeze 前完成能力发现、
  provider 选择和所有 extension；freeze 后专项 Skill 只读合同，通过独立 receipt / state
  envelope 回报结果，不再写合同。

以下各节描述目标 v1 行为。除第 8.1 节明确标记为“已有”的脚本外，其余 runtime、命令和
第四个 Skill 都尚未实现，不能当作当前仓库已经提供的能力。

## 5. 每个 Skill 如何独立使用

### 5.1 orchestrate-subagents

独立触发场景：

- 用户明确要求多 Agent、并行或委派；
- 任务规模需要拆分；
- 独立 critic 是多节点任务图的一部分，需要额外依赖、权限或并发控制；
- 多节点任务存在依赖、barrier 或不同权限。

对一个冻结 Artifact 只派生一个只读 reviewer，是
`verify-agent-output` 的单 reviewer carve-out，不触发完整 orchestrator。只有该 reviewer
属于更大的任务图，或用户明确要求多 Agent 编排时，才同时使用 orchestrator。

独立模式下：

1. controller 生成 Task Contract。
2. 使用宿主原生 Agent API 派发。
3. 用本 Skill 自带 ledger 工具持久化任务图和状态。
4. 在共享树安全时直接使用共享树。
5. 需要隔离但没有 `manage-worktrees` 时，使用 Skill 中的保守 Git 下限或要求用户提供环境。
6. 需要独立验收但没有专项验证 Skill 时，使用宿主原生 reviewer，并明确记录
   `verification_assurance: host_protocol`。

独立模式的交付不是“子 Agent 都回复了”，而是 controller 对稳定产物和证据完成最终验收。

### 5.2 manage-worktrees

独立触发场景：

- 用户明确要求 worktree；
- 同仓存在多个写入者；
- 写入归属不明且路径相交；
- 需要登记、交接、监听、批次集成候选或安全回收。

它不需要任何 Agent 编排 Skill。用户或单个 Agent 可以直接：

- 扫描碰撞；
- 创建或接管 worktree；
- 更新 owner 与状态；
- 固定 feature / target SHA；
- 生成批次集成计划；
- 监听合入；
- 审计并保守回收。

独立输出包括稳定的 worktree record、event journal、owner epoch 和 artifact identity。

### 5.3 verify-agent-output

独立触发场景：

- “只 review 这个 commit，不要修改”；
- “独立验收这份产物一次”；
- “检查实现者是否满足合同，失败后停止”；
- 需要标准 Evidence，但不需要自动修复。

独立模式下，当前会话担任 controller：

1. 冻结 Contract、Verification Profile 与 Artifact。
2. 脚本运行 smoke L0。
3. controller 使用宿主原生能力创建一个新上下文、只读 reviewer。
4. 脚本校验 L1 输出。
5. 脚本在同一 Artifact 上运行 final L0。
6. 输出 Evidence Package。

如果宿主不能提供新上下文，Skill 可以导出只读 review bundle，等待用户转交给第二会话。
第二会话返回结果时记录 `isolation_assurance: user_relayed`。如果宿主不能派生、用户也不
中继第二会话，运行以 `independent_context_unavailable` abort，不产生标准 Evidence。
同一 implementer 上下文的 self-check 只能生成另一种 `self_check_report`，不得进入本 Skill
的 independent Evidence 状态机。

### 5.4 run-agent-verify-loop

独立触发场景：

- 用户明确要求“一个 Agent 实现、另一个持续验收，直到通过”；
- 高风险工作需要有界修复—证伪；
- 需要 max iterations、failure fuse、恢复和人工门。

它不应该因为没有 `verify-agent-output` 就完全不可用。独立模式使用内置 adapter：

1. `loop-runtime` 冻结合同、维护 iteration、revision、锁和 fuse。
2. implementer 由宿主原生 Agent 机制或双会话方式提供。
3. L0 由 loop runtime 的受限命令执行器运行。
4. L1 必须由宿主新上下文 reviewer 或用户中继的第二会话提供，脚本校验其结构。
5. 结果记录为 `embedded_verification_record`，它只在当前 Loop 内有效，不是标准
   Evidence Package。

同时安装 `verify-agent-output` 时，Loop 切换为
`provider: verify-agent-output`，直接消费标准 Evidence Package，避免 Loop 重复实现完整的一次性
验证状态机，并获得标准 Artifact / Evidence 绑定保证。

两种模式必须使用不同 record type 和 assurance 标记。embedded 模式不能输出、导出或冒充
Evidence Package；如果无法获得独立 reviewer，同样停止而不是用 implementer 自审产生 pass。

### 5.5 显式 Loop 模式的启动协议

仅当命中第 5.4 节触发条件，或用户显式调用下列形式时，才执行本协议：

~~~text
/run-agent-verify-loop <目标>
~~~

这不是普通目标型任务的推荐入口；一次性验收继续直接使用 `verify-agent-output`。自然语言目标
只是显式 Loop 请求，不是可执行合同。启动前置顺序固定为：

1. controller 解析目标、scope、acceptance、权限、非目标和停止条件；
2. 缺少可观察验收标准或边界时，controller 先补合同，不创建 Loop；
3. controller / orchestrator 探测已安装 Skill 与宿主能力；
4. controller 在 freeze 前选择 orchestration、isolation 和 verification provider；
5. controller 冻结 Task Contract 与 Verification Profile；
6. 创建 Loop State，开始 implement → artifact → verify → decide；
7. 根据结果继续下一轮、等待 H gate，或熔断停止。

普通调用只创建本轮的 Loop contract / ledger，不自动创建宿主持久 Goal。只有用户明确要求“设置
Goal、持续追踪这个目标”时，controller 才创建外部 Goal，并把不透明的 `goal_ref` 绑定到 Loop。
Loop completed 只是 Goal 的完成证据之一；外层 controller 仍需检查全局 completion 与 H gate，
再决定是否把 Goal 标记完成。

controller 的 provider 选择是按需的，Loop 只消费冻结结果：

- 多节点派发或多个角色：使用 `orchestrate-subagents`；
- 同仓多写入者或明确隔离：使用 `manage-worktrees`；
- 需要标准一次性 Evidence：使用 `verify-agent-output`；
- provider 不存在时，只能在 freeze 前选择文档定义的 standalone adapter；
- freeze 后不得自动切换 provider。

## 6. 组合使用时如何联动

~~~mermaid
flowchart TD
    U["用户请求 / 目标"]
    C["当前 controller<br/>目标解释、路由与最终授权"]
    O["orchestrate-subagents<br/>多节点任务图与全局控制（按需）"]
    R{"按第 6.1 节选择执行模式"}
    W["manage-worktrees<br/>隔离 provider（按需）"]
    V["verify-agent-output<br/>independent_once"]
    L["run-agent-verify-loop<br/>adversarial_loop（仅显式）"]

    U --> C
    C -. "多 Agent / 多节点" .-> O
    C --> R
    O --> R
    R -->|"Git 隔离"| W
    R -->|"一次性独立验收"| V
    R -->|"明确要求循环收敛"| L
    L -. "冻结 isolation provider" .-> W
    L -. "冻结 verification provider" .-> V
    W -. "artifact_ref" .-> V
    W -. "artifact_ref" .-> L
    V -. "evidence_package" .-> L
    V -->|"one-shot result"| C
    L -->|"loop terminal result"| C
~~~

controller 始终先根据请求事实路由；需要多节点时，`orchestrate-subagents` 才接管全局任务图与
provider 选择。Loop 只执行已经显式选择并冻结的循环合同，不反向成为普通任务、一次性验收或
四 Skill 组合的总入口。

### 6.1 联动不是全量加载

controller 根据任务事实选择能力：

| 场景 | 使用方式 |
| --- | --- |
| 单 Agent、小修改、确定性检查足够 | 不加载四 Skill |
| 多 Agent 但只有一个写入者 | `orchestrate-subagents` |
| 单 Agent 需要隔离 Git 工作区 | `manage-worktrees` |
| 固定 commit 独立 review 一次 | `verify-agent-output` |
| 明确要求反复修复和独立验收 | `run-agent-verify-loop` |
| 多写入者 + 一次性验收 | orchestrator + worktrees + verifier |
| 多写入者 + 有界修复循环 | 四者组合 |

不能因为“仓库 dirty”“任务很多”或“可能并发”就默认加载全部 Skill。

### 6.2 能力发现

每个脚本运行时提供：

~~~text
<runtime> capabilities --json
~~~

最小输出：

~~~json
{
  "skill": "verify-agent-output",
  "runtime_version": "1.0.0",
  "contracts": {
    "task_contract": [1],
    "artifact_ref": [1],
    "evidence_package": [1]
  },
  "features": ["git-artifact", "l0", "l1", "immutable-evidence"]
}
~~~

controller 或宿主只能在 Skill 已被正常加载后，使用宿主解析出的 Skill 绝对路径调用该命令；
runtime 不自行扫描兄弟目录或全局安装位置。

调用方必须在合同 freeze 前完成版本交集判断，并把最终 provider 写入合同。没有交集时可以在
freeze 前选择 standalone provider 或 fail closed；合同 freeze 后发现 provider 缺失、版本不兼容
或能力漂移时，当前运行必须 abort，并由 controller 显式 re-contract，不能静默 fallback。

### 6.3 Provider 选择

公共合同显式记录 provider：

~~~yaml
extensions:
  orchestration:
    provider: orchestrate-subagents | host-native
  isolation:
    provider: manage-worktrees | caller-supplied | none
  verification:
    provider: verify-agent-output | embedded | self-check
  loop:
    provider: run-agent-verify-loop | none
~~~

Provider 只能由 controller 在 freeze 前选择。worker、implementer、verifier 和专项 runtime
不能在运行中自行升级权限、切换 provider 或降低 assurance。
`self-check` 只表示普通 L2 自查，不路由到 `verify-agent-output`，也不能产生 Evidence 或满足
Loop 的独立 L1 条件。

### 6.4 触发优先级

目标 v1 的 frontmatter 与 forward tests 必须共同保证：

- 固定 Artifact、单个只读 reviewer、只验一次：只触发 `verify-agent-output`；
- reviewer 是多节点任务图的一部分，或需要并发、不同权限、多个 critic：触发
  `orchestrate-subagents`；
- 明确要求实现—验收反复收敛：触发 `run-agent-verify-loop`；
- Loop 内的一次性验证是 provider 调用，不再次创建全局 orchestrator。

`orchestrate-subagents` 的 description 必须显式排除“单 Artifact、单 reviewer 的一次性验收”；
`verify-agent-output` 的 description 必须显式排除多节点编排与自动修复。

## 7. 跨 Skill 数据契约

所有 envelope 都使用 JSON 作为机器真源；文档中的 YAML 只为便于阅读。
v1 的摘要字段统一使用 RFC 8785 canonical JSON 与 UTF-8 字节；原始 JSON 在规范化前必须拒绝
重复 key。每种 envelope 的 digest 都对移除自身 digest 字段后的完整 payload 计算。

### 7.1 Task Contract

公共合同由 controller 创建。capability discovery、provider 选择和全部 extension 必须在
freeze 前完成；freeze 后其他 Skill 对整份合同只读，并把运行结果写入各自独立的 receipt、
Evidence 或 state envelope。

~~~yaml
schema_version: 1
contract_id: "<uuid>"
objective: "唯一目标"
scope:
  include: []
  exclude: []
acceptance:
  - contract_item_id: "stable-id"
    requirement: "可观察标准"
permissions:
  mode: read_only | write
  writable_paths: []
environment:
  repository: "<absolute path or none>"
  isolation: shared_tree | worktree | caller_supplied
skill_set:
  - name: run-agent-verify-loop
    version: "<semver or unversioned>"
    content_digest: "sha256:..."
    provider_mode: primary | optional
stop_conditions: []
extensions: {}
contract_digest: "sha256:..."
~~~

规则：

- `contract_item_id` 必须稳定且唯一；
- v1 canonical JSON 采用 RFC 8785；原始 JSON 解析阶段拒绝重复 key；
- `contract_digest` 对移除 `contract_digest` 字段后的完整 canonical payload 计算 SHA-256；
- `skill_set` 记录本轮实际加载并参与决策的 Skill；没有发布版本时仍必须记录内容摘要；
- Skill `content_digest` 根据已解析安装目录生成：对允许参与运行的 `SKILL.md / agents /
  references / scripts` 文件逐个计算 SHA-256，再对按规范化相对路径排序的
  `[{path, size, sha256}]` manifest 使用 RFC 8785 + SHA-256；不包含绝对路径、缓存和运行状态；
- 合同冻结后任何变化都创建新版本；
- extension 不得覆盖公共字段；
- 实现者不能修改 verification extension。
- freeze 后 provider 缺失或不兼容必须 abort / re-contract，不得修改原合同。

### 7.2 Worktree Binding

~~~yaml
schema_version: 1
provider: manage-worktrees
repository_id: "<opaque id>"
worktree_id: "<stable id>"
workdir: "<absolute path>"
branch: "<branch>"
owner:
  agent: "<host>"
  agent_id: "<opaque id>"
  epoch: 3
base_sha: "<full object id>"
head_sha: "<full object id>"
task_status: active | blocked | ready_for_review | integrating | done | abandoned
worktree_state: present | missing | reclaim_ready | reclaimed
~~~

`task_status` 与 `worktree_state` 是正交字段，沿用现有
`worktree-mgr.mjs` 状态模型，必须支持无损 round-trip。此 envelope 只表达隔离与归属；
`task_status: done` 也不表达 Verification verdict 或全局任务完成。

### 7.3 Artifact Ref

~~~yaml
schema_version: 1
provider: manage-worktrees | caller-supplied
repository_id: "<opaque stable identity>"
object_format: sha1 | sha256
base_sha: "<full commit object id>"
artifact_sha: "<full commit object id>"
branch_hint: "<optional mutable provenance>"
worktree_id: "<optional>"
ownership_epoch: "<optional>"
target_sha: "<optional integration target>"
ordered_input_shas: []
batch_fingerprint: "<optional>"
~~~

`branch_hint` 不是身份。验证期间 `HEAD` 必须始终等于 `artifact_sha`。

### 7.4 Verification Profile

Verification Profile 是冻结的“怎样验”定义，与 Task Contract 的“验什么”分离：

~~~yaml
schema_version: 1
profile_id: "<uuid>"
l0_checks:
  - check_id: unit
    argv: ["npm", "test"]
    cwd_rel: "."
    stage: smoke | final | both
    timeout_ms: 120000
    expected_exit_codes: [0]
l1_review:
  - contract_item_id: permission-boundary
    lenses: [functional, scope, verification_definition, safety]
protected_verifier_paths: ["tests/security/"]
allowed_validation_changes: []
runtime:
  env_allowlist: ["PATH"]
  executable_paths:
    npm: "<resolved absolute path>"
  cache_policy: disabled | isolated | trusted_identity
  network_policy: denied | contract_authorized
  max_log_bytes: 1048576
human_gate: none
verification_profile_digest: "sha256:..."
~~~

规则：

- `check_id` 必须稳定且唯一；
- `l1_review.contract_item_id` 必须引用冻结 Task Contract 的 acceptance item；
- L0 只接受 argv 数组，不接受 shell command string；
- `env_allowlist` 只记录变量名，不把值写入 Evidence；
- protected / allowed path 共用 v1 exact-path / directory-prefix grammar；
- `verification_profile_digest` 按第 7 节统一 canonical 规则计算；
- Profile freeze 后任何字段变化都必须新建 verification run；Loop 已启动时还必须 re-contract。

与当前已发布 `run-agent-verify-loop/SKILL.md` 的迁移映射：

| 现有 `extensions.verification` 字段 | v1 归属 |
| --- | --- |
| `l0_checks` | Verification Profile.`l0_checks` |
| `l1_review` | Verification Profile.`l1_review` |
| `protected_verifier_paths` | Verification Profile 同名字段 |
| `allowed_validation_changes` | Verification Profile 同名字段 |
| `human_gate` | Verification Profile.`human_gate`，并镜像为 Loop H gate 初值 |
| `on_failure` / `max_iterations` / `escalation` | Loop State 的 `policy / limits`，不属于 Verification Profile |
| `state` | Loop runtime 的外置 state root，不进入冻结验证语义 |

迁移期 adapter 在 freeze 前把现有 inline extension 规范化为独立 Profile；freeze 后不再双写。
旧字段删除必须与新 runtime、schema adapter 和兼容测试同批完成。

### 7.5 Verification Request

~~~yaml
schema_version: 1
request_id: "<uuid>"
contract_digest: "sha256:..."
verification_profile: {}
verification_profile_digest: "sha256:..."
artifact_ref: {}
~~~

runtime 必须重算内嵌 Profile digest，并确认 Contract、Profile 与 Artifact 均已冻结。reviewer view
由 Task Contract acceptance 与 Profile.`l1_review` 连接生成，不能由调用方另传一份漂移清单。

### 7.6 Review Result

full verifier 与 embedded adapter 共用同一个 Review Result v1 envelope：

~~~yaml
schema_version: 1
review_result_id: "<uuid>"
contract_digest: "sha256:..."
verification_profile_digest: "sha256:..."
artifact_ref: {}
verdict: fail | no_defect_found | undecidable
findings:
  - contract_item_id: permission-boundary
    class: functional | scope | verification_definition | safety
    evidence: "artifact or reproduction evidence"
    expected: "contract requirement"
    actual: "observed result"
forensics: []
review_result_digest: "sha256:..."
~~~

`verify-agent-output/references/verification-protocol.md` 是 reviewer 行为、输入隔离、证伪步骤和
三态 verdict 语义的唯一真源。Review Result schema 是跨 Skill 契约；unknown
`contract_item_id`、无 evidence finding、`no_defect_found` 无 forensics、以及包含 safety finding
却试图按普通 pass 处理都必须被脚本拒绝。

### 7.7 Evidence Package

~~~yaml
schema_version: 1
run_id: "<uuid>"
protocol_version: 1
runtime_version: "<semver>"
contract_digest: "sha256:..."
verification_profile_digest: "sha256:..."
artifact_ref: {}
stages:
  smoke_l0: {}
  l1_review: {}
  final_l0: {}
terminal_outcome: pass | fail | undecidable | blocked_safety
completion_scope: verification_only
human_gate_required: true | false
provenance:
  provider: verify-agent-output
  verified_at: "<runtime generated RFC3339>"
  verifier_run_id: "<host opaque id>"
  isolation_assurance: host_reported | user_relayed
  limitations: []
evidence_digest: "sha256:..."
~~~

`terminal_outcome: pass` 永远只表示验证通过，不表示全局任务完成。

### 7.8 Embedded Verification Record

此记录只由 standalone Loop 使用，不是 Evidence Package，也不能被其他 Evidence consumer 接受：

~~~yaml
schema_version: 1
record_type: embedded_verification_record
record_id: "<uuid>"
loop_id: "<uuid>"
iteration: 2
contract_digest: "sha256:..."
verification_profile_digest: "sha256:..."
artifact_ref: {}
l0_result: {}
l1_result: "<Review Result v1>"
independent_context:
  assurance: host_reported | user_relayed
  reviewer_run_id: "<opaque id>"
outcome: pass | fail | undecidable | blocked_safety
record_digest: "sha256:..."
~~~

它必须绑定当前 Loop、当前 iteration 和当前 Artifact，并执行稳定 ID、L0、L1、digest 与独立上下文
校验；但它不实现标准 Evidence 的 smoke/final 双阶段、内容寻址日志和可移植消费协议。因此它只
能推进创建它的 Loop，不能导出为 `evidence_package`。

### 7.9 Loop State

~~~yaml
schema_version: 1
loop_id: "<uuid>"
goal_ref: "<optional opaque external goal id>"
revision: 7
state: active | waiting_human | completed | stopped
contract_digest: "sha256:..."
verification_profile_digest: "sha256:..."
provider: verify-agent-output | embedded
limits:
  max_iterations: 3
  consecutive_identical_signature: 2
policy:
  on_failure: retry | rollback | change_strategy | stop
  escalation: []
current_iteration:
  index: 2
  artifact_ref: {}
  verification_run_id: "<uuid when provider is verify-agent-output>"
iterations: []
consumed_verification_run_ids: []
reflection_refs: []
convergence_report_ref: "<optional>"
human_gate:
  required: false
  status: not_required | pending | approved | rejected
terminal: {}
~~~

机器 ledger 永远是状态真源。聊天表格、issue、看板和外部 tracker 只能镜像。

### 7.10 Reflection Record

Reflection Record 只保存可复核结论，不保存 chain-of-thought：

~~~yaml
schema_version: 1
reflection_id: "<uuid>"
trigger: repeated_failure | undecidable | user_correction | runtime_abort |
  workaround | protocol_conflict | unexpected_outcome | terminal_retrospective
scope:
  contract_digest: "sha256:..."
  loop_id: "<optional>"
  iteration: "<optional>"
  run_id: "<optional>"
affected_skill:
  name: verify-agent-output
  version: "<semver or unversioned>"
  content_digest: "sha256:..."
classification: contract_gap | skill_gap | verification_gap | tool_gap |
  environment_gap | false_positive | false_negative | inefficiency
observation: "简短、可证伪的结论"
evidence_refs:
  - type: artifact | evidence | event | diagnostic
    id: "<stable id or relative ref>"
    digest: "sha256:..."
impact: low | medium | high | safety
confidence: low | medium | high
recommended_disposition: continue | undecidable | abort | re_contract | human_gate
recorded_at: "<runtime generated RFC3339>"
reflection_digest: "sha256:..."
~~~

Reflection 不能改变 Artifact verdict、Evidence、合同或当前 Skill。没有 evidence 的主观感受只能
作为低置信候选，不能推动自动改进。
runtime 必须验证每个 evidence ref 的 digest；无法稳定引用的聊天印象不得标成高置信证据。

### 7.11 Convergence Report

每个 Loop 在 `completed` 或 `stopped` 时生成不可变收敛报告；`waiting_human` 只生成 checkpoint：

~~~yaml
schema_version: 1
report_id: "<uuid>"
loop_id: "<uuid>"
contract_digest: "sha256:..."
skill_set: []
outcome: completed | stopped
iterations: 3
failure_signatures: []
strategy_changes: []
verification_aborts: []
verification_gaps: []
reflection_refs: []
improvement_proposal_refs: []
generated_at: "<runtime generated RFC3339>"
report_digest: "sha256:..."
~~~

报告用于复盘“怎样收敛、为何停止、哪里缺能力”，不替代 Evidence，也不自动证明 Goal 完成。

### 7.12 Skill Improvement Proposal

四个执行 Skill 只允许创建不可变的 `proposed` 候选：

~~~yaml
schema_version: 1
proposal_id: "<uuid>"
target_skill:
  name: run-agent-verify-loop
  based_on_version: "<semver or unversioned>"
  based_on_digest: "sha256:..."
source_reflections: []
problem:
  type: skill_gap | false_positive | false_negative | inefficiency
  evidence_refs: []
proposed_change: "要改变的规则、脚本或 schema"
affected_scope: []
counterexamples: []
validation_plan:
  replay_cases: []
  regression_suites: []
  independent_review: required
  canary: "<optional>"
lifecycle: proposed
proposal_digest: "sha256:..."
~~~

后续 `quarantined → evaluated → accepted / rejected → released` 由独立维护流程以追加事件推进。
当前任务中的 implementer、verifier、Loop 和 orchestrator 都无权把 proposal 改为 accepted 或
直接修改 Skill。被接受的改动只进入新版本，并必须支持回放、回滚和来源追踪。

## 8. 脚本化运行时设计

### 8.1 当前成熟度

| Skill | 当前脚本化程度 | 判断 |
| --- | --- | --- |
| `orchestrate-subagents` | 已有宿主能力缓存与模型策略脚本 | 有局部工具，但任务图与 ledger 仍主要靠协议 |
| `manage-worktrees` | 已有 manager、scan、profile、trace、provider 及测试 | 已接近完整可执行运行时 |
| `verify-agent-output` | 尚未创建 | 需要新增 Skill 与运行时 |
| `run-agent-verify-loop` | 当前没有 scripts | 状态、熔断和恢复仍停留在文档层，必须补强 |

### 8.2 通用脚本约束

- Node.js 脚本优先使用 Node 18+ 标准库；
- 现有 Python 工具保留，避免为统一语言做无收益重写；
- 所有机器消费命令支持 `--json`；
- 所有状态修改命令使用 revision / lock；
- init 冻结相关 Skill manifest；provider 派发、Evidence 接收和 Loop `next` 前重算摘要；
- 运行中 Skill 摘要变化以 `skill_drift` abort，必须 re-contract；
- 不接受任意 shell 字符串，命令使用 argv 数组；
- 默认不向业务仓库写运行状态；
- 状态目录必须显式授权；
- event journal 追加写，snapshot 可重建；
- Reflection、Convergence Report 和 Proposal 使用 write-new / append-only，不回写 Evidence；
- `propose-improvement` 只能输出 `lifecycle: proposed`，不能编辑 Skill 文件；
- `doctor` 只报告，不自动删除或修复；
- runtime 提供 `capabilities`、`status`、`inspect`、`validate`、`doctor`；
- 单个 Skill 的脚本不能依赖兄弟 Skill 路径。

### 8.3 orchestrate-subagents 的脚本工具

建议目录：

~~~text
orchestrate-subagents/
├── SKILL.md
├── agents/openai.yaml
├── references/
└── scripts/
    ├── host_capability_cache.py          # 已有
    ├── resolve_model_policy.py           # 已有
    ├── orchestration-ledger.mjs          # 新增
    ├── contract-tool.mjs                 # 新增
    └── *.test.*
~~~

`contract-tool.mjs`：

| 命令 | 作用 |
| --- | --- |
| `normalize` | 规范化公共 Task Contract |
| `validate` | 检查字段、ID、权限与 extension 冲突 |
| `digest` | 计算合同摘要 |
| `review-view` | 生成去除实现者叙事的 reviewer 输入 |
| `diff` | 比较合同版本，判断是否必须重签 |

`orchestration-ledger.mjs`：

| 命令 | 作用 |
| --- | --- |
| `init` | 创建任务图和 revision 0 |
| `add-node` / `add-edge` | 登记节点、依赖与 barrier |
| `dispatch-record` | 记录宿主派发参数和 worker identity |
| `update` | 记录运行中、阻塞、待验收和终态 |
| `attach` | 绑定 worktree、artifact、Evidence 或 Loop 结果 |
| `batch-init` | 登记一组独立 Loop、顺序/并发和批级 limits |
| `batch-record` | 原子记录单个 Loop 终态与批级失败键 |
| `batch-status` | 汇总批进度，不覆盖各 Loop 自己的 ledger |
| `batch-fuse` | 按连续相同失败指纹或批失败上限机械熔断 |
| `record-reflection` | 登记合同、路由、并行或资源层的 Reflection Record |
| `propose-improvement` | 基于 reflection 生成 proposed 候选，不修改 Skill |
| `status` | 输出用户台账所需 JSON |
| `rebuild` | 从 event 重建 snapshot |
| `doctor` | 检查孤儿节点、revision 冲突和未闭环资源 |

脚本不直接派发 Agent。派发 API 属于宿主，Skill 负责把宿主回执写入 ledger。

### 8.4 manage-worktrees 的脚本工具

保留现有：

- `worktree-mgr.mjs`；
- `worktree-scan.mjs`；
- `worktree-profile.mjs`；
- `worktree-trace.mjs`；
- `worktree-provider-gitlab.mjs`；
- 对应测试。

建议增强 `worktree-mgr.mjs`：

| 命令 | 作用 |
| --- | --- |
| `artifact <task-or-id> --json` | 输出标准 Artifact Ref |
| `binding <task-or-id> --json` | 输出 Worktree Binding |
| `verify-artifact <file>` | 验证 repository、object format、SHA、owner epoch |
| `incident <task-or-id> --input <json>` | 记录碰撞、漂移、交接或回收异常的结构化 reflection |
| `propose-improvement --reflection <id>` | 输出 worktree Skill 改进候选，不自动改 Profile / 脚本 |
| `capabilities --json` | 声明 schema 与 provider 能力 |

它继续只拥有 Git 隔离与生命周期，不读取 Verification verdict，不推进 Loop iteration。

### 8.5 verify-agent-output 的脚本工具

建议目录：

~~~text
verify-agent-output/
├── SKILL.md
├── agents/openai.yaml
├── references/
│   ├── verification-protocol.md
│   └── evidence-schema.md
└── scripts/
    ├── verification-runtime.mjs
    └── verification-runtime.test.mjs
~~~

建议 CLI：

| 命令 | 作用 |
| --- | --- |
| `capabilities` | 输出支持的 schema / protocol |
| `init` | 冻结 Contract、Profile 与 Artifact |
| `run-smoke` | 执行便宜 L0，失败时快速终止 |
| `review-input` | 生成隔离 reviewer 输入 |
| `record-review` | 校验并登记 L1 输出 |
| `run-final` | 在同一 Artifact 上执行完整 L0 |
| `record-reflection` | 记录漏检、误报、不可判定、Profile 或 Skill 缺口 |
| `propose-improvement` | 从有证据 reflection 生成 proposed 候选 |
| `status` / `inspect` | 查看运行态与证据 |
| `validate` | 重算 Evidence 与日志摘要 |
| `doctor` | 检查事件、锁、漂移和不一致 |

该 runtime 是 L0 与 Evidence 的权威；L1 判断仍由独立 Agent 提供。

### 8.6 run-agent-verify-loop 的脚本工具

建议目录：

~~~text
run-agent-verify-loop/
├── SKILL.md
├── agents/openai.yaml
├── references/
│   ├── embedded-review-adapter.md
│   ├── loop-state-machine.md
│   └── recovery-and-fuses.md
└── scripts/
    ├── loop-runtime.mjs
    └── loop-runtime.test.mjs
~~~

Loop 不维护第二套 verifier protocol。`embedded-review-adapter.md` 只定义：

- 如何在没有 `verify-agent-output` 时准备最小只读 reviewer view；
- 如何要求宿主新上下文或用户中继第二会话；
- 如何把 Review Result v1 绑定到 loop ID、iteration 和 Artifact；
- embedded 模式缺少标准 Evidence 哪些保证。

三态 verdict、finding class、取证要求和输入隔离以
`verify-agent-output/references/verification-protocol.md` 与第 7.6 节 Review Result v1 为唯一
语义真源。独立安装的 Loop 随版本化 JSON schema 携带必要的机器校验规则，但不能复制或改写完整
行为协议。现有 `run-agent-verify-loop/references/verifier-protocol.md` 只有在 verifier Skill、
新 adapter 和兼容测试同时落地后才删除，避免迁移窗口失去独立验收规则。

建议 CLI：

| 命令 | 作用 |
| --- | --- |
| `capabilities` | 输出 provider 和 schema 支持 |
| `init --contract --profile [--goal-ref]` | 校验并冻结 Loop 合同、Profile、limits、provider 与可选外部 Goal 绑定 |
| `record-artifact` | 登记当前 iteration 的精确 Artifact |
| `run-embedded-l0` | standalone 模式执行受限 L0 |
| `record-embedded-review` | standalone 模式校验 L1 |
| `record-evidence` | 组合模式消费标准 Evidence |
| `record-verification-abort` | 记录 operational abort |
| `next` | 根据确定性规则推进下一 iteration |
| `record-reflection` | 记录重复失败、策略失效、用户纠正或协议冲突 |
| `convergence-report` | 在 completed / stopped 时生成收敛报告 |
| `propose-improvement` | 从 reflection / report 生成 proposed 候选 |
| `resume` / `stop` | 显式恢复或停止 |
| `status` / `doctor` | 输出状态并检查 event / lock / fuse |

`loop-runtime` 不派发 Agent、不修改业务代码、不创建 worktree，也不拥有批队列。

`record-evidence` 必须机械完成：

1. 校验 schema、protocol 和 runtime version；
2. 校验 Evidence 的 `contract_digest` 与 `verification_profile_digest` 等于冻结 ledger；
3. 校验 repository identity 与 `artifact_sha` 等于当前 iteration；
4. 校验 Evidence `run_id` 等于当前 iteration 登记的 `verification_run_id`；
5. 重算 `evidence_digest`；
6. 在授权 state root 中原子保留 run ID；任何 Loop 已消费过都拒绝；
7. 使用 expected revision 在同一个锁事务中写 event 并推进 Loop。

`record-embedded-review` 同样校验 loop ID、iteration、contract、profile、Artifact 和 record digest，
但只生成 `embedded_verification_record`。它没有进入通用 Evidence 消费注册表的资格。

当前 `run-agent-verify-loop/SKILL.md` 中的“批量队列”属于现状协议。落地本架构时应迁移为：
orchestrator 为每个 work item 建立独立 Loop，并在自己的任务图中管理批状态；Loop runtime 只维护
单个收敛对象。

迁移必须等到 Phase 3 的 orchestration ledger、`batch-init / batch-record / batch-fuse` 和恢复测试
全部可用，再与 Loop 的旧批量条款做同批切换。此前 `run-agent-verify-loop/SKILL.md` 继续保留
现有批量队列与“连续 3 项同因失败”规则，并标注“迁移中”；不得提前删除造成批级熔断保证倒退。

## 9. 验证、证据与安全内核

### 9.1 一次性验证顺序

~~~text
冻结 Contract / Profile / Artifact
→ smoke L0
→ 新上下文 L1 主动证伪
→ final L0
→ Evidence Package
~~~

final L0 必须针对 L1 实际审查的同一 Artifact。

### 9.2 Git v1 机械约束

- `base_sha` 和 `artifact_sha` 必须是完整 commit object；
- `base_sha` 必须是 `artifact_sha` 的 ancestor；
- 验证工作目录必须干净；
- 每个 gate 前后检查 `HEAD == artifact_sha`；
- protected path 使用精确路径或以 `/` 结尾的目录前缀；
- v1 拒绝 wildcard、path magic、绝对路径和 parent traversal；
- 路径变化使用：

~~~text
git diff --name-status -z --no-renames <base_sha> <artifact_sha>
~~~

未授权的 protected-path 变化在 L1 之前直接失败。

### 9.3 Evidence 不可变

- canonical JSON 拒绝重复 key；
- `verified_at` 由 runtime 生成；
- `evidence_digest` 对移除自身字段后的完整 canonical JSON 计算 SHA-256；
- 日志先脱敏再落盘；
- 日志按内容摘要保存，write-new，不覆盖；
- validate 重算日志和 Evidence 摘要；
- 原始未脱敏日志不得持久化；
- Evidence 的 contract、profile、repository 和 artifact 必须互相绑定。

### 9.4 aborted 与 stale_precondition

任何非终态运行都可以因运行时前置条件失败进入：

~~~text
aborted(code, diagnostics_ref)
~~~

`aborted` 是 operational terminal，不是 Artifact verdict，不产生 Evidence Package。
`stale_precondition` 与 `skill_drift` 是其中的 code。aborted 不能直接续跑；修复条件后必须创建
新 run；Skill 版本变化还要求 controller 重新确认 provider、合同与 Profile 兼容性。

Loop 收到 verification abort 时：

- 记录 run ID、code 与 diagnostics；
- 进入 stopped；
- 不增加 iteration；
- 不生成 failure signature；
- 不自动无限重试；
- controller 显式 resume 后，对同一 Artifact 创建新 verification run。

### 9.5 失败指纹与熔断

失败键只使用稳定 ID：

- 失败 L0 的 `check_id`；
- L1 的 `{contract_item_id, class}`。

排序去重后对 canonical JSON 计算 SHA-256。熔断只判断“连续相同失败指纹”，不声称不同文本属于
同一个语义原因。

### 9.6 不可调安全内核

- reviewer 不能读取实现者过程叙事；
- verifier 不能修改业务 Artifact；
- implementer 不能改写冻结验证定义；
- safety finding 不能被投票抵消；
- `undecidable` 必须停止并升级；
- max iterations 与 fuse 不能由 implementer 提高；
- pending human gate 阻止全局完成；
- runtime 缺失时不能宣称对应 runtime 保证；
- Reflection / Proposal 不能修改当前 Contract、Profile、verdict、fuse 或 H gate；
- 发现 Skill 缺陷影响验收时必须 undecidable / abort / re-contract，不能现场修规则继续判 pass；
- 任何 Skill 都不能扩大用户权限。

## 10. 典型工作流

### 10.1 只使用 manage-worktrees

~~~text
扫描写入碰撞
→ spawn / adopt worktree
→ worker 提交
→ audit
→ push / watch（需授权）
→ reclaim
~~~

不需要多 Agent，也不产生验证 verdict。

### 10.2 只使用 verify-agent-output

~~~text
调用方提供 clean Git Artifact
→ 一次性验证
→ Evidence: pass / fail / undecidable / blocked_safety
→ 返回调用方
~~~

失败后停止，不自动修改。

### 10.3 只使用 run-agent-verify-loop

~~~text
/run-agent-verify-loop + 目标
→ 补齐并冻结 Contract / Profile
→ Loop provider = embedded
→ 宿主原生 implementer
→ loop-runtime 运行 L0
→ 宿主原生独立 reviewer
→ loop-runtime 校验和推进
→ pass / stopped / waiting_human
→ completed / stopped 时生成 Convergence Report
~~~

输出明确记录 embedded assurance。

### 10.4 orchestrator + worktrees

~~~text
orchestrator 建任务图
→ worktree provider 为每个并行 writer 建隔离树
→ worker 输出精确 SHA
→ controller 串行集成与验收
→ worktree provider 回收
~~~

orchestrator 不直接操作 Git 生命周期，worktree manager 不理解任务图。

### 10.5 orchestrator + verifier

~~~text
任务节点完成并冻结 Artifact
→ verification mode = independent_once
→ verifier 输出 Evidence
→ orchestrator 决定节点通过、失败或升级
~~~

Evidence pass 只是节点验收输入，最终任务完成仍由 controller 判断。

### 10.6 四个 Skill 全组合

~~~text
用户目标
→ controller 根据第 6.1 节明确选择 adversarial_loop
→ 需要多节点时，orchestrator 完成 capability discovery、任务图与 provider 选择
→ controller 冻结公共合同和 Verification Profile
→ orchestrator 建任务图并派发 implementer
→ worktrees 隔离 implementer
→ Loop 登记 iteration Artifact
→ verify-agent-output 生成 Evidence
→ Loop 根据 Evidence 推进、熔断或等待 H gate
→ Loop 生成 Convergence Report 与 proposed-only 改进候选
→ orchestrator 验收 Loop 终态
→ controller 检查 H gate / 全局 completion，再完成目标
→ worktrees 审计和回收
~~~

全流程只保留一份公共合同；各 Skill 的 event journal 分开，各自拥有自己的 revision 和锁。

## 11. 独立模式与组合模式的保证等级

| 能力 | 独立模式 | 组合模式 |
| --- | --- | --- |
| orchestrator 无 worktree provider | 可编排，按共享树或保守 Git 下限执行 | 获得可审计隔离、owner epoch 与 Artifact Ref |
| verifier 无 worktree provider | 接受调用方提供的 clean pinned workdir | 复用标准 repository/worktree identity |
| Loop 无 verifier provider | embedded L0 + host reviewer，脚本保证 Loop 状态 | 消费标准 Evidence，获得更强绑定与复用 |
| Skill 无 orchestrator | 当前会话直接担任 controller | 全局任务图、路由、台账和最终验收统一 |

建议 Evidence / Loop 输出记录：

~~~yaml
assurance:
  orchestration: host_direct | orchestrated
  isolation: none | caller_supplied | managed_worktree
  verification: none | host_protocol | runtime_bound
  recovery: none | local_journal
  limitations: []
~~~

保证等级只允许如实降低，不允许用文案把低保证模式包装成高保证模式。

## 12. 版本、兼容与安装

### 12.1 安装原则

- 四个 Skill 可以分别安装；
- 不存在“安装 Loop 必须同时安装另外三个”的要求；
- 安装多个 Skill 后，由 controller 做 capability discovery；
- Skill 不能在运行时静默下载兄弟 Skill；
- freeze 前缺少组合 provider 时选择明确的 standalone mode；freeze 后缺失则 abort / re-contract；
- 安全要求无法满足时 fail closed。

### 12.2 Schema 兼容

每个 envelope 记录：

- schema version；
- protocol version（适用时）；
- runtime version；
- provider；
- digest。

调用方只接受自己声明支持的版本范围。未来 schema 不兼容时拒绝，不做猜测转换。

### 12.3 独立发布与组合兼容矩阵

每个 Skill 可以独立发版，但发布测试必须覆盖：

- 自己的 standalone 行为；
- 与当前稳定版其他 Skill 的组合行为；
- capability 版本无交集时的 fallback / fail-closed；
- 旧 Evidence 和旧 ledger 的只读验证；
- 不存在兄弟 Skill 目录时不崩溃。

### 12.4 文档真源与实施位置

本文件当前是公开分发仓中的提案评审副本。架构定稿时必须完成一次真源迁移：

1. 把架构文档纳入四个 Skill 的 authoritative source repository；
2. 在该仓维护规则中登记：行为、schema、trigger 或 runtime 边界变化时，同一变更必须更新架构；
3. 把文档加入从真源到公开分发仓的单向白名单同步；
4. 公开仓只接收同步结果，不反向覆盖真源；
5. 发布检查验证两边文档摘要与 Skill 版本兼容矩阵。

`verify-agent-output`、`loop-runtime` 及后续脚本必须在 authoritative source repository 开发和测试，
再按白名单同步到公开分发仓；不得因为提案文档暂时位于公开仓，就直接在分发副本实现后反向搬运。
在上述维护规则落地前，Phase 0 不算完成。

## 13. 测试策略

### 13.1 单 Skill 测试

`orchestrate-subagents`：

- contract normalize / digest；
- task graph revision；
- worker 状态迁移；
- reviewer view 去污染；
- batch ledger、跨独立 Loop 失败指纹与批级熔断恢复；
- 合同 / 路由 reflection 与改进候选只写 proposed；
- orphan / barrier / resource doctor；
- 宿主能力缓存和模型路由。

`manage-worktrees`：

- 继续运行现有 manager、scan、profile、trace、provider 测试；
- 增加 Artifact Ref 和 Worktree Binding schema；
- 保证 `task_status` / `worktree_state` 双状态无损 round-trip；
- SHA-1 / SHA-256 repository；
- owner epoch、drift 和回收边界。
- incident reflection 不泄露凭证、原始日志或未授权路径；

`verify-agent-output`：

- 合同、Verification Profile schema / 迁移映射与 Artifact digest；
- smoke → L1 → final 状态机；
- protected path；
- argv 执行与环境 allowlist；
- 预写脱敏和内容寻址日志；
- Evidence 不变量；
- 漏检、误报、Profile gap reflection 与 Evidence 相互独立且不可回写；
- 无独立上下文时 abort；用户中继第二会话时记录 provenance；
- 未知 `contract_item_id` 与非法 path grammar 拒绝；
- aborted / stale_precondition；
- crash recovery。

`run-agent-verify-loop`：

- revision / lock 冲突；
- `/run-agent-verify-loop + 目标` 生成合同草案、缺验收时不启动；
- 可选 `goal_ref` 绑定不改变 Loop / Goal completion 边界；
- embedded record provider，且不能导出为 Evidence；
- embedded adapter 与 Review Result v1 兼容，且不重定义 verdict；
- Evidence provider；
- contract / artifact / run 绑定；
- state-root 级 Evidence run ID 原子防重放；
- max iterations；
- identical failure signature；
- verification abort；
- human gate；
- completed / stopped 自动生成 Convergence Report；
- reflection 和 improvement proposal 不改变当前 iteration / fuse / verdict；
- snapshot rebuild。

### 13.2 组合测试

- orchestrator 使用 managed worktree 派发多个 writer；
- worktree Artifact Ref 进入 verifier；
- verifier Evidence 进入 Loop；
- Loop 终态回到 orchestrator；
- provider 缺失时只允许 freeze 前选择 standalone；freeze 后 abort；
- embedded record 不能被通用 Evidence consumer 接受；
- schema 无交集时拒绝；
- 同一个 Evidence run 重复消费时拒绝；
- 分支在 L1 期间移动；
- controller 中断后从各自 journal 恢复；
- 四个 Skill 安装顺序任意。
- 单 Artifact、单 reviewer 不误触发完整 orchestrator；
- 批量条款只在 orchestration ledger 和 batch fuse 已通过恢复测试后迁移；
- authoritative source 与公开分发副本的架构摘要一致；
- Skill 内容摘要被合同冻结，运行中 Skill 文件变化触发 abort / re-contract；
- Skill tree manifest 在不同安装绝对路径下产生相同 content digest；
- Reflection Record 只能引用不可变证据，不能修改旧 Evidence；
- evidence ref digest 不匹配时拒绝高置信 reflection；
- Improvement Proposal 在四个执行 Skill 中只能停留在 proposed；
- proposal 命令不得写入 Skill 安装目录或业务仓库；

### 13.3 Forward tests

至少覆盖以下真实请求：

- “让两个 Agent 并行调查，不要改文件”；
- “给两个写任务分别建 worktree”；
- “只独立 review 这个 SHA，一次失败就停”；
- “只有当前实现者上下文，不能伪造独立验收 pass”；
- “一个 Agent 修，另一个验，最多三轮”；
- “没有 verifier Skill，使用 embedded record 运行明确低保证的 Loop”；
- “同时装了四个 Skill，但这个小任务不要全开”；
- “验证通过，但发布仍需我确认”。
- “Skill 的规则与仓库真源冲突，记录证据并停止重签，不能现场改 Skill”；
- “用户纠正了 Agent，形成低噪声 reflection 和待评估改进候选”；
- “Loop 成功但过程低效，生成收敛报告而不污染 Artifact verdict”。

## 14. 分阶段落地计划

### Phase 0：文档与契约

- 评审本架构；
- 固定四个 Skill 边界；
- 固定 Task Contract、Verification Profile、Review Result、Evidence、Embedded Record 与 Loop State；
- 固定 Skill provenance、Reflection Record、Convergence Report 与 Improvement Proposal；
- 明确显式 Loop 启动协议、Goal 绑定和 completion 边界；
- 明确 standalone / combined assurance；
- 完成架构文档真源迁移和单向同步维护规则。

### Phase 1a：一次性验收与 Loop 执行核心

优先实现：

1. `verify-agent-output` 及 `verification-runtime.mjs`；
2. `run-agent-verify-loop/scripts/loop-runtime.mjs`；
3. Verification Profile、Review Result、Evidence、Embedded Record、Loop State 的 schema、状态机和测试；
4. 更新 verifier / orchestrator frontmatter，落实单 reviewer carve-out；
5. 将 Loop 的现有 `verifier-protocol.md` 安全迁移为 canonical protocol + embedded adapter；
6. 实现 Skill provenance / content digest / drift 检查，保证运行中变化触发 abort / re-contract；
7. 保留现有 Loop 批量条款并标记“迁移中”，本阶段不转移批级熔断。

退出标准：一次性 verifier 可以独立产生并校验 Evidence；显式 Loop 可以使用 embedded 或 verifier
provider 运行；基本的 crash recovery、防重放和熔断测试通过。Phase 1a 不依赖 Reflection、
Convergence Report 或 Improvement Proposal runtime 即可交付。

原因：当前最缺的是可直接使用的一次性独立验收；Loop 的“可恢复、熔断、Evidence”也仍主要
停留在协议层。先补执行核心，避免反思面的实现范围延迟核心能力可用。

### Phase 1b：反思与沉淀接口

1. 为 verifier / Loop runtime 实现事件触发 Reflection Record；
2. 为 Loop 实现 completed / stopped 时的 Convergence Report；
3. 实现 proposed-only Improvement Proposal 命令与证据绑定；
4. 实现 reflection / report / proposal 的隐私、脱敏、不可回写测试；
5. 验证反思面失败、缺失或被禁用时，不改变 Phase 1a 的 verdict、fuse、H gate 和恢复语义。

Phase 0 仍先冻结反思 schema 与安全边界；Phase 1b 只后移 runtime 实现顺序，不把学习结果接入
当前任务执行链路。

### Phase 2：统一联动契约

- 为 `manage-worktrees` 增加 Artifact Ref / Binding 输出；
- 为四个 runtime 增加 capabilities；
- 接通 Evidence → Loop；
- 接通 Artifact → Verification；
- 为 worktree incident 增加结构化 Reflection Record；
- 验证 sibling Skill 不存在时的 standalone 行为。

### Phase 3：增强 orchestrator 机械台账

- 增加 contract tool；
- 增加 orchestration ledger；
- 接入跨节点 reflection、proposal 引用和批次 retrospective，但不做自动规则晋升；
- 实现 `batch-init / batch-record / batch-status / batch-fuse` 与批状态恢复；
- 用组合测试证明批级连续失败熔断后，再同批删除 Loop 的旧批量队列条款；
- 绑定 worktree / Evidence / Loop 稳定产物；
- 从 event 重建用户可见台账；
- 增加闭环 doctor。

### Phase 4：组合压力测试与发布

- fault injection；
- concurrency；
- crash recovery；
- schema compatibility；
- reflection / proposal fault injection 与隐私脱敏；
- 历史案例 replay，验证候选改进不会降低旧 acceptance；
- 四 Skill 独立安装测试；
- 任意组合安装测试；
- 文档、宿主映射和分发同步。

## 15. 反思、沉淀与受控改进

### 15.1 目标：让 Agent 审计 Skill，而不是迷信 Skill

反思的对象包括 Artifact、合同、验证定义、工具、环境和 Skill 本身。Agent 应遵守冻结 Skill，
但可以用证据指出其不完整、过时或错误。反思不是自由发挥，也不是输出隐藏推理；只保存：

- 触发事件；
- 可证伪观察；
- 证据指针；
- 影响范围；
- 当前任务应如何安全处置；
- 是否值得形成改进候选。

### 15.2 事件触发，不做无条件长反思

以下事件必须考虑生成 Reflection Record：

| 事件 | 默认动作 |
| --- | --- |
| 连续相同失败指纹 | 分析验证、策略或 Skill 是否存在系统性缺口 |
| `undecidable` | 记录缺少的证据、工具或判定规则 |
| 用户纠正 Agent | 对照原结论与新真源，记录 false positive / false negative / skill gap |
| runtime abort / stale precondition | 区分环境偶发问题和协议假设错误 |
| 必须使用 workaround | 记录 Skill 没覆盖的宿主或项目变体 |
| 测试通过但 reviewer 找到缺陷 | 记录 verification gap |
| reviewer 通过但后来出现可复现缺陷 | 记录 false negative，优先级高 |
| Skill 与裁决真源冲突 | abort / re-contract 或 H gate，禁止现场改规则 |
| Loop completed / stopped | 生成 Convergence Report；没有异常时只写最小报告 |

普通成功步骤不要求逐步反思。强制每一步长复盘会制造噪声、增加成本并诱发事后合理化。

### 15.3 四个 Skill 的沉淀职责

| Skill | 主要反思对象 | 稳定沉淀 |
| --- | --- | --- |
| `orchestrate-subagents` | 拆分、依赖、模型路由、无效并行、合同遗漏、批级失败 | 任务图 reflection、batch retrospective、proposal ref |
| `manage-worktrees` | 碰撞、漂移、owner、交接、回收、provider / Profile 假设 | incident reflection、可复现 Git 证据 |
| `verify-agent-output` | 漏检、误报、不可判定、L0 覆盖、L1 输入、Profile 缺口 | verification-gap reflection、Evidence 引用 |
| `run-agent-verify-loop` | 重复失败、策略变化、熔断、abort、迭代成本与收敛路径 | Convergence Report、failure pattern、proposal ref |

专项 Skill 只记录本层事实，不替另一个 Skill 解释内部状态。例如 worktree reclaim 失败不能直接推导
verifier 错误；Loop 多轮失败也不能在无证据时认定 implementer 能力不足。

### 15.4 执行面与改进面分离

~~~mermaid
flowchart LR
    E["执行面<br/>冻结 Skill / Contract / Profile"]
    R["Reflection Record<br/>证据化观察"]
    P["Improvement Proposal<br/>proposed"]
    Q["隔离评估<br/>replay / regression / independent review"]
    D{"维护者裁决"}
    N["新 Skill 版本"]

    E --> R --> P --> Q --> D
    D -->|"accepted"| N
    D -->|"rejected"| P
    N -. "只影响后续新任务" .-> E
~~~

当前执行面绝不读取未发布 proposal 作为新规则。Proposal 可以被记录、导出和评审，但不能：

- 修改当前 `SKILL.md`、script 或 Verification Profile；
- 改弱现有测试、protected path 或 acceptance；
- 让当前失败结果重新变成 pass；
- 反向修改旧 Evidence；
- 绕过 H gate 或权限边界。

### 15.5 当 Skill 可能错误时怎样处理当前任务

按影响选择最小安全动作：

1. **不影响当前判断**：继续执行，附 Reflection Record。
2. **局部步骤无法执行，但有合同允许的等价路径**：记录 workaround 与限制，继续后重验。
3. **验收完整性受损**：输出 `undecidable`，不得猜 pass。
4. **合同或 provider 必须变化**：abort，controller re-contract。
5. **涉及安全、权限或不可逆动作**：进入 H gate。

“Skill 可能不对”不能成为 implementer 弱化验证的理由。任何影响当前验收的规则变化都必须先停止
当前运行，由 controller 依据外部真源重签合同；必要时让独立 reviewer 专门证伪该规则。

### 15.6 改进候选的晋升门

Proposal 至少经过：

1. evidence / reflection 完整性校验；
2. 与同类 proposal 去重；
3. 历史失败案例 replay；
4. 现有 regression / holdout；
5. 独立 reviewer 主动寻找反例；
6. 安全内核与触发范围审查；
7. 维护者 accepted / rejected 决策；
8. 新版本 canary、回滚点和发布记录。

单个成功或失败案例通常不足以修改通用 Skill。安全缺陷可以快速阻断发布，但仍须保留证据、
独立复核和可回滚变更。

### 15.7 隐私、噪声与保留

- Reflection 只保存结论和证据引用，不保存 chain-of-thought；
- 复用日志脱敏规则，不复制原始秘密或完整实现对话；
- 默认不把本地绝对路径、个人身份和凭证写入跨任务 proposal；
- 没有证据的低置信观察不得自动升级；
- 重复 signal 通过稳定 classification、Skill digest 和 evidence key 去重；
- retention、导出位置与跨项目共享必须由用户或维护策略授权；
- Reflection / Proposal 默认写仓库外 state root；进入源码仓需要明确维护流程。

### 15.8 v1 边界

v1 包含：

- 冻结 Skill provenance；
- 事件触发 Reflection Record；
- Loop terminal Convergence Report；
- proposed-only Skill Improvement Proposal；
- 人工维护的评估与发布接口。

v1 不包含自动聚类、自动改 Skill、自动 accepted、自动发布或跨用户学习。它只把高质量改进输入
生产出来，为未来独立改进层提供可靠接口。

## 16. 暂不纳入 v1 的学习与进化平台

参考架构中“历史 Git 记录、Evidence、案例库、规则库、提前训练、日常自学习”的方向值得保留，
但不应直接塞进这四个执行 Skill。

v1 只做四件为未来铺路的事：

1. 产出结构化、不可变、可追溯的 Evidence；
2. 保留 contract、artifact、outcome、finding 和 provenance 的稳定关系；
3. 记录事件触发的 Reflection Record 与 Loop Convergence Report；
4. 输出 proposed-only Improvement Proposal，但不在执行面晋升。

只有满足以下条件后，才考虑独立的学习层：

- Evidence schema 已稳定且有真实消费；
- Reflection / Proposal taxonomy 已稳定，并有足够 accepted / rejected 样本评估噪声；
- 有足够的可回放成功与失败样本；
- 隐私、保留周期和脱敏规则明确；
- 有冻结 regression / holdout / verification-fidelity 套件；
- promotion、canary 和 rollback 不修改正在执行的任务；
- 学习层永远不能改写当前任务的安全内核。

未来如要实现，应派生为独立平台或独立 Skill，而不是让任一执行 Skill 在任务内自我进化。

## 17. 已确定的设计决策与待定 ADR

### 17.1 已确定

1. 四个 Skill 均可独立使用。
2. `verify-agent-output` 是独立的一次性验证 Skill。
3. `run-agent-verify-loop` 继续保留，服务明确要求循环收敛的用户。
4. 仅在用户明确要求循环收敛或显式调用时，`/run-agent-verify-loop + 目标` 才按第 5.5 节先冻结
   合同再启动循环；普通任务与一次性验收不经过 Loop，普通 Loop 也不自动创建外部 Goal。
5. Loop 可以 standalone embedded 运行，也可以消费 verifier provider。
6. Verification Profile 是独立冻结 envelope，并承接现有验证 extension。
7. full verifier protocol 只有一个真源；Loop 只维护 embedded adapter。
8. 多 Skill 通过 envelope 联动，不跨目录 import。
9. 能机械表达的保证必须由脚本实现。
10. v1 以 Git commit 作为 Artifact。
11. one-shot pass 与 Loop completed 都不自动等于外部 Goal / 全局任务完成。
12. 目标 v1 中 Loop 不拥有批队列；批量由 orchestrator 组合多个独立 Loop，但迁移必须与
    orchestration ledger 同批落地。
13. Skill 是可质疑的版本化协议；当前任务冻结版本和内容摘要。
14. 四个执行 Skill 只生成 proposed 改进候选，不能任务内自改或自行 accepted。
15. Reflection 保存证据化结论，不保存 chain-of-thought，也不改变 Artifact verdict。
16. 自动学习与自进化不进入 v1。

### 17.2 待定 ADR

1. orchestration ledger 与 verification / loop state root 的默认目录布局。
2. 日志大小上限和脱敏配置格式。
3. standalone verifier 如何获得 clean pinned workdir，同时不复制 worktree 生命周期能力。
4. 不依赖 `manage-worktrees` 时 repository identity 的跨 clone 语义。
5. RFC 8785 的 Node 实现采用经测试的本地实现还是锁定版本依赖；无论选择哪种，都必须通过
   RFC 测试向量、重复 key 拒绝和跨 Skill digest 兼容测试。“优先标准库”不等于允许自创另一套
   canonical 语义。
6. Reflection / Proposal 的默认 state root、保留周期、跨项目去重键和用户导出授权。

这些 ADR 可以影响实现细节，但不能推翻“独立可用、组合增强、脚本保证机械不变量”的总体边界。
