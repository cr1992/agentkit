# agentkit 维护约定

## 真源与边界

- 本仓库是 `agentkit` CLI、四个 Skill、canonical schema、测试与架构文档的唯一真源。
- 产品代码不得从其他仓库生成、镜像或反向覆盖；外部仓库只能按已发布版本消费本仓库。
- `docs/architecture/skill-system-architecture.md` 是四个 Skill 的架构真源。行为、schema、trigger、runtime 边界或组合协议变化，必须在同一变更中更新该文档。
- `core/`、`domains/`、`schemas/` 与四个 Skill 目录共同组成一个版本化发布单元；不得单独发布互不匹配的部分。

## 变更门禁

- Node.js 最低版本为 22，CI 同时覆盖 Node.js 22 与 24。
- 提交前运行 `npm test`；发布前再运行 `npm pack --dry-run`，并从生成的 tarball 做一次干净安装验证。
- 四个 Skill 目录保持薄壳：实现放在 `core/` 或 `domains/`，Skill 内的 `scripts/` 只保留兼容转发。
- 公共文档优先使用 `agentkit` 命令，不新增指向 Skill 内兼容脚本的调用示例。
- 仓库不得包含本机绝对路径、凭证、私有远端、组织专用配置或旧真源的内部信息。

## 发布

- Git tag、GitHub Release 与 npm 包使用同一个 semver。
- `main` 上通过 CI 的提交才可打 tag；tag 后发布物必须能从 registry 反装并通过 `agentkit doctor`。
- npm namespace 尚未就绪时不得创建正式 release tag；仓库版本可以保持候选版本，但 README 必须明确标注 registry 尚未发布。
