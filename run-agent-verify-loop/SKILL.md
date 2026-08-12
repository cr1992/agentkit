---
name: run-agent-verify-loop
description: "运行显式的 Agent 实现—独立验收有界循环：controller 先冻结 Task Contract、Verification Profile、provider 和轮次限制，再由 implementer 迭代产出 Artifact、独立 reviewer 主动证伪，runtime 通过状态台账、防重放、失败指纹、熔断和人工门推进收敛。当用户明确要求一个 Agent 实现另一个验收、独立 reviewer 反复复查直到通过、设置可恢复的验证循环，或显式调用 /run-agent-verify-loop + 目标时使用。普通目标、一次性独立验收、实现者自测、普通批量处理不适用。"
---

# run-agent-verify-loop：显式实现—验收循环

只在 controller 已明确选择循环模式后运行。Loop 不是普通任务、一次性验收或四 Skill 组合的总入口，
不拥有 Agent 派发、provider 选择、Git 生命周期和全局完成授权。

## 启动闸门

命中以下两类之一才启动：

- 用户明确要求反复修复并由独立 reviewer 验收；
- 用户显式调用 `/run-agent-verify-loop <目标>`。

启动前固定顺序：

1. controller 补齐 objective、scope、acceptance、权限、非目标和停止条件；
2. 缺少可观察验收标准时不创建 Loop；
3. freeze 前完成 capability discovery 和 provider 选择；
4. 冻结 Task Contract、Verification Profile、Skill content digest、limits 与 H gate；
5. 创建 Loop State，再开始 implement → artifact → verify → decide。

普通 Loop 不自动创建宿主持久 Goal。只有用户明确要求持续追踪 Goal 时，controller 才创建外部 Goal
并把不透明 `goal_ref` 绑定进 Loop；Loop completed 仍只是 Goal 的完成证据之一。

## Provider

### 标准组合模式

安装 `verify-agent-output` 时选择 `provider: verify-agent-output`。每轮为冻结 Artifact 创建一个新的
verification run，消费其标准 Evidence Package。Loop 不执行或复制完整 verifier 协议。

### Embedded 独立模式

没有专项 verifier 时，可在 freeze 前明确选择 `provider: embedded`：

- `loop-runtime` 在 clean pinned workdir 执行单阶段 L0；
- 宿主提供新上下文 reviewer，或用户中继第二会话；
- reviewer 仍输出共享 Review Result v1；
- runtime 只生成 `embedded_verification_record`，不能导出、转换或冒充 Evidence Package；
- 无独立 reviewer 时停止，不用实现者自审产生 pass。

进入 embedded L1 前读取 [references/embedded-review-adapter.md](references/embedded-review-adapter.md)。
verifier 行为语义以 `verify-agent-output/references/verification-protocol.md` 为唯一真源；独立安装本 Skill
时，adapter 只携带绑定和最低输入要求，不重定义 verdict。

## Runtime 流程

从宿主解析出的 Skill 目录调用脚本，状态默认放仓库外：

```text
node <skill-dir>/scripts/loop-runtime.mjs capabilities
node <skill-dir>/scripts/loop-runtime.mjs init \
  --contract contract.json --profile profile.json \
  --provider verify-agent-output --state-root <state-root> \
  --max-iterations 3 --consecutive-identical-signature 2
node <skill-dir>/scripts/loop-runtime.mjs record-artifact \
  --loop <loop-dir> --artifact artifact.json --verification-run-id <run-id>
node <skill-dir>/scripts/loop-runtime.mjs record-evidence \
  --loop <loop-dir> --evidence evidence.json
node <skill-dir>/scripts/loop-runtime.mjs next --loop <loop-dir>
node <skill-dir>/scripts/loop-runtime.mjs record-reflection \
  --loop <loop-dir> --input reflection-input.json
node <skill-dir>/scripts/loop-runtime.mjs convergence-report --loop <loop-dir>
node <skill-dir>/scripts/loop-runtime.mjs propose-improvement \
  --loop <loop-dir> --reflection <relative-ref> --input proposal-input.json
node <skill-dir>/scripts/loop-runtime.mjs status --loop <loop-dir>
node <skill-dir>/scripts/loop-runtime.mjs adopt-root --state-root <moved-or-copied-state-root>
```

Embedded 模式在 `record-artifact` 后执行：

```text
run-embedded-l0 → 新上下文 reviewer → record-embedded-review
```

所有状态写命令可带 `--expected-revision <n>`；revision 不匹配时拒绝写入。详细状态迁移见
[references/loop-state-machine.md](references/loop-state-machine.md)，恢复和熔断见
[references/recovery-and-fuses.md](references/recovery-and-fuses.md)。

## 决策规则

- `pass`：无 H gate 时进入 `completed`；有 H gate 时只能 `waiting_human`；
- `fail`：记录稳定 failure signature，再按 policy 进入下一轮或熔断；
- `undecidable` / `blocked_safety`：立即 `stopped` 并升级；
- verification operational abort：`stopped`，不增加 iteration、不生成 failure signature；
- resume 只允许 controller 为 verification abort 绑定新的 verification run；
- max iterations、连续相同失败阈值和 H gate 不能由 implementer 提高或绕过；
- Loop completed 不等于外部 Goal 或全局任务完成。

失败指纹只使用失败 L0 的 `check_id` 和 L1 的 `{contract_item_id, class}`，不对自然语言做猜测归类。

## 状态与证据

- event journal 是真源，snapshot 丢失或落后时从最后完整 event 恢复；
- state root 级扫描所有 Loop journal，原子拒绝重复消费同一 Evidence `run_id`；
- freeze 后每次推进前重算本 Skill content digest；漂移时停止并要求 re-contract；
- full Evidence 与 embedded record 使用不同文件、digest 字段和 assurance，consumer 不得混用；
- runtime 不派发 Agent、不修改业务 Artifact、不创建 worktree、不下载依赖。

### 信任与恢复边界

state root 只应由 controller/operator 与本 runtime 写入。journal digest chain 能发现部分、追加、乱序
和意外损坏，但不是签名或外部不可变锚；能重写整棵 state root 的 writer 可构造另一条自洽历史。
Review nonce 只拒绝未经修改的跨 run 重放，`host_reported` assurance 是调用方声明。当前 Loop 内
`blocked_safety` 优先且不可抵消；跨新 Loop/run 的同一 Artifact 安全记忆属于上层台账/维护流程。
state-root identity 只拒绝未修改的复制或移动；`adopt-root` 会检查已有 Loop journal 与冻结 envelope，
然后代表 operator 显式重新授权当前位置，它不是针对 state-root writer 的防复制证明。doctor 会在身份
错误时返回 `state_root_identity_invalid` 和恢复命令。
Embedded L0 会冻结 executable 与所有实际存在的 argv 文件参数；workdir 内文件同时受 clean pinned
Git Artifact 约束，被 gitignore 的 runner 也不能绕过内容冻结。

`completed` / `stopped` 状态转换会自动 write-new 一个不可变 Convergence Report；`waiting_human`
不是终态，不生成完整报告。Reflection 只绑定可重算摘要的事件、Evidence、Artifact 或诊断文件；
Proposal 永远停留在 `proposed`，不得改变 failure fuse、H gate、verdict 或既有报告。

## 批量边界

一个 Loop 只维护一个收敛对象，不接受批队列。普通批量由 controller / orchestrator 为每个 work
item 建立独立 Loop；批状态、断点续跑、失败上限和连续同因熔断由 orchestration ledger 的
`batch-init / batch-record / batch-status / batch-fuse` 管理。Loop 的 Convergence Report 与稳定
failure signature 是批台账输入，但批台账不能反向改写单个 Loop 的终态。
