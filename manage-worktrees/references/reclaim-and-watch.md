# Watch 与保守回收

仅在准备武装、恢复或解除 watcher，以及执行 `reclaim` 或诊断 `KEEP/BRANCH_PENDING` 时读取。

## 内容监听

监听绑定“冻结的 head SHA 已成为目标 ref 祖先”这一事实，不绑定 change request 载体。载体改为他人代推、
聚合 MR 或其他分支时不解除监听。进入 `ready_for_review` 默认武装；`submit` 只是其中一个入口。电脑重启后
由 `resume-all` 恢复 stale watcher；change request 已关闭且明确不会合入时用 `unwatch`。

## 已推送成果

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" reclaim <task-or-id> --pushed <exact-sha>
```

只有无 stash、树干净、branch/HEAD 已进入给定 SHA，才执行：

```text
final_snapshot -> reclaim_ready -> git worktree remove -> branch cleanup -> reclaimed
```

终态事件将非 `abandoned` 任务收敛为 `done`，并以最终 source HEAD 闭合 ownership epoch。旧版本若留下
`reclaimed` 但状态或 epoch 未闭合，重复同一命令会追加 reconciliation event 后再对账。

给定 SHA 还必须由待回收 branch 以外的持久 ref 保护：local/remote branch、tag 或
`refs/worktree-archive/*` 均可。`--pushed <当前 HEAD>` 但只有候选 branch 自己引用时会被拒绝，因为删掉
branch 后对象仍会成为 dangling object；这不是“已推送”证据。

## 固定 SHA 的批次验收候选

一次性 batch integration candidate 不作为 MR 载体，且正式分支可能用不同 merge topology 合入各输入，
因此“代码内容已进入目标分支”不等于“设备证据绑定的精确 candidate SHA 已成为目标分支祖先”。先用
`batch-result` 冻结 `passed` / `failed` / `stale`，再走独立归档回收：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" reclaim <candidate> \
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
node "$SKILL_DIR/scripts/worktree-mgr.mjs" reclaim old-task --superseded-by new-task
```

默认 ref 是 `refs/worktree-archive/superseded/<old-worktree-id>`。manager 验证旧树为 `abandoned`、会话和
owner 一致、替代关系双向、替代树干净，并继续执行 stash、dirty、submodule 和目录审计。只有归档创建并
回读到精确旧 HEAD 后，才删除目录和 local branch；恢复方式为：

```bash
git branch <recovery-branch> <archive-ref>
```

人工明确裁定无需恢复时，才允许精确 SHA 授权丢弃：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" reclaim old-task \
  --superseded-by new-task --discard <exact-old-head>
```

`--discard` 不是布尔开关，SHA 必须与实时旧 HEAD 完全一致；归档和丢弃策略登记后不得互换。

## 故障与不变量

- `abandoned` 只冻结写入，不等于已回收；`doctor` 持续报告残留树和断裂替代关系。
- 禁止 `rm -rf`、`git worktree remove --force` 和 `branch -D`。
- branch cleanup 失败时保留 `BRANCH_PENDING`；修复占用后重跑相同 `reclaim`，工具重新验证 branch tip。
- `git worktree remove` 失败返回非零 `KEEP` 并记录原始错误。即使 Git 登记已解除，物理目录仍在也不能
  标为 `reclaimed`；先恢复权限或登记关系，不用强删掩盖孤儿目录。
- 含 submodule 的树逐个验证已初始化工作区干净，再自动 deinit 并清理该树私有元数据。submodule 脏、
  未初始化目录非空或 `.git` 指针悬空均返回 `KEEP`。
- worktree 在宿主或沙箱写权限之外时，先取得精确目录的写权限，再重试回收。
