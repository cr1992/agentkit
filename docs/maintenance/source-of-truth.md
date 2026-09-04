# 真源与发布维护

## 当前边界

`cr1992/agentkit` 直接拥有并维护以下内容：

- `bin/`：`agentkit` 命令入口与路由；
- `core/`、`domains/`：共享内核与四个领域运行时；
- `schemas/`：跨 Skill 的 canonical schema；
- 四个 Skill 目录：触发条件、不变量和 1.x 兼容转发；
- `docs/`、`tests/`、`tools/`：架构真源、复验门禁与维护工具。

这些路径必须作为同一个版本化单元演进。外部聚合仓或本机安装只能消费已发布版本或固定 Git commit，
不得向本仓库回写生成结果。

## 迁移切换点

公开提交 `cb08a62` 是旧单向镜像链的最后一个生成提交。其后的产品、文档、测试与发布改动均从本仓库
发起。旧聚合仓应删除出站同步 job、同步脚本和产品副本，避免重新形成双真源。

## 变更流程

1. 从最新 `main` 创建分支，在本仓库直接修改代码与文档。
2. 若变更涉及行为、schema、trigger、runtime 边界或组合协议，同步更新架构真源。
3. 运行 `npm test`；CI 在 Node.js 22 与 24 上复验相同门禁。
4. 合入 `main` 后，以固定 commit 准备版本；发布前检查 `npm pack --dry-run` 的文件清单。
5. 同一个 commit 使用同一个 semver 创建 Git tag、GitHub Release 与 npm 包。
6. 从 npm registry 安装该精确版本，运行 `agentkit doctor` 和安装矩阵测试，保存发布证据。

## 本机开发安装

需要验证未发布改动时，可从仓库根目录建立本地 CLI 链接：

```bash
npm link
agentkit doctor
```

Skill 可直接从 Git commit 安装；用于可复现环境时应固定 commit 或 release tag，不依赖浮动的 `main`。
