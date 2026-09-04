---
name: manage-worktrees
description: "管理 Git worktree 隔离与生命周期，包括碰撞扫描、创建或接管、堆叠分支、批量集成候选、交接和回收。仅在明确需要 worktree，或同仓多写入者存在覆盖风险时使用；只读并行和普通单写入者不适用。"
metadata:
  requires:
    bins: ["agentkit"]
---

# manage-worktrees：Git Worktree 隔离与生命周期

在改文件之前选择最小安全隔离，并让每棵 worktree 都能回答：谁创建、为何创建、正在做什么、谁接手、哪些提交属于谁、为何尚未回收。

## 组合位置

本 skill 是环境适配层，不决定是否派生 Agent，也不判断全局任务是否完成：

- 由 `orchestrate-subagents` 调用时，接收已确认的写入者和并发关系，或已裁决的归属不明 / 路径相交风险；只负责返回目标仓的隔离位置与生命周期记录。
- `run-agent-verify-loop` 中只有 implementer 写、verifier 只读时不需要 worktree；多个 implementer 并行写或 controller 同时写时才使用本 skill。
- 用户可以直接要求创建、接管、审计或回收 worktree，此时无需加载其他 skill。
- 与 `verify-agent-output` 组合时，由本 Skill 输出 Artifact Ref；verifier 只消费冻结身份，不接管 worktree 生命周期。

运行时是 `PATH` 上的 `agentkit` 命令（`agentkit worktree <command>`），要求 `git` 可执行。
下文多行示例采用 POSIX 续行语法；PowerShell/cmd 保留相同 argv 即可。不要把 `python3`、`bash`、
`~` 展开或 `/tmp` 视为跨平台常量。

不要假设目标仓库有同名脚本。仓库可以通过根目录 `.worktree-trace.json` 提供 Profile，但 portable core 不执行 Profile 中的任意 shell command。配置 schema 和项目适配边界见 [Profile 配置](../docs/worktree/profile.md)。

所有命令都必须从**目标 Git 仓库的任意 worktree 内**执行：manager 以当前工作目录解析 repository
identity、primary worktree 和 Profile。

### 跨 Skill 稳定产物

需要交给 verifier 或 orchestrator 时，不手抄 SHA 和 owner：

```bash
agentkit worktree capabilities --json
agentkit worktree binding <selector> --json
agentkit worktree artifact <selector> --json
agentkit worktree verify-artifact <artifact.json> --json
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

按下表顺序执行；只在进入对应阶段时读取链接文档：

| 阶段 | 最小命令面 | 硬门禁与按需文档 |
|---|---|---|
| 恢复/盘点 | `resume-all` → `list` → `doctor` | `list/doctor` 只读；`UNTRACKED` 不等于无人使用；`EPHEMERAL` 优先 commit+push；任何 error 都暂停 `spawn/adopt` |
| 碰撞扫描 | `scan --target <paths>` | `COLLIDE`、范围不确定或重做昂贵时隔离；`CLEAR` 仅在 owner 明确且改动小时共享；低置信后缀匹配先人工核对路径基准 |
| 交付身份 | 选择复用/并存/替代 | branch、MR 或目录名不同不能单独证明独立交付；同一 agent 有存量树或需要替代时读[交付身份](../docs/worktree/delivery-identity.md) |
| 创建/接管 | `spawn <semantic-slug>` / `adopt <path>` | 使用真实 agent-id，不猜身份；task 至少两个 lowercase 语义分词；base、root、堆叠、rebase/retarget 读[创建与堆叠](../docs/worktree/spawn-and-stack.md) |
| 更新/交接 | `touch` / `handoff` / `refresh-review` | `ready_for_review` 默认武装冻结 HEAD；handoff 只接受 clean、已 push 边界，禁止 stash 搬运；读[评审生命周期](../docs/worktree/review-lifecycle.md) |
| 审计/提交 | `audit` / `submit` | portable core 不决定 MR/PR 或直推策略；先服从目标仓规则，再原子登记 change request 与 watcher target |
| 批量集成 | `plan-batch` → `batch-integrate` → `batch-step` → `batch-result` | 同仓同 target：≥3 默认聚合，2 个仅在碰撞时；只合成冻结 SHA，不代跑门禁；合同/顺序/target 变化即重规划；读[批量集成](../docs/worktree/batch-integration.md) |
| 回收 | `reclaim` / `archive` | 必须有远端/其他 ref 可达证明或明确 archive evidence；dirty、stash、submodule、权限或 branch-tip 异常一律 `KEEP`；替代树默认先归档，`--discard` 需人工明确授权；读[回收与看护](../docs/worktree/reclaim-and-watch.md) |

不得按目录年龄、名称或“看起来干净”删除。禁止 `rm -rf`、`git worktree remove --force`、`branch -D`
和 feature owner 手工 rebase。watcher 的 `merge-tree` 结果只是目标前进后的只读成本预判，不保证逐
commit rebase 成功；`batch-result` 只冻结 controller 已完成的验收结论，不替代验证。

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
