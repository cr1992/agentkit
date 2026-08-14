# 批量集成验收契约

## 选择模式

- **分支矩阵**：各 feature 相互独立，只需批量跑检查。固定每个 SHA 后分别验收，不建集成树。
- **合成候选**：需验证交叉文件、编译、运行时或用户链路兼容性。每批、每仓创建一棵一次性候选树。

选哪个由 SKILL.md 第 8 节的口径决定：同一仓库、同一目标分支的并行输入 ≥3 时默认走合成候选——此时
"互不触碰"的人工评估视为不可信，不得据它豁免；=2 时按三条判据走，交叉面成立即合成。跨仓或目标
分支不同的输入不计入同批。

不维护长期共享 integration 分支。长期分支会混入旧 feature，无法证明报告对应哪组输入。

集成候选也**不作为 change request 载体**。它的产出是一份"这组输入合成后兼容"的验收结论；合入仍按
可独立评审、合入和回退的交付单元分别进行。用聚合载体代替各自载体会同时失去评审独立性、回退
粒度，以及各输入自己的合入监听。

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

## 合成执行

`batch-integrate` 负责 `planned -> composing` 这一段，并只负责这一段：

- **新鲜度**：按**原始 selector 全集**（计划中的 `requested_selectors`）重算，与冻结计划逐项比对
  repository identity、target ref/SHA、有序输入、被折叠/已合入输入集合和 fingerprint；任一漂移或
  重算出现 blocker 即拒绝，要求重新 `plan-batch`。只回算 `included` 是不够的：被折叠的父分支后来
  前进时，指纹不变的假象会让那部分改动被静默漏出合成结果。不存在"就地放行"的旁路。
- **候选身份**：同 fingerprint 幂等复用；fingerprint 变化视为新的一次性候选，另起 semantic task
  并双向登记替代关系，旧候选先冻结为 `abandoned`。一次性候选不复用交付身份。跨会话只能读取
  已完成候选的 `already_composed` 结果；任何续合、重置或台账改写前必须先 `handoff` 给当前 controller。
- **已合成候选不重置**：合成后候选树通常会因执行 `post_integrate_steps` 而前进，HEAD 不再等于
  `composed_sha`。此时同指纹重跑只做幂等回报，不重置候选、不重置步骤状态；HEAD 既不等于也不是
  `composed_sha` 后继时 fail-closed 要求人工核对。只有当前 owner 同时提供 `--recompose` 与
  `--recompose-head <候选当前完整 HEAD>` 才可重合成：工具先记录包含 discarded/authorized HEAD 的
  `batch_candidate_recompose_authorized` event，并在 reset 前再次做 HEAD CAS，防止陈旧授权丢弃新提交。
- **冲突**：fail-closed 停在冲突处，报告冲突文件、双方来源 SHA 和候选树路径；不自动解、不自动
  abort。人工裁决属于 controller 的职责，工具只保证现场可读、可复现。
- **rerere**：候选树默认启用 `rerere.enabled` + `rerere.autoUpdate`（worktree 级配置，不写全局）。
  两项必须同时生效：只有 `enabled` 时 rerere 会把已录解法写回工作区却不更新 index，合成循环仍会
  把它判成真冲突，重放形同失效。因此仓库已继承 `rerere.enabled=true` 也不会跳过补齐 `autoUpdate`。
  自动启用共享 `extensions.worktreeConfig` 时会写一条独立审计事件
  （`repository_config_extension_enabled`），如实记录覆盖前值，并可区分"本轮写入"与"原本已启用"；
  Git boolean 通过 `git config --bool` 归一化，`yes/on/1` 不会被误判成未启用。
  人工裁决并提交一次后，重跑合成会自动重放同一冲突的解法——多轮候选之间不再重复手解。
  解法缓存位于共享 common dir 的 `rr-cache/`，因此同仓任何 worktree 录下的解法都会被复用；
  一个错误解法同样会跨候选扩散，需要时用 `git rerere forget <path>` 清除。
  worktree 级配置依赖仓库 `extensions.worktreeConfig`；`core.bare` / `core.worktree` 非默认值时
  工具拒绝自动启用并回报原因，不擅自搬动这两个键。
- **门禁**：`batch-integrate` 不执行任何验收命令。`post_integrate_steps` 只回显、不代跑，执行结果
  由 `batch-step` 登记。这条边界与"portable core 不执行 Profile 中的任意 shell command"是同一条。

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
