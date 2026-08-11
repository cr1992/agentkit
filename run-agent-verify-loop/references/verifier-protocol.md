# verifier 协议

独立 verifier 的完整协议：输入规范、提示词模板、三态输出 schema、取证要求、回传规则。orchestrator 每轮验证按本文件组装 verifier。

## 输入规范

给 verifier 的（全部四样，不多不少）：

1. 任务契约全文。
2. 产物：diff / 文件清单 / 记录集，或其稳定指针。
3. 验证入口：l0_checks 的命令与运行方式、环境前置条件。
4. verifier_view：逐项状态 + 证据指针，不含实现者叙事。

禁止给 verifier 的：

- 实现者的对话、思考过程、自述——「我已完成并测试通过」这类陈述是最强的污染源。
- 上一轮 verifier 的完整报告。可以给上一轮的 fail 项清单用于确认修复，但不给其推理过程。
- 任何「预期它应该通过」的暗示。

## verifier 提示词模板

```text
你是独立验收者。你的任务不是确认工作已完成，而是设法找出它不满足契约的证据。

[任务契约]
{contract}

[产物]
{artifact_or_pointer}

[验证入口]
{how_to_run_l0_checks}

[逐项状态]
{verifier_view}

要求：
1. 在最终产物上亲自执行全部 l0_checks，记录命令与退出码。不得采信任何他人提供的运行结果。
2. 对照契约 objective 和 l1_review 范围逐条检查产物，主动构造边界情况尝试证伪。
3. 若产物改动了 protected_verifier_paths 内的文件：核对每处改动是否在 allowed_validation_changes 授权范围内、是否与契约目标一致（如基线更新对应契约声明的预期变化）；任何弱化验收的改动直接判 fail。
4. 按输出 schema 给出三态之一。报 no-defect-found 必须附带你实际执行的取证记录；无取证的通过无效。
5. 无法判定时输出 undecidable 并说明缺什么，不许猜。
6. 涉及视觉/布局/行为偏差的判词，预期值必须从裁决真源（设计稿帧、协议、计划文档）独立推导，
   不得以表面测量差值直接定罪。证据与结论必须耦合：你自己的证据已解释掉大部分偏差时，
   结论必须同步降级或撤销；开出「改变现状」的处方前，先证明真源支持该方向。
   视觉对照的对象是**整组图层**（含矢量装饰、投影、模糊、渐变、描边层），不是单一位图填充；
   逐层枚举真源图层并核对去处，未被实现且未被显式豁免的图层即缺陷。
   视觉基准按「图层参数 < 导出渲染 < 画布原生渲染」递进；涉及投影、模糊、混合模式、渐变等
   效果或合成时，以最高可用档裁决，有争议升到最高档。最高档不可得且会改变结论时输出
   `undecidable` 并声明缺口，不得用低档结果替代。
```

## 输出 schema

```json
{
  "verdict": "fail | no-defect-found | undecidable",
  "l0_results": [
    {"check": "<命令>", "exit_code": 0, "summary": "<关键输出摘要>"}
  ],
  "findings": [
    {
      "item": "<不满足契约的点>",
      "evidence": "<怎么触发：命令 / 输入 / 步骤>",
      "expected": "<契约要求>",
      "actual": "<实际表现>"
    }
  ],
  "forensics": [
    "<报 no-defect-found 时：跑了什么、读了什么、比对了什么>"
  ],
  "undecidable_reason": "<verdict=undecidable 时：缺什么才能判定>"
}
```

语义约束：

- verdict 只有三态，没有「保证正确」。no-defect-found 的含义是「在取证范围内未发现缺陷」。
- fail 时 findings 不可为空，每条必须带可复现的 evidence。
- no-defect-found 时 forensics 不可为空，且 l0_results 必须全部退出码为零。
- undecidable 不是失败，是诚实——orchestrator 收到后升级给用户，不重试。

## orchestrator 侧机械核验

收到 verifier 输出后，orchestrator 按规则核验，不动用判断：

1. no-defect-found 但 forensics 为空：输出无效，重新组装 verifier 再验。
2. no-defect-found 但 l0_results 有非零退出码：输出自相矛盾，无效。
3. fail 但 findings 缺 evidence：打回 verifier 补证据。
4. diff protected_verifier_paths：存在 allowed_validation_changes 之外的改动——不论 verdict 是什么，直接停机升级。

## 回传规则（fail 回内环）

回传给 implementer 的只有 findings 数组：每条的触发方式、期望、实际。不回传 verifier 的检查方法论和取证清单——防止 implementer 面向清单打补丁而不是面向契约修复。

## 实例规则

- 每轮验证新开 verifier 实例，不复用；旧实例带着上一轮的沉没判断。
- 高风险任务可开 N 个 verifier 独立证伪（互不可见彼此结论），任一 fail 即 fail；票数由契约或用户定。
