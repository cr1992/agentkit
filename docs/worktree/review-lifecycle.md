# 评审、交接与合入监听

进入 `ready_for_review`、handoff、提交 change request 或处理 watcher 漂移时读取。

## 状态与 watcher

```bash
agentkit worktree touch <selector> --status blocked --note "等待环境"
agentkit worktree touch <selector> --status active
agentkit worktree touch <selector> --status ready_for_review
```

`ready_for_review` 默认按该树登记的 `base_ref` 武装监听，Profile `default_base` 只在 record 没有 base 时
兜底；显式 target 与既有人工 target 仍然优先。HEAD 前进时同一 event 使旧 watcher 失效，
再尝试冻结新 HEAD。worktree dirty、HEAD 未推送或远端主干不可刷新时 fail-soft，状态更新成功但明确
回报未武装原因，并把 `review_watch=auto/pending` 与原因写入 trace；`resume-all` 会重试。`--no-watch`
则持久登记 `disabled`，与启动失败严格区分。`doctor` 对 pending、缺失 intent 和显式退出分别报告
`AUTO_RECLAIM_NOT_ARMED`、`AUTO_RECLAIM_INTENT_MISSING` 与 `AUTO_RECLAIM_DISABLED`。

进程级 watcher 只保证当前宿主允许后台进程存活期间的即时回收。需要跨 Agent 会话或机器重启：

```bash
agentkit worktree watch-service install
agentkit worktree watch-service status --json
```

macOS adapter 安装用户级 LaunchAgent，每 60 秒（可用 `--interval-seconds` 调整）从 primary worktree
运行一次 `resume-all`。安装是显式动作，不随 npm install 自动发生，不保存调用会话的环境变量或凭证。
服务固定安装时的 Node 与 manager script 绝对路径；升级 agentkit 或切换 Node 安装位置后重跑 install，
`status --json` 的 `program_available` 会检查这两个路径。卸载使用 `watch-service uninstall`。其他平台仍可
手工运行 `resume-all`，在相应 service adapter 落地前不宣称跨会话保证。

人工 `watch --target` 可改默认目标；已经显式武装的 target 不被静默改写，换目标先 `unwatch`。陈旧
watcher 不能覆盖并发 rearm 或 `merge_detected`。旧 SHA 合入不代表新 HEAD 已完成。

### Target 前进与显式评审刷新

watcher 发现 target SHA 偏离本次武装时冻结的 target baseline、且冻结 HEAD 尚未合入时，只读记录一次
`target_advanced` event，并用 `git merge-tree` 给出三档预判：

- `clean`：`TARGET_ADVANCED_REFRESH_CLEAN`，三方合并干跑无冲突；逐 commit rebase 仍可能不同。
- `conflict`：`REBASE_NEEDED`，预留人工解冲突时间。
- `unknown/diverged`：`TARGET_ADVANCED_PREDICTION_UNKNOWN`，不能可靠预判或 target 非快进。

watcher 本身不改写历史、不 push。由人或 controller 显式授权一次刷新：

```bash
agentkit worktree refresh-review <selector>
```

命令要求 `ready_for_review`、clean、冻结 HEAD 与远端 upstream 完全一致、target 是登记 base 的快进后继。
它先登记 `review_refresh` marker，再调用同一 managed rebase 事务；成功后使用绑定旧 upstream SHA 的精确
`--force-with-lease` 推送，回读新远端 HEAD，更新 change request head 并自动重新武装 watcher。

无项目 wrapper 时，显式调用默认完成 push，后续门禁由远端 CI 和 merge human gate 承担。项目要在
push 前跑本地门禁时：

```bash
agentkit worktree refresh-review <selector> --pause-before-push
# 项目 wrapper 运行 lint/test/sign 等门禁
agentkit worktree refresh-review <selector> --continue
```

rebase 冲突时保留 managed intent 与 refresh marker；只编辑冲突并 `git add`，然后运行同一
`refresh-review <selector> --continue`，它会继续 rebase、push、重冻结和 rearm。仍处于 Git rebase
冲突态时可用 `--abort` 恢复原 HEAD 与原 watcher。`--pause-before-push` 后项目门禁失败时也可
`--abort`：manager reset 到 `old_head`，以补偿 event 恢复原 base、ownership 与 change-request 边界，
重武装原 watcher；已发生的 rebase lineage 保留审计，并追加 rollback 记录。远端 branch 必须仍等于
冻结旧 HEAD；已经 push、远端被他人更新或分支已删除时拒绝自动回滚。非暂停模式中 rebase 已成功而
push/凭证/网络失败时用 `--continue` 幂等恢复。远端分支不存在会单独报告，其他 SHA 漂移由精确 lease
门禁拒绝覆盖。

## Handoff

交接前使树 clean 并 push：

```bash
agentkit worktree handoff <selector> \
  --to-agent kiro --to-agent-id <real-task-id> \
  --note "已完成什么，下一步是什么"
```

handoff 保存 ownership boundary SHA；脏树拒绝，禁止用 stash 搬运未提交内容。

## Change request

先执行目标仓库自己的测试、commit gate、review 和 push 规则。Profile 已启用 provider 时：

```bash
agentkit worktree submit <selector> \
  --title "<title>" --description "<summary>" --notify auto
```

若 change request 已由 UI/API 创建，用一个 event 原子登记 URL、目标、冻结 HEAD、状态和 watcher：

```bash
agentkit worktree touch <selector> \
  --status ready_for_review \
  --mr "https://gitlab.example/group/project/-/merge_requests/42" \
  --watch-target origin/main --notify auto
```

未给 target 时使用 record 的 `base_ref`；远端 MR target 不同时先核对 provider/UI，再显式传
真实目标。`--mr` 只接受 HTTP(S) URL；纯文本载体使用 `--change-ref`。

watcher 只在冻结 SHA 成为目标 ref 祖先后回收。`resume-all` 恢复 stale watcher 和已登记的 pending
intent；对没有 intent 的 legacy 评审记录只报告 skipped，要求重新 `touch ready_for_review`，不猜测它
是否曾显式 `--no-watch`。change request 关闭且确定不会合入时 `unwatch`。详细回收见
[reclaim-and-watch.md](reclaim-and-watch.md)。
