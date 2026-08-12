# Embedded reviewer adapter

本 adapter 只在 freeze 前明确选择 `provider: embedded` 时使用。它定义 standalone Loop 如何准备
最小 reviewer 输入、绑定共享 Review Result，以及 embedded assurance 的缺口；不复制完整 verifier
行为协议。

## 前置条件

1. 当前 iteration 已绑定完整 Git Artifact Ref；
2. workdir clean 且 `HEAD == artifact_sha`；
3. `run-embedded-l0` 已完成；
4. reviewer 是宿主新上下文，或由用户中继的第二会话；
5. reviewer 不可读取实现者过程对话、自述和期待通过的暗示。

只有当前实现者上下文时停止。L2 自查不能满足 embedded L1，也不能产生 pass record。

## Reviewer 输入

只提供冻结 Contract、Profile 中的 L1 lenses、Artifact、L0 入口/结果与去污染 acceptance view。
reviewer 按 canonical verifier protocol 主动证伪，输出 Review Result v1。

`record-embedded-review` 必须校验：

- Contract/Profile digest；
- 当前 loop ID、iteration 与 Artifact；
- 当前 iteration 的 `challenge_nonce`，拒绝跨轮重放；
- acceptance ID、finding class 与 evidence；
- `no_defect_found` forensics；
- Review Result digest；
- `host_reported | user_relayed` assurance 和 opaque reviewer run ID。

## 保证边界

生成物固定为 `record_type: embedded_verification_record`，使用 `record_digest`。它缺少标准 verifier 的
smoke/final 双阶段、内容寻址 Evidence 消费协议和可移植 run provenance，只能推进创建它的 Loop。

必要的结构 schema 位于 [schemas/](schemas/)；其中 Review Result v1 schema 必须与 verifier Skill 的
同版本文件逐字节兼容，但本目录不复制 reviewer 行为协议。

任何 consumer 必须拒绝把 embedded record 当 Evidence Package；不得添加 `evidence_digest`，也不得
通过字段重命名或 wrapper 转换提高 assurance。
