# Agent Skills 协作契约与安全边界

> 状态：v1.1.0 稳定发布（Stable）
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
- [15. 反思、沉淀与受控改进](#15-反思沉淀与受控改进)
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

> `SKILL.md` 负责触发条件、决策规则、角色边界和宿主编排；`agentkit` 的 `domains/` 负责状态、
> Git 身份、确定性执行、证据、锁、恢复和机械不变量，`core/` 只承载跨域稳定原语。

四个 Skill 不是一套必须整体安装的“框架”。它们是四个可独立使用的能力模块：

1. `orchestrate-subagents`：控制面，决定是否拆分、派谁、何时收敛。
2. `manage-worktrees`：Git 隔离与产物身份面，管理并发写入和生命周期。
3. `verify-agent-output`：一次性独立验收面，对冻结产物做一次完整验证。
4. `run-agent-verify-loop`：显式循环收敛面，在实现与独立验收之间做有界迭代。

四个 Skill 路由可以分别安装和触发；执行时都要求同一 `agentkit` 包在 `PATH` 上可用。组合使用时，
它们通过版本化 JSON 契约和 CLI 输出联动，不通过兄弟 Skill import、共享可变文件或隐藏调用耦合。
Skill 目录下的 `scripts/` 只在 1.x 保留兼容入口，不再承载运行时实现。

当用户明确要求反复修复与独立验收，或显式调用
`/run-agent-verify-loop + 目标` 时，controller 才选择 Loop 模式，并按
[`run-agent-verify-loop/SKILL.md`](../../run-agent-verify-loop/SKILL.md) 的启动闸门完成启动前置。
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
- 自己的 domain CLI 入口与 Skill 路由；
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

### 3.8 渐进式披露与上下文预算

四个 Skill 使用三层披露：frontmatter description 只负责准确触发；`SKILL.md` 只保留组合路由、正常
流程、授权/安全边界和停止条件；低频模式、完整 envelope、异常恢复与命令诊断放进按场景读取的
reference。reference 必须从入口说明“何时读取”，不得要求所有任务预加载，也不得与入口重复维护同一
规则。脚本实现无需进入模型上下文即可执行，只有修改或诊断 runtime 时才读取源码。

| Skill | 按需加载边界 |
| --- | --- |
| `orchestrate-subagents` | 写派发/完整档读 `dispatch-contract`；专项 Skill 缺失读 `isolation-fallback`；失败、中断、重派或接手读 `failure-routing-and-recovery`；reviewer 决策读 `review-budget` |
| `manage-worktrees` | 多树关系读 `delivery-identity`；创建/堆叠历史读 `spawn-and-stack`；评审/交接/watcher 读 `review-lifecycle`；批量集成和回收分别读取现有专项 reference |
| `verify-agent-output` | 输入未准备、preflight 失败或完整诊断时读 `input-preparation`；进入 L1 才读 verification protocol |
| `run-agent-verify-loop` | embedded、状态迁移、恢复/熔断分别读取已有专项 reference；正常 happy path 不加载恢复细节 |

字符数是稳定、tokenizer-independent 的固定上下文代理，不冒充实际计费 Token。当前入口预算为：
`orchestrate-subagents <= 8500`、`manage-worktrees <= 5200`、`verify-agent-output <= 4900`、
`run-agent-verify-loop <= 5100`，合计 `<= 23700`（单文件预算之和，不单独写死总量）；每个 description
`<= 140` 字符，合计 `<= 4 × 140 = 560`（skill 数量 × 140，随 SKILL.md 数量同步调整）。
预算是回归上限，不是填充目标；超限时优先下沉真正条件化的细节，不能删除安全不变量来过测试。数字与
[`tests/skill-budgets.mjs`](../../tests/skill-budgets.mjs) 保持一致，由
`tests/architecture-consistency.test.mjs` 的反查断言锁定。

撞线时按以下边界判断，不是撞线就抬预算：

- 先问这段文字能不能变成命令、退出码或报错文案；能，就不进 `SKILL.md`。
- 不能机制化、且每次触发该 skill 都要用到的内容，才算"该常驻"；这时才抬预算，并在 commit message
  里写明抬的理由。
- 只在某个分支场景才用到的细则，下沉到 `docs/<域>/`，正文只留一句指针。

## 4. 四个 Skill 的职责边界

| Skill | 核心职责 | 独立交付 | 组合时提供 | 明确不拥有 |
| --- | --- | --- | --- | --- |
| `orchestrate-subagents` | 任务图、角色、权限、模型路由、进度、全局收敛 | 一份可执行任务图、派发契约和验收结论 | 向 worktree / verification / loop provider 传递公共契约 | Git 生命周期、具体 verifier 协议、业务实现 |
| `manage-worktrees` | Git 写入隔离、owner、分支、精确 SHA、交接与回收 | 可审计的 worktree 生命周期 | 输出标准 `artifact_ref` 与 isolation binding | 任务拆分、验证 verdict、循环策略 |
| `verify-agent-output` | 对冻结产物做一次 smoke L0 → L1 → final L0 | 一份只写新文件、与摘要绑定的 Evidence Package | 给 orchestrator 或 Loop 提供标准验证结果 | 修改业务产物、重试循环、Agent 池 |
| `run-agent-verify-loop` | 显式实现—验收循环的有界收敛、恢复与熔断 | 一条可恢复的独立验证循环 | 消费 controller 冻结的 provider、Artifact / Evidence 并回报终态 | 全局任务图、provider 选择、全局授权、批队列 |

### 4.1 控制权规则

- controller 始终只有一个。
- `orchestrate-subagents` 存在时，它是全局控制面。
- 其他 Skill 只拥有自己的局部状态机，不能扩展 scope、修改用户授权或宣布全局完成。
- 没有 orchestrator 时，各 Skill 可以直接由当前会话 controller 使用。
- 多 Skill 组合只维护一份公共 Task Contract。controller 必须在 freeze 前完成能力发现、
  provider 选择和所有 extension；freeze 后专项 Skill 只读合同，通过独立 receipt / state
  envelope 回报结果，不再写合同。

以下各节描述目标 v1 行为。当前源码成熟度以 [`domains/`](../../domains/) 中实际存在的运行时与测试
为准；尚未评审、合入或发布的能力不能当作稳定版本承诺。

## 5. 每个 Skill 如何独立使用

四个 Skill 的独立触发条件、standalone 流程、最小命令面和 provider 缺失时的降级路径，真源是各自的
Skill 外壳与对应的 `docs/<域>/`：[`orchestrate-subagents/SKILL.md`](../../orchestrate-subagents/SKILL.md)、
[`manage-worktrees/SKILL.md`](../../manage-worktrees/SKILL.md)、
[`verify-agent-output/SKILL.md`](../../verify-agent-output/SKILL.md)、
[`run-agent-verify-loop/SKILL.md`](../../run-agent-verify-loop/SKILL.md)。它们是 agent 实际加载的那一份，
本节只做导航，不另外抄写触发条件与流程。

### 5.3 verify-agent-output

如果宿主不能提供新上下文，Skill 可以导出只读 review bundle，等待用户转交给第二会话。
第二会话返回结果时记录 `isolation_assurance: user_relayed`。如果宿主不能派生、用户也不
中继第二会话，运行以 `independent_context_unavailable` abort，不产生标准 Evidence。
同一 implementer 上下文的 self-check 只能生成另一种 `self_check_report`，不得进入本 Skill
的 independent Evidence 状态机。

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
| 明确要求反复修复，或 freeze 前已合理预期同一目标会经历多轮新 Artifact 且修复已获授权 | `run-agent-verify-loop` |
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
  "protocol_version": "1.0.0",
  "runtime_version": "1.0.0",
  "contracts": {
    "task_contract": [1],
    "artifact_ref": [1],
    "evidence_package": [1]
  },
  "features": ["git-artifact", "l0", "l1", "immutable-evidence"]
}
~~~

controller 或宿主只能在 Skill 已被正常加载后调用 `PATH` 上的 `agentkit`；runtime 不自行扫描兄弟
Skill 目录或全局安装位置。域级命令也可以通过包内固定入口直接执行，供安装矩阵和兼容层复验。

`agentkit capabilities --json` 在保留各域原始载荷之外输出 `runtime_bundle_digest`，精确标识同一
tarball 内的 CLI、core、domains、schema、按需文档、四个 shell 与 `shell-manifest.json`。摘要算法的
真源是 [`core/runtime-bundle.mjs`](../../core/runtime-bundle.mjs)，入口与目标路径的清单真源是
[`shell-manifest.json`](../../shell-manifest.json)。
`agentkit doctor` 校验 manifest 与 `package.json` 版本、全部兼容入口和目标路径；公开写命令在执行前
重复该门禁。版本失配时写操作 fail closed，`status/inspect/doctor` 等只读诊断仍可运行。诊断项的真源
是 [`bin/cli.mjs`](../../bin/cli.mjs)。

`protocol_version` 表示跨实现兼容语义，`runtime_version` 表示脚本实现版本，Skill tree
`content_digest` 表示该域实际执行所依赖的分发内容。三者必须分别报告；软链安装不能依赖 Git 信息、
mtime 或路径字符串识别版本，CLI 入口判断也必须对调用路径和模块路径做 realpath 归一化。

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
- 明确要求实现—验收反复收敛，或 freeze 前已合理预期同一目标会连续产生多轮新 Artifact 且有修复授权：触发 `run-agent-verify-loop`；
- Loop 内的一次性验证是 provider 调用，不再次创建全局 orchestrator。

固定 SHA 的一次性 terminal Evidence 不会自动升级成 Loop，也不能被后续修复覆盖；模式变化时保留旧
Evidence，显式冻结新的 Loop state。多个彼此独立的收敛对象仍由 orchestrator 各自建节点/Loop，不能
塞进一个 Loop。

`orchestrate-subagents` 的 description 必须显式排除“单 Artifact、单 reviewer 的一次性验收”；
`verify-agent-output` 的 description 必须显式排除多节点编排与自动修复。

## 7. 跨 Skill 数据契约

envelope 的机器真源是 [`schemas/`](../../schemas/)：字段名、类型、必填项和取值域由 JSON Schema
逐项定义，运行时与测试直接校验这些文件。本节只做导航，不另外抄写字段表。

所有 envelope 以 JSON 为机器真源。v1 的摘要字段统一使用 RFC 8785 canonical JSON 与 UTF-8 字节，
原始 JSON 在规范化前必须拒绝重复 key，每种 envelope 的 digest 都对移除自身 digest 字段后的完整
payload 计算；规范化与摘要实现的真源是 [`core/digest.mjs`](../../core/digest.mjs)。

| envelope | schema |
| --- | --- |
| Task Contract | [`task-contract-v1`](../../schemas/task-contract-v1.schema.json) |
| Worker Capability Requirements | [`worker-capability-requirements-v1`](../../schemas/worker-capability-requirements-v1.schema.json) |
| Effective Worker Capability | [`effective-worker-capability-v1`](../../schemas/effective-worker-capability-v1.schema.json) |
| Model Policy Resolution | [`model-policy-resolution-v1`](../../schemas/model-policy-resolution-v1.schema.json) |
| Worktree Binding | [`worktree-binding-v1`](../../schemas/worktree-binding-v1.schema.json) |
| Artifact Ref | [`artifact-ref-v1`](../../schemas/artifact-ref-v1.schema.json) |
| Verification Profile | [`verification-profile-v1`](../../schemas/verification-profile-v1.schema.json) |
| Review Result | [`review-result-v1`](../../schemas/review-result-v1.schema.json) |
| Evidence Package | [`evidence-package-v1`](../../schemas/evidence-package-v1.schema.json) |
| Embedded Verification Record | [`embedded-verification-record-v1`](../../schemas/embedded-verification-record-v1.schema.json) |
| Controller Recheck Record | [`controller-recheck-record-v1`](../../schemas/controller-recheck-record-v1.schema.json) |
| Loop State | [`loop-state-v1`](../../schemas/loop-state-v1.schema.json) |
| Convergence Report | [`convergence-report-v1`](../../schemas/convergence-report-v1.schema.json) |
| Reflection Record | [`reflection-record-v1`](../../schemas/reflection-record-v1.schema.json) |
| Skill Improvement Proposal | [`improvement-proposal-v1`](../../schemas/improvement-proposal-v1.schema.json) |
| Orchestration Ledger | [`orchestration-ledger-v1`](../../schemas/orchestration-ledger-v1.schema.json) |
| Batch Result | [`batch-result-v1`](../../schemas/batch-result-v1.schema.json) |

合同冻结后任何变化都创建新版本；extension 不得覆盖公共字段；freeze 后 provider 缺失或不兼容必须
abort / re-contract，不得修改原合同。这三条是跨 envelope 的架构约束，各 envelope 内部的字段语义
以上表的 schema 为准。

## 8. 脚本化运行时设计

运行时实现的真源是 [`domains/`](../../domains/)：每个域的目录清单、命令表、参数和退出语义都由那里
的 `.mjs` 与同目录测试定义。操作细则的真源是 `docs/<域>/`，由 `agentkit docs <域> <主题>` 按需读取。
本节只做导航，不另外抄写目录树和命令表。

| 域 | 运行时 | 操作文档 | Skill 外壳 |
| --- | --- | --- | --- |
| orchestrate | [`domains/orchestrate/`](../../domains/orchestrate/) | [`docs/orchestrate/`](../orchestrate/) | `orchestrate-subagents/` |
| worktree | [`domains/worktree/`](../../domains/worktree/) | [`docs/worktree/`](../worktree/) | `manage-worktrees/` |
| verify | [`domains/verify/`](../../domains/verify/) | [`docs/verify/`](../verify/) | `verify-agent-output/` |
| loop | [`domains/loop/`](../../domains/loop/) | [`docs/loop/`](../loop/) | `run-agent-verify-loop/` |

跨域共享原语在 [`core/`](../../core/)；Skill 目录下的 `scripts/` 只在 1.x 保留兼容 stub，不承载实现。

full verifier protocol 只有一个真源：[`docs/verify/verification-protocol.md`](../verify/verification-protocol.md)
与 Review Result v1 schema。Loop 只维护 [`docs/loop/embedded-review-adapter.md`](../loop/embedded-review-adapter.md)，
定义 standalone 模式如何准备最小只读 reviewer view、如何把 Review Result 绑定到 loop ID / iteration /
Artifact，以及 embedded 模式缺少标准 Evidence 时哪些保证不成立；它不复制也不改写完整行为协议。

### 8.2 通用脚本约束

- 统一使用 Node 22+ 原生 ESM 模块（`.mjs`），不引入第三方或 Python 运行时依赖，也不提前编译；
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
- 域级 `doctor` 只检查显式选择的 ledger / run / loop 等状态，不自动删除或修复；顶层
  `agentkit doctor` 只检查 Node、Git、安装完整性与各域 capabilities，不把缺少状态选择器判为故障；
- runtime 提供 `capabilities`、`status`、`inspect`、`validate`、`doctor`；
- 单个 Skill 不能依赖兄弟 Skill 路径；共享代码只能从包根 `core/` 与对应 `domains/<domain>/` 获取；
- 1.x 兼容入口必须 import-safe，只允许静态透传 domain 导出并在直接执行时调用同一进程内的
  `runCli()`；不得在 import 时执行命令，也不得再派生第二个 Node 进程。2.0 删除这些 stub。

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

以下不变量由诚实运行的 runtime 在冻结合同、受信 controller 和受信 state-root writer 的权限边界内
执行；它们不是针对可任意重写 state root 的本地攻击者所作的密码学承诺：

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

### 9.7 威胁模型与持久性边界

- state root 是本地授权边界，只应由 controller / operator 和对应 runtime 写入；目录权限、备份和
  外部审计由宿主负责。拥有完整写权限的进程可以重写 snapshot、journal 和身份文件，v1 不声称能
  对抗这种进程。
- journal 的 digest chain 用于发现非合作写入造成的部分、追加、乱序和意外损坏，并支持 crash
  recovery；它不是数字签名，也没有外部不可变锚。能重写整条链的 writer 可以生成另一条自洽历史。
- safety finding 在当前冻结 run / Loop 的诚实执行链中优先于其他 verdict，不能被投票抵消。跨新 run
  的同一 Artifact 安全记忆属于 controller / orchestration ledger / 维护流程；一次性 verifier 不把
  自己描述为 Artifact 级永久安全台账。
- `challenge_nonce` 只拒绝未经修改的跨 run Review Result 重放。nonce 对 state-root writer 可见，
  `host_reported` isolation assurance 是调用方声明，不是 runtime 对宿主隔离的证明。
- state-root identity 能拒绝未修改的目录复制或移动。`adopt-root` 是 operator 对现有完整 history 的
  显式重新授权，不是自动修复；拥有写权限的进程仍可删除、改写身份后重新授权，因而该机制不是
  防复制的密码学证明。

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

需要证明多个 feature 合成后兼容时，在 `audit` 之后插入批量集成段：

~~~text
plan-batch（冻结 target 与有序输入；可选 --scan-conflicts 出冲突矩阵定合并顺序）
→ batch-integrate（建/复用一次性候选树并合成）
→ controller 跑门禁 + batch-step 登记合成后再生成步骤
→ batch-result 冻结 candidate SHA、环境检查摘要与 Evidence digest
→ 各输入按可独立评审的交付单元分别合入
→ reclaim --archive-evidence（候选）/ reclaim --pushed（各 feature）
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

- 四个 Skill 路由可以分别安装，运行前必须能从 `PATH` 解析兼容版本的 `agentkit`；
- 每个 Skill frontmatter 用 `metadata.requires.bins: ["agentkit"]` 提示宿主依赖；该提示不替代运行时门禁；
- 不存在“安装 Loop 必须同时安装另外三个”的要求；
- 安装多个 Skill 后，由 controller 通过 `agentkit capabilities --json` 做 capability discovery；
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

### 12.3 统一引擎发布与组合兼容矩阵

引擎、四个 Skill 路由、schema 与按需文档作为同一包版本发布；Skill 可以独立安装，但发布测试必须覆盖：

- 从真实 `npm pack` tarball 安装到临时 prefix，并经临时 `PATH` 遍历四个 Skill 的 15 种非空组合；
- 自己的 standalone 行为；
- 与当前稳定版其他 Skill 的组合行为；
- capability 版本无交集时的 fallback / fail-closed；
- 旧 Evidence 和旧 ledger 的只读验证；
- 不存在兄弟 Skill 目录时不崩溃。

### 12.4 文档与实现一致性

本文件描述当前发布版四个 Skill 的协作契约与安全边界。维护时遵守以下规则：

1. 行为、schema、trigger 或 runtime 边界变化时，同一发布必须更新本文件；
2. README 只提供稳定能力摘要，不能另行定义或弱化本文件中的行为语义；
3. 发布检查必须验证文档摘要、Skill 版本和组合兼容矩阵；
4. 运行时实现、测试、schema 与本文件冲突时，停止发布并完成重新评审，不能在发布副本中临时改写契约。

### 12.5 仓库与发布载荷

本仓库直接维护四个 Skill 目录及以下同版本内容：

- `package.json` 与 `bin/`：提供零依赖 ESM 的 `agentkit` 命令映射，不生成编译产物；
- `shell-manifest.json`：绑定包版本、CLI 入口、四个 Skill shell、兼容入口、domain 目标与只读命令边界；
- `core/`、`domains/` 与 `schemas/`：共享原语、四个领域运行时与 canonical schema 真源；
- `docs/orchestrate/`、`docs/worktree/`、`docs/verify/`、`docs/loop/`：由 `agentkit docs` 按需读取。SKILL.md
  只能以 `agentkit docs <域> <主题>` 命令引用这些文档，不得写 `../docs/...` 相对链接：宿主把 Skill
  基目录报成安装路径（可能是软链），Read 工具按词法折叠 `..`，跨目录链接在安装态必断，
  `tools/validate-skills.mjs` 对此 fail closed；
- `LICENSE`：MIT，随发布一起分发；
- `tests/`：四个 Skill 的共享测试，使安装侧可以在自己的环境上复验安装矩阵与跨 Skill 契约；
- `tools/validate-skills.mjs`：Skill 规范校验入口，供安装侧独立复跑。

仓库中的 `tests/`、domain 测试文件和仓库级校验工具用于持续复验，不进入 npm tarball；npm 包只
携带运行时、schema、按需文档、四个 Skill shell、兼容入口、manifest、LICENSE，以及由发布仓维护的
双语 README。
包清单必须显式排除 `*.test.mjs`，并在 `publishConfig` 固定 public npm registry 与公开访问级别。

仓库级 CI、README 与生成的协作图由本仓库自行维护。任何外部聚合仓只能消费固定 commit、tag 或
npm 版本，不得向本仓库回写生成结果。发布流程在提交前必须校验载荷清单与内容摘要，使 tag、npm
tarball、架构文档与四个 `SKILL.md` 可以事后证明来自同一 commit。

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
- 软链安装路径下所有 CLI 入口真实执行而不是静默 exit 0；
- worker effective capability binding / expiry、拒绝与审批通道故障分类、无需能力时不强制探针；
- 轻量 Reflection 不依赖 ledger，仍校验证据摘要并只生成 proposed Proposal；
- 模型发现不可用、用户显式不可验证与宿主默认未暴露三种状态不混写。
- reviewer 预算按 Artifact 限制 primary/escalation 数量，拒绝重复 lens、smoke 前 review、超预算输入和
  safety stop；escalation 必须有可验证触发原因；
- 四个 `SKILL.md` 与 frontmatter description 的单项/总字符预算使用 tokenizer-independent 测试守住；
  reference 路由按真实操作场景加载，避免每次触发支付异常恢复与其他模式的上下文成本；

`manage-worktrees`：

- 继续运行现有 manager、scan、profile、trace、provider 测试；
- 增加 Artifact Ref 和 Worktree Binding schema；
- 保证 `task_status` / `worktree_state` 双状态无损 round-trip；
- SHA-1 / SHA-256 repository；
- owner epoch、drift 和回收边界。
- manager-owned rebase 的成功、冲突 continue、abort 与 crash recovery；pending 时交付命令 fail-closed；
- retarget 祖先门禁、stack parent drift 诊断、旧 Artifact 失效；
- `touch --mr --watch-target` 的原子结构化登记与 URL 校验；
- incident reflection 不泄露凭证、原始日志或未授权路径；
- batch-result 的 SHA/指纹/target/有序输入/Evidence 绑定、终态不可覆盖、passed step 门禁；
- evidence archive 的 HEAD CAS、ref collision/readback、dirty/stash/Git 中间态/submodule、幂等恢复与精确恢复；
- `--pushed` 必须有候选 branch 外的持久 ref，原有 pushed/superseded 回收路径保持兼容；

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
- `prepare-run` 对源输入只读、自动摘要、前置失败不创建 run；
- `record-review --stdin` 的 digest 回填、严格 JSON、互斥与大小门禁；
- compact / verbose CLI 输出与每个子命令 `--help`；

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
- 发布文档与四个 Skill 的架构摘要一致；
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
- “Kiro 类宿主 schema 不暴露 worker 权限，先按节点需求探测；审批通道故障后停止同类派发”。
- “轻量编排发现 Skill 缺口，不补造 ledger 也能形成有证据 Reflection”。

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

## 17. 已确定的设计决策与待定 ADR

### 17.1 已确定

1. 四个 Skill 均可独立使用。
2. `verify-agent-output` 是独立的一次性验证 Skill。
3. `run-agent-verify-loop` 继续保留，服务明确要求循环收敛，或在 freeze 前已合理预期同一目标会连续产生多轮新 Artifact 且修复已获授权的任务。
4. 仅在第 5.4 节循环触发条件成立或显式调用时，`/run-agent-verify-loop + 目标` 才按第 5.5 节先冻结
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
