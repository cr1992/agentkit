# 编排运行时 v1

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

所有修改命令支持 `--expected-revision`。状态默认写在业务仓库外；宿主派发回执必须通过
`dispatch-record` 绑定精确 worker identity、model 和 reasoning effort。节点只有绑定稳定产物后才能
进入 `passed`。批级熔断属于此 ledger；每个 Loop 仍只维护自己的单个收敛对象。

Reflection 与 Improvement Proposal 是追加式改进输入。Proposal 的生命周期固定为 `proposed`，
当前执行面不读取它，也不会据此改写合同、节点状态或验收结论。
