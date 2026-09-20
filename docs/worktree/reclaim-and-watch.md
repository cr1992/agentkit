# Watch 与保守回收

仅在准备武装、恢复或解除 watcher，以及执行 `reclaim`/`archive` 或诊断 `KEEP/BRANCH_PENDING` 时读取。

## 内容监听

监听绑定“冻结的 head SHA 已成为目标 ref 祖先”这一事实，不绑定 change request 载体。载体改为他人代推、
聚合 MR 或其他分支时不解除监听。进入 `ready_for_review` 默认武装；`submit` 只是其中一个入口。电脑重启后
由 `resume-all` 恢复 stale watcher；macOS 要让这一步无需新 Agent 会话触发，显式安装用户级维护器：

```bash
agentkit worktree watch-service install
```

维护器定期执行有限的 `resume-all`，实际 watcher 仍用 token/event CAS 与 heartbeat 裁决；它不放宽任何
回收前置条件。`watch-service status` 检查 plist、launchd job 与当前 Node/runtime 路径，`uninstall` 解除。
未安装时只有进程级自动回收，不得称作跨会话保证。change request 已关闭且明确不会合入时用 `unwatch`。

`unwatch` 不只翻 record 状态：写入解除事件后，它按进程组终止该次租约的 watcher，把 worker 与它在途的
`git fetch` 子进程一起收尾，并等到整组退出才返回。发信号的前提是心跳判定健康——token 一致、pid 存活、
心跳未过期——且心跳与 record 登记同一个 pid。心跳新鲜度是其中的承重项：崩溃的 worker 来不及删心跳，
陈旧登记会一直留着同一个 pid，等它被系统复用成别的进程组 leader，只比对 token 和 pid 就会打到无关进程组。

判定成立时命令返回即代表没有后台写入者还在写该仓库，可以直接删除或移动这棵 worktree。判定不成立则退回
worker 自己轮询退出：登记的 pid 已不存在时终态是 `watcher=not-running`，仍存活时是 `watcher=unverified`。输出末尾的 `watcher=<终态>` 说明实际走到哪一步；
`signal-denied`（无权发信号）、`timeout`（超时未退出）`unsupported-platform`（非 POSIX 平台没有进程组
信号）与 `unverified` 各自打印独立告警，这几种情况都需要自行确认进程已结束再动目录。

## 已推送成果

```bash
agentkit worktree reclaim <task-or-id> --pushed <sha-or-unique-prefix>
```

只有无 stash、树干净、branch/HEAD 已进入给定 SHA，才执行：

```text
final_snapshot -> reclaim_ready -> git worktree remove -> branch cleanup -> reclaimed
```

命令可以从待回收 worktree 自身发起；runtime 在删除目录前冻结 primary worktree 作为后续仓库级 Git
操作的稳定 cwd。branch probe 只有在 `show-ref` 明确返回“不存在”时才记为 `absent`，cwd、权限或其他
执行错误一律 fail closed。目录已删除但 branch cleanup 未完成时保留 `BRANCH_PENDING`，命令返回非零，
从任一仍存在的 worktree 重跑同一 `reclaim` 完成对账。

终态事件将非 `abandoned` 任务收敛为 `done`，并以最终 source HEAD 闭合 ownership epoch。旧版本若留下
`reclaimed` 但状态或 epoch 未闭合，重复同一命令会追加 reconciliation event 后再对账。

给定 SHA 还必须由待回收 branch 以外的持久 ref 保护：local/remote branch、tag 或
`refs/worktree-archive/*` 均可。`--pushed <当前 HEAD>` 但只有候选 branch 自己引用时会被拒绝，因为删掉
branch 后对象仍会成为 dangling object；这不是“已推送”证据。

`--pushed` 是人体工学例外：接受十六进制唯一短前缀，runtime 用 `rev-parse --verify` 展开后，后续 event、
可达性和 branch cleanup 全部只使用完整 object ID。`--discard`、Artifact、batch candidate 与 evidence
archive 仍要求完整 SHA，因为它们承担 CAS 或冻结身份边界。

## 固定 SHA 的批次验收候选

一次性 batch integration candidate 不作为 MR 载体，且正式分支可能用不同 merge topology 合入各输入，
因此“代码内容已进入目标分支”不等于“设备证据绑定的精确 candidate SHA 已成为目标分支祖先”。先用
`batch-result` 冻结 `passed` / `failed` / `stale`，再走独立归档回收：

```bash
agentkit worktree reclaim <candidate> \
  --archive-evidence <exact-candidate-head> \
  --reason "固定验收已结束，输入已按正式交付单元处理"
```

manager 校验终态 `batch_result`、live HEAD CAS、clean/stash/Git 中间态/submodule，并创建
`refs/worktree-archive/evidence/<worktree-id>`。只有回读 ref 精确等于候选 HEAD 后，才进入通用
`reclaim_ready -> remove -> branch cleanup -> reclaimed`。trace 保留 fingerprint、target SHA、有序输入、
结果/Evidence digest 和归档原因；`task_status` 保持 `done`，不把已通过候选伪装成 `abandoned`。

恢复方式：

```bash
git branch <recovery-branch> refs/worktree-archive/evidence/<worktree-id>
```

该 ref 是**本地 GC 保护**，不是远端备份。归档 ref 已存在但指向别的提交、用户 SHA 与 live HEAD 不同、
结果未冻结或 ref 创建后回读失败时均不删除。命令可在 worktree remove 或 branch cleanup 中断后用同一
参数幂等重跑。`doctor` 用 `DONE_BATCH_CANDIDATE_RESULT_UNRECORDED` 提示只标 done 未冻结结果，用
`DONE_EVIDENCE_WORKTREE_RECLAIM_PENDING` 提示已冻结但仍占目录的候选。

## 被替代的未推送成果

不得为了清理而推送废弃分支。双向替代关系已经登记后，默认先归档旧 HEAD：

```bash
agentkit worktree reclaim old-task --superseded-by new-task
```

默认 ref 是 `refs/worktree-archive/superseded/<old-worktree-id>`。manager 验证旧树为 `abandoned`、会话和
owner 一致、替代关系双向、替代树干净，并继续执行 stash、dirty、submodule 和目录审计。只有归档创建并
回读到精确旧 HEAD 后，才删除目录和 local branch；恢复方式为：

```bash
git branch <recovery-branch> <archive-ref>
```

人工明确裁定无需恢复时，才允许精确 SHA 授权丢弃：

```bash
agentkit worktree reclaim old-task \
  --superseded-by new-task --discard <exact-old-head>
```

`--discard` 不是布尔开关，SHA 必须与实时旧 HEAD 完全一致；归档和丢弃策略登记后不得互换。

## 分支回收边界

`reclaim` 只收本地 ref：删除目录后清理这棵树自己的 local branch，不触碰任何远端。PR 合入后的远端
head 分支由托管平台的「合并后自动删除」收——GitHub 的 `delete_branch_on_merge`、GitLab 的
`remove_source_branch`——工具不扫远端，也不替你删：判定要联网，删远端 ref 是对外动作。REST
`PUT /pulls/{n}/merge` 这类接口本身不删 head 分支，仓库没开自动删除时远端会持续积累。

本地侧的兜底是 `doctor`：已是默认分支祖先、不属于任何 record、也没有被任何 worktree 检出的本地
分支，作为 `[info] MERGED_ORPHAN_LOCAL_BRANCH` notice 逐条列出，并给出 `git branch -d <branch>`。
宿主自带的隔离建的分支不进 record，`reclaim` 的分支清理没有机会起作用，只能在这里被看见。notice
既不是 error 也不计入 `findings=N`，不改变退出码，也不自动删除：判据只做存在性检查，删不删由人
决定。默认分支的判定先看 `refs/remotes/origin/HEAD`，再退到 spawn 用的 base 解析（Profile
`default_base`、其他 remote 的 HEAD、well-known remote 分支）；只能解析到描述当前分支自己的来源时
整类跳过，输出 `MERGED_ORPHAN_BRANCH_SCAN_SKIPPED` 和原因，不猜 `main`。

## 故障与不变量

- `abandoned` 只冻结写入，不等于已回收；`doctor` 持续报告残留树和断裂替代关系。
- 禁止 `rm -rf`、`git worktree remove --force` 和 `branch -D`。
- branch cleanup 失败时保留 `BRANCH_PENDING` 并返回非零；修复占用后从仍存在的 worktree 重跑相同
  `reclaim`，工具重新验证 branch tip。
- `git worktree remove` 失败返回非零 `KEEP` 并记录原始错误。即使 Git 登记已解除，物理目录仍在也不能
  标为 `reclaimed`；先恢复权限或登记关系，不用强删掩盖孤儿目录。
- 含 submodule 的树逐个验证已初始化工作区干净，再自动 deinit 并清理该树私有元数据。submodule 脏、
  未初始化目录非空或 `.git` 指针悬空均返回 `KEEP`。
- worktree 在宿主或沙箱写权限之外时，先取得精确目录的写权限，再重试回收。
