# 本地模型路由与动态调整

模型路由只保存用户在当前宿主上的执行偏好。Skill 不内置具体模型名、供应商排序、价格、上下文长度，
也不再维护 `economy / balanced / quality`、role route、task override、alias 和 profile 的多层组合。
最强适配 Controller 根据节点难度和验收证据选择本地 tier；脚本只负责校验选择是否在用户配置、
宿主实时能力和动态调整上限内。

## 配置位置

每个宿主只有一个用户级文件：

```text
<user-config-root>/
└── hosts/
    └── <host>.json
```

用户配置根：

| 平台 | 默认位置 |
|---|---|
| Windows | `%APPDATA%\agent-skills\orchestrate-subagents`；缺失时回退 `%USERPROFILE%\AppData\Roaming\...` |
| macOS | `~/Library/Application Support/agent-skills/orchestrate-subagents` |
| Linux | `$XDG_CONFIG_HOME/agent-skills/orchestrate-subagents`；未设置时 `~/.config/agent-skills/...` |

`ORCHESTRATE_SUBAGENTS_CONFIG` 可覆盖配置根。仓库内配置不参与模型与成本路由，避免项目文件静默
改变用户的模型消费偏好。不同宿主独立配置，不从另一宿主复制或猜测模型 ID。

## 配置结构

下面是贴近“强 Controller + 主力 + 杂活”偏好的**非规范性占位示例**。现场必须用当前宿主实际
暴露的精确 ID 替换 `provider-*`；示例名称不是内置型号：

```json
{
  "schema_version": 2,
  "host": "host-a",
  "effort_order": ["low", "medium", "high", "xhigh"],
  "tier_order": ["utility", "primary", "frontier"],
  "tiers": {
    "utility": {
      "models": ["provider-utility-current"],
      "effort": {"default": "xhigh", "min": "medium", "max": "xhigh"},
      "channel": "worker",
      "dispatch": "explicit"
    },
    "primary": {
      "models": ["provider-primary-current"],
      "effort": {"default": "xhigh", "min": "medium", "max": "xhigh"},
      "channel": "worker",
      "dispatch": "explicit"
    },
    "frontier": {
      "models": ["provider-frontier-current"],
      "effort": {"default": "high", "min": "medium", "max": "xhigh"},
      "channel": "worker",
      "dispatch": "explicit"
    }
  },
  "dynamic_adjustment": {
    "enabled": true,
    "max_attempts": 3,
    "allowed_actions": [
      "retry_same",
      "raise_effort",
      "switch_model",
      "promote_tier",
      "fresh_context",
      "change_strategy"
    ]
  }
}
```

- tier 名称和数量由用户定义；`tier_order` 从低到高排列，脚本不猜模型强弱。
- `models` 是有序候选；解析器选择当前宿主实时可用的第一个候选。
- `effort.default` 是普通派发默认值，Controller 可在 `min..max` 内按节点和失败证据调整。
- `channel / dispatch` 必须能由当前宿主工具契约验证。
- `max_attempts` 包含首次派发；达到上限后停止，不通过改配置现场绕过。

上述示例表达一种合理个人偏好：复杂、高模糊、高爆炸半径任务用 `frontier`，日常实现和评审用
`primary`，边界清楚的提取、扫描、格式化等工作用 `utility`。三个 tier 都可以使用较高 effort；
便宜来自模型选择，不强制来自低 effort。最终选哪个 tier、是否降低或提高 effort，由最强适配
Controller 根据任务证据判断。

## 首次配置与修改确认

配置文件不存在时，Controller 只根据宿主实时 schema 形成候选表，展示 tier、精确模型、effort
范围、默认值、成本/质量影响和目标文件。不得凭记忆写型号，也不得先保存再让用户追认。

以下动作需要用户确认：

- 首次写入本地配置；
- 增加新模型、提高 effort 上限或增加最大尝试数；
- 替换 tier 顺序或默认模型，且可能明显影响质量或成本；
- 宿主候选变化导致原配置失效。

已有合法配置就是用户授权的动态调整 envelope。在其模型候选、effort 范围、动作集合和尝试上限内，
Controller 可以根据当轮证据自主调整，不逐次询问；超出 envelope 时停止并展示待确认变更。

## Controller 选择 tier

Controller 不按 worker 的角色名机械路由，按节点实际决策杠杆选择：

| 节点特征 | 常见选择 |
|---|---|
| 输入完备、输出机械、错误容易由测试发现 | 较低 tier |
| 日常实现、局部评审、常规跨文件修改 | 中间或默认 tier |
| 高模糊、跨系统、隐蔽错误、高爆炸半径、关键对抗核验 | 较高 tier |

这只是启发式，不把 tier 名称写死成 `utility / primary / frontier`。Controller 必须记录
`selection_reason`，说明为何当前配置是最低可靠选择。

## 验收失败后的动态调整

先把失败归一为：

| `failure_kind` | 处置 |
|---|---|
| `implementation_defect` | 可定向重试、换策略或按证据提升配置 |
| `reasoning_gap` | 可提高 effort、切模型或提升 tier |
| `context_gap` | 优先新上下文；必要时切模型或提升 tier |
| `strategy_gap` | 改策略、切模型或提升 tier |
| `environment_fault` | 诊断工具、权限或依赖；不得用模型重路由掩盖 |
| `contract_gap` | 停止并 re-contract |
| `safety` | 停止或进入人工门 |
| `undecidable` | 停止并升级 Controller / 用户 |

允许的重路由动作：

- `retry_same`：配置不变，只携带精确 finding 定向重试；
- `raise_effort`：同 tier、同模型，effort 沿本地顺序提高；
- `switch_model`：切换到本地 envelope 内另一模型；
- `promote_tier`：沿 `tier_order` 向更高 tier 移动；
- `fresh_context`：模型参数不变，换干净 Worker 上下文；
- `change_strategy`：保留失败事实但替换实现策略。

不要固定成“第 N 次必升模型”。Controller 先判断失败是实现缺陷、推理、上下文还是策略问题；
环境、合同、安全和不可判定失败不能通过重路由继续试错。每次重派都必须绑定前序 attempt、失败类型、
稳定失败证据摘要和选择理由。

## 解析器

首次派发：

```text
node "<skill-dir>/scripts/resolve_model_policy.mjs" \
  --host host-a \
  --tier primary \
  --selection-reason "常规跨文件实现使用本地主力层" \
  --available-model <live-model-id> \
  --available-effort <live-effort> \
  --available-channel <live-channel>
```

失败后由 Controller 选择调整方式，并把上一份解析结果作为 lineage：

```text
node "<skill-dir>/scripts/resolve_model_policy.mjs" \
  --host host-a \
  --tier frontier \
  --attempt 2 \
  --previous-dispatch <attempt-1.json> \
  --action promote_tier \
  --failure-kind reasoning_gap \
  --failure-ref sha256:<digest> \
  --selection-reason "验收显示跨模块推理遗漏，提升到更高本地 tier" \
  --available-model <live-model-id> \
  --available-effort <live-effort> \
  --available-channel <live-channel>
```

解析器验证配置 schema、实时候选、effort 上下限、tier 顺序、动作语义、前序 attempt、失败摘要和
最大尝试数。它不判断业务失败原因，也不直接派发 Agent；Controller 对分类与选择负责。

解析结果是独立的 [`model-policy-resolution` schema v1](schemas/model-policy-resolution-v1.schema.json)，
不是 ledger 的 `dispatch-record` schema v2。
结果中的 `dispatch_record_patch` 已直接使用 dispatch 字段名。Controller 必须补齐
`schema_version: 2 / worker_id / orchestration_mode / capability_source / capability_fingerprint /
token_budget`，再与该 patch 合并后交给 `dispatch-record`；不得把整个解析结果或不完整 patch 直接
写入 ledger。解析结果顶层的 `host / channel / tier_rank / selection_source` 是派发控制信息，不属于
ledger dispatch。下一次重派的 `--previous-dispatch` 接收上一份完整解析结果，以校验 attempt lineage。

宿主无法列举模型时，持久本地配置不能验证并阻塞。只有用户当轮同时明确给出的精确 `--model` 与
`--effort` 才可配合 `--user-explicit` 继续，并标记 `user-explicit-unverifiable`；单独传 flag 或省略
任一显式值都拒绝，不得把旧配置静默标成用户授权。
