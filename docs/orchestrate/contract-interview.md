# 契约访谈（contract interview）

`agentkit contract interview-*` 是一台状态机：**问什么由实质性判据的拒绝清单驱动，什么时候算问完由它自己的完成判据决定。**

两者不能合一。`core/contract-substance.mjs` 的 error 只匹配 scaffold 的字面量，任意填一轮文字就能通过；
拿它当结束条件，访谈就退化成一张一次性表单。

| 环节 | 谁决定 |
|---|---|
| 问哪些字段 | 实质性判据的 error / warning 清单，另加一道必问题：`permissions` |
| 提问顺序 | `permissions → objective → acceptance → scope.include → scope.exclude → stop_conditions` |
| 每题的选项 | **调用本命令的模型**：根据用户诉求和仓库现状给出 2–4 个互斥选项 |
| 选哪个 | 用户 |
| 何时结束 | 三条完成判据同时满足 |

命令本身不调用任何模型，也不对自然语言做启发式判定。它只出题、校验回填、冻结。

## 交互形态

多次调用、文件往返，不是 TTY 交互。轮次与作答记录写在**契约草稿自己的 `extensions.interview` 里**，
不另建状态目录：草稿在哪里，进度就在哪里。

```
contract scaffold            → 契约草稿（原样占位）
contract interview-ask       → 本轮问题批（最多 4 题，选项槽是空的）
  ↑                            ↓ 你把选项填进去，交给用户选
  └──── contract interview-answer ← 作答文件
contract interview-freeze    → 带 contract_digest 的冻结契约
```

### `contract scaffold [--workdir <dir>]`

契约骨架。与 `verify scaffold --kind contract` 同源（`core/contract-scaffold.mjs`），
只有 `skill_set` 不同：本命令冻结当前 `orchestrate-subagents` 的 content digest，`ledger init` 要求它；
verify 侧冻结 `verify-agent-output`。

### `contract interview-ask --input <草稿>`

输出本轮问题批：

| 字段 | 含义 |
|---|---|
| `round` / `max_rounds` | 本轮序号与上限 |
| `questions[]` | `{ field, question, field_semantics, options: [], selected: null, source: "user" }` |
| `answer_spec[]` | 填写规范原文，直接转述给用户 |
| `remaining_criteria[]` | 仍缺的完成判据，每条带 `criterion` / `field` / `detail` |
| `required_fields[]` | 本次权限模式下的必问题清单 |

`options` 是空槽——命令不生成选项。

### `contract interview-answer --input <草稿> --answers <作答文件>`

作答文件是 `{ "answers": [...] }` 或裸数组，一轮最多 4 条，同一字段一轮只能答一次。

```jsonc
{ "field": "permissions", "options": ["read_only", "write"], "selected": 1, "source": "user" }
{ "field": "objective",   "options": ["A", "B"], "selected": "custom", "custom_value": "用户原话", "source": "user" }
{ "field": "scope.exclude", "options": ["A", "B"], "deferred": true, "assumed": "保留 scaffold 的空 exclude" }
```

命令把选中的内容写进对应字段，追加 `extensions.interview.answers[]`，重新校验，
输出下一批问题（`next`）或 `complete: true`。

`deferred` 用于用户回答"都行"或拒答：**不替用户选**——字段保留当前默认值，一个字都不往里写，
只在 `extensions.interview.assumptions[]` 记下 `{ field, assumed, reason: "user_deferred" }`。
**"无所谓"不等于"排除"**，所以 `deferred` 永远不会往 `scope.exclude` 里加内容。带 assumption 的字段视为已作答。

### `contract interview-freeze --input <草稿>`

三条完成判据都满足时重新签名并输出契约，否则非零退出并列出仍缺的判据。
冻结产物能通过 `contract validate` 与 `ledger init`。

配一份合规 profile 时也能通过 `verify preflight`，但 preflight 另外要求契约冻结 `verify-agent-output`。
`skill_set` 不是访谈会问、会改的字段，所以这条绑定要在开访谈之前就写进草稿：

```
agentkit contract scaffold --workdir <repo>     # 只带 orchestrate-subagents
# 再往 skill_set 追加 verify-agent-output 的 name/version/content_digest
agentkit verify capabilities --json             # 取当前 runtime_version 与 content_digest
```

## 必问题清单

| 权限模式 | 必问字段 |
|---|---|
| `read_only` | `permissions` / `objective` / `acceptance` / `scope.include` |
| `write` | 以上，再加 `scope.exclude` / `stop_conditions` |

**`permissions` 必问且最先问。** `scope.exclude` 与 `stop_conditions` 的判据只在 write 模式下生效，
而 scaffold 默认 `read_only`，能悄无声息地通过校验。不先问权限，一个写任务走完整个访谈，
也不会被问到边界和刹车。

实际出题的字段 = 必问题里尚未作答的 ∪ 实质性判据仍在报的字段。
error 指向的字段一律重问——填了一轮文字不等于问完了；warning 指向的字段若已有作答记录就不再问。

## 完成判据

三条同时满足才冻结：

1. **实质性判据的创建入口 error 为零。** warning 允许保留：用户可以明确回答"没有要排除的"，
   这时 `scope.exclude` 为空的 warning 仍在，但该字段已有作答记录。
2. **每道必问题都有一条作答记录**（`source: "user"`），或一条 `user_deferred` 的 assumption。
3. **每条作答记录的 `field` 在契约里的当前值，与 `selected` 对应的内容一致。**
   单值字段（`permissions` / `objective`）按相等判定，列表字段（`acceptance` / `scope.*` / `stop_conditions`）按包含判定。

第 3 条是这台状态机的实际门禁：事后手改字段而不更新记录，冻结就不成立。

## 作答记录格式

```jsonc
"extensions": {
  "interview": {
    "schema_version": 1,
    "round": 2,
    "answers": [
      { "field": "permissions", "options": ["read_only", "write"], "selected": 1, "source": "user" },
      { "field": "objective", "options": ["A", "B"], "selected": "custom", "custom_value": "用户原话", "source": "user" }
    ],
    "assumptions": [
      { "field": "scope.exclude", "assumed": "保留 scaffold 的空 exclude", "reason": "user_deferred" }
    ]
  }
}
```

- `options` 是当时给出的 2–4 个选项原文，**逐字保留**；
- `selected` 是选项下标，或 `"custom"` 配 `custom_value` 写用户原话；
- `source` 只能是 `"user"`；
- 单值字段再次作答会**替换**旧记录——两条记录只有一条能与字段当前值一致，留着另一条会让判据 3 永远不成立。

`extensions.interview` **进入 `contract_digest`**。这是预期的：作答记录是契约的一部分，冻结后不可变。

## 选项校验

每题 2–4 个选项、互不相同、非空。0 或 1 个选项按开放式问题拒绝——一道只有一个答案的题，
不是在让用户选择。命令只看形状，不判断选项内容"好不好"。

## 3 轮上限

一轮 = 一次"出题 → 回填 → 校验"。第 3 轮回填后完成判据仍未满足，命令非零退出，
列出仍缺的判据，并建议把任务拆开：一份契约要问到第 4 轮还定不下来，通常说明它同时在做两件事。

## 命令检查不了什么

**`source: "user"` 的真伪。** 命令能检查作答记录是否存在、是否与字段当前值自洽，
但无法判断这条记录背后是不是真的有一个人做过选择——伪造一份 `answers[]` 与真实作答在字节上没有区别。
这是本命令的剩余风险，不由它承担。

同样不承担的还有：选项是否真正互斥、`assumed` 描述的默认值是否就是字段当前的值、
用户选中的内容是否切题。这些都需要对自然语言做判断，命令一律不做。
