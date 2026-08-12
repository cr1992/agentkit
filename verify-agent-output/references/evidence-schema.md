# Verification v1 envelope 与证据约束

## 目录

1. 公共摘要规则
2. Task Contract
3. Verification Profile
4. Artifact Ref
5. Evidence Package
6. Git 与路径约束

## 1. 公共摘要规则

所有机器输入必须是 JSON。解析时拒绝重复 key、非法 Unicode surrogate 与非有限 number；摘要使用
RFC 8785 canonical JSON 的 UTF-8 字节并以 `sha256:<hex>` 表示。每个 envelope 的 digest 对移除
自身 digest 字段后的完整对象计算。

## 2. Task Contract

必需字段：`schema_version: 1`、`contract_id`、非空 `objective`、`scope.include/exclude`、非空
`acceptance`、`permissions`、`environment`、`skill_set`、`stop_conditions`、`extensions` 和
`contract_digest`。每个 acceptance item 包含唯一非空 `contract_item_id` 与 `requirement`。

`skill_set` 必须记录实际参与本轮决策的 Skill 名称、版本、`content_digest` 和 provider mode。

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
`max_log_bytes` 必须为正整数。

## 4. Artifact Ref

必需字段：`schema_version: 1`、`provider`、`repository_id`、`object_format`、完整 `base_sha` 和
`artifact_sha`。branch 只可作为 `branch_hint`，不得用于身份绑定。

v1 runtime 通过 Artifact 可达的 root commit 集合计算 repository identity：

```text
git:<object_format>:sha256(<排序后的 root commit JSON>)
```

调用方使用其他稳定 identity 时可保留自己的 opaque 值，但 runtime 会同时冻结并校验
`runtime_repository_identity`，避免当前 run 内换仓。

## 5. Evidence Package

Evidence 包含 `run_id`、protocol/runtime version、Contract/Profile 摘要、Artifact、三阶段结果、
`terminal_outcome`、`completion_scope: verification_only`、human gate 标记、provider 与 reviewer
provenance、runtime 生成的 RFC3339 时间和 `evidence_digest`。

`init` 必须在 reviewer 执行前冻结计划使用的 `host_reported | user_relayed` isolation assurance；
若 smoke 失败导致 L1 未运行，Evidence 保留该计划 assurance，并在 limitations 标记 `l1_not_run`。

terminal outcome 仅为：`pass | fail | undecidable | blocked_safety`。operational abort 不生成
Evidence。日志先脱敏，再按内容摘要持久化；Evidence 只引用日志摘要和相对 ref。

版本化 JSON Schema 位于 [schemas/](schemas/)；runtime 仍执行跨字段、Git 和 digest 机械校验，不能只靠
结构 schema 宣称验证成立。

## 6. Git 与路径约束

- base/artifact 必须是完整 commit object，base 是 artifact ancestor；
- 每个 gate 前后要求 clean workdir 且 `HEAD == artifact_sha`；
- protected path 只接受精确相对路径或以 `/` 结尾的目录前缀；
- 拒绝 wildcard、path magic、绝对路径、反斜杠、空段与 parent traversal；
- 未被 `allowed_validation_changes` 覆盖的 protected path 变化在 L1 前失败。
