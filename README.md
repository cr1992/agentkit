# Awesome Agent Skills

**中文** · [English](./README.en.md)

一组面向 Agent 软件工程的可复用 Skill：从任务编排、Git worktree 隔离，到一次性独立验收和显式有界循环。

![Agent Skills 显式有界 implementation–verification Loop](./docs/architecture/skill-collaboration.svg)

图中展示显式 Loop 模式下的典型组合：Controller 冻结合同和 provider 后，Loop 驱动实现、冻结
Artifact、消费独立验收 Evidence，并把收敛结果交回 Controller。它不表示本组全部 Skill 必须全开；
一次性验收直接使用 `verify-agent-output`，不进入 Loop。

[Agent Skills 协作契约与安全边界（v1 · Pilot）](./docs/architecture/skill-system-architecture.md)

## 包含的 Skill

| Skill | 用途 |
| --- | --- |
| [`orchestrate-subagents`](./orchestrate-subagents/) | 判断任务是否值得拆分，设计依赖图与派发契约，选择合适的 Agent 能力，并由主控 Agent 统一验收结果。 |
| [`manage-worktrees`](./manage-worktrees/) | 扫描写入冲突，创建和登记可追踪的 Git worktree，为多个功能分支生成固定提交的批量验收计划，并安全回收 worktree。 |
| [`verify-agent-output`](./verify-agent-output/) | 对冻结的单一 Git Artifact 做一次独立验收，执行 L0/L1/L0 并输出与摘要绑定、可复核的 Evidence Package；不修改产物、不自动重试。 |
| [`run-agent-verify-loop`](./run-agent-verify-loop/) | 让实现 Agent 与隔离上下文中的验收 Agent 形成闭环，通过确定性检查、证据台账、熔断和人工门控制收敛。 |

本组目前包含 4 个 Skill。它们都可以独立使用，也可以通过冻结的 JSON envelope 联动。普通任务不必
加载任何一个；固定 Artifact 只验一次时直接使用 `verify-agent-output`；只有明确要求反复修复和独立
复验时才使用 Loop。多节点编排和 worktree 隔离同样按实际需要添加，不是默认必经步骤。

## 安装

安装全部 Skill：

```bash
npx skills add https://github.com/cr1992/awesome-agent-skills.git -g --agent '*'
```

只安装一个 Skill：

```bash
npx skills add https://github.com/cr1992/awesome-agent-skills.git -g --agent '*' --skill manage-worktrees
```

将 `manage-worktrees` 替换为表中的其他 Skill 名称即可。安装或更新后，建议新建 Agent 任务；部分宿主
会缓存 Skill 清单或正文，需要重启后才会加载新版本。

## 使用方式

安装完成后，直接用自然语言描述目标，并明确触发对应能力，例如：

```text
用 orchestrate-subagents 把这个功能拆给多个 Agent 并行处理。
用 manage-worktrees 为这些 feature 分支准备一批集成验收。
用 verify-agent-output 独立验收这个固定 commit，只验一次并输出 Evidence。
用 run-agent-verify-loop 让一个 Agent 实现、另一个 Agent 独立验收，直到通过或触发停止条件。
```

Skill 会根据当前宿主可用的 Agent、终端、Git 和任务控制能力进行适配。宿主缺少某项能力时，应遵循
各 Skill 中的降级路径，而不是假设某个特定产品或工具一定存在。

## 环境要求

- Git。
- Node.js 18 或更高版本（四个 Skill 的确定性 runtime 与辅助脚本）。
- 若要实际派生和隔离多个 Agent，上层宿主需要提供相应的任务或子 Agent 能力。

## 本地验证

```bash
node --test \
  manage-worktrees/scripts/*.test.mjs \
  orchestrate-subagents/scripts/*.test.mjs \
  verify-agent-output/scripts/*.test.mjs \
  run-agent-verify-loop/scripts/*.test.mjs \
  scripts/*.test.mjs
```

## 仓库范围

本仓库只包含上述 4 个可分发 Skill 目录和仓库级文档，不包含无关 Skill、凭证或组织专用配置。
