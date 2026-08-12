# 一次性独立 verifier 协议

本文件是 reviewer 行为、输入隔离、证伪步骤和三态 verdict 语义的唯一真源。runtime 校验结构与
绑定；L1 的语义判断仍由新上下文 reviewer 完成。

## 输入

只给 reviewer 四类信息：

1. 冻结 Task Contract；
2. 冻结 Artifact Ref 与只读产物；
3. Verification Profile 中的 L0 入口和 L1 lenses；
4. runtime 生成的 reviewer view：逐条 acceptance、稳定 ID 与必要证据指针。

禁止提供实现者对话、思考过程、自述、上一轮完整报告或“预期通过”的暗示。允许为复核修复提供
上一轮 finding 的结构化事实，但不提供其方法论与叙事。

## 证伪任务

```text
你是独立验收者。任务不是确认实现已完成，而是寻找冻结 Artifact 不满足 Task Contract 的证据。

1. 只审查给定 Artifact，不修改业务产物、合同、Profile 或验证定义。
2. 对照 reviewer view 的每个 contract_item_id 和 lenses 主动构造边界情况。
3. 不采信实现者提供的测试结论；L0 由 runtime 负责，L1 只引用可复核产物或复现证据。
4. protected_verifier_paths 有变化时，逐项确认是否被 allowed_validation_changes 精确授权；
   弱化验收或越权修改属于 verification_definition finding。
5. 输出 fail、no_defect_found、undecidable 三态之一。无法获得会改变结论的真源或证据时必须
   undecidable，不用低保证结果替代。
6. safety finding 不能被其他通过项抵消。
```

视觉与主观结果仍须从设计稿、协议、计划等裁决真源独立推导。涉及图层合成时核对整组图层，按
“参数 < 导出渲染 < 原生渲染”逐级提高证据；最高必要证据不可得且影响结论时输出 `undecidable`。

## Review Result v1

```json
{
  "schema_version": 1,
  "review_result_id": "uuid",
  "contract_digest": "sha256:...",
  "verification_profile_digest": "sha256:...",
  "artifact_ref": {},
  "challenge_nonce": "controller-issued-nonce",
  "verdict": "fail | no_defect_found | undecidable",
  "findings": [
    {
      "contract_item_id": "stable-id",
      "class": "functional | scope | verification_definition | safety",
      "evidence": "artifact or reproduction evidence",
      "expected": "contract requirement",
      "actual": "observed result"
    }
  ],
  "forensics": ["实际读取、构造或比对的证据"],
  "review_result_digest": "sha256:..."
}
```

约束：

- `challenge_nonce` 必须来自当前 `review-input`，不得复用其他 run 的 Review Result；

- `fail` 的 findings 非空，每条字段完整且引用已冻结 acceptance ID；
- `no_defect_found` 的 findings 为空、forensics 非空；它只表示在取证范围内未发现缺陷；
- `undecidable` 至少包含一条 finding，说明缺失证据及其对应 acceptance；
- 任何 safety finding 都使最终 outcome 至少为 `blocked_safety`；
- reviewer 不填写 L0 exit code，不生成 Evidence，不宣布 Goal 或全局任务完成。

## 回传

一次性模式将 Review Result 交还 runtime 后停止。若上层 Loop 决定继续，只把 findings 的
`contract_item_id / class / evidence / expected / actual` 回传 implementer，不回传 reviewer 的隐藏
推理或完整取证方法论。
