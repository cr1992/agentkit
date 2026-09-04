# Verification v1 envelope 与证据约束

## 目录

1. 公共摘要规则
2. Task Contract
3. Verification Profile
4. Artifact Ref
5. Reviewer Input / Review Result
6. Evidence Package
7. Git 与路径约束
8. 派发与前置检查（prepare / readiness / review-bundle）

## 1. 公共摘要规则

所有机器输入必须是 JSON。解析时拒绝重复 key、非法 Unicode surrogate 与非有限 number；摘要使用
RFC 8785 canonical JSON 的 UTF-8 字节并以 `sha256:<hex>` 表示。每个 envelope 的 digest 对移除
自身 digest 字段后的完整对象计算。

## 2. Task Contract

必需字段：`schema_version: 1`、`contract_id`、非空 `objective`、`scope.include/exclude`、非空
`acceptance`、`permissions`、`environment`、`skill_set`、`stop_conditions`、`extensions` 和
`contract_digest`。每个 acceptance item 包含唯一非空 `contract_item_id` 与 `requirement`。

`skill_set` 必须记录实际参与本轮决策的 Skill 名称、版本、`content_digest` 和 provider mode。
`provider_mode` 只接受 `primary | optional`，由 `preflight/init` 按 schema 严格校验，其他值一律拒绝。

## 3. Verification Profile

必需字段：`schema_version: 1`、`profile_id`、`l0_checks`、`l1_review`、protected/allowed path、
`runtime`、`human_gate` 与 `verification_profile_digest`。

每个 L0 check：

```json
{
  "check_id": "unit",
  "argv": ["node", "--test"],
  "cwd_rel": ".",
  "stage": "smoke | final | both",
  "timeout_ms": 120000,
  "expected_exit_codes": [0]
}
```

`argv[0]` 必须在 `runtime.executable_paths` 映射到绝对可执行文件；runtime 不调用 shell。
`runtime.env_allowlist` 只列变量名；`network_policy` 是 `denied` 或 `contract_authorized`；
`cache_policy` 是 `disabled | isolated | trusted_identity`；`max_log_bytes` 必须为正整数。

`l1_review` 是非空数组，每项形状为：

```json
{
  "contract_item_id": "acceptance-item-id",
  "lenses": ["functional", "scope", "verification_definition", "safety"]
}
```

`contract_item_id` 必须引用 Task Contract；`lenses` 只能使用上述四值。`human_gate` 只能是
`none | release | destructive | external_side_effect`。`network_policy: denied` 时，`preflight/init`
还要求宿主显式传入 `--network-isolated`，该旗标是宿主 assurance，不由 runtime 自行推断。

## 4. Artifact Ref

必需字段：`schema_version: 1`、`provider`、`repository_id`、`object_format`、完整 `base_sha` 和
`artifact_sha`。branch 只可作为 `branch_hint`，不得用于身份绑定。

v1 runtime 通过 Artifact 可达的 root commit 集合计算 repository identity：

```text
git:<object_format>:sha256(<排序后的 root commit JSON>)
```

调用方使用其他稳定 identity 时可保留自己的 opaque 值，但 runtime 会同时冻结并校验
`runtime_repository_identity`，避免当前 run 内换仓。

## 5. Reviewer Input / Review Result

`review-input` 顶层提供 `contract_digest`、`verification_profile_digest`、`artifact_ref` 和
`challenge_nonce`。Review Result v1 必须原样复制这四个绑定；controller 不得在 reviewer 输出后补写
或修改元数据。完整 Review Result 形状见 [schemas/review-result-v1.schema.json](../../schemas/review-result-v1.schema.json)。

## 6. Evidence Package

Evidence 包含 `run_id`、protocol/runtime version、Contract/Profile 摘要、Artifact、三阶段结果、
`terminal_outcome`、`completion_scope: verification_only`、human gate 标记、provider 与 reviewer
provenance、runtime 生成的 RFC3339 时间和 `evidence_digest`。

`init` 必须在 reviewer 执行前冻结计划使用的 `host_reported | user_relayed` isolation assurance；
若 smoke 失败导致 L1 未运行，Evidence 保留该计划 assurance，并在 limitations 标记 `l1_not_run`。

terminal outcome 仅为：`pass | fail | undecidable | blocked_safety`。operational abort 不生成
Evidence。日志先脱敏，再按内容摘要持久化；Evidence 只引用日志摘要和相对 ref。

版本化 JSON Schema 位于 [schemas/](../../schemas/)；runtime 仍执行跨字段、Git 和 digest 机械校验，不能只靠
结构 schema 宣称验证成立。

## 7. Git 与路径约束

- base/artifact 必须是完整 commit object，base 是 artifact ancestor；
- 每个 gate 前后要求 clean workdir 且 `HEAD == artifact_sha`；
- protected path 只接受精确相对路径或以 `/` 结尾的目录前缀；
- 拒绝 wildcard、path magic、绝对路径、反斜杠、空段与 parent traversal；
- 未被 `allowed_validation_changes` 覆盖的 protected path 变化在 L1 前失败。

## 8. 派发与前置检查

这三个命令只服务于「把输入准备好、把验收派出去」，都不产生 verdict，也不写 Evidence。

### 8.1 `prepare --workdir <dir> [--out-dir <dir>]`

薄串联：`scaffold --kind contract` + `scaffold --kind profile` + TODO 清单 + 后续命令清单。
带 `--out-dir` 时写出 `contract.json` 与 `profile.json`（已存在即拒绝覆盖），否则把两个骨架内联
返回。**它不猜测任何测试命令，也不内置任何项目专属 preset**；输出的 `notice` 固定声明
「Verification Profile 的 `l0_checks` 需 controller 按项目实际填写并确认」。`prepare` 不代跑
`readiness` 与 `preflight`，只在 `next_steps` 给出命令行。

### 8.2 `readiness --contract <json> --profile <json> --workdir <dir> [--state-root <dir>]`

只机械检查环境前提。`contract_readable` / `profile_readable` 是**门槛项**：输入不可读或解析失败时
只以 blocker 形式出现（`blockers[]`），不进入 `checks[]`。其余检查项在其所需输入可用时照常执行并
逐项产出 `{check_id, ok, detail}` 进入 `checks[]`（`workdir_git_root` / `state_root_writable` 无输入
依赖；`executable:*` / `l0_cwd:*` / `argv_file:*` 三类仅依赖 Profile，与合同无关）：

| check_id | 判据 |
| --- | --- |
| `contract_readable` / `profile_readable` | 门槛项：输入可读且能严格解析；失败只出现在 `blockers[]` |
| `workdir_git_root` | workdir 存在、是目录，且是 Git worktree 根目录 |
| `state_root_writable` | state root（或其最近的已存在祖先）是目录且可写 |
| `executable:<name>` | `runtime.executable_paths` 的每个绝对路径存在、是文件、可执行 |
| `l0_cwd:<check_id>` | `resolve(workdir, cwd_rel)` 存在、是目录、不越出 workdir |
| `argv_file:<check_id>:<index>` | argv 中**在 workdir 下 resolve 后确实存在**的文件参数可读 |

argv 参数沿用 L0 冻结逻辑的同一口径：不猜测哪些参数是文件，只对已经存在的路径做可读性检查。
`runtime.env_allowlist` 中的变量是否为 L0 必需无法机械判定，因此只写进 `notes`，既不猜也不拦。

输出为 `{ready: true, ...}` 或 `{ready: false, blockers: [{kind: 'precondition', check_id, detail}], ...}`，
并固定带 `blocker_semantics: 'blocked_precondition_not_artifact_defect'`。CLI 在 not ready 时以退出码
2 表达，与 `preflight` 同口径。

**readiness 失败 ≠ 产物缺陷。** 它只表示环境前提未就绪，归类为 blocked/precondition，不构成
Artifact `fail`，也不进入任何 terminal outcome。

`run-smoke` 会先内联跑一次同样的检查，未通过时拒绝执行 L0 并记录 `stale_precondition` operational
abort——这正是本命令存在的理由：环境问题不该以「L0 跑挂」的形式与产物缺陷混在一起。内联版本
排除 `executable:*` 与 `argv_file:*`，这两类在 run 内已被冻结身份门禁接管，漂移仍判
`check_runtime_failure`，避免同一现象出现两种 abort 语义。

### 8.3 `review-bundle --run <run-dir> [--out <path>]`

要求 run 已 `smoke_passed`。输出一份自包含 JSON（stdout 或 `--out` 落盘），字段：

| 字段 | 内容 |
| --- | --- |
| `reviewer_prompt` | 标准 reviewer 提示词：证伪任务原文（取自 `verification-protocol.md` 的「证伪任务」段）+ 三态 verdict、finding 五字段、forensics、safety 不可抵消、绑定原样复制等输出契约 |
| `review_input` | `review-input` 全量，含两个 digest、`challenge_nonce` 与 `reviewer_view` |
| `review_result_schema` | 内联的 `schemas/review-result-v1.schema.json` |
| `artifact_ref` / `workdir` | 冻结 Artifact 与 workdir 绝对路径 |
| `permissions` | `read_only`，显式列出禁止的 commit / checkout 等操作 |
| `stop_conditions` | 三态 verdict 产出后立即停止 |
| `digest_backfill` | `digest --kind review` 命令行与「不要手写 digest」说明 |
| `contract_kind` | `public \| projected` |

`contract_kind` 的判据是 `contract.extensions.projection` 是否存在。投影场景下 bundle 的合同部分
就是投影合同本身（`review-input` 本就如此），runtime 不做二次裁剪；该字段只是给 reviewer 的提示：
只对被投影的 acceptance 取证，不越界评判未投影条目。
