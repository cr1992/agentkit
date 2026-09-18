# 输入准备与诊断命令

仅在尚未准备 Contract/Profile/Artifact、`prepare-run` 失败，或需要调试完整 snapshot 时读取。三个输入
已经冻结且 happy path 正常时不加载。

## 骨架与摘要

`prepare` 生成 Contract/Profile 骨架、逐项 TODO 和后续命令，不猜测试命令、不内置项目 preset。
`l0_checks` 必须由 controller 按项目实际填写。`scaffold` 支持 `contract | profile | artifact | review |
bundle`；骨架结构和摘要合法，但 TODO acceptance 与示例 L0 必须替换。创建入口（`preflight`、`init`、
`prepare-run`，以及 `contract validate`、`ledger init`、`loop init`）会拒绝原样保留的 scaffold 占位，
判据与级别见下节。

`artifact/bundle` 要求 `--workdir` 与 `--base-sha`，默认冻结当前 HEAD。`review` 从 `review-input` 原样
取得 Contract/Profile digest、Artifact 与 challenge nonce。`digest` 支持 `contract | profile | review`，
输出重算摘要的新 JSON，不覆盖源文件。

```text
agentkit verify prepare \
  --workdir <clean-pinned-workdir> --out-dir <inputs-dir>
agentkit verify scaffold \
  --kind bundle --workdir <clean-pinned-workdir> --base-sha <full-base-sha>
```

## 实质性检查

形状合法不等于有内容。五条判据在创建入口执行，逐条给出字段路径与当前值，不给可照抄的合规值。

| # | 判据 | 需要的输入 | 级别 |
|---|---|---|---|
| 1 | `objective`、`acceptance[].requirement`、`scope.include` 中残留 scaffold 占位字面量 | 契约 | error |
| 2 | `l0_checks[].check_id` 是 scaffold 占位标识，或全部 `argv` 都是 scaffold 占位命令（两个分支独立触发） | profile | error |
| 3 | 某条 `acceptance[].contract_item_id` 未被任何 `l1_review` 条目引用 | 契约 + profile | error |
| 4 | `permissions.mode` 为 `write` 且 `scope.exclude` 为空 | 契约 | warning |
| 5 | `permissions.mode` 为 `write` 且 `stop_conditions` 为空 | 契约 | warning |

#4、#5 只检查是否存在，边界划得对不对 runtime 判断不了，所以只给 warning：`valid` 结论和退出码都不
变。#3 要同时拿到两份文件才成立，只有 `preflight`、`init`、`prepare-run` 和 `loop init` 能执行；
`contract validate`、`ledger init` 手上只有契约，执行 #1、#4、#5。#3 保证每条 acceptance 都被 L1 审过，
不保证被 L0 测到——`l0_checks` 条目没有 `contract_item_id`，无从建立对应关系。

warning 通过两个输出键带出：

- `warnings`：仅非空时出现，见 `contract validate`、`ledger init`、`verify init`、`loop init` 的返回值，
  以及 `preflight` 报告（该键在报告里恒在，可能是空数组）。`prepare-run` 的完整报告把它放在
  `preflight.warnings`，默认 compact 输出不带，取证加 `--verbose`。
- `substance_warnings`：恒在，见 `ledger doctor`、`verify doctor`、`loop doctor`。doctor 把手上能执行的
  全部判据整体降级成 warning，不进 `findings`，不改变 `healthy`。

续跑与恢复入口（`add-node`、`record-review`、`validate`、`adopt-root`、`record-embedded-review`）不重判
实质性：契约冻结后不可变，实质性只在冻结那一刻判定一次；`validate`、`adopt-root`、`doctor` 这些只读回看
路径还会读到判据出现之前冻结的状态，在那里拒绝等于让历史 Evidence 的审计结论随 runtime 版本变化。

## Readiness 与 Preflight

`readiness` 只检查环境前提：Git worktree 根、可执行文件、已存在的 argv 文件、L0 `cwd_rel` 和可写
state root。失败返回 precondition blockers，不是 Artifact defect，不进入 verdict。runtime 无法判断
`env_allowlist` 中变量是否为 L0 必需，只记 note。

`run-smoke` 内联同一检查，排除已由冻结身份门禁接管的 executable 与 argv 文件；漂移时报
`stale_precondition`。`preflight/init` 一次汇总 envelope、枚举、摘要、Skill binding 与隔离 assurance
问题；init 通过后再执行 Git、路径和运行环境门禁。

`prepare-run` 在临时副本重算 Contract/Profile digest，依次执行 readiness、preflight 和 init，不覆盖
源输入；失败不留下半初始化 run。逐层诊断可分别运行 `digest/readiness/preflight/init --help`。

## Reviewer bundle 与输出

`review-bundle` 生成一次派发的自包含 JSON：标准证伪提示、review-input、Review Result v1 schema、
Artifact、workdir、只读权限、停止条件和摘要回填指引。投影合同标记为 `projected`，reviewer 只核被
投影 acceptance。controller 直接转交该 JSON，不重写提示。

`init/prepare-run` 返回稳定 `run_dir/run_id`。写状态命令支持 `--expected-revision`。CLI 的
`run-smoke/record-review/run-final` 默认 compact；取证加 `--verbose`，`inspect` 始终返回完整 snapshot。
程序化 `main()` 始终返回完整对象。
