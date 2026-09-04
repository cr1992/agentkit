# Worktree 交付身份

仅在同一 Agent 已有未回收树、需要第二棵树、替代旧树，或发现未登记的并存关系时读取。

## 三种关系

- **复用**：验收结果、目标 ref、写入归属相同且改动面实质重叠。目录或提交历史不够整洁不构成新交付。
- **并存**：成果能独立评审、合入和回退，依赖确需单独落地，或多个写入者必须物理隔离。不同 MR、
  branch 或命名只是线索，不能单独证明独立。
- **替代**：旧树因基线、历史、环境、权限或 owner 问题不能继续。先冻结旧写入，记录旧树到新树、
  独有改动保存位置和退出条件；迁移结束立即停止旧 watcher、处理旧 change request 并回收。

manager 用真实 `agent-id` 做最小门禁。同一会话已有未回收树时，普通 `spawn` 返回
`DELIVERY_WORKTREE_EXISTS`。同一交付直接进入旧路径；确属独立并行时说明可独立交付的理由：

```bash
agentkit worktree spawn independent-release-audit \
  --agent codex --agent-id <real-thread-id> \
  --purpose "独立发布审计" \
  --parallel-reason "与现有改动可独立评审、合入和回退"
```

替代旧树前先使旧树 clean，并用 `touch ... --status abandoned --note <迁移边界>` 冻结：

```bash
agentkit worktree spawn current-ios-validation \
  --agent codex --agent-id <real-thread-id> \
  --purpose "迁移到新基线" \
  --supersedes old-ios-validation \
  --replacement-reason "旧基线不可继续，独有提交已保存"
```

`--parallel-reason` 与 `--supersedes/--replacement-reason` 互斥，都是人工裁决后的审计出口。
存量替代树用 `supersede` 补双向关系，不伪造新树或手改 trace：

```bash
agentkit worktree supersede old-ios-validation \
  --by current-ios-validation --reason "旧树已被完整替代"
```

该命令只接受同一会话、owner 一致且新树不早于旧树的组合，幂等写入双方关系；冲突关系 fail-closed。
