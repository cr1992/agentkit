# Quickstart：一次独立验收，看一份真实 Evidence

四个 Skill 里，`verify-agent-output` 不依赖多 Agent 宿主就能完整演示：整条 `agentkit verify` 流程都能
用命令行驱动。本示例把「装好 CLI」到「亲眼看到一份 Evidence」之间的路径写成一个可照抄执行的脚本。

## 跑起来

需要 `git` 和 Node.js 22+，以及可用的 `agentkit` 命令（`npm install -g @cr1992/agentkit`）。

```bash
node examples/quickstart/run.mjs
```

脚本会：

1. 在系统临时目录里建一个最小 git 仓库，提交三个 commit：一个 base、一个**有缺陷**的实现
   （`sum` 做减法）、一个**已修复**的实现（`sum` 做加法）。
2. 对**缺陷版**和**修复版**两个固定 SHA 各走一次完整的独立验收（scaffold → 冻结 → prepare-run →
   L0 smoke →（若通过）L1 复核 → L0 final → validate）。
3. 打印两份 Evidence 的路径、`terminal_outcome` 与 `validate` 结果。
4. 演示「冻结 Artifact」不变量：workdir 的 HEAD 偏离冻结的 `artifact_sha` 时 `prepare-run` 拒绝。

结束时会清理掉临时目录，不在仓库或工作目录留下任何状态。

## 它演示了什么

- **验收跑完 ≠ 通过。** 缺陷版的 L0 smoke 失败，脚本正常退出（退出码 0），Evidence 的
  `terminal_outcome` 是 `fail`，且这份 Evidence 一样能过 `agentkit verify validate`。「验收是否跑完」
  和「结论是什么」是两件事。
- **冻结的 Artifact。** Artifact Ref 把 `artifact_sha` 绑定到某个具体 commit。scaffold 时它取自
  workdir 的 HEAD，所以演示缺陷版要先 `checkout` 到缺陷 commit。一旦 HEAD 偏离冻结的 SHA，
  `prepare-run` 会以 `{"error":"stale_precondition","message":"HEAD 已偏离冻结 artifact_sha"}`
  拒绝（退出码 3），而不是默默验错东西。
- **Evidence 与摘要绑定、可独立复核。** 两份 Evidence 都落在各自 run 目录的 `evidence.json`，同目录
  还有 `snapshot.json`、`events.ndjson`、`review-result.json`（若有 L1）与 `logs/`。

## 如实说明（脚本输出里也会打印）

- `--isolation-assurance` 只有 `host_reported` 和 `user_relayed` 两个取值。示例没有宿主，用
  `user_relayed`——这是**调用方自己声明的隔离等级，不是运行时证明的**。真实宿主应上报
  `host_reported`。
- L1 复核在真实使用中由**隔离上下文里的另一个 reviewer agent** 产出。示例用 `fixture.json` 里的
  预置 Review Result 代替，**agentkit 自己不审代码**。缺陷版的 L1 根本不会执行（L0 先失败），所以
  只需要一份预置 review，不必为了凑数伪造第二份 L1 结果。
- Evidence 里的 `limitations`（如 `l1_not_run`、`network_policy_not_os_enforced`、
  `generic_runtime_cannot_prove_all_tool_caches_disabled`）是**运行时主动声明的能力边界，不是 bug**。
  `l1_not_run` 出现在 L0 先失败、L1 未运行时。

## 文件

- [`run.mjs`](./run.mjs) —— 可运行脚本。只调用 `agentkit verify ...` 公开命令，不 import 仓库内部
  模块，因此它同时是 CLI 对外契约的一条回归用例。
- [`fixture.json`](./fixture.json) —— 只放**与机器无关**的预置片段：示例仓库的源码、契约的
  objective/scope/acceptance 文案、profile 的 `l0_checks`/`l1_review`、修复版的预置 Review Result。
  三个 digest、绝对路径（`environment.repository`、`runtime.executable_paths.node`）、repository
  identity 和 `artifact_ref` 的 SHA 都由脚本在运行时从 `scaffold` 生成，**不写进 fixture**——别的机器上
  冻结出来的 envelope 在你的机器上不会通过校验。

## 找到 CLI

脚本默认调用全局 `agentkit`。把环境变量 `AGENTKIT_BIN` 指向某个 JS 入口，脚本就会用当前 `node`
启动它——仓库测试用这个把示例锁定到本仓库的 `bin/agentkit.mjs`，而不是开发机上碰巧全局安装的版本：

```bash
AGENTKIT_BIN="$(pwd)/bin/agentkit.mjs" node examples/quickstart/run.mjs
```

## 外部依赖与离线

脚本只用到两个外部命令：`git`（建示例仓库、checkout 固定 commit）和 `node`（启动 CLI，并作为
L0 检查 `node test.mjs` 的运行时）。全程不访问网络：示例仓库是本地新建的，验收只在本地跑确定性检查，
不安装任何依赖，也不需要任何 Agent 宿主。实测两次完整验收加建仓在数秒内完成。
