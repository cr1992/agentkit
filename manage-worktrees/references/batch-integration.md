# 批量集成验收契约

## 选择模式

- **分支矩阵**：各 feature 相互独立，只需批量跑检查。固定每个 SHA 后分别验收，不建集成树。
- **合成候选**：需验证交叉文件、编译、运行时或用户链路兼容性。每批、每仓创建一棵一次性候选树。

不维护长期共享 integration 分支。长期分支会混入旧 feature，无法证明报告对应哪组输入。

## 输入契约

`plan-batch` 的 selector 只能指向当前 repository identity 的 tracked record。调用者先按项目规则 fetch target，工具本身保持离线只读。

计划只接受：

1. `task_status` 为 `ready_for_review` 或 `integrating`。
2. worktree 存在且干净，没有 merge/rebase/cherry-pick/revert 中间态。
3. live HEAD 等于 trace `last_head`。
4. upstream 存在且指向同一 HEAD，证明精确产物已推送。

工具会先排除 target 已包含的 HEAD，再按 Git 祖先关系折叠重复/父分支。`included` 保留用户给定顺序；顺序参与 fingerprint，不得在合成时重排。

fingerprint 只绑定 target SHA 和有序输入 SHA，不纳入本机路径、repository UUID 或平台默认目录，因此同一组 Git 对象在不同宿主上保持一致。验收契约与环境指纹另外记录；它们变化时即使 Git fingerprint 未变，报告也必须标记 `stale`。

## 候选树状态

```text
collecting -> planned -> composing -> verifying -> passed / failed / stale -> reclaimed
```

- `planned`：保存 fingerprint、target SHA、有序输入 SHA。
- `composing`：只有一个 controller/integrator 写候选树。
- `verifying`：候选树已干净，验收器只读候选 SHA。
- `failed`：区分 composition conflict 和 test failure，不把冲突修复混入候选树。
- `stale`：target、输入、顺序或验收契约任一变化。

## 验收报告

报告至少记录：

- repository identity、target ref/SHA、plan fingerprint。
- 有序输入的 task、worktree ID、branch、HEAD、upstream。
- 候选分支与最终 candidate SHA。
- 验收契约/环境指纹、每项命令、退出码、证据地址。
- 结论 `passed` / `failed` / `stale` 及失败归因。

Git worktree 只隔离工作目录和 index，不隔离端口、模拟器/设备、Docker 名、外部数据库、用户级 cache 或凭证。项目 wrapper/Profile 必须为并行候选分配独立运行时资源，或显式串行。

## 多仓项目

项目目录可能只是包含多个 Git 仓库的容器。先按 repository identity 分组，每仓独立规划/合成/验收；上层批次台账再绑定各仓 candidate SHA 和跨仓环境测试。不得把一个仓的 worktree 冒充整个项目的集成边界。
