# Repository Profile 与项目适配边界

portable runtime 在没有配置时即可运行。仓库若要固定 base、命名模板、任务来源或 change-request provider，可在 Git primary worktree 根放置 `.worktree-trace.json`。

## 推荐最小 Profile

```json
{
  "schema_version": 1,
  "default_base": "origin/main",
  "branch_template": "{host}/{task}",
  "path_template": "{host}-{task}",
  "task_naming": {
    "mode": "semantic",
    "example": "ci-gate-hardening"
  }
}
```

semantic naming 是推荐且默认的安全模式：

- task 必须是 lowercase hyphenated semantic slug。
- task 至少包含两个以字母开头的词。
- branch/path 模板必须包含完整 `{host}` 和 `{task}`。
- semantic 模式禁止 `{id8}` 和 `{task_short}`；内部 identity 只进 metadata。

如果仓库需要兼容既有命名，可以显式选择 legacy `slug` mode，但这会降低可读性；不要为新仓库使用它。

从 legacy `slug` 切换到 `semantic` 时，`doctor` 会把仍活跃但不满足新 DoD 的存量 record 报为 error。这是有意的迁移压力：先完成、handoff 或回收存量树；迁移窗口也可以暂留 `slug`，不要静默改名已有 worktree。

## 可配置内容

Profile 可声明：

- `default_base`：默认基线。primary Profile 启用该字段时必须使用可 fetch 的 `remote/branch` 形式，例如 `origin/main`；本地 `main` 或 `feature/foo` 不属于可刷新配置。
- `worktree_root`：仓库级集中 worktree 根；CLI `--root` 和 `WORKTREE_ROOT` 优先级更高。显式值不可写时 fail-closed；只有零配置默认 root 才允许 manager 使用安全降级根。
- `task_naming`、`branch_template`、`path_template`：可见命名约定。
- collision scan adapter：将仓库自己的任务认领信息并入 dirty/recent-commit 扫描。
- change-request provider：当前 bundled adapter 支持 GitLab push-options；未配置时走仓库自己的 PR/MR 流程。
- `post_integrate_steps`：声明"合成之后需要重新生成"的动作（见下）。
- 无秘密的 prerequisite/doctor 提示。

Profile 是数据，不是任意命令执行入口。不要放 shell command、token、cookie、私钥或个人凭证路径。

## 合成后再生成步骤

golden 基准、代码生成产物、依赖锁文件这类东西被多个分支各自重新生成时，合成必然冲突，且冲突
无法靠挑一边解决——只有在合成态重新生成一次才是对的。这类动作高度依赖具体仓库，portable core
不知道该跑什么，也**不允许**替仓库跑任何命令。

因此 Profile 只**声明**清单，`batch-integrate` 合成完成后只回显它，由 controller 逐条执行，再用
`batch-step` 登记结果：

```json
{
  "schema_version": 1,
  "post_integrate_steps": [
    { "name": "regenerate-golden", "hint": "在候选树重跑 golden 生成命令后提交" },
    { "name": "recompute-lock", "hint": "重算依赖锁文件并确认无版本漂移" }
  ]
}
```

- 每项只有 `name` 与 `hint` 两个键，**没有也不会有 `command` / `run` / `script`**；未知键一律
  fail-closed，防止有人把 shell 塞进声明位，绕过"portable core 不执行 Profile 内容"这条边界。
- `name` 是 kebab-case slug、同一 Profile 内唯一，它是 `batch-step` 登记结果的键。
- `hint` 是给人看的单行说明（≤240 字符），不是可执行内容。
- 最多 20 项。清单过长通常说明这些动作应当收进仓库自己的一条 wrapper 命令。

显式 `--config <path>` 不执行 primary Profile 的 baseline fetch/drift gate，只读取本地 ref；它适合已经人工核对的离线恢复，不等于自动证明配置新鲜。

## 通用层与项目层

放在本 skill：

- worktree 创建、接管、状态机、event/record trace、审计和保守回收。
- 通用 dirty/recent-commit collision scan。
- semantic naming DoD 与 fail-closed 校验。
- provider 协议和 GitLab push-options adapter。

留在目标仓库：

- `.worktree-trace.json` 与任务系统 adapter 的启用配置。
- 项目测试、lint、commit gate、构建、签名、视觉验收和部署流程。
- 特定 app/module 的初始化、凭证 doctor 和 finish wrapper。
- owner、默认目标分支、MR/PR 审批和 source branch 删除策略。

项目 wrapper 可以先调用自己的门禁，再调用 portable manager 的 `submit`、`watch` 或 `reclaim`；不要把项目目录名或业务判断回写进 portable scripts。

## Kiro tasks adapter

bundled scan 保留一个可选 `kiro_tasks` adapter，用来读取 Profile `glob` 命中的任务文件中实施中的任务及“影响文件或目录”。`glob` 必须是仓库内安全相对路径，支持路径段内 `*` / `?` 和跨目录 `**`，禁止绝对路径、空路径段和 `..`。典型值为 `.kiro/specs/*/tasks.md`。只有 Profile 显式启用时才生效；不使用 Kiro 的仓库不会访问该目录。

新增任务系统时应实现独立 adapter，并保持：

1. 只读目标仓库。
2. 输出规范化的 owner/task/path claims。
3. 解析失败时报可诊断错误，不假装 `CLEAR`。
4. 不把平台或业务名写进 portable collision 算法。

## 同步和分发

本目录中的 `scripts/` 是安装后执行的 portable runtime。项目如果 vendoring 一份副本用于 CI 或 clone 后即用，应记录 upstream 版本并做确定性 diff/check；项目专用 wrapper 不参与同步。
