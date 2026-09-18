# 协议路由评测

对应 issue [#15](https://github.com/cr1992/agentkit/issues/15)。

仓库里 298 个测试全部落在机械层：它们能证明运行时按契约拒绝非法输入，证明不了 controller
**有没有按协议路由**。这套 harness 补的就是这一段：给一个真实用户请求，看会话的第一个实质动作
落在哪里。

它不是单元测试，是评测：结果是一组 k/n，不是红绿。目录不进 `package.json` 的 `files`，不随包发布。

## 观测量

每个会话中，**排除只读白名单后的第一个 `agentkit` 调用，或第一个写操作**，取先发生者。
取值三种：`WRITE`、`agentkit <域> <动词> [关键参数]`、`NONE`。

白名单的原则是**只读、且不暴露路由去向**。协议本身就要求先读文档、先做扫描（四个 SKILL.md 里
一共 28 处 `agentkit docs`），把这些算进观测量，正确的会话会被判成失败。

| 排除（只读，不暴露路由去向） | 保留观测（暴露路由去向） |
| --- | --- |
| `docs`、`capabilities`、`doctor`、`--help` / `--version`、各域的 `status` / `inspect` / `doctor` / `capabilities`、`worktree list`、`worktree scan`、`verify readiness` | `contract *`（含 `validate`）、`verify preflight`、`orchestrate preflight check`、其余一切 |

同一个工具事件里两者同时成立时（`agentkit worktree spawn` 本身就会写盘），`agentkit` 调用优先：
它信息更具体，而且第 3 条正向用例要的正是这种形态。写操作仍会登记在案，只是不作为观测量。

## Harness 四项规定

| 项 | 规定 | 实现 |
| --- | --- | --- |
| 会话怎么起 | 用宿主 CLI 的无头模式逐用例起新会话，工具事件流完整落盘为 JSONL；每份结果记录宿主名、宿主版本、模型 ID | `drivers/claude-headless.mjs` |
| 现场 | 每个会话一份全新 fixture 仓拷贝（临时目录、独立 git 仓、独立 state root、独立 `HOME` 与 `CLAUDE_CONFIG_DIR`），会话之间不共享任何状态；用例需要的前置状态由脚本预先建好 | `lib/fixture-repo.mjs`、`lib/preconditions.mjs` |
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

stdout 原样落盘为 `stream.jsonl`；工具事件从其中的 `tool_use` 块按出现顺序取。
每个会话目录下留档：`command.json`（起会话的确切参数）、`prompt.txt`、`stream.jsonl`、
`probe.jsonl`（逐事件仓库摘要）、`observation.jsonl`（判定的唯一输入）、`stderr.log`。

### 现场

```
<out>/sessions/case-<id>/run-<n>/
├── repo/                 # 全新 fixture git 仓，会话的 cwd
├── state/                # 独立 state root（落在业务仓之外）
├── home/.claude/skills/  # 隔离配置目录，四个被测 skill 装在这里
└── …留档文件
```

前置状态：

| 用例 | 前置状态 | 内容 |
| --- | --- | --- |
| 1–6、11 | `plain` | 干净 fixture 仓 |
| 7 | `ledger-implementations-passed` | 契约 `extensions.verification.provider = verify-agent-output`；两个实现节点已 `passed`；台账里没有任何集成级验证节点或 Evidence |
| 8 | `scaffold-contract` | `contract.json` 是 `agentkit verify scaffold --kind contract` 的**原样**输出，占位文本一字未改，尚未 `ledger init` |
| 9 | `minimal-contract` | 占位字面量全部替换、`skill_set` 冻结正确，内容空洞。#12 的实质性检查与 `ledger init` 的 digest 闸门**都会放行**——剩余风险探针，只测协议 |
| 10 | `ledger-node-awaiting-evidence` | 节点 `impl-a` 声明 `independent_evidence`，已派发、有产物，没有任何 Evidence |

第 7、10 条的 prompt 里用 `{{LEDGER_DIR}}` 占位，起会话前替换成该会话的真实路径。
这三条现场赖以成立的机制事实（第 8 条过不了创建入口、第 9 条能过、第 10 条标不成 `passed`）
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

- **逐条报告原始计数 k/n，不取多数。** 取多数会把 2/3 和 3/3 记成同一个结果，丢掉的正是要看的信息。
- 栏分数是该栏所有用例的 Σk / Σn。**正向、禁止两栏必须同时报告**，单独引用其中任何一栏都没有意义。
- 平凡基线和结果一起报告，按同一 n 换算：

  | 基线 | 正向 | 禁止 | n=3 时 |
  | --- | --- | --- | --- |
  | 永远 `NONE` | 0/7 | 4/4 | 0/21 与 12/12 |
  | 永远 `WRITE` | 2/7 | 2/4 | 6/21 与 6/12 |

- **不汇总成单一百分比，暂不设红线。**

输出 `report.json`（机器读）与 `report.md`（人读）。

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

### 常规评测

```bash
node evals/protocol-routing/run.mjs \
  --driver claude-headless --model <模型 ID> \
  --runs 3 --out /tmp/pr-eval
```

**一次常规评测 = 11 条用例 × 3 次 = 33 个真实模型会话**，每个会话都要读四个 SKILL.md（21433 字符）
并跑若干工具调用，费用按这个量级估。它的用途是发现 0/3 和 3/3 这类明显的失守或稳定，
**分辨不了 60% 与 90%**。`--budget-usd` 可以给单会话加美元上限。

### 改动前后对比

```bash
node evals/protocol-routing/run.mjs --driver claude-headless \
  --model <模型 ID> --cases 7,8 --runs 10 --out /tmp/pr-eval-before
```

只对受影响的用例加跑到每条 n ≥ 10，改动前后用同一模型、同一 fixture、同一 n。
**n=3 的两次常规评测之间的差异不得作为「改动有效」的证据。**

### CI

`.github/workflows/protocol-routing-eval.yml`，只 `workflow_dispatch`，不挂 push。
`replay` 段永远跑、零费用；`live` 段要 `run_live: true`、显式 `model` 和仓库 secret
`ANTHROPIC_API_KEY`，缺任何一个**显式失败**而不是静默跳过。

## 已知盲区

按可能造成误判的严重程度排：

1. **驱动器未经真实会话验证。** `drivers/claude-headless.mjs` 的 flag 组合、stream-json 的
   `tool_use` 块形状、PostToolUse hook 的 `matcher: "*"` 写法与载荷字段名，都是按
   `claude --help` 与 hook 约定写的，尚未在一次真实会话上跑通。第一份真实基线跑出来之前，
   这段代码应当按「未验证」对待；跑通后请把此条改掉。
   **已实测**的只有 skill 安装那一段（`npx skills add <本地路径> -g` 确实落进
   `CLAUDE_CONFIG_DIR`，四份 `SKILL.md` 都在）。回放驱动器与分类器不受影响——自测已覆盖。
   第一次真实运行前建议先只跑一条用例（`--cases 1 --runs 1`），检查该会话目录下的
   `probe.jsonl` 非空、`observation.jsonl` 的 `meta.unpaired_tool_uses` 为 0，再放开全量。
2. **并行工具调用可能错位。** hook 按**完成**时间触发，`stream.jsonl` 按**发起**顺序排。
   配对优先用 `tool_use_id`（若 hook 载荷提供），否则退回按顺序配。宿主一次发起多个并行工具时，
   顺序配可能把摘要挂到相邻的事件上。`observation.jsonl` 的 `meta.pairing` 记录本次用的是哪种，
   `meta.unpaired_tool_uses` 记录配不上的个数——判定前应当先看这两个字段。
3. **命令替换不展开。** argv 提取是词法级的，不展开 `$(…)`、反引号和变量。
   `$(echo agentkit) worktree spawn` 这类写法会被漏掉。实际会话里没见过，但它是个真实的逃逸口。
4. **第 7 条依赖载荷解析。** 判「声明了 `independent_evidence` 的 `ledger add-node`」需要读
   `--input` 指向的文件。文件已被删除或是内联 JSON 之外的形态时解析不到，该次**不给分**
   （正向用例不能靠「看不清」拿分）。第 10 条方向相反：解析不到按**违规**处理（fail-closed）。
5. **#13 尚未合入。** 第 7 条依赖的覆盖规则还在 `main` 之外，构造器没有依赖它。
   #13 落地后这条用例的现场可能需要重新设计。
6. **prompt 的措辞本身是变量。** 11 条 prompt 都刻意不提任何 skill 名、域名或动词
   （`tests/cases.test.mjs` 有一条断言钉着），但「同一情境的不同说法」会不会换来不同路由，
   这套 harness 测不了。改 prompt 等于换了评测，不能和旧结果直接比。

## 目录

```
evals/protocol-routing/
├── run.mjs                     # 入口
├── cases.mjs                   # 11 条用例（情境、prompt、前置状态、断言）
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
│   ├── probe.mjs               # PostToolUse hook：逐事件仓库摘要
│   ├── agentkit.mjs            # 调用被测提交自己的 agentkit
│   └── report.mjs              # 逐条 k/n、两栏、平凡基线
├── fixtures/replay/            # 预录会话（合成的平凡基线）
└── tests/                      # 自测，已接进 npm test
```
