# 四 Skill 协作架构 v1：总评审上下文

## 1. 本次评审要决定什么

本变更把朋友架构中的“任务隔离、独立验证、证据台账、有界循环、失败熔断、复盘沉淀”拆成四个
可独立安装的 Agent Skill，并用脚本保证关键不变量：

| Skill | 唯一职责 | 明确不拥有 |
| --- | --- | --- |
| `orchestrate-subagents` | 多节点任务图、派发回执、依赖/barrier、跨节点稳定产物、批级熔断 | 单 Artifact verdict、Git 生命周期、单 Loop iteration |
| `manage-worktrees` | Git 隔离、owner epoch、生命周期、Artifact Ref / Binding | Agent 派发、Verification verdict、全局完成判断 |
| `verify-agent-output` | 对单个冻结 Artifact 做一次独立验收并产生 Evidence | 修改 Artifact、自动重试、全局完成判断 |
| `run-agent-verify-loop` | 显式的单对象 implement → verify → decide 有界循环 | 默认路由、批队列、provider 选择、外部 Goal 完成 |

核心路由原则：普通任务不加载任何 Skill；一次性独立验收直接使用 `verify-agent-output`；只有用户
明确要求反复修复并独立复验时才使用 Loop；只有真实多节点/并行/不同权限时才使用 orchestrator；
只有并发写入或所有权冲突确实需要 Git 隔离时才使用 worktree。

Loop 保留为独立能力，但不是统一入口。批量 Loop 的连续同因熔断已经迁移到 orchestrator 的 batch
ledger；每个 Loop 只维护一个收敛对象。

## 2. 评审范围与提交结构

评审分支：`codex/verify-agent-phase1a`，基线：`origin/main`。

按 Phase 划分的提交：

1. `d00f610 feat: add evidence-driven verification skills`
   - 架构真源、`verify-agent-output`、Loop runtime、embedded adapter；
   - Evidence / Review Result / Loop State；
   - Reflection、Convergence Report、proposed-only Improvement Proposal。
2. `4acc645 feat: expose worktree artifacts for verification`
   - Worktree Binding / Artifact Ref / capabilities；
   - owner epoch 与 Artifact 机械校验；
   - incident Reflection / Proposal；
   - `manage-worktrees → Artifact → verifier` 真实组合测试。
3. `51abdb1 feat: add orchestration ledger and batch fuses`
   - Task Contract tool；
   - 任务图、barrier、派发回执、stable attachment、journal rebuild、doctor；
   - batch ledger / fuse；
   - 三个真实 Loop 连续同因失败的迁移组合测试；
   - 删除 Loop 的旧批量责任。
4. `8f74323 test: harden skill combinations and recovery`
   - 并发 revision、crash recovery、篡改、隐私、schema compatibility；
   - 四 Skill 独立安装和全部 15 种非空组合测试。

主设计文档：[`skill-system-architecture.md`](skill-system-architecture.md)。

## 3. 关键运行时

### 3.1 一次性验收

`verify-agent-output/scripts/verification-runtime.mjs`：

```text
capabilities
init
run-smoke
review-input
record-review
run-final
record-reflection
propose-improvement
status / inspect / validate / doctor
```

顺序固定为 `initialized → smoke_passed → review_recorded → terminal`。L1 必须来自宿主新上下文或
用户中继第二会话；无独立 reviewer 时不能产生 pass。Evidence 的 completion scope 固定为
`verification_only`。

### 3.2 显式 Loop

`run-agent-verify-loop/scripts/loop-runtime.mjs`：

```text
capabilities / init / record-artifact
run-embedded-l0 / record-embedded-review
record-evidence / record-verification-abort
next / resume / stop / human-gate
record-reflection / convergence-report / propose-improvement
status / inspect / validate / doctor
```

full provider 消费标准 Evidence；standalone embedded provider 只生成类型隔离的 Embedded Record，
不能冒充 Evidence。失败指纹只使用稳定 `check_id` 和 `{contract_item_id,class}`。

### 3.3 Worktree runtime

在既有 `worktree-mgr.mjs` 上新增：

```text
capabilities
binding <selector>
artifact <selector>
verify-artifact <json>
incident <selector> --input <json>
propose-improvement --reflection <uuid> --input <json>
```

Artifact 只从存在且 clean 的 worktree 产生；验证会检查 repository identity、object format、完整
commit、ancestor、worktree ID、owner epoch、live HEAD 和 dirty 状态。

### 3.4 Orchestrator runtime

`contract-tool.mjs` 提供 `normalize / validate / digest / review-view / diff`。

`orchestration-ledger.mjs` 提供：

```text
capabilities / init
add-node / add-edge / dispatch-record / update / attach
batch-init / batch-record / batch-status / batch-fuse
record-reflection / propose-improvement
status / inspect / rebuild / doctor
```

脚本不直接派发 Agent。controller 调用宿主 API 后，把精确 worker identity、model、effort 和稳定产物
写入 ledger。没有稳定产物的实现节点不能进入 `passed`；barrier 未满足时不能派发下游。

## 4. 公共数据契约

v1 冻结以下 envelope：

- Task Contract；
- Worktree Binding；
- Artifact Ref；
- Verification Profile；
- Verification Request / Review Result；
- Evidence Package；
- Embedded Verification Record；
- Loop State；
- Reflection Record；
- Convergence Report；
- Skill Improvement Proposal；
- Orchestration Ledger。

JSON 原始输入拒绝重复 key；摘要移除自身 digest 字段后计算 canonical JSON + SHA-256。Task Contract
冻结参与决策的 Skill version/content digest；运行中摘要漂移触发 abort / re-contract。

## 5. 安全与恢复不变量

- 状态默认写业务仓库外；祖先 symlink 指回仓库也会被识别。
- 所有状态写有 lock/revision；并发同 revision 至多一个成功。
- event journal 是恢复真源；snapshot 缺失、落后或尾部半条 event 可恢复。
- Evidence run ID 在 Loop state root 全局防重放。
- Evidence、Embedded Record、Reflection、Report、Proposal 和 attachment 使用 write-new / 内容摘要。
- L0 只接受 argv 数组、冻结绝对 executable、env allowlist、timeout 和日志大小上限。
- 日志和学习文本写盘前脱敏；不保存 chain-of-thought。
- safety、H gate、fuse、protected verifier path 不能被 implementer 降级。
- operational abort 与 Artifact verdict 分离，不把环境/工具失败算成代码 fail。
- Proposal 永远是 `lifecycle: proposed`，执行 Skill 没有 accepted/released 权限。

威胁模型以“诚实 runtime + 受信 controller/operator + 受限 state-root writer”为边界。journal digest
chain 能发现部分、追加、乱序与意外损坏，但不是签名或外部审计锚；可重写整个 state root 的 writer
能制造另一条自洽历史。nonce 只阻止未经修改的跨 run 重放，`host_reported` assurance 是调用方声明。
state-root identity 只拒绝未修改的复制/移动；`adopt-root` 是 operator 对既有完整历史的显式重新授权。
当前 run 内 safety 优先级是机械不变量；同一 Artifact 跨新 run 的安全记忆由上层台账/维护流程负责。

## 6. 反思和沉淀的边界

Reflection 只在 repeated failure、undecidable、用户纠正、runtime abort、workaround、协议冲突、意外
结果或 terminal retrospective 等事件触发。每个证据引用必须能重算摘要；没有证据只能是 low
confidence。普通成功步骤不强制长反思。

Reflection/Proposal 不进入当前执行决策链，不能修改旧 Evidence、verdict、fuse、H gate、合同或
Skill。Loop 在 completed/stopped 时自动生成不可变 Convergence Report，但报告不证明外部 Goal
完成。未来的 evaluated/accepted/released 属于独立维护流程，未纳入 v1。

## 7. 验收证据

最终本地回归：

- Node：147 tests，147 pass；
- Python：26 tests，26 pass；
- `quick_validate.py`：四个 Skill 全部通过；
- 独立安装：4/4 通过；
- 任意非空安装组合：15/15 通过；
- 公共 schema required compatibility：通过；
- 敏感信息与 sibling runtime import 扫描：零 finding。

覆盖的故障包括：duplicate JSON key、unpaired surrogate、revision conflict、并发写、stale/malformed
lock、snapshot 丢失、journal 截断、write-new 后 event 丢失、Skill drift、Evidence replay、Artifact
漂移、protected path、executable 消失、workdir 变脏、Reflection/Proposal 篡改和 batch fuse。

## 8. 当前安装与发布状态

四个 Skill 已在本机共享池使用指向本仓源码的软链；既有宿主映射也已补齐新 verifier。已运行的
宿主可能缓存 Skill 清单，验证触发效果时应新建任务或重启宿主。

本分支尚未 push、merge 或同步实现到公开分发仓。这是有意的发布门：先完成本次总评审，接受后
再进入权威分支并执行单向白名单同步、公开仓测试、敏感扫描和发布提交。公开仓中只有已评审的架构
提案提交，不代表四个 runtime 已发布。

## 9. 建议 reviewer 重点证伪

1. 四个 Skill 的触发边界是否仍有重叠，特别是 one-shot verifier 与 Loop、orchestrator 与 Loop。
2. Task Contract / Profile / Artifact / Evidence binding 是否存在可绕过或未冻结字段。
3. terminal、abort、H gate、batch fuse 的状态转换是否存在恢复后语义变化。
4. standalone 模式是否意外依赖 sibling 目录，或 embedded record 是否能被误认成 Evidence。
5. Reflection/Proposal 是否可能反向改变当前 verdict、泄漏隐私或绕过维护者晋升门。
6. Worktree owner epoch、repository identity 与 live HEAD 校验是否足以防 stale Artifact。
7. orchestration ledger 是否会把 worker 自述、无稳定产物或未满足 barrier 的节点误标为通过。
8. schema 的 strictness 是否应在 v1 收紧；当前部分跨 Skill schema 保留扩展空间，runtime 校验更严格。
9. runtime 代码可维护性，特别是 ledger 的紧凑实现，是否需要在不改变行为的前提下拆分模块。
10. 是否接受“评审通过后才同步公开分发”的发布顺序。

## 10. 总评审整改增量（待复审）

上一轮总评审给出“实现 reject”，指出四个 blocker 与一组 major。本分支在原 Phase 1a 提交之上
完成了以下整改；本节是增量 review 入口，不能替代 reviewer 对实际 diff 和攻击路径的核验。

### 10.1 四个 blocker

1. Verification 非 pass 终态不再把缺失 stage 回填成 `undefined`；smoke fail、L1 fail、
   undecidable、blocked_safety 均生成结构完整且可 validate 的 Evidence。
2. Loop abort 后 resume 会解除旧 report 绑定；Convergence Report 改为 report-ID 文件名，保留旧
   stopped 报告并为恢复后的 completed 终态生成新报告。
3. `manage-worktrees` Artifact 必须包含 `worktree_id + ownership_epoch`；缺字段、epoch stale、live
   HEAD drift、dirty worktree 与 worktree 不存在全部 fail closed。
4. ledger 的 worktree attachment 不再算稳定产物；只有 artifact/evidence/loop/report 能让实现节点
   `passed`，barrier 因而不会被 worktree 占位绕过。

### 10.2 信任与恢复边界

- Review Result 新增 runtime 生成的 `challenge_nonce`，绑定当前 run/iteration 并拒绝重放；
  verifier/reviewer run ID 不能与被验对象相同，isolation assurance 必须与 init 冻结值一致；nonce 只
  阻止未经修改的跨 run 重放，assurance 仍是 caller-reported，不是宿主隔离证明。
- verifier、Loop、ledger 的 event journal 增加连续 revision、`previous_event_digest` 与
  `event_digest` 校验；错误链接的部分/追加/乱序写入不能通过 validate/doctor。digest chain 无外部锚，
  不对能重写整条链的 state-root writer 提供签名级保证。
- executable 与所有实际存在的 argv 文件在 init 时冻结参数路径、realpath、size、mode 与内容 digest，
  每次执行前重验；workdir 内文件还继续由 clean pinned Git Artifact 门覆盖，包括 gitignored runner。
- orphan Evidence 只能与 runtime 将要写入的完整确定性 envelope 字节等价；validate 还会重验
  terminal snapshot、stage 与 binding，不再接受调用方自造的自洽包。
- Loop state root 写入与 canonical path 绑定的身份文件；未修改复制到新位置会被拒绝；operator 可用
  `adopt-root` 显式检查并重新授权既有完整历史。该绑定不对拥有 state-root 写权限者提供防复制证明。
- lock owner record 先在同目录完整落盘并 fsync，再以原子 hard-link 发布；死 PID 的旧锁可回收，
  malformed lock fail closed，释放前必须匹配 pid + token，旧 owner 不会删除后来者的锁。

### 10.3 契约、安全与 CLI

- 三个 runtime 的 CLI 改为逐命令 whitelist；未知 flag、缺值、boolean 带值均拒绝；ledger rebuild
  也遵守 expected revision。
- Profile 的 L0/L1 必须非空且覆盖 smoke/final，`human_gate` 使用显式 enum；Review finding 和
  forensics 只接受非空字符串。
- embedded outcome 的顺序改为 safety > undecidable > fail > pass；无失败 check/finding 的 fail
  Evidence 被判为无效，不能产生空 failure signature 绕过 fuse。
- Task Contract 的 scope/permissions/environment/stop conditions/extensions 被实际校验；review view
  同时保留原 contract permissions 与独立 reviewer read-only permissions，不再覆盖事实。
- ledger node role/permissions/writable paths 受合同上界约束，read-only 合同不能派生 write node；
  dispatch identity/model/effort 必须为非空单行字符串。

### 10.4 schema 与实现一致性

- Verification Profile 与 Review Result 已接入仓内自包含的 JSON Schema 校验器，同时保留更强的
  语义校验；两个 Skill 的对应 schema 有完整兼容测试。
- Reflection/Proposal schema 在四个 Skill 中 byte-identical；verifier 与 Loop 的独立
  `reflection-support.mjs` 也 byte-identical，standalone 安装仍不依赖 sibling。
- worktree canonical key 排序改为 Unicode code-unit 顺序，并加入含非 ASCII key 的跨 runtime
  digest 回归。
- Artifact schema 同步了 manage-worktrees provider 对 worktree ID/epoch 的条件要求。

### 10.5 新增攻击型回归

本轮新增/加强了以下负向用例：四类非 pass Evidence、abort→resume→pass 报告、Artifact 字段删除/
漂移/脏树、worktree attachment 绕过、CLI typo、Review replay、伪造 journal、空 Profile、非法
H gate、非字符串 finding、undecidable+L0 fail、无依据 fail Evidence、复制 state root、节点越权、
rebuild revision、executable 替换/消失与跨 runtime canonical JSON。

请 reviewer 优先重新攻击上述路径，并特别检查：nonce 是否足以代表宿主隔离、state-root path binding
是否符合可移植性预期、轻量 schema validator 的支持子集是否覆盖已发布 v1 schema，以及 journal
hash chain 对本地有写权限攻击者的保证是否被正确表述为“可检测篡改”而非密码学签名。

### 10.6 本轮增量重审后的收口

- 锁不再使用时间 grace；完整 owner record 原子发布，释放校验 pid + token，并保留死 PID 主锁及
  orphan `.reclaim` 子锁恢复；live/malformed reclaim 继续 fail closed。
- L0 冻结所有实际存在的 argv 文件本体和参数路径，覆盖 workdir 内 gitignored runner。
- verifier、Loop、ledger 的 `capabilities --json` 恢复统一能力发现兼容。
- Loop 增加显式 `adopt-root --state-root <dir>`；doctor 在身份缺失/路径不匹配时给出诊断而非自身失败。
- §5 与架构 §9.7 明确 digest chain、nonce、state-root identity、safety 持久性的真实威胁边界。
