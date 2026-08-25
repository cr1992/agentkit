# 评审、交接与合入监听

进入 `ready_for_review`、handoff、提交 change request 或处理 watcher 漂移时读取。

## 状态与 watcher

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" touch <selector> --status blocked --note "等待环境"
node "$SKILL_DIR/scripts/worktree-mgr.mjs" touch <selector> --status active
node "$SKILL_DIR/scripts/worktree-mgr.mjs" touch <selector> --status ready_for_review
```

`ready_for_review` 默认按 Profile `default_base` 武装监听；HEAD 前进时同一 event 使旧 watcher 失效，
再尝试冻结新 HEAD。worktree dirty、HEAD 未推送或远端主干不可刷新时 fail-soft，状态更新成功但明确
回报未武装原因。补齐前提后重跑，或用 `--no-watch` 明确接受人工回收。

人工 `watch --target` 可改默认目标；已经显式武装的 target 不被静默改写，换目标先 `unwatch`。陈旧
watcher 不能覆盖并发 rearm 或 `merge_detected`。旧 SHA 合入不代表新 HEAD 已完成。

## Handoff

交接前使树 clean 并 push：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" handoff <selector> \
  --to-agent kiro --to-agent-id <real-task-id> \
  --note "已完成什么，下一步是什么"
```

handoff 保存 ownership boundary SHA；脏树拒绝，禁止用 stash 搬运未提交内容。

## Change request

先执行目标仓库自己的测试、commit gate、review 和 push 规则。Profile 已启用 provider 时：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" submit <selector> \
  --title "<title>" --description "<summary>" --notify auto
```

若 change request 已由 UI/API 创建，用一个 event 原子登记 URL、目标、冻结 HEAD、状态和 watcher：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" touch <selector> \
  --status ready_for_review \
  --mr "https://gitlab.example/group/project/-/merge_requests/42" \
  --watch-target origin/main --notify auto
```

堆叠分支未给 target 时使用 record 的 `base_ref`；远端 MR target 不同时先核对 provider/UI，再显式传
真实目标。`--mr` 只接受 HTTP(S) URL；纯文本载体使用 `--change-ref`。

watcher 只在冻结 SHA 成为目标 ref 祖先后回收。重启后 `resume-all` 恢复 stale watcher；change request
关闭且确定不会合入时 `unwatch`。详细回收见 [reclaim-and-watch.md](reclaim-and-watch.md)。
