# Spawn、命名与堆叠分支

创建新 worktree，或对堆叠分支执行 `rebase/retarget` 时读取。接管已有树使用 `adopt`，不加载本文件。

## 命名门禁

1. task 是至少两个连字符分词的 lowercase semantic slug，如 `ci-gate-hardening`。
2. 禁止纯编号、UUID、hash、日期或无业务语义缩写。
3. 可见 branch/path 包含完整 host 与 task；trace UUID/session ID 只进入 metadata。
4. `spawn` 回显的 task、branch、path、base 必须符合 primary Profile，不一致即停止。

```bash
agentkit worktree spawn ci-gate-hardening \
  --agent codex --agent-id <real-thread-id> \
  --owner <human-owner> --purpose "加固 CI 门禁" --codegraph auto
```

CodeGraph 在交互 TTY 中保留原生进度；Agent、CI 和其他非 TTY 调用捕获其 stdout/stderr，成功时只输出
manager 的一行摘要，失败时只返回有界错误，避免 ANSI 进度条占满工具上下文。

`agent-id` 必须来自宿主真实 session/thread/task ID，不得编造。相同会话已有其他树时，先按
[delivery-identity.md](delivery-identity.md) 判断复用、并存或替代。

## Root 与 branch

无 Profile 时：base 按 remote HEAD、`origin/main`、`origin/master`、upstream、HEAD 依次选择；branch
为 `{host}/{task}`；root 按 `--root`、`WORKTREE_ROOT`、Profile、用户 worktree 目录依次选择。

- 显式 root 不可写时 fail-closed。
- 只有零配置默认 root 因权限或只读文件系统不可写时，才降级到仓库同级 `.worktrees` 或平台临时目录；
  降级写入 record，临时目录标记 `EPHEMERAL`。
- manager 在创建 branch 前认领 root；`git worktree add` 失败后，只有能证明新 branch 未挂载且 tip
  等于 base 才删除空 branch，否则 `KEEP + 原因`。
- local branch 已存在但没有匹配的 active record 时返回 `BRANCH_ALREADY_EXISTS`，不继承旧 tip。

## 非默认 base 与堆叠关系

依赖未合入分支时必须给出理由：

```bash
agentkit worktree spawn api-contract-followup \
  --agent codex --agent-id <real-thread-id> \
  --purpose "基于契约分支实现客户端" \
  --base origin/agent/api-contract \
  --base-reason "依赖未合入契约"
```

父分支前进后禁止在 feature 树手工 rebase。冻结 live HEAD，由 manager 原子撤防 watcher、刷新 base、
保存父 worktree 关系并开启新 ownership epoch：

```bash
agentkit worktree rebase api-contract-followup \
  --onto origin/agent/api-contract \
  --expected-head <current-full-head> --reason "吸收父分支最新契约"
```

冲突时只人工编辑并 `git add`；继续只需 `rebase <selector> --continue`，intent 中已有 onto、原始 HEAD
和 reason。为兼容旧调用可重复提供原参数，但提供时必须一致；放弃用 `rebase <selector> --abort`。
pending 时 `artifact/touch/handoff/submit/watch` 全部 fail-closed。成功后旧 Artifact、MR head 与 watcher
失效，push 新 HEAD 后重新登记评审边界。

已经处于 `ready_for_review` 且 watcher 发现 target 前进时，不手工串联上述步骤；使用
`refresh-review <selector>`，完整 push/rearm 与恢复语义见 [review-lifecycle.md](review-lifecycle.md)。

历史已包含新目标时只更新 attribution：

```bash
agentkit worktree retarget api-contract-followup \
  --base origin/main --expected-head <current-full-head> \
  --reason "父分支已合入，MR 改指 main"
```

`retarget` 要求新 base 是 live HEAD 祖先；否则使用 `rebase`。portable core 不会假装已修改远端 MR
target，provider/UI 更新后才能重新武装 watcher。
