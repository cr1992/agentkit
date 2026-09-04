# 恢复、防重放与熔断

## Journal 与 revision

- 每次 mutation 在 state-root lock 内检查 `expected_revision`；
- event journal 先 fsync 追加完整 next snapshot，再原子替换 snapshot cache；
- snapshot 缺失或落后时，以最后一个完整 event 为真源恢复；
- `doctor` 只报告 snapshot、lock 与 Skill drift，不删除或猜测修复状态。

## Evidence 防重放

`record-evidence` 持有 state-root 级锁，扫描该 root 下所有 Loop journal 的
`consumed_verification_run_ids`。run ID 已出现时拒绝；新消费与 Loop next snapshot 写在同一 event，
因此 snapshot 写入前崩溃仍能从 journal 发现消费记录。

Evidence 还必须绑定当前 Contract digest、Profile digest、Artifact、iteration verification run ID 和
自身 digest。只复制 Evidence 文件但未成功追加 event 不构成消费；重试时内容必须一致。

## 失败指纹

只把以下稳定 ID 排序去重后做 canonical JSON SHA-256：

- failed L0 `check_id`；
- L1 `{contract_item_id, class}`。

自然语言 evidence、expected、actual 和 summary 不进入指纹。runtime 不猜测不同文本是否语义同因。

连续相同指纹达到冻结阈值、达到 max iterations、policy=stop、undecidable 或 safety finding 时确定性
停止。阈值不能由 implementer 或 reviewer 在运行中提高。

## Skill drift

init 冻结本 Skill tree manifest 的 content digest。非终态 mutation 前重算；不一致进入 stopped
`operational_abort(skill_drift)`，必须由 controller re-contract，不能在旧 Loop 内接受新规则。
