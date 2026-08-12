# Loop State v1

## 状态

```text
active
├─ pass + no H gate ───────────────→ completed
├─ pass + H gate ──────────────────→ waiting_human
├─ fail + 未熔断 ──────────────────→ active（下一 iteration）
├─ fail + max/fuse/policy stop ────→ stopped
├─ undecidable / blocked_safety ───→ stopped
└─ verification abort / drift ─────→ stopped

waiting_human
├─ approved ───────────────────────→ completed
└─ rejected / explicit stop ───────→ stopped
```

`completed` 与 `stopped` 是 Loop 终态，不表示外部 Goal 或全局任务完成。

## Iteration

每个 iteration 固定绑定：

- 从 1 开始的 index；
- 完整 Artifact Ref；
- full provider 的唯一 verification run ID，或 embedded provider 的 L0/Review Result；
- terminal outcome；
- Evidence digest 或 embedded record digest；
- fail 时的稳定 failure signature。

一个 active iteration 尚未终结时不能登记新 Artifact。fail 后由 controller 执行 `next`，再为修复后的
新 Artifact 调用 `record-artifact`。

## H gate

H gate 与 verification verdict 正交。`pass` 只能把 required gate 推到 `waiting_human`；只有
`human-gate --decision approved` 能进入 completed。rejected 进入 stopped。

## Verification abort

operational abort 不写入 `iterations`，不增加 index，也不生成 failure signature。controller 修复前置
条件后，可用 `resume --verification-run-id <new-id>` 为同一 Artifact 创建新 verification run。
