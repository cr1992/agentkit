---
name: manage-worktrees
description: "管理 Git worktree 隔离、批量集成候选与生命周期：扫描写入碰撞，创建或接管可追踪 worktree，登记归属，为多个 feature 生成固定 SHA 的批次验收计划，并完成交接、审计、合入监听和安全回收。当用户明确要求 worktree、多 feature 联合验收或集成测试分支，已确认多个 Agent、线程或开发者会同时写入同一仓库且存在覆盖风险，或编排层因写入归属不明且路径相交、丢失代价高而裁决需要隔离时使用。只读并行、不需要跨分支合成的普通单写入者/顺序执行、仅因仓库 dirty 或理论上可能并发的场景不适用。"
---

# manage-worktrees：Git Worktree 隔离与生命周期

在改文件之前选择最小安全隔离，并让每棵 worktree 都能回答：谁创建、为何创建、正在做什么、谁接手、哪些提交属于谁、为何尚未回收。

## 组合位置

本 skill 是环境适配层，不决定是否派生 Agent，也不判断全局任务是否完成：

- 由 `orchestrate-subagents` 调用时，接收已确认的写入者和并发关系，或已裁决的归属不明 / 路径相交风险；只负责返回目标仓的隔离位置与生命周期记录。
- `run-agent-verify-loop` 中只有 implementer 写、verifier 只读时不需要 worktree；多个 implementer 并行写或 controller 同时写时才使用本 skill。
- 用户可以直接要求创建、接管、审计或回收 worktree，此时无需加载其他 skill。
- 与 `verify-agent-output` 组合时，由本 Skill 输出 Artifact Ref；verifier 只消费冻结身份，不接管 worktree 生命周期。

本 skill 自带 portable runtime，要求 Node.js 18+ 且 `git` 可执行文件在 `PATH`。先从本文件位置解析 skill 目录绝对路径；不要猜固定安装路径，也不要假设当前 shell 是 Bash。

POSIX shell 使用：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" <command>
node "$SKILL_DIR/scripts/worktree-scan.mjs" <command>
```

PowerShell 使用：

```powershell
$SkillDir = (Resolve-Path "<skill-directory>").Path
node (Join-Path $SkillDir "scripts/worktree-mgr.mjs") <command>
node (Join-Path $SkillDir "scripts/worktree-scan.mjs") <command>
```

下文多行示例采用 POSIX 续行语法；PowerShell 或 cmd 中保留相同 argv，改成宿主支持的一行命令或续行语法。不要把 `python3`、`bash`、`~` 展开或 `/tmp` 视为跨平台常量。

不要假设目标仓库有同名脚本。仓库可以通过根目录 `.worktree-trace.json` 提供 Profile，但 portable core 不执行 Profile 中的任意 shell command。配置 schema 和项目适配边界见 [references/profile.md](references/profile.md)。

所有命令都必须从**目标 Git 仓库的任意 worktree 内**执行；`SKILL_DIR` 只用于定位脚本，不能先 `cd` 到 skill 安装目录。manager 以当前工作目录解析 repository identity、primary worktree 和 Profile。

### 跨 Skill 稳定产物

需要交给 verifier 或 orchestrator 时，不手抄 SHA 和 owner：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" capabilities --json
node "$SKILL_DIR/scripts/worktree-mgr.mjs" binding <selector> --json
node "$SKILL_DIR/scripts/worktree-mgr.mjs" artifact <selector> --json
node "$SKILL_DIR/scripts/worktree-mgr.mjs" verify-artifact <artifact.json> --json
```

`artifact` 只接受存在、clean 的 worktree，绑定 repository identity、完整 commit、worktree ID 和
ownership epoch。`verify-artifact` 重算 object format、commit ancestry、owner epoch 与 live HEAD；
任何漂移都要求重新冻结 Artifact，不能沿用旧验证结果。Binding 只表达隔离与归属，`task_status:
done` 不代表验证通过或全局任务完成。

碰撞、漂移、交接或回收异常可用 `incident <selector> --input <json>` 记录带 trace event 摘要的
Reflection，再用 `propose-improvement --reflection <uuid> --input <json>` 形成 `proposed` 候选。
这些文件写入 Git common-dir 下的运行状态，不进入业务源码，也不自动修改 Profile 或 Skill。

manager 的 trace/common-dir 状态只应由受信 operator/controller 与 runtime 写入。event digest 链用于
发现部分、追加、乱序和意外损坏，不是签名或外部不可变审计锚；拥有该状态完整写权限的进程可重写
一条自洽历史。Artifact/owner epoch 的机械保证以诚实 runtime 和受信状态 writer 为权限边界。

## 强制流程

### 1. 先恢复和检查全局状态

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" resume-all
node "$SKILL_DIR/scripts/worktree-mgr.mjs" list
node "$SKILL_DIR/scripts/worktree-mgr.mjs" doctor
```

- `resume-all` 只恢复已经登记并 arm、但 heartbeat stale/missing 的 watcher。
- `list` 和 `doctor` 严格只读，不启动进程、不删目录。
- `UNTRACKED` 代表 Git 已知但 trace 未登记的树，不能当成无人使用。
- `EPHEMERAL` 代表平台 `tmpdir()`、`/tmp`、macOS `/var/folders` 或 Profile 声明的其他易失目录，优先 commit + push。
- 不根据目录年龄、名称或“看起来干净”自动删除。

`doctor` 出现 error 时暂停 `spawn` / `adopt`。尤其不能绕过 Profile drift、命名 DoD、event chain 或 branch cleanup 错误。

### 2. 改文件前扫描碰撞

```bash
node "$SKILL_DIR/scripts/worktree-scan.mjs" scan --target path/a.ts,path/b.css
```

- `COLLIDE`、目标多、范围不确定或重做成本高：创建独立 worktree。
- `CLEAR` 且改动小、文件归属明确：可以留在当前树。
- 拿不准时选择 worktree；额外集成成本低于覆盖别人未提交改动的风险。

portable scan 默认检查所有 worktree 的 dirty 文件和近期 commit。任务看板等额外来源只能由仓库 Profile 以 adapter 显式开启。

### 3. 建树前先收敛交付身份

不要因为 task / branch 名不同、要刷新 base、整理提交链或重做 change request 包装，就默认创建新树。`spawn` 前对照在飞 record，按实际交付关系选择：

- **复用**：验收结果、目标 ref、写入归属相同，且预计改动面实质重叠时，优先继续现有树。目录或提交历史“不够干净”本身不构成独立交付。
- **并存**：只有成果能独立评审、合入和回退，依赖确需单独先落地，或多个写入者确实需要隔离时，才视为独立树。不同 MR、branch 或命名只能作为线索，不能单独证明独立。
- **替代**：旧树因基线、历史、环境、权限或所有权问题不宜继续时，可以重建，但先冻结旧写入并记录 `旧树 -> 新树`、独有改动保存位置和退出条件。能先退役就先退役；迁移必须短暂并存时，及时展示两树的关系、负责人和待完成的回收动作。

替代完成后，停止旧 watcher，关闭或改指被替代的 change request，并在保存独有 dirty / unpushed 内容后尽快将旧 record 标为 `abandoned`、执行保守回收。不要用固定 worktree 数量或名称相似度做硬门禁；数量是复查交付边界的信号，不是结论。

manager 以宿主提供的真实 `agent-id` 作为最小执行门禁：同一 Agent 会话已有未回收树时，
换一个 task 名再次 `spawn` 会返回 `DELIVERY_WORKTREE_EXISTS`。继续同一交付时直接进入原
路径工作，不再调用 `spawn`；确属独立交付并行时必须显式说明：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" spawn independent-release-audit \
  --agent codex \
  --agent-id <real-thread-id> \
  --purpose "独立发布审计" \
  --parallel-reason "与现有功能改动可独立评审、合入和回退"
```

旧树确实必须被替代时，先让旧树干净并用 `touch ... --status abandoned --note <迁移边界>`
冻结，再显式登记双向关系：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" spawn current-ios-validation \
  --agent codex \
  --agent-id <real-thread-id> \
  --purpose "迁移到不可继续使用的旧基线之外" \
  --supersedes old-ios-validation \
  --replacement-reason "旧基线与目标环境不兼容，独有提交已保存"
```

`--parallel-reason` 与 `--supersedes/--replacement-reason` 互斥。它们是经人工裁决后的审计
出口，不是“多建一棵更省事”的绕过开关；`doctor` 会报告同一会话遗留的、未声明关系的
多 worktree。

旧版工具或外部流程已经建好替代树、但当时没有写入关系时，不要伪造新树或手改 trace。先让
两树干净、旧树进入 `abandoned`，再补登记：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" supersede old-ios-validation \
  --by current-ios-validation \
  --reason "旧基线已由新树完整替代，独有提交已确认"
```

`supersede` 只接受同一 Agent 会话、owner 一致且新树创建时间不早于旧树的组合；命令双向写入
`superseded_by` / `delivery_relation`，可幂等重跑，遇到已有冲突关系则 fail-closed。

### 4. 满足命名 DoD 后建树

命名规则是门禁，不是建议。任一条件不满足都必须报错，不得自行拼 branch/path 或用随机后缀绕过：

1. task 是可读的 lowercase semantic slug，至少两个以字母开头的连字符分词，例如 `ci-gate-hardening`、`portable-worktree-skill`。
2. 禁止 `trace-9`、纯任务编号、UUID、hash、日期串或没有业务语义的缩写。
3. 可见 branch/path 必须包含完整 host 与完整 task；trace UUID 和 session ID 只存在 metadata，不进入名称。
4. `spawn` 回显的 task、branch、path、base 必须符合 Profile；不一致就停止，不能进入错误树改文件。

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" spawn ci-gate-hardening \
  --agent codex \
  --agent-id <real-thread-id> \
  --owner <human-owner> \
  --purpose "加固 CI 与本地提交门禁" \
  --codegraph auto
```

相同 `agent-id` 下已存在其他未回收树时，上述普通 `spawn` 必须复用已有树或按第 3 节显式
声明 `--parallel-reason` / `--supersedes`，不能仅通过改 task slug 创建新交付身份。

`--agent-id` 必须是宿主提供的真实 session/thread/task ID，不知道就从宿主上下文查，禁止现编占位值。它只用于追踪，不参与可见命名。

无 Profile 时的安全默认值：

- base：remote HEAD → `origin/main` → `origin/master` → upstream → `HEAD`
- branch：`{host}/{task}`
- root：`--root` → `WORKTREE_ROOT` → Profile `worktree_root` → `~/.worktrees`
- path：`~/.worktrees/<repo>/{host}-{task}`

root 的个性化与降级规则：

- 一次性覆盖使用 `--root <authorized-path>`；当前宿主/用户偏好使用 `WORKTREE_ROOT`；仓库长期约定使用 primary Profile 的 `worktree_root`。
- 显式 root 不可写时 fail-closed，不静默换位置；修正配置后重试。
- 只有零配置默认 `~/.worktrees` 因 `EACCES` / `EPERM` / `EROFS` 不可写时，才依次降级到仓库同级 `.worktrees`、平台 `tmpdir()/agent-worktrees`。降级来源写入 record；临时目录会标为 `EPHEMERAL`。
- manager 在创建 branch 前认领并验证 root；若 `git worktree add` 仍失败，只在能证明新 branch 未挂载且 tip 等于 base 时删除该空 branch，否则 `KEEP + 原因`。

只有同名仓库容器确实属于另一 repository identity 时，工具才在仓库容器层增加短 identity；branch 和 task 始终保持可读。相同 agent/session/task 的重复 `spawn` 幂等复用；同一 host 的同名活跃任务直接报冲突，要求 handoff 或重新划清任务边界。

如果目标 local branch 已存在但没有匹配的活跃 trace record，`spawn` 返回 `BRANCH_ALREADY_EXISTS`，绝不把旧 branch tip 静默挂到新 worktree。先完成/修复原 branch cleanup，或使用新的 semantic task；已有外部 worktree 走 `adopt`。

需要基于依赖分支时必须记录理由：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" spawn api-contract-followup \
  --agent codex \
  --agent-id <real-thread-id> \
  --purpose "基于未合入契约实现客户端" \
  --base origin/agent/api-contract \
  --base-reason "依赖契约分支，随后随该分支进入默认目标分支"
```

### 5. 接管宿主创建的外部树

宿主可能绕过 manager，在 scratchpad 或临时目录建树。发现后立即登记：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" adopt /absolute/path/to/worktree \
  --agent claude \
  --agent-id <real-session-id> \
  --purpose "修复什么、交付什么"
```

path、branch、HEAD、base 和 task 会尽量推断。detached HEAD 或 branch 无法生成合法语义 task 时，显式补 `--task <semantic-slug>`；不要猜 Agent 身份。

### 6. 更新状态并安全交接

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" touch <task-or-id> --status blocked --note "等待环境"
node "$SKILL_DIR/scripts/worktree-mgr.mjs" touch <task-or-id> --status active
node "$SKILL_DIR/scripts/worktree-mgr.mjs" touch <task-or-id> --status ready_for_review
```

换 Agent 前必须先让工作树干净并 push，再执行：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" handoff <task-or-id> \
  --to-agent kiro \
  --to-agent-id <real-task-id> \
  --note "已完成什么，下一步是什么"
```

handoff 保存 ownership boundary SHA；脏树交接会被拒绝。不要用 stash 搬运未提交改动。

### 7. 审计、提交和监听合入

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" audit <task-or-id>
node "$SKILL_DIR/scripts/worktree-mgr.mjs" audit <task-or-id> --json
```

portable core 不决定 MR、PR 或直推策略。先执行目标仓库自己的测试、commit gate、review 和 push 规则。

Profile 启用 change-request provider 时，可以使用 `submit` 完成 push、创建 change request、登记 review 状态并 arm watcher：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" submit <task-or-id> \
  --title "<change request title>" \
  --description "<single-line summary>" \
  --notify auto
```

如果 change request 已由 UI/API 创建，使用通用 fallback：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" touch <task-or-id> --status ready_for_review --note "PR/MR <url>"
node "$SKILL_DIR/scripts/worktree-mgr.mjs" watch <task-or-id> \
  --target origin/main \
  --change-ref "PR/MR <url>" \
  --notify auto
```

`watch` 冻结精确 head SHA，只在该 SHA 成为目标 ref 的祖先后进入安全回收。电脑重启后由 `resume-all` 恢复 stale watcher。change request 关闭且不会合入时显式执行 `unwatch`。

### 8. 规划批量集成验收

只有需要证明多个 feature **合成后**的兼容性时才建集成候选树；仅批量跑各分支独立检查时，verifier 直接读固定 SHA，不建树。

先按项目规则刷新 target ref，再在**单一 Git 仓库根**执行只读规划：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" plan-batch \
  feature-a feature-b feature-c \
  --target origin/main \
  --json
```

`plan-batch` 不 fetch、不 merge、不创建树。它固定 target SHA 和有序 feature HEAD，并且：

- 拒绝 dirty、未完成 merge/rebase/cherry-pick、HEAD 与 trace 漂移、未进入评审态或未推送的输入。
- 排除已被 target 包含的 HEAD；子分支已包含父分支时折叠父分支，避免重复合成。
- 只在没有 blocker 且仍有唯一输入时返回 `ready=true` 和稳定 `fingerprint`。

`ready=true` 后，controller 使用语义化 task 调用 `spawn`，从计划中的 target ref 建立**一次性集成候选 worktree**，并把 fingerprint、target SHA、有序输入 SHA 写入验收台账。只允许该 controller 在候选树按冻结顺序合成精确 SHA；feature 树仍禁止 merge。冲突时停止验收并归因，可在候选树用 `git merge --abort` 回到干净 target，不在候选树修业务代码。

target SHA、任一输入 SHA、顺序或验收契约变化后，旧结果立即 `stale`，重新规划。多仓目录必须按 repository identity 分批，再由上层台账汇总；Git worktree 无法合成跨仓提交。完整状态、报告契约和运行时隔离见 [references/batch-integration.md](references/batch-integration.md)。

### 9. 保守回收

已合入或已推送成果的人工恢复出口：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" reclaim <task-or-id> --pushed <exact-sha>
```

只有无 stash、树干净、branch/HEAD 已进入给定 SHA，才执行：

```text
final_snapshot -> reclaim_ready -> git worktree remove -> branch cleanup -> reclaimed
```

进入 `reclaimed` 时，manager 在同一终态事件中把非 `abandoned` 任务收敛为 `done`，并用最终 source
HEAD 闭合当前 ownership epoch。对旧版本留下的 `reclaimed` 但状态 / epoch 未闭合的 record，重复
执行同一条 `reclaim --pushed <exact-sha>` 会追加可审计的 reconciliation event 后再做 branch 对账。

被替代、未推送的旧树不能为了清理而推送废弃分支。双向替代关系已经登记后，默认先把旧 HEAD
保存到仓库内的持久 ref，再回收：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" reclaim old-ios-validation \
  --superseded-by current-ios-validation
```

默认归档 ref 为 `refs/worktree-archive/superseded/<old-worktree-id>`。工具验证旧树是 `abandoned`、
两边属于同一会话/owner、关系双向一致、替代树干净，并继续执行普通 reclaim 的 stash、旧树 dirty、
submodule 与目录审计。归档创建并回读到精确旧 HEAD 后才允许删除目录和本地 branch；ref 与恢复证据
写入 event/record，后续可用 `git branch <recovery-branch> <archive-ref>` 恢复。

只有人工明确裁定旧提交无需恢复时，才允许用精确旧 HEAD 授权无归档回收：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" reclaim old-ios-validation \
  --superseded-by current-ios-validation \
  --discard <exact-40-char-old-head>
```

`--discard` 不是布尔开关；SHA 与实时旧 HEAD 不完全一致即拒绝。归档与丢弃策略一经登记不得互换。
`doctor` 会持续报告仍为 `present` 的 abandoned/superseded worktree，以及断裂的单向替代关系；
`abandoned` 只是冻结写入，不等于完成回收。

禁止 `rm -rf` 和 `git worktree remove --force`。目录已删但 local branch cleanup 失败时，trace 保留 `BRANCH_PENDING`，修复占用后重跑同一条 `reclaim`；工具会重新验证 branch tip，不能用 `-D` 绕过。

worktree 位于当前宿主或沙箱写权限之外时，先取得该目录的写权限再回收。`git worktree remove` 失败会以非零状态返回 `KEEP`，并把 Git 原始错误写入 `reclaim_failed` 事件供 `doctor` 复查；若 Git 已解除登记但物理目录仍在，record 不得标成 `reclaimed`，后续重跑也维持非零 `KEEP`。此时先人工审计并恢复权限或登记关系，禁止用强删掩盖孤儿目录。

含 submodule 的树在上述审计通过后，由工具逐个校验已初始化 submodule 工作区干净，再自动 `deinit` 并清理该树私有的 submodule 元数据后继续回收；任一 submodule 脏、未初始化目录非空或 `.git` 指针悬空都维持 `KEEP`，保留不可审计内容并标明具体路径。

## 并发安全底线

- 当前树并发时只改明确归属文件，提交必须带 pathspec：`git commit -m "type(scope): message" -- <owned-files...>`。
- 小步 commit、频繁 push；worktree 只隔离 working directory/index，仍共享 refs、objects 和 stash。
- 禁止 feature owner/agent 自行执行 `stash`、`reset --hard`、`clean -fd`、`checkout -- .`、`restore`、`merge`、`pull`、`rebase`。唯一例外是已登记的批次 integrator 在专用候选树按 `plan-batch` 冻结顺序 merge 精确 SHA，或用 `git merge --abort` 退出失败合成。
- manager 只拥有它创建或接管的 worktree、branch 和 trace metadata，不拥有项目凭证、SDK license、个人 token 或共享运行态。
- 秘密放在仓库外的 credential store；不得复制、软链或写入 trace。
- event 是真源，record 是可重建缓存；`doctor` 永远只报告，不自动修复或删除。
- trace 是本机审计，不替代跨机器任务看板、代码评审或文件锁。

## 命令速查

| 命令 | 作用 |
|---|---|
| `list [--all] [--json]` | 展示 tracked、untracked、missing、branch pending 和历史记录 |
| `doctor [--json]` | 只读检查 Profile、命名、事件链、watcher、目录和 branch cleanup |
| `plan-batch <selector...> [--target] [--json]` | 固定批次 target/输入 SHA，折叠依赖并输出可复现指纹 |
| `spawn` / `adopt` | 创建或接管可追踪 worktree |
| `supersede <old> --by <new> --reason` | 为已存在的替代树补登记双向交付关系 |
| `touch` / `handoff` | 更新状态或按干净 SHA 边界交接 |
| `audit` / `rebuild` | 审计或从 event 真源重建 record cache |
| `submit` / `watch` / `resume-all` / `unwatch` | 管理 change request 与合入监听 |
| `reclaim --pushed` / `--superseded-by` | 按已推送证据，或归档被替代旧 HEAD 后保守回收 |

所有命令支持 `--config <path>`。默认只读取 Git primary worktree 根的 Profile，linked worktree 副本不能隐式改变仓库约定。

显式 `--config` 是人工核对后的恢复出口：它不会刷新 primary `default_base` 或执行 drift gate，只使用本地已有 ref。离线使用前，调用者必须自行确认 Profile 与 base ref 已同步。
