# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## Unreleased

- 修复 `agentkit worktree unwatch` 只翻 record 状态、不等后台 watcher 退出的竞态。此前命令返回后
  detached worker 最快也要等下一轮轮询才发现自己被解除，期间仍在写心跳、target cache 和 `FETCH_HEAD`；
  紧接着删除或移动该 worktree 会与这些写入相撞（在 CI 上表现为 teardown `rmSync` 报 `ENOTEMPTY`）。
  现在解除事件落盘后按进程组终止该次租约的 watcher，worker 与它在途的 `git fetch` 子进程一起收尾，
  等整组退出才返回；只有心跳与 record 登记同一个 pid 时才发信号。输出新增 `watcher=<终态>` 后缀，
  发信号被拒或超时未退出时额外打印告警。

## 1.2.0 - 2026-09-20

- 升级影响：本批改动多数触及 `core/`、`schemas/`、各域 `domains/<域>/` 或 `docs/<域>/`，升级后
  所有升级前 init 的在途 ledger、loop、verify run 都会判定为 `skill_drift`，需要先收尾在途任务
  再升级。升级后 drift 的 ledger 可用 `agentkit orchestrate ledger close --abandon --reason <text>`
  记为放弃；drift 但未放弃、未进入终态的 ledger 指针会一直保留，等待 `close --abandon` 或
  re-contract。升级前 init 的 ledger 没有仓级指针，`agentkit status` 找不到它们，仍需手传
  `--ledger <ledger 目录>`。
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
- 契约、profile 的创建入口（`contract validate`、`ledger init`、`verify preflight / init / prepare-run`、
  `loop init`）新增实质性检查，原样照抄 `verify scaffold` 生成的占位契约或 profile 一律拒绝，
  报错给出字段路径与当前值但不给可以照抄的合规值；`prepare-run` 遇到该拒绝时紧凑输出也会带上
  `errors`。续跑与恢复入口（`ledger add-node`、`verify record-review` / `validate`、
  `loop adopt-root` / `record-embedded-review` / `validate`）不重判实质性，行为不变。
  同一批判据里，每条 `acceptance[].contract_item_id` 必须至少被一条 `l1_review` 引用，不分权限
  模式，只在同时拿到契约与 profile 的创建入口执行；`permissions.mode` 为 `write` 且
  `scope.exclude` / `stop_conditions` 为空只降级为 warning，不拒绝、退出码不变。`warnings` 键仅
  非空时出现：见 `contract validate`、`ledger init`、`verify init`、`loop init` 的返回值，以及
  `preflight` 报告（该键恒在，可能是空数组）；`prepare-run` 把它放进完整报告的
  `preflight.warnings`，默认紧凑输出不带，取证需加 `--verbose`。`ledger / verify / loop doctor`
  新增 `substance_warnings`：恒在，把手上能执行的判据整体降级为 warning，不进 `findings`，
  不改变 `healthy`。
- 声明 `extensions.verification.provider === 'verify-agent-output'` 时，`completion_ready` 要求每个
  required 的实现节点（`verification.requirement !== 'not_applicable'`）要么自身是已通过的
  `independent_evidence` 节点，要么沿 `dependency` / `barrier` 边可达一个已通过、
  `artifact_scope: integration_candidate` 的 `independent_evidence` 节点；不满足则拒绝视为完成。
  没有任何 required 节点的空 ledger，`completion_ready` 恒为 false。`status` / `inspect` 的
  `summary` 新增三份名单：`uncovered_implementation_nodes`（声明 provider 但未被覆盖的实现节点）、
  `non_required_implementation_nodes`、`nodes_without_independent_evidence`（未声明 provider 时，
  列出尚未经独立验证的实现节点）。
- `orchestrate ledger close` 要求 `status` 判定的 `completion_ready` 为 true，不满足时非零退出，
  逐条列出未满足的条件（同一份文本同时出现在 `status.summary.unmet_completion_conditions`）；
  `close --abandon --reason <text>` 记为放弃，`reason` 必填且非空，不带 `--abandon` 的 `--reason`
  会被拒绝。事件链新增终态事件 `closed` / `abandoned`，快照新增可选字段 `lifecycle`
  （终态种类、时间、reason、写入时的 runtime 摘要与 drift 状态），旧快照不含该字段仍然合法。
  `close` 返回体新增 `pointer` 字段（仓级指针的写入/删除结果）。ledger 进入终态后任务图冻结，
  `add-node / add-edge / dispatch-record / update / attach / batch-init / batch-record / close`
  等修改命令一律拒绝，只读命令与 `record-reflection / propose-improvement / rebuild` 仍可用；
  `status` / `inspect` 新增输出键 `skill_drift`，drift 下 `close --abandon` 是唯一仍能写入的路径，
  其余修改命令照常拒绝。
- ledger 状态发现。`orchestrate ledger init` 在 `contract.environment.repository` 所属仓库的
  git common dir 下写仓级指针 `<git-common-dir>/agentkit/ledgers/<ledger_id>.json`（第 18 份
  canonical schema `ledger-pointer-v1`），`close`（含 `--abandon`）成功后删除它。**指针不是真源**：
  只回答"ledger 在哪"，一切判定仍回读 state root 的事件链；指针只写在 `.git/` 下，不进版本控制。
  写/删失败一律降级为 warning，不让 `init` 失败后留下半个 ledger。
- 新增顶层 `agentkit status [--json]`：从 cwd 找 git common dir，读全部指针、回读各 state root，
  筛出未终态的 ledger，单屏给出当前阶段、活跃 worktree、阻塞项、未覆盖节点与下一步命令。多个时
  全部列出不猜测；受管 worktree 里用 record 的 `ledger` 字段收窄；`skill_drift` 的单独成组，
  下一步只给 `close --abandon` 与 re-contract。
- `orchestrate ledger doctor` 新增 `--repository <path>` 档位（返回体新增 `mode: "repository"`，
  单 ledger 档位为 `mode: "ledger"`），扫描并分类该仓的全部指针；回收是显式的
  `orchestrate ledger reclaim-pointers --repository <path>`，不藏在只读的 `doctor` 里。
  **drift 但未进入终态的 ledger 指针一律保留**：它还需要有人来 `close --abandon` 或 re-contract。
- `worktree spawn` 新增可选 `--ledger <id>`，写进 record 的 `ledger` 字段供 `agentkit status` 收窄；
  worktree 域只校验 id 格式，格式规则下沉到 `core/ledger-pointer.mjs`，两个域之间不互相 import。
- 编排拦截点（缺 `verification_ref`、`verification_ref` 类型不符、`completion_ready` 为 false 时
  `close`、drift 下执行修改命令）的报错文案改写为"违规原因 + 合规做法"：点出字段路径或节点 id、
  当前值、要求的性质与可执行的命令/flag 名，取值一律用占位符，不给可以照抄的合规值；不新增拦截点，
  不改变任何命令的放行/拒绝行为、`error` 码或退出码。
- `verify-agent-output` 的证伪任务提示词新增一条：已成立的 finding 涉及结构调整时，`expected`
  必须写出具名重构手法且只针对该 finding 的 `contract_item_id`，给不出具名手法的结构评价不写入
  findings；不扩大取证范围，不新增 schema 字段。
- 架构文档 `docs/architecture/skill-system-architecture.md` 只保留与真源不重复的内容，其余段落
  改写为指向 `domains/<域>/`、`docs/<域>/`、四份 `SKILL.md`、`schemas/`、`core/digest.mjs` 等真源的
  指针（累计从 114,315 字节精简到 49,877 字节）；`tests/architecture-consistency.test.mjs` 的判据
  从"固定字符串存在"改为"指针能实际解析且覆盖当前 `domains/*` 与 `docs/<域>/` 目录"。四份
  `SKILL.md` 补齐指向 `agentkit status`、`orchestrate ledger close`、`contract interview-*`、
  `worktree spawn --ledger` 的指针；`tests/documentation.test.mjs` 新增孤儿文档检查，
  `docs/<域>/` 下每个主题必须被至少一个 `SKILL.md` 以 `agentkit docs <域> <主题>` 的形式指到。
- 四个 Skill 的正文字符预算按当前实测值重新标定并去掉总量卡口里不再起约束作用的重复上限；
  `description` 合计上限改为按 Skill 数量推导。删除 `approximate_tokens`
  （原按英文字符数估算 token，在中英混排文本上系统性偏差较大）。`tests/skill-budgets.mjs`
  作为预算数字的共享真源，供架构文档反查比对。
- 新增手动触发的发版流水线（`.github/workflows/release.yml`）：`verify`（限定从 `main` 发布、
  版本号须与 `package.json` 一致、该版本不得已在 registry 上、`npm test` 与 tarball 干净安装验证，
  Node 22/24 双版本矩阵）→ `publish`（`npm publish --provenance`）→ `attest`（从 registry 反装并跑
  `agentkit doctor` 确认版本一致，同样跑 Node 22/24 双版本矩阵）→ `tag-and-release`（同一 commit
  对同一 semver 打 tag、建 GitHub Release，正文从本文件对应小节程序化提取，缺小节即失败）。
  `verify` 与 `attest` 两段的发布证据（`npm pack --dry-run` 文件清单、`agentkit doctor` 输出，
  均带上 commit SHA 与版本号）按矩阵各存为一份 GitHub Actions 产物。需要仓库 secret `NPM_TOKEN`。
- 新增 `evals/protocol-routing/`：协议路由评测 harness 与 11 条用例，用于衡量 agent 在给定提示下
  是否按预期路由到只读、`agentkit <域> <动词>` 或写操作。支持预录 JSONL 回放（接入 `npm test`）与
  两种真实评测运行方式——GitHub Actions + `ANTHROPIC_API_KEY`，或本机一次性容器
  （`evals/protocol-routing/container/`）+ `claude setup-token` 生成的订阅 token；容器以只读挂载
  仓库、非 root 用户、`--cap-drop ALL` 等收紧运行。均不进发布包，不在任何 Skill 内容摘要范围内。
- 本批各域新增用户可见能力，同步各升一个 minor：`orchestrate-subagents` 的
  `ORCHESTRATION_RUNTIME_VERSION` 1.7.0 → 1.8.0（`ledger close`、`reclaim-pointers`、`status` 新键）；
  `contract-tool` 的 `capabilities().runtime_version` 1.1.0 → 1.2.0（`scaffold`、`interview-*`）；
  `verify-agent-output` 的 `RUNTIME_VERSION` 1.3.0 → 1.4.0（实质性检查、`warnings` /
  `substance_warnings`）；`run-agent-verify-loop` 的 `RUNTIME_VERSION` 1.0.0 → 1.1.0（同上）；
  `manage-worktrees` 的 `runtime_version` 1.4.0 → 1.5.0（`spawn --ledger`）。
  `orchestration-reflection`、`worker-capability-preflight`、`review-budget` 本批未改行为，
  runtime version 不动。

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
