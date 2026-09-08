# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## Unreleased

- 修复 `doctor` 对已回收 record 仍生成需要活树才能收敛的 metadata finding。`stack_parent`、
  `history_operation` 和 `review_refresh` 三个分支缺少 `worktree_state` 过滤，对已删除目录报
  `STACK_PARENT_ADVANCED` 等提示，其补救动作（managed rebase/retarget、`rebase --continue`、
  `refresh-review`）在回收后都无法执行，噪声永远清不掉；其中 error 级的还会按「任何 error 都暂停
  `spawn/adopt`」把后续派工钉死。生命周期与 watcher 两个收集器早已是这个口径，本次补齐 metadata。
- `manage-worktrees` 补齐 `--no-watch` 的使用判据：只用于确定不会合入，或武装失败原因为永久性
  （否则 pending 会积一条清不掉的 `AUTO_RECLAIM_NOT_ARMED`）。明确禁止因 watcher 活不过会话或
  为压后台进程数而关闭——前者是 `watch-service` 的职责，后者不成立（`disabled` 持久且不重试）。
- `watch-service status` 进入强制流程表的「恢复/盘点」行，不再只以表外散文形式存在。

- 四个 SKILL.md 对 `docs/<域>/` 的引用从相对链接改为 `agentkit docs <域> <主题>` 命令。宿主把 Skill
  基目录报成安装路径（常为软链），Read 工具按词法折叠 `..`，原 `../docs/...` 链接在安装态全部不可达，
  agent 只剩摘要表。`validate-skills` 新增安装态检查：SKILL.md 相对链接越出 Skill 目录即报错，
  `agentkit docs` 引用的主题必须真实存在。

## 1.1.0 - 2026-09-07

- 修复从待回收 worktree 自身执行 `reclaim` 时，目录删除后误判本地分支已不存在的问题；未完成的
  branch cleanup 现在返回非零并可幂等重试。
- `manage-worktrees` 持久化评审 watcher 的 pending/disabled 意图，让 `doctor` 与 `resume-all` 不再忽略未武装记录。
- 新增 macOS `watch-service` LaunchAgent，为已登记 watcher 提供跨 Agent 会话与重启后的自动恢复触发。

## 1.0.0 - 2026-09-04

- 将四个 Agent 工程 Skill 收敛为一个零依赖 Node.js CLI 与四个薄壳。
- 提供 orchestrate、worktree、verify、loop、capabilities、doctor 与 docs 命令面。
- 将共享运行时、canonical schema、安装身份和内容摘要统一到单个版本化发布单元。
- 保留 1.x Skill 脚本兼容入口，并增加 CLI/shell 版本失配的 fail-closed 门禁。
- 覆盖四个 Skill 的 15 种非空安装组合、跨域协议、恢复路径与 npm tarball 反装。
- 将 `cr1992/agentkit` 设为代码、测试、架构文档和发布流程的唯一真源。
