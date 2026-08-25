# 输入准备与诊断命令

仅在尚未准备 Contract/Profile/Artifact、`prepare-run` 失败，或需要调试完整 snapshot 时读取。三个输入
已经冻结且 happy path 正常时不加载。

## 骨架与摘要

`prepare` 生成 Contract/Profile 骨架、逐项 TODO 和后续命令，不猜测试命令、不内置项目 preset。
`l0_checks` 必须由 controller 按项目实际填写。`scaffold` 支持 `contract | profile | artifact | review |
bundle`；骨架结构和摘要合法，但 TODO acceptance 与示例 L0 必须替换。

`artifact/bundle` 要求 `--workdir` 与 `--base-sha`，默认冻结当前 HEAD。`review` 从 `review-input` 原样
取得 Contract/Profile digest、Artifact 与 challenge nonce。`digest` 支持 `contract | profile | review`，
输出重算摘要的新 JSON，不覆盖源文件。

```text
node <skill-dir>/scripts/verification-runtime.mjs prepare \
  --workdir <clean-pinned-workdir> --out-dir <inputs-dir>
node <skill-dir>/scripts/verification-runtime.mjs scaffold \
  --kind bundle --workdir <clean-pinned-workdir> --base-sha <full-base-sha>
```

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
