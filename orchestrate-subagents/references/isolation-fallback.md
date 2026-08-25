# 无 manage-worktrees 时的隔离下限

仅在已经裁决需要 worktree、但 `manage-worktrees` 不可用时读取。专项 Skill 可用时服从其 runtime，
不要同时执行本 fallback。

1. **建树**：controller 按项目规则刷新 base，在仓库外的 durable 临时位置创建独立分支与 worktree。
   已有目录或分支先判定归属并复用；禁止 `rm -rf` 重建，宿主临时树语义不明时不用。
2. **worker 边界**：合同固定 repository、workdir、branch 与 writable paths；worker 不换目录，不执行
   merge、stash、push 或创建 MR，环境异常立即报告 `blocked`。
3. **共享资源**：worktree 只隔离 working directory 和 index，不隔离 refs、端口、进程、数据库或
   外部服务；实际使用的共享资源必须分配 owner 并登记。
4. **验收集成**：controller 在 worker 树内重跑门禁，再在已确认目标分支的集成树中串行合回并重验；
   重验 diff 使用 base 到 HEAD 的范围，不能依赖 merge 后为空的 staged diff。merge clean 不代表语义兼容。
5. **保守回收**：任务、路径、分支和 owner 可对账，树与 untracked 均 clean，成果已验收合入，仓库无
   stash，四项全部满足才运行不带 `--force` 的 `git worktree remove`；否则 `KEEP + 原因`。

共享树写入时 controller 是唯一 integrator。worker 只能按归属 pathspec stage/commit，禁止切分支、
`git add -A`、`git commit -am`、裸 stash、`reset --hard`、`checkout -- .` 和并发 merge。
