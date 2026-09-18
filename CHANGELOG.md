# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## Unreleased

- 新增 `agentkit contract interview-ask / interview-answer / interview-freeze`：一台由实质性判据的
  拒绝清单驱动提问、由自己的三条完成判据决定何时冻结的状态机。命令本身不调用任何模型，只出题、
  校验回填、冻结；选项由调用它的模型填，选哪个由用户定。提问顺序固定为
  `permissions → objective → acceptance → scope.include → scope.exclude → stop_conditions`，
  `permissions` 必问且最先问——`scope.exclude` / `stop_conditions` 的判据只在 write 模式下生效，
  而 scaffold 默认 `read_only`，不先问权限，写任务会一路走完却从没被问到边界和刹车。
  轮次与作答记录写在契约草稿自己的 `extensions.interview` 里，并进入 `contract_digest`；上限 3 轮。
  `permissions` / `objective` / `acceptance` 必须有 `source: "user"` 的作答记录，不接受 assumption——
  否则模型可以先把 `objective` 写进草稿，再记一条"用户说都行"，在没有任何用户选择的情况下把契约冻掉。
  只有 `scope.include` / `scope.exclude` / `stop_conditions` 可以 `deferred`，`assumed` 会原样写进对应字段
  （执行方读的是契约字段而不是 `extensions`），`assumed` 允许是空数组表示"没有"。
  用法见 `agentkit docs orchestrate contract-interview`。
- 新增 `agentkit contract scaffold` 别名。契约骨架下沉到 `core/contract-scaffold.mjs`，
  与 `agentkit verify scaffold --kind contract` 同源，两边只在 `skill_set` 上分叉
  （各自冻结自己域的 content digest）。
- ledger 状态发现。`orchestrate ledger init` 在 `contract.environment.repository` 所属仓库的
  git common dir 下写仓级指针 `<git-common-dir>/agentkit/ledgers/<ledger_id>.json`（第 18 份
  canonical schema `ledger-pointer-v1`），`close`（含 `--abandon`）成功后删除它。**指针不是真源**：
  只回答"ledger 在哪"，一切判定仍回读 state root 的事件链；指针只写在 `.git/` 下，不进版本控制。
  写/删失败一律降级为 warning，不让 `init` 失败后留下半个 ledger。
- 新增顶层 `agentkit status [--json]`：从 cwd 找 git common dir，读全部指针、回读各 state root，
  筛出未终态的 ledger，单屏给出当前阶段、活跃 worktree、阻塞项、未覆盖节点与下一步命令。多个时
  全部列出不猜测；受管 worktree 里用 record 的 `ledger` 字段收窄；`skill_drift` 的单独成组，
  下一步只给 `close --abandon` 与 re-contract。
- `orchestrate ledger doctor` 新增 `--repository <path>` 档位，扫描并分类该仓的全部指针；
  回收是显式的 `orchestrate ledger reclaim-pointers --repository <path>`，不藏在只读的 `doctor` 里。
  **drift 但未进入终态的 ledger 指针一律保留**：它还需要有人来 `close --abandon` 或 re-contract。
- `worktree spawn` 新增可选 `--ledger <id>`，写进 record 的 `ledger` 字段供 `agentkit status` 收窄；
  worktree 域只校验 id 格式，格式规则下沉到 `core/ledger-pointer.mjs`，两个域之间不互相 import。
- 升级影响：`core/ledger-pointer.mjs` 与第 18 份 schema 都在三个域的内容摘要范围内，本次发版后
  所有在途的 ledger、loop、verify run 都会 `skill_drift`，请先收尾在途任务。升级前 init 的 ledger
  没有指针，`agentkit status` 找不到它们，仍需手传 `--ledger <ledger 目录>`。
||||||| 262405d

## 1.1.1 - 2026-09-08

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
