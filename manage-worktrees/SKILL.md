---
name: manage-worktrees
description: "管理 Git worktree 隔离与生命周期，包括碰撞扫描、创建或接管、堆叠分支、批量集成候选、交接和回收。仅在明确需要 worktree，或同仓多写入者存在覆盖风险时使用；只读并行和普通单写入者不适用。"
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

watcher 发现目标分支已从登记 base 前进、但冻结 HEAD 尚未合入时，会记录只读冲突预判：
`TARGET_ADVANCED_REFRESH_CLEAN`、`REBASE_NEEDED` 或 `TARGET_ADVANCED_PREDICTION_UNKNOWN`。预判使用
`merge-tree`，只用于估算操作成本，不保证逐 commit rebase 必然同样成功。

### 2. 改文件前扫描碰撞

```bash
node "$SKILL_DIR/scripts/worktree-scan.mjs" scan --target path/a.ts,path/b.css
```

- `COLLIDE`、目标多、范围不确定或重做成本高：创建独立 worktree。
- `CLEAR` 且改动小、文件归属明确：可以留在当前树。
- `match=exact|ancestor, confidence=high` 表示仓库根路径直接重叠；`match=suffix-relative,
  confidence=low` 只来自声明了 app 相对路径的任务 adapter，保持保守 `COLLIDE`，但先人工确认路径
  基准再决定是否隔离。Git worktree / recent commit 来源不做 basename 或后缀模糊匹配。
- 拿不准时选择 worktree；额外集成成本低于覆盖别人未提交改动的风险。

portable scan 默认检查所有 worktree 的 dirty 文件和近期 commit。任务看板等额外来源只能由仓库 Profile 以 adapter 显式开启。

### 3. 建树前先收敛交付身份

不要因 task/branch 名不同、刷新 base、整理提交链或重做 change request 包装就默认创建新树。`spawn`
前按实际交付关系选择：

- **复用**：验收结果、目标 ref、写入归属相同，且预计改动面实质重叠时，优先继续现有树。目录或提交历史“不够干净”本身不构成独立交付。
- **并存**：只有成果能独立评审、合入和回退，依赖确需单独先落地，或多个写入者确实需要隔离时，才视为独立树。不同 MR、branch 或命名只能作为线索，不能单独证明独立。
- **替代**：旧树因基线、历史、环境、权限或所有权问题不宜继续时，可以重建，但先冻结旧写入并记录 `旧树 -> 新树`、独有改动保存位置和退出条件。能先退役就先退役；迁移必须短暂并存时，及时展示两树的关系、负责人和待完成的回收动作。

同一 `agent-id` 已有未回收树、需要并行或替代、或发现存量关系缺失时，必须先读
[Worktree 交付身份](references/delivery-identity.md)。数量只是复查信号，不是新建结论。

### 4. 满足命名 DoD 后建树

命名是门禁：task 必须是至少两个连字符分词的 lowercase semantic slug；禁止纯编号、UUID、hash、
日期或无业务语义缩写；可见 branch/path 保留完整 host 与 task。任一不满足都停止，不自行拼名称。

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" spawn ci-gate-hardening \
  --agent codex \
  --agent-id <real-thread-id> \
  --owner <human-owner> \
  --purpose "加固 CI 与本地提交门禁" \
  --codegraph auto
```

创建前必须读取 [Spawn、命名与堆叠分支](references/spawn-and-stack.md)，取得真实 `agent-id`，核对
Profile 回显。非默认 base、root 降级、`rebase/retarget` 和冲突恢复全部服从该 reference；feature owner
禁止手工 rebase。

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

`ready_for_review` 默认武装冻结 HEAD 的合入监听，`--no-watch` 明确退出；handoff 只接受 clean、已 push
边界，禁止 stash 搬运。更新评审态、交接或 watcher target 前必须读
[评审、交接与合入监听](references/review-lifecycle.md)。

目标前进后的显式 `refresh-review`、wrapper 门禁、远端 CI 默认与恢复语义见上述 reference。

### 7. 审计、提交和监听合入

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" audit <task-or-id>
node "$SKILL_DIR/scripts/worktree-mgr.mjs" audit <task-or-id> --json
```

portable core 不决定 MR/PR 或直推策略。先执行目标仓规则；`submit` 或 `touch --mr --watch-target` 的
原子登记与堆叠 target 处理见 [评审、交接与合入监听](references/review-lifecycle.md)。

### 8. 规划并合成批量集成验收

只统计同一仓库、同一目标分支的输入：`>=3` 个默认聚合；`=2` 个仅在碰撞、同文件或同生成物时
聚合。用户当轮指引优先。先刷新 target ref，再只读冻结计划：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" plan-batch \
  feature-a feature-b feature-c \
  --target origin/main \
  --json > batch-plan.json
```

`ready=true` 后只通过 manager 合成固定 SHA：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" batch-integrate \
  --plan batch-plan.json \
  --agent codex --agent-id <real-thread-id> \
  --json
```

`batch-integrate` 不执行门禁或再生成步骤；冲突 fail-closed，候选树不能作为 change request 载体。
Profile 的 `post_integrate_steps` 由 controller 执行后登记：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" batch-step <candidate-selector> \
  --step regenerate-golden --state done --note "<结果>"

node "$SKILL_DIR/scripts/worktree-mgr.mjs" batch-result <candidate-selector> \
  --state passed --candidate <exact-candidate-head> --evidence <evidence.json>
```

`batch-result` 只冻结 controller 已完成的结构化结论，不代跑验证；`passed/failed/stale` 不可覆盖。
target、输入、顺序或验收合同变化即重新规划。首次使用、结果冻结、冲突矩阵、重合成或故障恢复时，必须先读
[references/batch-integration.md](references/batch-integration.md)。

### 9. 保守回收

监听绑定冻结内容进入目标 ref 的事实，不依赖 change request 载体。`ready_for_review` 默认武装 watcher；
已推送成果用 commit SHA 回收；唯一短 SHA 会先展开、登记为完整 OID：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" reclaim <task-or-id> --pushed <sha-or-unique-prefix>
```

`--pushed` 还必须能由候选分支以外的 local/remote branch、tag 或 archive ref 证明可达；候选 HEAD 自证
不能防止删分支后对象丢失。已冻结终态的一次性批次候选走独立证据归档：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" reclaim <candidate-selector> \
  --archive-evidence <exact-candidate-head> --reason "<为何可结束本地候选>"
```

它创建 `refs/worktree-archive/evidence/<worktree-id>`，只保证当前本地仓库内可恢复，不等于远端备份。

被替代且未推送的旧树默认先把 HEAD 归档到持久 ref，再回收：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" reclaim old-ios-validation \
  --superseded-by current-ios-validation
```

只有人工明确裁定无需恢复时，才用精确旧 HEAD 授权无归档回收：

```bash
node "$SKILL_DIR/scripts/worktree-mgr.mjs" reclaim old-ios-validation \
  --superseded-by current-ios-validation \
  --discard <exact-old-head>
```

禁止 `rm -rf`、`git worktree remove --force` 和 `branch -D`。任何 dirty、stash、submodule、目录、权限、
branch-tip 或归档证据异常都返回 `KEEP`，由 `doctor` 报告。首次回收、`KEEP/BRANCH_PENDING`、替代树或
submodule 场景，必须先读 [references/reclaim-and-watch.md](references/reclaim-and-watch.md)。

## 并发安全底线

- 当前树并发时只改明确归属文件，提交必须带 pathspec：`git commit -m "type(scope): message" -- <owned-files...>`。
- 小步 commit、频繁 push；worktree 只隔离 working directory/index，仍共享 refs、objects 和 stash。
- feature owner 禁止自行 stash、清理、重置、合并或 rebase；历史刷新只走 manager 的 `rebase` / `refresh-review`。批次候选仅当前 owner 可执行 `batch-integrate`。跨会话先 handoff，非干净树拒绝改写。
- manager 只拥有它创建或接管的 worktree、branch 和 trace metadata，不拥有项目凭证、SDK license、个人 token 或共享运行态。
- 秘密放在仓库外的 credential store；不得复制、软链或写入 trace。
- event 是真源，record 是可重建缓存；`doctor` 永远只报告，不自动修复或删除。
- trace 是本机审计，不替代跨机器任务看板、代码评审或文件锁。

所有命令支持 `--config <path>`，默认只读取 Git primary worktree 的 Profile，linked worktree 副本不能
改变仓库约定。使用 `capabilities --json` 发现 provider 与协议；命令按上述操作场景读取对应 reference。

显式 `--config` 是人工核对后的恢复出口：它不会刷新 primary `default_base` 或执行 drift gate，只使用本地已有 ref。离线使用前，调用者必须自行确认 Profile 与 base ref 已同步。
