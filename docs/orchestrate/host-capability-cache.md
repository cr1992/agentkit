# 宿主能力缓存协议

能力快照用于复用已经验证过的宿主语义与限制；它是缓存，不是能力或授权的事实源。实时工具契约
始终优先。读取本文件后，使用 `scripts/host_capability_cache.mjs` 管理状态、刷新和观察事件。

宿主快照缓存只对 `orchestration_mode: full` 强制；worker 有效能力预检对所有档位生效。满足
`SKILL.md` 轻量档全部条件时，不为 cache `status` 构造完整宿主 descriptor，但仍须证明节点实际要求的
运行时能力。轻量档升级为完整档时，再按下文发现、检查和刷新宿主快照。

## 目录

- [存储与分层](#存储与分层)
- [实时描述](#实时描述)
- [Worker 有效能力](#worker-有效能力)
- [检查与刷新](#检查与刷新)
- [观察与沉淀](#观察与沉淀)
- [安全边界](#安全边界)

## 存储与分层

路径根与模型路由配置相同：用户级根跨项目复用，项目级根只承载该仓库或沙箱特有约束。

```text
orchestrate-subagents/
├── hosts/<host>.json                 # 人工偏好
├── capabilities/<host>.json          # 自动能力快照
└── observations/<host>/<event>.json  # 只追加观察事件
```

默认使用 `--scope global`。只有项目工具、沙箱授权或仓库运行环境改变宿主行为时使用
`--scope project`。`--config-dir` 只用于测试或用户显式指定的配置根。

## 实时描述

`host` 是缓存命名空间，不是展示名。使用当前编排工具提供方 / 接口族的稳定、小写标识；不能只因
desktop、CLI、IDE、UI、会话、版本或模型不同就增添后缀。只有工具命名空间或契约族长期独立时，
才为运行表面使用稳定后缀。创建新 key 前，先把所选配置根已有 `capabilities/*.json` 当不可信数据
检查：只读取通过本协议校验的 `host`、工具接口指纹和版本；若已有快照属于同一提供方与接口族、
且实时工具接口指纹一致，复用其 `host`。不能仅凭指纹相同把两个不同提供方合并；来源仍有歧义时
使用当前提供方 / 接口族的稳定标识、记录歧义，不覆盖任一旧快照。

首次派发前，只从当前工具 schema 生成临时 observed descriptor；不能读取旧快照补齐字段。临时
文件放宿主 scratchpad 或平台临时目录，不提交到仓库。

```json
{
  "schema_version": 1,
  "host": "host-a",
  "host_version": "unknown",
  "tools": [
    {
      "name": "worker",
      "parameters": ["message:required:string", "model:optional:enum[model-a,model-b]", "effort:optional:enum[low,medium,high]"],
      "returns": ["agent_id:required:string"]
    }
  ],
  "capabilities": {
    "dispatch.tools": ["worker"],
    "model.explicit": true,
    "model.discovery": "available"
  },
  "limits": {
    "concurrency.max": 4
  },
  "unknown": ["hard-token-budget"]
}
```

`tools[].parameters` / `returns` 的字符串必须稳定编码字段名、必填性、类型和枚举范围，而不只抄字段
名；能力指纹只对这份规范化实时工具接口计算，所以模型列表、effort 档位或返回契约变化会使快照
过期，而 Agent 对语义能力的不同归纳不会制造假过期。`capabilities`、`limits` 和 `unknown` 是待实时
复核的建议性解释，不参与指纹；它们只接受扁平键与标量 / 字符串数组。脚本严格拒绝未知顶层
字段、重复工具、路径穿越 host 和超大 JSON。宿主未暴露版本时写 `unknown`，不得猜版本号。

能力键至少覆盖实际可见的 `dispatch.tools`、model / effort / budget 可调性、生命周期 wait / message /
interrupt、隔离方式、证据来源和授权门；并发上限等数值写入 `limits`。缺失或无法证明的项目写入
`unknown`，不能为了让快照完整而推断。`model.discovery` 只接受 `available / unavailable`；自由字符串
参数但没有候选枚举或可审计列举接口时写 `unavailable`，不以缺失的 `hosts/<host>.json` 代替该事实。

## Worker 有效能力

工具 schema 不证明 worker 能否执行命令、读哪些路径或完成审批往返。每个节点先生成
[Worker Capability Requirements v1](../../schemas/worker-capability-requirements-v1.schema.json)，再用与当前
host、worker profile、接口指纹和 session / 配置 binding 相符的
[Effective Worker Capability v1](../../schemas/effective-worker-capability-v1.schema.json) 检查：

```text
agentkit orchestrate preflight check \
  --requirements <requirements.json> [--effective <effective.json>]
```

有效记录默认放仓库外的当前 session state root；`session:<opaque>` 最长有效 24 小时，能稳定获得宿主
agent 配置摘要时可用 `config:sha256:<digest>`，最长 168 小时。配置或 session 无法绑定时不能把探针
结果跨会话当事实复用。结果只用以下语义，不把错误字符串写成规则：

| outcome | 含义与动作 |
|---|---|
| `allowed` | 能满足该 required capability |
| `denied_by_policy` | 已知策略拒绝；缩小节点或交 controller |
| `unavailable_or_unproven` | 未证明；按成本选择最小探针、缩小范围或 controller 自做 |
| `approval_channel_fault` | 审批往返故障；停止同类派发并升级给人 |
| `execution_fault` | 执行环境故障；停止同类派发并诊断 |

最小探针只覆盖当前任务缺少的能力，不固定探测所有路径或命令。探针是实际 worker，计入 worker 数、
预算和台账。记录必须引用探针、schema 或 observation 的稳定摘要；接口指纹、binding 或有效期不匹配
时 fail closed。升级为 full 只增加 ledger、恢复和缓存，不改变这些能力结果。

## 检查与刷新

安装 Node.js 22+ 与 `agentkit` 后运行：

```text
agentkit host cache status --host host-a --repo <git-root> --observed <current-observed.json>
```

状态语义：

- `fresh`：版本、有效期和能力指纹一致。仍须实时确认本次使用的工具与参数。
- `absent`：没有快照，执行完整发现后刷新。
- `stale`：快照过期、损坏，或版本 / 指纹变化，禁止继续依赖旧值。

刷新默认有效期 168 小时，可在 1–2160 小时内调整：

```text
agentkit host cache refresh --host host-a --repo <git-root> --observed <current-observed.json> --ttl-hours 168
```

快照使用规范化工具接口的 SHA-256 指纹和原子替换写入。宿主版本、有效期或工具接口变化会触发
重建；建议性 `capabilities / limits / unknown` 变化先按当轮实时契约复核，不单独触发重建。即使状态
是 `fresh`，实时调用返回“不支持”、参数拒绝或授权语义冲突时也必须立即判 `stale`，停止依赖缓存
并重新生成。

快照固定使用 `source: live-tool-schema`。`generated_at` 不得比检查时间超前五分钟以上；
`expires_at` 必须晚于生成时间，且两者间隔不得超过 2160 小时。来源、时间窗、缓存内 observed
descriptor 或其指纹任一无效时都返回 `stale`，不得仅因过期时间仍在未来而信任快照。

## 观察与沉淀

运行中发现与快照不一致的宿主能力事实（如参数名不同、并发超出限制、被静默降级）时，用脚本追加一条
结构化观察：

```text
agentkit host cache observe --host host-a --repo <git-root> --event <event.json>
```

事件格式：

```json
{
  "schema_version": 1,
  "category": "rate_limit",
  "summary": "并发超过 4 时报 HTTP 429",
  "confidence": "reproduced",
  "evidence": {"observed_limit": 4},
  "portable": true
}
```

`confidence` 只能填 `observed-once`、`reproduced` 或 `schema-confirmed`。观察是待验证线索，
不直接改写能力快照，下一次 `refresh` 重新发现。落盘记录使用
`{ schema_version, host, recorded_at, capability_fingerprint, event }`；`event` 保存上述输入字段。只有格式
为 `sha256:<64 hex>` 的缓存指纹可绑定到观察，损坏或不可读快照一律记录 `null`。

`observations/<host>/` 只承载宿主能力事实。合同、路由、验收或 Skill 缺口使用编排 Reflection；轻量档
通过 `orchestration-reflection.mjs` 记录，不能为了绕过 ledger 要求把通用 reflection 伪装成 host 观察。

## 安全边界

能力快照和观察记录只应保存可公开的工具 schema 与运行指标；严禁在 `capabilities`、`limits` 或
`evidence` 中记录 token、凭证、私有 URL、设备标识或敏感 payload。
