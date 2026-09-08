# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## Unreleased

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
