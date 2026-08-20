# 编排运行时 v1

本运行时用于 `orchestration_mode: full`。`SKILL.md` 定义的 `≤3` 个独立只读 worker 轻量档使用仓库外
JSON 快照，不初始化本 ledger；两种档位都先通过 `worker-capability-preflight.mjs` 校验节点所需有效
能力。任一轻量资格失效时，将节点、宿主派发回执和已有产物收养到本 ledger 后继续。

`contract-tool.mjs` 是 Task Contract 的机械入口：

```text
normalize --input <json>
validate --input <json>
digest --input <json>
review-view --input <json>
diff --left <json> --right <json>
```

`orchestration-ledger.mjs` 只记录控制面的已发生事实，不直接派发 Agent：

```text
init --contract <json> --state-root <dir>
add-node / add-edge / dispatch-record / update / attach
batch-init / batch-record / batch-status / batch-fuse
record-reflection / propose-improvement
status / inspect / rebuild / doctor / capabilities
```

`capabilities` 同时输出独立的 `protocol_version`、`runtime_version` 和 Skill tree `content_digest`。
当前协议版本为 `1.1.0`，ledger runtime 为 `1.5.0`；三者分别表达兼容语义、脚本实现和精确安装内容，
不能互相替代。

所有修改命令支持 `--expected-revision`。状态默认写在业务仓库外；宿主派发回执必须通过
`dispatch-record` 绑定精确 worker identity、本地 tier、model、reasoning effort、attempt lineage、
动态调整动作、选择理由、配置来源 / 确认状态、能力证据、派发 provenance、token budget 和
`max_attempts`。完整档的
`capability_fingerprint` 必须是当轮实时复核过的 `sha256:` 摘要；未知字段和缺字段均拒绝。示例：

`resolve_model_policy.mjs` 输出的是 `model-policy-resolution` schema v1；其
`dispatch_record_patch` 与下列 v2 dispatch 的同名字段可直接合并。Controller 仍须补齐
`schema_version / worker_id / orchestration_mode / capability_source / capability_fingerprint /
token_budget`。两种记录各自版本化，不能把 resolver 顶层 envelope 当作 dispatch 写入 ledger。

```json
{
  "schema_version": 2,
  "worker_id": "opaque-worker-id",
  "orchestration_mode": "full",
  "attempt_id": "opaque-attempt-id",
  "attempt": 1,
  "previous_attempt_id": null,
  "tier": "primary",
  "model": "provider-primary-current",
  "reasoning_effort": "medium",
  "adjustment_action": "initial",
  "failure_kind": null,
  "failure_ref": null,
  "selection_reason": "规范明确且测试可低成本发现偏差",
  "config_source": ["user-host:<path>/hosts/<host>.json"],
  "configuration_state": "persisted-config",
  "model_resolution_state": "discovered-and-validated",
  "capability_source": "cache:<path>+live-validation",
  "capability_fingerprint": "sha256:...",
  "dispatch_provenance": "explicit",
  "token_budget": "unsupported",
  "max_attempts": 3
}
```

示例模型名不是推荐值。`configuration_state` 只接受 `user-explicit / session-inferred /
session-confirmed / persisted-config / host-default`；它说明偏好如何形成，不替代宿主调用参数或回执。
`doctor` 会重新校验持久化 dispatch。

`model_resolution_state` 只接受 `discovered-and-validated / user-explicit-unverifiable /
host-default-unexposed`。第二种必须同时是 `configuration_state: user-explicit`；第三种必须使用
`model: host-default`、`configuration_state: host-default` 和 `dispatch_provenance: host-default`。

验收失败后的重派必须创建新节点；前序节点先附 `report` 或 `evidence` 并进入 `failed`。新 dispatch
使用连续 `attempt`，通过 `previous_attempt_id` 指向前序 dispatch，并用 `failure_ref` 指向前序节点的
稳定失败附件摘要。ledger 拒绝重复 attempt ID、不连续 lineage、未失败前序或错绑证据。环境、合同、
安全和不可判定失败不属于可重路由类型，不能写进重派 dispatch。

## Worker 有效能力预检

`worker-capability-preflight.mjs` 不派发探针，只校验 controller 提供的 Requirements 与 Effective
Capability：

```text
capabilities
normalize --input <effective.json>
check --requirements <requirements.json> [--effective <effective.json>]
```

没有 required capability 时允许缺省 effective 文件；有要求但缺记录时返回
`scoped_probe_or_replan`。binding / 指纹不匹配或过期返回 `refresh_effective_profile`；策略拒绝、审批
通道故障和执行故障分别返回 `replan_or_controller`、`stop_same_class_and_escalate`、
`stop_same_class_and_diagnose`。具体结构见对应两个 v1 schema。

## 轻量 Reflection

轻量档通过独立入口记录改进输入，不初始化 ledger：

```text
node scripts/orchestration-reflection.mjs record --state-root <session-state> --input <reflection-input.json>
node scripts/orchestration-reflection.mjs propose --state-root <session-state> --reflection <relative-ref> --input <proposal-input.json>
```

`record` 的 `evidence_refs[].id` 必须是 state root 内相对路径，并逐项校验文件摘要；没有证据只能记录
`confidence: low`。`propose` 重验 Reflection 与证据，只生成 `lifecycle: proposed`。完整档仍由 ledger
登记同一 v1 Reflection / Proposal，二者不需要共享 journal。

每个 `add-node` 输入必须显式包含：

```json
{
  "verification": {
    "requirement": "worker_self_check | controller_recheck | independent_evidence",
    "provider": "none | verify-agent-output",
    "artifact_scope": "node_output | integration_candidate | not_applicable"
  }
}
```

`worker_self_check` 有任一稳定输出即可通过，只能报告该最低保证。`controller_recheck` 先附稳定输出，
再附以下 report；它必须完整覆盖当时除其他 Controller Recheck Record 外的稳定输出摘要。机器结构见
[Controller Recheck Record v1](schemas/controller-recheck-record-v1.schema.json)：

```json
{
  "schema_version": 1,
  "report_type": "controller_recheck",
  "contract_digest": "sha256:...",
  "stable_output_digests": ["sha256:..."],
  "outcome": "pass",
  "checked_at": "RFC3339"
}
```

`independent_evidence` 要求公共合同预先冻结 `verify-agent-output` provider 与 Skill 摘要，只接受一个
标准 Artifact Ref，以及结构、摘要、合同和 Artifact 绑定都有效的 Evidence Package。进入 `passed`
时，后两档的 `update` 输入必须用 `verification_ref` 指向被采信的 report / Evidence attachment digest；
Evidence 必须为 `terminal_outcome: pass` 且不再要求 human gate。节点终态后不再接受 attachment。
`status.summary.verification_assurance` 分别计数三档和 `none`，`doctor` 重新执行同一门禁。

**Token 消耗与成本核算（v1.2）**：`update` 支持记录节点消耗的 `tokens`（非负安全整数，或字段完整的 `{ input_tokens, output_tokens, total_tokens }`，其中 `total_tokens = input_tokens + output_tokens`）及非负安全整数 `duration_ms`。`status` 命令在 `summary.token_accounting` 中自动汇总总 Token 与按角色分级的消耗分布，支持计算多 Agent 分发相比全量顶配模型的 Token 节省率；`doctor` 使用同一校验器复核持久化节点。

**合同投影（v1.2）**：Evidence 的合同绑定有两条合法路径，缺省仍是全等——verify-agent-output
那次验证直接使用本 ledger 的公共合同（同一份 JSON、同一个摘要）。多节点图下若多个节点各自
独立验收，公共合同的 acceptance 条目往往覆盖全图，reviewer 会拿其他节点的条目审出假 fail；
此时改用**投影合同**：从公共合同切出该节点产物专属的条目子集，作为该节点的验证合同。

投影合同由 `contract-tool.mjs project` 生成，不得手写：

```bash
node scripts/contract-tool.mjs project --input <公共合同.json> --items <item-id1,item-id2> \
  [--contract-id <显式 id>] > node-contract.json
```

投影只允许改动**四项**：`contract_id`、`acceptance`（收窄为父合同条目的子集）、
`extensions.projection`（血缘）、`contract_digest`（重签）。其余顶层字段——`objective / scope /
permissions / environment / skill_set / stop_conditions`，以及父合同自带的任何扩展顶层字段——
逐字节原样继承；`extensions` 去掉 `projection` 键后也必须与父合同完全一致。选中的 acceptance
条目**逐字节 verbatim** 拷贝，不得改写措辞。血缘写在：

```json
{
  "extensions": {
    "projection": {
      "parent_contract_digest": "sha256:...",
      "projected_item_ids": ["item-id1", "item-id2"]
    }
  }
}
```

`contract_id` 缺省为 `<父 contract_id>--proj-<8 位随机>`，`contract_digest` 按 RFC 8785 重算。
未知条目 id、空 `--items`、重复 id、父合同缺摘要或摘要不自洽一律报错。

ledger 侧用 `attach --type contract` 登记：只有 `independent_evidence` 节点可附，每节点至多一份，
终态节点不再接受，且必须在附 Evidence 之前登记。attach 时机械校验血缘与条目子集；随后
`validateEvidencePackage` 接受 `evidence.contract_digest` 等于公共合同摘要**或**该节点这份投影合同
的摘要。`update --state passed` 与 `doctor` 对 `passed` 节点复跑同一门禁，attachments 目录被改写
会在 doctor 现形。没有 contract attachment 的节点行为与 v1.1 完全一致。

**反张冠李戴保证如何保持**：换一个任务的合同来交差，被 `parent_contract_digest !== ledger 公共合同
摘要` 拦下；把条目措辞改宽松，条目的 canonical JSON 摘要不再命中公共合同的条目摘要集合，被拦下；
夹带公共合同里没有的自造条目，同样被条目子集校验拦下；`acceptance` 的 id 集合必须与
`projected_item_ids` 完全一致，防止声明与实际条目不符；改写 `objective / scope / permissions /
environment / skill_set / stop_conditions` 或其他 `extensions` 键，被逐字段全等校验拦下并指名是哪个
字段——放宽 `permissions` 或掉包 `scope` 骗过 reviewer 这条路是堵死的。子集校验取的父条目集合来自
ledger 目录里的 `contract.json`，使用前先要求 `envelopeDigest(contract.json) === snapshot.contract_digest`，
否则换掉那份文件就能给私货投影背书。因此投影只能**收窄**验收面，不能改写或扩张它——仍然不要通过
复制改写公共合同来伪造"等值"，那会破坏合同摘要的审计意义。

从 runtime 1.0 升级到 1.1 时，旧 `add-node` 输入必须补齐 `verification`；缺省不再等价于最低档。
Ledger v1 schema 仍可读取旧快照，但 Skill content digest 已变化的旧 ledger 只允许审计，继续写入前
必须 re-contract，不做原地补字段或静默升级。

批级熔断属于此 ledger；每个 Loop 仍只维护自己的单个收敛对象。

Reflection 与 Improvement Proposal 是追加式改进输入；轻量档也有 ledger-independent 的同 schema
入口。Proposal 的生命周期固定为 `proposed`，
当前执行面不读取它，也不会据此改写合同、节点状态或验收结论。
