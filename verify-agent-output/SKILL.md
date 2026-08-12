---
name: verify-agent-output
description: "对冻结的单一 Agent 产物执行一次独立验收：固定 Task Contract、Verification Profile 与 Git Artifact，由隔离上下文 reviewer 主动证伪，runtime 执行 L0、校验 Review Result 并生成不可变 Evidence Package。当用户要求独立 review 某个固定 commit/SHA、一次性验收后停止、为上层 orchestrator 或 Loop 提供标准证据时使用。多节点任务编排、自动修改产物、失败后反复修复、实现—验收循环不适用。"
---

# verify-agent-output：一次性独立验收

只验证一个冻结 Artifact 一次，不修改业务产物，不自动重试，也不宣布全局任务完成。

## 控制权与组合边界

- 当前会话或 `orchestrate-subagents` 担任 controller，负责目标、授权、provider 选择和最终完成判断。
- 本 Skill 只拥有 `smoke L0 → 独立 L1 → final L0 → Evidence` 状态机。
- 与 `manage-worktrees` 组合时消费其 Artifact Ref；没有时接受调用方提供的 clean pinned Git workdir。
- 与 `run-agent-verify-loop` 组合时只返回 Evidence；是否进入下一 iteration 由 Loop 决定。
- 单 Artifact、单 reviewer、只验一次时直接使用本 Skill，不为此启动全局 orchestrator。

## 前置条件

controller 必须先提供：

1. 冻结的 JSON Task Contract，含稳定且唯一的 `acceptance[].contract_item_id`；
2. 冻结的 JSON Verification Profile，只使用 argv 数组定义 L0；
3. 精确 Git Artifact Ref：完整 `base_sha`、`artifact_sha`、object format 与 repository identity；
4. clean workdir，`HEAD == artifact_sha`；
5. 新上下文 reviewer，或由用户中继的第二会话。只有当前实现者上下文时停止，不得伪造独立验收。

详细 envelope 与字段规则见 [references/evidence-schema.md](references/evidence-schema.md)。进入 L1 前必须完整读取
[references/verification-protocol.md](references/verification-protocol.md)。

## 标准流程

从宿主解析出的 Skill 目录调用 runtime，不扫描兄弟 Skill 或全局安装目录：

```text
node <skill-dir>/scripts/verification-runtime.mjs capabilities
node <skill-dir>/scripts/verification-runtime.mjs init \
  --contract contract.json --profile profile.json --artifact artifact.json \
  --workdir <clean-pinned-workdir> --state-root <repo-outside-state-root> \
  --isolation-assurance host_reported
node <skill-dir>/scripts/verification-runtime.mjs run-smoke --run <run-dir>
node <skill-dir>/scripts/verification-runtime.mjs review-input --run <run-dir>
node <skill-dir>/scripts/verification-runtime.mjs record-review \
  --run <run-dir> --review review-result.json \
  --verifier-run-id <opaque-id> --isolation-assurance host_reported
node <skill-dir>/scripts/verification-runtime.mjs run-final --run <run-dir>
node <skill-dir>/scripts/verification-runtime.mjs record-reflection \
  --run <run-dir> --input reflection-input.json
node <skill-dir>/scripts/verification-runtime.mjs propose-improvement \
  --run <run-dir> --reflection <relative-ref> --input proposal-input.json
node <skill-dir>/scripts/verification-runtime.mjs validate --run <run-dir>
```

每次写状态的命令都可带 `--expected-revision <n>`；revision 不匹配时拒绝写入。runtime 输出 JSON，
`init` 返回稳定的 `run_dir` 和 `run_id`。

## 状态与裁决

固定顺序：

```text
initialized → smoke_passed → review_recorded → terminal
```

- smoke 失败：`fail`，不进入 L1；
- L1 `fail`：必须有可复现 finding，终止本次验证；
- L1 `undecidable`：终止并升级，不猜测、不自动重试；
- safety finding：`blocked_safety`，不能被其他检查抵消；
- L1 `no_defect_found` 后必须在同一 Artifact 执行 final L0；
- final 全绿才可输出 `pass`；`pass` 只表示 `completion_scope: verification_only`。

任何 Git 身份变化、dirty workdir、Skill 内容漂移、provider 不兼容或日志完整性错误进入 operational
`aborted`，不冒充 Artifact verdict。修复后创建新 run；不要原地续写旧 Evidence。

## 独立 reviewer

给 reviewer 的输入只包含 Contract、Profile 生成的验证入口、Artifact 和去除实现者叙事的 reviewer
view。不得传实现过程对话、“已经测试通过”等自述或期待通过的暗示。

reviewer 主动寻找不满足合同的证据，输出 Review Result v1。controller 负责把 reviewer 的 JSON 写入
临时文件并交给 `record-review`；runtime 机械拒绝未知 acceptance ID、无证据 finding、无 forensics
的 `no_defect_found` 和 digest/binding 不匹配。

## Evidence 与恢复

- state root 默认放仓库外；仓库内落状态必须获得用户许可。
- runtime 先脱敏再持久化日志，按内容摘要 write-new，不保存原始未脱敏日志。
- event journal 是恢复真源；snapshot 丢失或落后时从最后一个完整 event 恢复。
- Evidence 绑定 Contract、Profile、repository、Artifact、reviewer provenance 和三阶段结果。
- `validate` 重算所有摘要；`doctor` 检查 journal、snapshot、Skill drift 与 Evidence 一致性。

## 信任边界

state root 只应由 controller/operator 与本 runtime 写入。event journal 的 digest chain 能发现部分、
追加、乱序和意外损坏，但不是签名或外部审计锚；能重写整个 state root 的 writer 可制造另一条自洽
历史。Review `challenge_nonce` 只拒绝未经修改的跨 run 重放，`host_reported` isolation assurance 是
调用方声明，不证明宿主隔离。safety 在当前冻结 run 内优先且不可抵消；同一 Artifact 跨新 run 的
安全记忆由上层台账或维护流程负责。L0 的 executable 与所有实际存在的 argv 文件参数都会冻结参数
路径、realpath 和内容；workdir 内参数还同时受 clean pinned Git Artifact 约束。

runtime 不派发 Agent、不创建 worktree、不运行 shell command string、不下载依赖，也不修改 Artifact。

## 反思与受控改进

只在漏检、误报、`undecidable`、runtime abort、用户纠正或协议冲突等事件出现时记录 Reflection；
普通成功步骤不做长复盘。每个 evidence ref 都必须能在 state 目录内重算摘要；无稳定证据的观察只能
标为 low confidence。Reflection 禁止保存 chain-of-thought，并在写盘前脱敏凭证与本地路径。

`propose-improvement` 只能基于当前 run 已登记且带证据的 Reflection，输出不可变
`lifecycle: proposed` 候选。它不能修改 Skill、Profile、Evidence、verdict 或当前运行状态语义。
