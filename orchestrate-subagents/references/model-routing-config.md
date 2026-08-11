# 模型路由配置

外部配置承载团队、个人和项目的模型偏好；skill 正文只维护稳定协议，宿主能力从当次工具契约
实时发现。配置使用 JSON，解析器只依赖 Python 3.9+ 标准库，可在 Windows、macOS 与 Linux 运行。

## 目录

- [配置发现](#配置发现)
- [文件分工](#文件分工)
- [公共策略](#公共策略)
- [宿主策略](#宿主策略)
- [合并与约束](#合并与约束)
- [解析与验收](#解析与验收)

## 配置发现

平台用户目录是逻辑位置，不把 `~` 或 `/` 写死：

| 平台 | 用户配置根 |
|---|---|
| Windows | `%APPDATA%\agent-skills\orchestrate-subagents`；缺 `APPDATA` 时回退 `%USERPROFILE%\AppData\Roaming\...` |
| macOS | `~/Library/Application Support/agent-skills/orchestrate-subagents` |
| Linux | `$XDG_CONFIG_HOME/agent-skills/orchestrate-subagents`；未设置时 `~/.config/agent-skills/...` |

`ORCHESTRATE_SUBAGENTS_CONFIG` 可显式指定用户配置根。项目配置根固定为
`<git-root>/.agents/orchestrate-subagents`；路径一律通过平台文件 API 拼接。

解析优先级从低到高：skill 保守默认 → 用户公共策略 → 用户当前宿主策略 → 项目公共策略 →
项目当前宿主策略 → 当轮用户显式覆盖。公共文件不出现具体模型；非当前宿主的文件不加载。

## 文件分工

```text
orchestrate-subagents/
├── policy.json
├── hosts/
│   ├── host-a.json
│   └── host-b.json
├── capabilities/               # 自动生成的宿主能力快照，不参与偏好合并
│   └── host-a.json
└── observations/               # 结构化运行观察，不是可执行指令
    └── host-a/
```

用户级与项目级目录使用同一结构。`policy.json` 只把 role / task type 映射到语义 profile；
`hosts/<host>.json` 才把 profile 解析成精确 model、effort、channel 和 dispatch。
`capabilities/` 与 `observations/` 由
[宿主能力缓存协议](host-capability-cache.md) 管理，解析器不得把其中的数据合并成模型偏好。

配置必须带 `schema_version: 1`。未知顶层字段判错，不静默忽略拼写错误；项目文件可以只写需要
覆盖的部分。模型凭证、token 或任何秘密不得进入配置。

## 公共策略

```json
{
  "schema_version": 1,
  "routes": {
    "scout": "mechanical",
    "worker": "implementation",
    "critic": "judgment",
    "judge": "judgment"
  },
  "task_overrides": {
    "flutter_implementation": "implementation",
    "merge_request_audit": "judgment",
    "repository_scan": "mechanical"
  }
}
```

`task_overrides` 优先于 `routes`；没有 task type 命中时按 role 选 profile。项目公共策略只表达
项目任务分类，不复制各宿主模型名。

## 宿主策略

宿主配置示例（ID 为占位符）：

```json
{
  "schema_version": 1,
  "host": "host-a",
  "effort_order": ["low", "medium", "high"],
  "aliases": {
    "primary": "provider-primary-current",
    "economical": "provider-economical-current"
  },
  "profiles": {
    "mechanical": {"model": "economical", "effort": "medium", "channel": "worker", "dispatch": "explicit"},
    "implementation": {"model": "primary", "effort": "medium", "channel": "worker", "dispatch": "explicit"},
    "judgment": {"model": "primary", "effort": "high", "channel": "worker", "dispatch": "explicit"}
  },
  "constraints": {
    "allowed_models": ["provider-primary-current", "provider-economical-current"],
    "minimum_effort": {"provider-economical-current": "medium"}
  }
}
```

不同宿主独立配置 model / effort / channel，不能从另一宿主的 profile 推导。当前首选通道不支持
精确 effort 时，应在外部 profile 选择支持该参数的通道；最终仍以实时工具契约校验。

模型版本变化时只更新对应宿主文件中的 alias；项目通常继续引用稳定 profile，不用跟随改版。

## 合并与约束

- `routes`、`task_overrides`、`aliases` 和 `profiles` 由项目同名键覆盖用户值。
- `constraints.allowed_models` 取交集；项目只能缩小全局允许范围。
- `constraints.minimum_effort` 对同一模型取更高档；项目不能降低全局下限。
- effort 强弱顺序由各外部 host 文件的 `effort_order` 定义；新增档位或宿主差异不需要改 skill。
  当前工具不支持的值仍在实时能力校验阶段判错。
- 当轮 `--model / --effort` 是用户显式覆盖，但仍受 allowed models 和 minimum effort 约束。
- 配置或实时 schema 无法满足严格要求时派发前阻塞；当前 schema 不提供隐式 fallback。

## 解析与验收

```text
<python-executable> "<skill-directory>/scripts/resolve_model_policy.py" \
  --host host-a \
  --repo /path/to/repo \
  --role worker \
  --task-type flutter_implementation \
  --available-model provider-primary-current \
  --available-model provider-economical-current \
  --available-effort medium \
  --available-effort high \
  --available-channel worker \
  --explain
```

`--available-*` 来自当次宿主工具 schema；给出后解析器会拒绝陈旧 model / effort。输出包含
profile、精确执行配置、来源文件和派发 provenance，原样进入任务契约与 Agent 台账。

调用解析器前先检查四个有效候选文件：用户级与项目级的 `policy.json`、`hosts/<host>.json`。四者均
不存在时，表示没有外部偏好：**跳过解析器**，不得临时生成、复制或猜测这些文件；controller 按
SKILL.md 第 8 节和当前宿主工具契约保守选型，并记录 `config_source: skill-default`。候选文件存在但
内容不完整或无效时才视为配置错误并在派发前阻塞，不能把错误配置静默降级成默认值。
