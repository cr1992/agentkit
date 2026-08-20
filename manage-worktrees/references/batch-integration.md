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

## 冻结前的冲突预测

冲突对和冲突文件如果只在真的合到一半时才暴露，合并排序和"这两支是不是该并成一支"就都成了事后
补救。`plan-batch --scan-conflicts` 把这份信息提前到规划期。

**形态是 `plan-batch` 的附加输出，不是独立子命令。** 理由：矩阵要针对的恰好是这份计划**冻结下来的
那一组输入**——同一批 selector、同一个 target、同一套折叠与准入规则（dirty / HEAD 漂移 / 未推送的
输入根本不该进矩阵，否则读到的是不可复现的现场）。独立子命令得把选择器解析、准入和折叠再实现
一遍，两套口径迟早漂移。因此扫描只挂在 `cmdPlanBatch` 上，**不进 `computeBatchPlan`**：后者同时是
`batch-integrate` 的新鲜度重算口径，把扫描塞进去会让每次合成都白跑一遍 `merge-tree`，也会把决策
辅助信息混进"必须逐项比对"的冻结契约。指纹只绑 SHA，加不加 flag 都一样。

干跑用 `git merge-tree --write-tree`：合并在**对象库**里算完，只产生未被任何 ref 引用的临时
tree/blob（随 gc 回收），不动工作区、index、HEAD 和任何 ref，因此可以在 `plan-batch` 的只读语义下
跑，也不需要先建候选树。

**冲突判定只认退出码，不认文件条目数。** git-merge-tree(1) 的 EXIT STATUS 是 0=可自动合并、
1=有冲突、其他=Git 自身失败；同一页的 MISTAKES TO AVOID 明确写着不得把空的 Conflicted file info
当成干净合并——有几类目录重命名冲突就是退出码 1 却没有任何 unmerged 文件条目。按条目数判 clean
会把真冲突报成"没事"，这是最坏的一种错。这类格子的信息全在 `conflict_notes` 里，人读输出用
`[NOTE]` 单独打出来。

**Git ≥ 2.39。** `merge-tree --write-tree` 2.38 就有，但本扫描依赖 `-z` 信息段里的结构化 NUL 记录
（`<路径数>NUL<路径>...NUL<conflict-type>NUL<message>NUL`，其中 `<conflict-type>` 是 man page 明说的
stable string）；2.38 的 `-z` 信息段还是自由文本，按结构化格式去解会把消息当类型，冲突类型粗分
随之错判。与其写一段本机无法实测的 2.38 兼容分支，不如把线抬到 2.39 并 fail-closed 降级：低版本
整段回报 `supported: false` 并说明原因，计划本身照常冻结——**宁可没有矩阵，不要一份可能错的矩阵。**

输出结构（`conflict_scan`）：

- `pairs[]`：两两干跑。每对给 `merge_base`、`conflict_files`、`adjacent_files`、`state`、
  `files[]`、`files_total`、`conflict_notes[]`。
- `state` 五态：`conflict`（退出码 1）、`adjacent`（可自动合但有同文件相邻）、`clean`、
  `incomplete`（能自动合，但相邻面没算出来）、`error`（merge-tree 自身失败）。
- `adjacent_files` 允许为 `null`，表示相邻面**未知**（merge base 解析不了、`git diff` 失败或超时）。
  未知一律显式标注，绝不退化成 `0`——空集会被读成"确认没有相邻文件"，那是静默降级。汇总里
  `incomplete_pairs`、`unknown_adjacency_rows`、`pathless_conflict_pairs` 分别计数，人读输出在存在
  未完成格子时打 `[WARN]`：矩阵不完整就不能据它断言"没有冲突"。
- `against_target[]`：每个输入各自对 target 干跑一次。它常常全是 `clean`——这恰好说明冲突只在
  "合到一起"时出现，正是矩阵要提前暴露的东西。
- `files[].class` 三分：`overlapping`（Git 报的内容冲突，同 hunk）、`structural`（改/删、重命名、
  distinct types 这类非内容重叠冲突，处置方式和挑 hunk 完全不同）、`adjacent`（两支相对
  merge base 都改了同一文件，但能自动合）。`adjacent` 单独成类是因为语义冲突只会藏在这一格，
  机器判不了，必须交给人看清单。
- **截断只发生在展示层。** `files[]` 每对上限 50 项并置 `files_truncated`，但 `files_total`、
  `conflict_files` 和 `summary.regenerated_paths` 都跑在**未截断的全量清单**上——先截断再统计会让
  排在 50 项之后的 lock/golden 从产物类汇总里凭空消失，而那恰恰是最需要被看见的一类。
- `files[].regenerated`：命中 lock / golden / codegen / dist 这类"只能在合成态重新生成"的产物
  （见 Profile 的 `post_integrate_steps`）。命中只是提示，portable core 不猜也不代跑生成命令。
- `summary.inputs[]`：按冲突面降序，直接支撑"冲突面大的压轴"这条排序口径。排序主键是
  `conflicting_peers` 而不是 `conflict_files`——没有文件条目的目录重命名类冲突同样是真冲突，
  不能因为 `conflict_files=0` 被排到干净输入后面。

**已知边界**：两两干跑预测的是**成对**冲突，实际合成是顺序累积的三方合并，两两干净不等于合成一定
干净。矩阵是决策输入，不是通过证明，替代不了 `batch-integrate` 的实合与门禁。

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
