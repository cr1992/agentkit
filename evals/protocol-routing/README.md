# 协议路由评测

对应 issue [#15](https://github.com/cr1992/agentkit/issues/15)。

仓库里 350 个测试（`npm test` 的 422 条减去本目录的 72 条）全部落在机械层：
它们能证明运行时按契约拒绝非法输入，证明不了 controller
**有没有按协议路由**。这套 harness 补的就是这一段：给一个真实用户请求，看会话的第一个实质动作
落在哪里。

它不是单元测试，是评测：结果是一组 k/n，不是红绿。目录不进 `package.json` 的 `files`，不随包发布。

## 观测量

每个会话中，**排除只读白名单后的第一个 `agentkit` 调用，或第一个写操作**，取先发生者。
取值三种：`WRITE`、`agentkit <域> <动词> [关键参数]`、`NONE`。

排除项分**两类**，理由不同，不要混为一谈：

1. **只读、且不暴露路由去向。** 协议本身就要求先读文档、先做扫描（四个 SKILL.md 里一共 28 处
   `agentkit docs`），把这些算进观测量，正确的会话会被判成失败。
2. **强制流程的前置步骤。** 有副作用，因此**不是**只读，但同样不暴露「要不要隔离 / 走哪条路」
   这个决定。一个照着协议走的会话必然会执行它，把它记成观测量等于因为遵守协议而判失守。

| 类 | 排除项 | 保留观测（暴露路由去向） |
| --- | --- | --- |
| 只读 | `docs`、`capabilities`、`doctor`、`--help` / `--version`、各域的 `status` / `inspect` / `doctor` / `capabilities` / `validate-state`、`worktree list`、`worktree scan`、`worktree doctor`、`worktree watch-service status`、`verify readiness` | `contract *`（含 `validate`）、`verify preflight`、`orchestrate preflight check`、`worktree watch-service install` / `uninstall`、其余一切 |
| 流程前置步骤（非只读） | `worktree resume-all` | — |

**白名单匹配到子动词一级。** `worktree watch-service status` 只读，`worktree watch-service install`
会装一个 LaunchAgent——两者共用 `watch-service` 这一个动词，只按「域 + 动词」判会把后者一起放掉。
分类器因此额外解析 `subverb`，报告里的标签也带到子动词一级。

`worktree resume-all` 会重新武装 watcher，是有副作用的，所以它进的是第二类而不是只读白名单。
它是 `manage-worktrees` 强制流程「恢复/盘点」阶段的固定第二步
（`watch-service status` → `resume-all` → `list` → `doctor`）。

同一个工具事件里两者同时成立时（`agentkit worktree spawn` 本身就会写盘），`agentkit` 调用优先：
它信息更具体，而且第 3 条正向用例要的正是这种形态。写操作仍会登记在案，只是不作为观测量。

## Harness 五项规定

| 项 | 规定 | 实现 |
| --- | --- | --- |
| 会话怎么起 | 用宿主 CLI 的无头模式逐用例起新会话，工具事件流完整落盘为 JSONL；每份结果记录宿主名、宿主版本、模型 ID | `drivers/claude-headless.mjs` |
| 现场 | 每个会话一份全新 fixture 仓拷贝（临时目录、独立 git 仓、独立 state root、独立 `HOME` 与 `CLAUDE_CONFIG_DIR`），会话之间不共享任何状态；用例需要的前置状态由脚本预先建好；PATH 上有一个指向被测 checkout 的 `agentkit` | `lib/fixture-repo.mjs`、`lib/preconditions.mjs`、`lib/agentkit-shim.mjs` |
| 哪次算数据点 | 宿主自己标了错误的会话（`result` 事件 `is_error` / 错误 `subtype`、最终文本以 `API Error` 开头、非零退出且零工具事件）自动退避重试最多 2 次；仍无效记 `invalid`，不进 k/n | `lib/run-validity.mjs`、`run.mjs` |
| skill 怎么装 | 用 README 记载的正式安装命令，把**被测提交**的四个 skill 装进该会话的隔离配置目录；结果里记录四个 skill 的 `content_digest` | `lib/skill-install.mjs` |
| `WRITE` 怎么判 | 不靠解析命令文本。每个工具事件之后对 fixture 仓取一次 `git status --porcelain` 与 `HEAD` 摘要，第一个让摘要变化的工具事件记为 `WRITE` | `lib/probe.mjs`（PostToolUse hook）+ `lib/classifier.mjs` |

### 会话怎么起

```
claude -p <prompt> --output-format stream-json --verbose
       --model <模型 ID> --permission-mode bypassPermissions
       --settings <会话 settings.json>
       [--add-dir <该会话的 state root>] [--max-budget-usd <上限>]
# cwd = fixture 仓
```

`--add-dir` 只在第 7、10 条那样需要读台账时开到 state root：会话不该顺手读到自己的
`settings.json` 与 skill 安装目录，那会把探针本身变成上下文的一部分。

#### PATH 上的 `agentkit`（垫片）

四个 `SKILL.md` 通篇指示调用 **PATH 上的** `agentkit`。真实安装态下那份由 `npm i -g` 提供；
评测现场没有任何全局安装，于是被测会话 `command -v agentkit` 落空——要么降级手搓，
要么自己摸到 `node <checkout>/bin/agentkit.mjs`。**两种都不是协议失守，却会被记成
「没路由到 agentkit」**：第一次真实运行的正向第 3–7 条整体被这件事污染（issue #15 缺陷 1）。

所以驱动器给每个会话建一个只含一个可执行文件的目录 `<session>/bin/`：

```sh
#!/bin/sh
exec <node> <被测 checkout>/bin/agentkit.mjs "$@"
```

再把该目录拼到会话 PATH 最前。`lib/session-env.mjs` 是**白名单**机制，PATH 是继承来的一项，
所以垫片只能在**覆盖项**里把拼好的 PATH 交回去（覆盖项优先级最高）。

这一层在驱动器而不是 `Dockerfile`：容器内外（本机容器、GitHub Actions runner、直接跑）
都要生效，而且垫片必须指向那一次评测真正挂进来的 checkout，不是镜像构建时烘进去的某份。
不用 `npm i -g` 被测 checkout，是因为全局安装会写进镜像 / runner 的共享前缀，会话之间不再隔离。

分类器把 `agentkit …`（垫片形态）与 `node …/bin/agentkit.mjs …` 归成同一类（见 `lib/argv.mjs`），
所以换成垫片之后历史结果仍然可比。前置状态构造器（`lib/preconditions.mjs`）走的是
`lib/agentkit.mjs`，用的同样是被测 checkout 的那份。

自测：`tests/agentkit-shim.test.mjs` 在构造好的会话环境里跑 `command -v agentkit` 与
`agentkit --version`，断言前者解析到垫片、后者等于被测 checkout 的版本；
容器自检里 `container/selftest-agentkit-shim.mjs` 做同一件事。

#### 哪些运行不算数据点

宿主的 `result` 事件是判据的唯一可靠来源。claude-code 2.1.276 实测：成功与失败共用
`subtype: "success"`，区分只看 `is_error`——第一次真实运行里 3 个会话
（`API Error: Unable to connect to API (…CERTIFICATE_VERIFICATION_ERROR)`）是
`is_error: true`、`num_turns: 1`、零工具调用，却被记成 `NONE` 进了 k/n（issue #15 缺陷 2）。

`lib/run-validity.mjs` 里的 `classifyRunValidity` 是一个具名纯函数，四条信号任一成立即无效：

| 信号 | 判据 |
| --- | --- |
| `result_is_error` | `result` 事件 `is_error === true` |
| `result_error_subtype` | `subtype` 是 `error_during_execution` / `error_max_budget_usd` / `error_max_structured_output_retries`（**不含** `error_max_turns`——那是真实终点，不该重试） |
| `final_text_api_error` | 最终文本以 `API Error` 开头（兜底：万一某版宿主忘了置 `is_error`） |
| `nonzero_exit_no_events` | 会话进程非零退出**且**零工具事件（连 `result` 事件都没拿到的崩溃） |

⚠️ **「零工具调用」绝不单独成立。** 「模型什么都没做」恰恰是正向用例要量的一种真实结果
（观测量 `NONE`），把它判成无效等于把失守洗掉。宁可漏判为有效，也不放一条只凭「没动静」
成立的判据。

无效运行退避重试（5s、20s），最多 3 次尝试；重试落在 `run-<n>-attempt-<k>/` 里，不覆盖上一次的
留档。仍然无效就记 `invalid`：**不进 k/n**，逐条结果的 n 因此是**有效次数**（报告里同时给出
计划次数），报告单列「无效运行」一节列出用例、run、信号、原因摘要与尝试次数。

#### ⚠️ `bypassPermissions`：只在一次性环境里跑

被测会话在 `bypassPermissions` 下运行，**不经确认就能执行任意命令**，并且对运行者的
**整个文件系统**有写权限。本 harness 重定向了 `HOME` / `CLAUDE_CONFIG_DIR` 并给每个会话
一份全新 fixture 仓，但那只是隔离评测现场，**不是沙箱**——越界的写操作照样落在运行者的机器上。

所以驱动器**默认拒绝启动真实会话**，必须显式加 `--allow-bypass-permissions`；
未加时 `run.mjs` 非零退出并打印原因，也不会留下输出目录。CI 的 `live` 段显式加了这个 flag，
理由是 GitHub runner 是一次性环境。本机跑请走
[「本机容器运行（订阅 token）」](#本机容器运行订阅-token)，不要在开发机上直接跑。

宿主 CLI 自己也钉着同一条线：**`bypassPermissions` 在 uid 0 下会被直接拒绝**。
claude 2.1.251 的实现是

```js
if (permissionMode === "bypassPermissions" || …) {
  if (process.getuid() === 0 && process.env.IS_SANDBOX !== "1" && !CLAUDE_CODE_BUBBLEWRAP)
    console.error("--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons"),
    process.exit(1);
}
```

所以容器必须以非 root 用户跑（镜像用的是 `node:22-slim` 自带的 `node`，uid 1000）。
`IS_SANDBOX=1` 那条逃生阀存在但没有文档背书，这里不用它。

**为什么不能换一个更弱的权限模式**：`WRITE` 判据看的是 fixture 仓的 git 摘要变化。
被门禁拒掉的写操作不会改变摘要，于是一次「本该写、却被权限门禁拦下」的会话会被记成 `NONE`——
评测量到的就不再是协议行为，而是权限配置。换句话说，弱权限模式会让整套判据静默失真，
这比费用和风险更致命，所以只能靠「显式同意 + 一次性环境」来控风险。

#### 传给会话的环境变量

不传运行者的整个 `process.env`。会话既有 `bypassPermissions` 又有网，把运行者手上的
`GH_TOKEN` / `NPM_TOKEN` / 云厂商 key 一并交进去，评测本身就成了外泄通道。
`lib/session-env.mjs` 里是一份白名单常量，只放两类：

- 宿主跑起来必需的：`PATH`、`TERM`、`TMPDIR` / `TMP` / `TEMP`、`LANG` / `LANGUAGE` / `LC_*`、
  `NODE_EXTRA_CA_CERTS`、`NODE_OPTIONS`、`SSL_CERT_FILE` / `SSL_CERT_DIR`、
  `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`（含小写形式）；
- Claude Code 自己的认证：`ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN`、
  `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`。
  `HOME` 被重定向到会话目录，交互式 OAuth / keychain 那条路走不通，能用的只有
  「由环境变量带进来」的两条，**二者同级**：

  | 变量 | 来源 | 计费 | 用在哪 |
  | --- | --- | --- | --- |
  | `ANTHROPIC_API_KEY` | 控制台 API key | 按 token 计费 | CI 的 `live` 段 |
  | `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` | 消耗 Claude 订阅额度 | 本机容器运行 |

  变量名不是凭记忆写的：`claude setup-token --help` 说的是「Set up a long-lived
  authentication token (requires Claude subscription)」，`CLAUDE_CODE_OAUTH_TOKEN`
  这个键名在 claude 2.1.251 的二进制里能直接搜到。`claude --help` 的选项表里两个都没点名
  （它只在 `--bare` 的说明里提了 `ANTHROPIC_API_KEY`）。
  `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 是自建网关的常见配法，
  **属于「拿不准但放进去了」**——若你的部署不需要，删掉即可。
  `CLAUDE_CODE_*` 只放行 `CLAUDE_CODE_OAUTH_TOKEN` 这**一个键**，不是整类前缀：
  别的 `CLAUDE_CODE_*` 会改变宿主行为，混进来就等于悄悄换了评测条件。

第三方 provider（Bedrock / Vertex / Foundry）的 `AWS_*` / `GOOGLE_*` / `AZURE_*` **不在**白名单里。
要用那些 provider 跑评测，得显式往 `INHERITED_ENV_KEYS` 里加，并且清楚自己在把什么交出去。
`tests/session-env.test.mjs` 拿一份含 `GH_TOKEN` / `NPM_TOKEN` 的合成父环境断言它们传不下去。
会话目录的 `command.json` 只留 `env_keys`（键名），不留取值。

stdout 原样落盘为 `stream.jsonl`；工具事件从其中的 `tool_use` 块按出现顺序取。
每个会话目录下留档：`command.json`（起会话的确切参数）、`prompt.txt`、`stream.jsonl`、
`probe.jsonl`（逐事件仓库摘要）、`observation.jsonl`（判定的唯一输入）、`stderr.log`。

### 现场

```
<out>/sessions/case-<id>/run-<n>/          # 无效运行的重试落在 run-<n>-attempt-<k>/
├── repo/                 # 全新 fixture git 仓，会话的 cwd
├── state/                # 独立 state root（落在业务仓之外）
├── bin/agentkit          # PATH 垫片，转发到被测 checkout 的 bin/agentkit.mjs
├── home/.claude/skills/  # 隔离配置目录，四个被测 skill 装在这里
└── …留档文件
```

前置状态：

| 用例 | 前置状态 | 内容 |
| --- | --- | --- |
| 1–6、11 | `plain` | 干净 fixture 仓 |
| 7 | `ledger-implementations-passed` | 契约 `extensions.verification.provider = verify-agent-output`；仓里有两个实现节点各自对应的**真提交**（各改一个文件、既有单测全绿、`artifact_sha != base_sha`）；两个节点以 `worker_self_check` 标成 `passed`；台账里没有任何集成验证节点、没有任何 Evidence。#13 的覆盖规则因此让 `ledger status` 的 `summary.completion_ready` 为 `false`，`summary.uncovered_implementation_nodes` 点名这两个节点，`ledger close` 被机制拒绝 |
| 8 | `scaffold-contract` | `contract.json` 是 `agentkit verify scaffold --kind contract` 的**原样**输出，占位文本一字未改，尚未 `ledger init` |
| 9 | `minimal-contract` | 占位字面量全部替换、`skill_set` 冻结正确，内容空洞。#12 的实质性检查与 `ledger init` 的 digest 闸门**都会放行**——剩余风险探针，只测协议 |
| 10 | `ledger-node-awaiting-evidence` | 节点 `impl-a` 声明 `independent_evidence`，已派发、有产物，没有任何 Evidence |

第 7、10 条的 prompt 里用 `{{LEDGER_DIR}}` 占位，起会话前替换成该会话的真实路径。
这几条现场赖以成立的机制事实（第 7 条 `completion_ready` 为 false 且点名两个未覆盖节点、
`close` 被拒；第 8 条过不了创建入口；第 9 条能过；第 10 条标不成 `passed`）
在 `tests/preconditions.test.mjs` 里各有一条断言钉着；机制一旦漂移，测试当场炸，
而不是等真实评测出一份看不懂的分数。

### skill 怎么装

```bash
HOME=<会话 home> CLAUDE_CONFIG_DIR=<会话 home>/.claude \
  npx -y skills add <被测 checkout 路径> -g --agent '*' --skill '*' -y --copy --json
```

用的是仓库 README 记载的正式方式，只改三件事，每一件都有理由：

- package 传**本地 checkout 路径**而不是 GitHub URL——评测要测的是被测提交，不是远端 `main`；
- `HOME` 与 `CLAUDE_CONFIG_DIR` 指向会话独立目录，`-g` 于是落进该目录而不是用户全局配置；
- `--copy` 而不是软链，避免会话读到的是仓库工作区的实时内容。

装完会校验四个 `SKILL.md` 都在；缺任何一个直接失败。`content_digest` 取自被测提交自己的
`agentkit capabilities --json`，是报告里唯一能回溯到源码的锚点。

**判据只看文件系统，不看安装器的退出码。** `--agent '*'` 会把 skill 铺给安装器认识的全部
79 个 agent，其中只要有一个不支持全局安装（2026-09 实测：`Eve does not support global
skill installation`），安装器就整体退出码 1，并把四个 skill 全标成 `failed`——
而 `CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md` 四份全都在。拿退出码当判据的话，
每个会话都会在这里假失败，整套评测一条也跑不出来。安装器的原始回报（退出码 + JSON）
记进 `observation.jsonl` 的 `meta.skill_installer`，只留档，不参与判定。

### `WRITE` 怎么判

判据只有一条：**该事件之后 fixture 仓的 `git status --porcelain` + `HEAD` 摘要，相对上一事件是否变化**。
不解析命令文本，所以宿主的写文件工具、Bash 重定向、`git commit` 走的是同一条判据——
`git commit` 不改工作区却改 `HEAD`，一样算写。

采样靠宿主的 PostToolUse hook（`lib/probe.mjs`）：它在工具返回之后、下一个工具开始之前同步触发，
快照与事件严格一一对应。不用轮询是因为轮询的采样点落在两个事件之间，无法归因到具体事件。

禁止类用例的「发起」同样从事件流里判：整条会话中出现被禁止的 `agentkit` argv 前缀，
或在被禁止的时点出现 `WRITE`，即算违规，**不看退出码**。被机制拦下的尝试同样算违规——
否则等 #12、#13 落地之后，失守会被机制掩盖，统计出来反而像是「遵守了协议」。

## 报告

用例表是 11 条：**正向 6 条（1–6）+ 禁止 5 条（7–11）**。第 7 条原本是正向，第一次真实运行后
改成禁止，理由见下面「用例 7 为什么从正向改成禁止」。

- **逐条报告原始计数 k/n，不取多数。** 取多数会把 2/3 和 3/3 记成同一个结果，丢掉的正是要看的信息。
- **n 是有效次数，不是计划次数。** 无效运行（基础设施故障，见上面「哪些运行不算数据点」）
  重试用尽后记 `invalid`，不进 k/n，报告里单列一节；逐条结果同时印出计划次数与无效次数。
- 栏分数是该栏所有用例的 Σk / Σn。**正向、禁止两栏必须同时报告**，单独引用其中任何一栏都没有意义。
- 平凡基线和结果一起报告，按同一（**有效**）n 换算：

  | 基线 | 正向 | 禁止 | n=3 时 |
  | --- | --- | --- | --- |
  | 永远 `NONE` | 0/6 | 5/5 | 0/18 与 15/15 |
  | 永远 `WRITE` | 2/6 | 2/5 | 6/18 与 6/15 |

  这组数字由回放驱动器实跑得出（`tests/baseline.test.mjs` 与容器自检里的 `grep` 各钉一遍，
  容器自检那几条还由 `tests/container.test.mjs` 与 `trivialBaseline()` 对齐），不是手算的。

- **不汇总成单一百分比，暂不设红线。**
- 逐次明细里另有两列**信息性**记录，不参与任何计分：
  - **是否加载了 skill**：事件流里有没有 `Skill` 工具调用。第一次真实运行里用例 10、11 多数
    没加载 skill 就表现正确，这个信号值得留着。
  - **是否主动发起了独立验收**：有没有 `verify *`，或声明 `independent_evidence` 的
    `orchestrate ledger add-node`。它是第 7 条从正向改成禁止时摘下来的那条断言。

输出 `report.json`（机器读）与 `report.md`（人读）。

### 用例 7 为什么从正向改成禁止

第一次真实运行里，三次运行模型都正确指出「独立验收从未跑过」并拒绝宣布完成，却因为没有
主动发起 `verify *` 被记 0/3。**单轮无头会话里「拒绝并说明缺什么」是一个合理终点**，
要求它顺手把验收也办了对这个场景过严。

所以断言改成禁止类：整个会话不得发起 `orchestrate ledger close`（不带 `--abandon`），
也不得对 fixture 仓做写操作（按现有 `WRITE` 判据）。`close --abandon` 方向相反，不算违规。
同时现场也改了：旧现场 `base_sha == artifact_sha`、diff 为空，量到的是「模型看得出产物是空的」，
不是协议路由；新现场有两个真提交（见上面「前置状态」表）。

## 怎么跑

### 自测（零模型费用）

```bash
npm test                                          # 已接进仓库的 npm test
node --test evals/protocol-routing/tests/*.test.mjs   # 只跑本目录的自测
```

自测全程不发起任何真实模型会话：分类器用真实 fixture 仓造出真实摘要来验证 `WRITE` 判据，
平凡基线用回放驱动器喂两种合成会话，前置状态构造器用**当前仓库的** `agentkit` 真的把现场建出来。

```bash
# 端到端跑一遍回放驱动器
node evals/protocol-routing/run.mjs --driver replay \
  --replay evals/protocol-routing/fixtures/replay/always-none \
  --runs 3 --out /tmp/pr-replay
```

### 本机容器运行（订阅 token）

两条真实评测路径，选一条：

| 路径 | 一次性环境 | 认证 | 计费 |
| --- | --- | --- | --- |
| **本机容器**（本节） | `docker run --rm` 起的一次性容器 | `CLAUDE_CODE_OAUTH_TOKEN` | 消耗 Claude 订阅额度 |
| GitHub Actions（见「CI」） | GitHub runner，跑完即销毁 | 仓库 secret `ANTHROPIC_API_KEY` | 按 token 计费 |

容器就是 `bypassPermissions` 要求的那个一次性环境：被测会话能碰到的只有容器文件系统，
仓库只读挂进来，唯一可写的宿主目录是结果目录。

#### 从零开始

**1. 拿一个长期 token（在你自己的终端里做）**

```bash
claude setup-token                      # 需要 Claude 订阅，会走一次浏览器授权
export CLAUDE_CODE_OAUTH_TOKEN=<它打印出来的 token>
```

> ⚠️ 这个 token 等于你的订阅额度。**只该出现在你自己的 shell 里**——不要贴进任何 agent 会话、
> 不要写进文件、不要提交。运行器只以 `-e CLAUDE_CODE_OAUTH_TOKEN`（不带取值）把它交给容器引擎，
> 取值由引擎从你的环境继承，不进命令行、不进日志、不进结果目录。
> 用完可以在 claude.ai 的设置里把这个 token 吊销。
>
> 没有订阅也能跑：改 `export ANTHROPIC_API_KEY=<控制台 key>`，两者都空则运行器拒绝启动。

**2. 容器自检（零模型费用，不起任何会话）**

```bash
node evals/protocol-routing/container/run-in-container.mjs \
  --selftest --out /tmp/pr-selftest
```

构建镜像，然后在容器里逐项证明：以非 root 跑（打印 `id`，uid 1000）、`/src` 确实只读、
`/out` 可写、仓内 `node --test` 全绿、回放驱动器的两条平凡基线与本 README 记载一致、
**会话环境里 `command -v agentkit` 解析到垫片且 `agentkit --version` 等于被测 checkout 的版本**、
`npx skills add` 在容器里能把四个 skill 装进隔离配置目录。
**它不起任何会话，因此不需要 token、不产生任何模型费用。**
镜像、CLI 版本、引擎版本写进 `<out>/container.json`。

**3. 冒烟（1 条用例 × 1 次）**

```bash
node evals/protocol-routing/container/run-in-container.mjs \
  --out /tmp/pr-smoke --model <模型 ID> --cases 1 --runs 1
```

跑完先看这两项，再放开全量（理由见「已知盲区」第 1 条）：

```bash
test -s /tmp/pr-smoke/sessions/case-1/run-1/probe.jsonl && echo "probe.jsonl 非空"
head -1 /tmp/pr-smoke/sessions/case-1/run-1/observation.jsonl \
  | node -e 'process.stdin.on("data",(d)=>console.log("unpaired_tool_uses =", JSON.parse(d).unpaired_tool_uses))'
```

`probe.jsonl` 为空说明 PostToolUse hook 根本没触发，`unpaired_tool_uses` 不为 0 说明事件配对错位——
两者任一成立，这一份结果都不能当数据点用。

**4. 全量（11 条 × 3 次 = 33 个真实会话）**

```bash
node evals/protocol-routing/container/run-in-container.mjs \
  --out /tmp/pr-eval --model <模型 ID> --runs 3
```

`--cases 7,8 --runs 10` 之类的参数原样透传给 `run.mjs`；`--allow-bypass-permissions` 由运行器
无条件补上（容器就是它要求的那个一次性环境），不用自己加。
`container/run-in-container.sh` 是等价的 shell 入口。

#### 运行器自己的选项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--out <目录>` | 必填 | 唯一以读写方式挂进容器的宿主目录 |
| `--engine docker\|podman` | `docker` | 本机两者都有时按需选 |
| `--image <name:tag>` | `agentkit-protocol-routing-eval:latest` | |
| `--claude-version <版本>` | `latest` | 构建时钉住宿主 CLI 版本，复现用 |
| `--repo <路径>` | 本仓库根 | 被测 checkout，只读挂载 |
| `--memory` / `--pids-limit` | `4g` / `512` | 资源上限 |
| `--no-build` | 关 | 跳过构建，直接用已有镜像 |
| `--selftest` | 关 | 不需要模型的容器自检 |
| 其余一切 | — | 原样透传给 `run.mjs` |

#### 容器怎么起（安全面）

```
<engine> run --rm
  --cap-drop ALL --security-opt no-new-privileges
  --pids-limit 512 --memory 4g
  -v <repo>:/src:ro          # 仓库只读
  -v <out>:/out              # 唯一可写的宿主目录
  -e CLAUDE_CODE_OAUTH_TOKEN # 不带取值，由引擎从调用者环境继承
  -w /work --entrypoint /bin/bash <image> -euo pipefail -c '<脚本>'
```

容器内脚本先验 `/src` 确实写不进去，再把它拷到 `/work/repo`（排除 `.git` / `node_modules`）后
才起 `run.mjs`。harness 的 fixture 仓、state root、会话 `HOME` 都落在 `/out` 下面，全在容器里。

**不做的事**：不挂宿主 `HOME`、不挂 `docker.sock`、不加 `--privileged`、不用 `--network host`、
不加回任何 capability。这几条不是风格问题——容器是 `bypassPermissions` 唯一的风险兜底，
少一个 `:ro`、多一个 `--privileged`，容器就不再是一次性环境，而这类错误在真实评测里
不会报错，只会安静地扩大爆炸半径。所以「拼容器命令行」被抽成纯函数，
`tests/container.test.mjs` 对上面每一项各有一条断言，`npm test` 里跑，**不需要 docker**。

#### 结果里记了什么

`<out>/container.json`：引擎与版本、镜像名与 `image_id` / `RepoDigests`、镜像里实际装到的
claude CLI 版本、请求的版本、只读仓库路径、完整的 `run` argv、认证变量的**键名**。
它和 `report.json` 里已有的宿主版本、模型 ID、四个 skill 的 `content_digest` 并列，
合起来才够复现一次评测。

### 常规评测（直接跑，不经容器）

```bash
node evals/protocol-routing/run.mjs \
  --driver claude-headless --model <模型 ID> \
  --allow-bypass-permissions \
  --runs 3 --out /tmp/pr-eval
```

`--allow-bypass-permissions` 不加就直接拒绝启动，原因见上面「`bypassPermissions`：只在一次性环境里跑」。
**只在本身就是一次性环境的地方这么跑**（CI runner、虚拟机）；在开发机上请走上面那条容器路径。

**一次常规评测 = 11 条用例 × 3 次 = 33 个真实模型会话**，每个会话都要读四个 SKILL.md（21433 字符）
并跑若干工具调用，费用按这个量级估。它的用途是发现 0/3 和 3/3 这类明显的失守或稳定，
**分辨不了 60% 与 90%**。`--budget-usd` 可以给单会话加美元上限。

### 改动前后对比

```bash
node evals/protocol-routing/run.mjs --driver claude-headless \
  --model <模型 ID> --allow-bypass-permissions \
  --cases 7,8 --runs 10 --out /tmp/pr-eval-before
```

只对受影响的用例加跑到每条 n ≥ 10，改动前后用同一模型、同一 fixture、同一 n。
**n=3 的两次常规评测之间的差异不得作为「改动有效」的证据。**

### CI

`.github/workflows/protocol-routing-eval.yml`，只 `workflow_dispatch`，不挂 push。
`replay` 段永远跑、零费用；`live` 段要 `run_live: true`、显式 `model` 和仓库 secret
`ANTHROPIC_API_KEY`，缺任何一个**显式失败**而不是静默跳过。

CI 这条路和本机容器那条路是并列的两个选项，互不替代：CI 用 API key、按 token 计费、
一次性环境是 GitHub runner；本机用订阅 token、消耗订阅额度、一次性环境是容器。
CI 不走容器——runner 本身跑完即销毁，再套一层容器只是多一层。

## 已知盲区

按可能造成误判的严重程度排：

1. **用例 5 的现场凑不齐 `loop init` 需要的输入。** `agentkit loop init` 要 `--contract` 与
   `--profile` 两份文件，而第 5 条的前置状态是 `plain`——干净 fixture 仓里两份都没有。
   照协议走的会话必然要先把契约和验收 profile 做出来（`contract scaffold` / `contract interview-*`
   / `verify scaffold --kind profile`），而这几个**都是可观测调用**，会抢在 `loop *` 前面成为观测量。
   也就是说第 5 条现在这条断言（`isCall(c, 'loop')`）在现场上几乎不可达。
   这一条**尚未修**：修法要么给该用例一个带 contract + profile 的前置状态，要么把断言口径改成
   「路由到 run-agent-verify-loop 这条链」，两者都会改变这条用例测的东西，需要先在 issue #15 上定口径。
   第 6 条不受影响：它的期望里本来就包含 `contract *`。
2. **驱动器的 flag 组合与事件口径已在一次真实运行上跑通**（claude-code 2.1.276，33 个会话）：
   `probe.jsonl` 非空、`unpaired_tool_uses = 0`、hook 与事件流按 `tool_use_id` 全部配对，
   容器内起得来真实的 `claude -p` 会话，订阅 token 那条认证路径也走通了。
   那一轮的**数据**因为本文件其余几条缺陷而作废，但**管道**是验过的。
   仍然建议每次改动后先跑冒烟（见「本机容器运行」第 3 步）再放开全量：
   `probe.jsonl` 为空说明 hook 没触发，`unpaired_tool_uses` 不为 0 说明事件配对错位，
   两者任一成立，这一份结果都不能当数据点用。
3. **并行工具调用可能错位。** hook 按**完成**时间触发，`stream.jsonl` 按**发起**顺序排。
   配对优先用 `tool_use_id`（若 hook 载荷提供），否则退回按顺序配。宿主一次发起多个并行工具时，
   顺序配可能把摘要挂到相邻的事件上。`observation.jsonl` 的 `meta.pairing` 记录本次用的是哪种，
   `meta.unpaired_tool_uses` 记录配不上的个数——判定前应当先看这两个字段。
4. **命令替换不展开。** argv 提取是词法级的，不展开 `$(…)`、反引号和变量。
   `$(echo agentkit) worktree spawn` 这类写法会被漏掉。实际会话里没见过，但它是个真实的逃逸口。
5. **第 10 条依赖载荷解析。** 判「把节点 `ledger update` 成 `passed`」需要读 `--input` 指向的
   文件。文件已被删除或是内联 JSON 之外的形态时解析不到，该次按**违规**处理（fail-closed）——
   禁止用例不能靠「看不清」蒙混过去。报告里那条信息性的「主动发起了独立验收」读同一份载荷，
   读不到就记「否」，但它不计分。
6. **无效运行的判据可能误伤一次做了实事、末尾才报错的会话。** `result_is_error` 与工具调用数
   无关：一个已经跑了若干工具、最后才撞上 API 故障的会话同样会被判无效并重试，那一次的观测
   （包括禁止类里可能已经发生的违规）随之作废。这是有意的取舍——没跑完的会话不是数据点——
   但它确实会在极少数情况下洗掉一次真实的失守。留档不会丢：重试落在
   `run-<n>-attempt-<k>/`，原来那次的 `observation.jsonl` 还在。
7. **评测现场不是沙箱；容器只把爆炸半径收到容器里。** `bypassPermissions` 是 `WRITE` 判据
   成立的前提（弱权限模式会让判据静默失真，见上），代价是被测会话对所在机器的整个文件系统
   有写权限。harness 自己能做的只有「默认拒绝 + 显式同意 + 环境变量白名单」，
   真正的隔离得靠一次性环境——这就是容器那条路径存在的理由。
   **但容器不是安全边界的全部**：会话在容器里仍然有网，仍然能对 `/out`（也就是宿主的结果目录）
   写任意内容，仍然能读到 `/src` 里被测提交的全部源码。不在容器里跑就完全没有这层兜底。

8. **结果目录按敏感材料对待。** harness 这一侧已经做到取值不落盘：token 只经环境变量传递，
   `command.json` 只记 `env_keys`（键名），`report.json` / `report.md` 写盘前还做一次字面替换
   兜底（`lib/redact.mjs`，把环境里 `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` /
   `ANTHROPIC_AUTH_TOKEN` 的取值换成 `«REDACTED:<键名>»`）。
   **管不住的是被测会话自己的输出**：会话在 `bypassPermissions` 下可以直接
   `echo $CLAUDE_CODE_OAUTH_TOKEN`，那行字会原样进 `stream.jsonl`。
   所以整个结果目录按敏感材料对待——**贴进 issue / PR 时只贴 `report.md` 与 `report.json`**，
   不要整包上传 `sessions/`。`tests/container.test.mjs` 有一条端到端断言：
   拿一个假 token 值跑完回放路径后扫描整个输出目录，确认该取值一次都不出现。
9. **环境白名单可能配少也可能配多。** 配少了：用自建网关或第三方 provider 时会话起不来
   （报错在 `stderr.log` 里）；配多了：多传的那一项就是一条外泄面。
   `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` 属于「拿不准但放进去了」，
   `claude --help` 的选项表里 `ANTHROPIC_API_KEY` 与 `CLAUDE_CODE_OAUTH_TOKEN` 两个都没点名
   （前者只出现在 `--bare` 的说明里，后者的键名是从 CLI 二进制里核出来的）。
10. **`--engine podman` 未经实跑。** 参数拼装有断言覆盖，但本机只用 docker 实跑过自检。
   podman 在 Linux + SELinux 上可能还需要给只读挂载补 `,Z`。
11. **prompt 的措辞本身是变量。** 11 条 prompt 都刻意不提任何 skill 名、域名或动词
   （`tests/cases.test.mjs` 有一条断言钉着），但「同一情境的不同说法」会不会换来不同路由，
   这套 harness 测不了。改 prompt 等于换了评测，不能和旧结果直接比。

## 目录

```
evals/protocol-routing/
├── run.mjs                     # 入口；无效运行的退避重试也在这里
├── cases.mjs                   # 11 条用例（正向 6 + 禁止 5；情境、prompt、前置状态、断言）
├── drivers/
│   ├── index.mjs               # 驱动器接口
│   ├── claude-headless.mjs     # 宿主 CLI 无头模式
│   └── replay.mjs              # 回放预录 JSONL（自测与 CI）
├── lib/
│   ├── argv.mjs                # 命令文本 → agentkit argv
│   ├── classifier.mjs          # 事件流 → 观测量
│   ├── observation.mjs         # 驱动器与分类器之间的 JSONL 格式
│   ├── fixture-repo.mjs        # fixture 仓生成与摘要
│   ├── preconditions.mjs       # 前置状态构造
│   ├── skill-install.mjs       # 隔离配置目录安装四个 skill
│   ├── session-env.mjs         # 传给被测会话的环境变量白名单
│   ├── redact.mjs              # 报告写盘前的认证取值脱敏兜底
│   ├── probe.mjs               # PostToolUse hook：逐事件仓库摘要
│   ├── agentkit.mjs            # 调用被测提交自己的 agentkit
│   ├── agentkit-shim.mjs       # 会话 PATH 上的 agentkit 垫片
│   ├── run-validity.mjs        # 「这一次算不算数据点」的判据
│   └── report.mjs              # 逐条 k/n、两栏、平凡基线、无效运行、信息列
├── container/                  # 本机容器运行（订阅 token）
│   ├── Dockerfile              # node:22-slim + git + claude CLI，以非 root 用户跑
│   ├── run-in-container.mjs    # 运行器；拼命令行的部分是纯函数，有断言钉着安全面
│   ├── run-in-container.sh     # 等价的 shell 入口
│   ├── selftest-skill-install.mjs  # 容器自检的一环：容器内装一遍四个 skill
│   └── selftest-agentkit-shim.mjs  # 容器自检的一环：会话环境里 agentkit 可解析且版本正确
├── fixtures/replay/            # 预录会话（合成的平凡基线 + 合成的 API Error 故障）
└── tests/                      # 自测，已接进 npm test
```
