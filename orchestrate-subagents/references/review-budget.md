# Reviewer 数量与 Token 预算

只在 controller 考虑派独立 reviewer、critic 或 judge 时读取。本规则限制昂贵 L1 取证，不降低
`verify-agent-output` 对单次冻结 Artifact 的完整性要求。

## 默认策略

普通 worker self-check 与 controller recheck 不计入独立 reviewer 配额。对同一 Artifact：

- smoke/preflight 未通过时不派 reviewer；
- 默认最多 1 次 primary independent review；
- 默认最多 1 次 escalation review，且必须使用不同 lens；
- escalation 只能由 `undecidable`、可复现证据冲突或协议歧义触发；
- `blocked_safety` 直接停止并升级给人，不用更多 reviewer 抵消；
- 每次请求必须说明会改变哪个决策，并估算 reviewer 输入 tokens；超预算先投影合同或缩小 scope；
- 同 Artifact、同 lens 的重复 review 复用已有 Evidence，不重新派发。

高风险不等于 reviewer 越多越好。第二 reviewer 只有在独立证据可能改变处置时才有价值；多个普通
worker 也不做 1:1 reviewer 配对，优先验证最终集成候选。

## 冻结策略

公共 Task Contract 可在 `extensions.review_policy` 冻结：

```json
{
  "schema_version": 1,
  "max_primary_reviews_per_artifact": 1,
  "max_escalation_reviews_per_artifact": 1,
  "require_distinct_lens": true,
  "review_only_after_smoke_pass": true,
  "max_review_input_tokens": 12000
}
```

这些上限是当前任务的成本与停止条件。提高数量或 token 上限属于 re-contract，需要 controller 明确
说明新增 reviewer 会改变的决策；reviewer/worker 不能自行提高。

## 派发前机械门禁

把已完成 review 的最小历史与新请求写成 JSON，然后执行：

```text
node <skill-dir>/scripts/review-budget.mjs evaluate \
  --policy <review-policy.json> \
  --history <review-history.json> \
  --request <review-request.json>
```

请求字段：

```json
{
  "schema_version": 1,
  "artifact_digest": "sha256:...",
  "lens": "protocol_semantics",
  "kind": "primary",
  "decision_impact": "该 finding 会决定是否接受 direct response lifecycle",
  "smoke_passed": true,
  "estimated_input_tokens": 6000,
  "escalation_trigger": null
}
```

`allowed: false` 时按 `next_action` 缩小输入、复用现有 review、先跑 smoke，或停止并升级；不得绕过
门禁直接派发。runtime 只做纯函数判断，不派 Agent、不读取源码、不修改 ledger。

`estimated_input_tokens` 使用宿主实际计数；宿主不暴露时以即将投递的 UTF-8 字符数作为保守代理并在
台账注明 `estimated`。运行后把实际 token 使用写回节点 `tokens`，用于 `status.summary.token_accounting`。
