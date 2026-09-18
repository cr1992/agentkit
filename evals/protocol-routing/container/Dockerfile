# 协议路由评测的一次性运行环境。
#
# 为什么要容器：无头驱动器必须用 `--permission-mode bypassPermissions`（换更弱的模式会让
# WRITE 判据静默失真，见 README「会话怎么起」）。该模式下被测会话不经确认就能执行任意命令，
# 对所在机器的整个文件系统有写权限。容器是这个「一次性环境」——被测会话能碰到的只有容器
# 文件系统：仓库以只读挂载进来，唯一可写的宿主目录是结果目录。
#
# ⚠️ 必须以非 root 运行。宿主 CLI 自己钉着这条（claude 2.1.251 实测）：
#     if (permissionMode === "bypassPermissions" || ...) {
#       if (process.getuid() === 0 && process.env.IS_SANDBOX !== "1" && !CLAUDE_CODE_BUBBLEWRAP)
#         console.error("--dangerously-skip-permissions cannot be used with root/sudo privileges
#                        for security reasons"), process.exit(1)
#     }
# 即 uid 0 下 bypassPermissions 直接 exit(1)。逃生阀 `IS_SANDBOX=1` 存在但没有文档背书，
# 这里不用它，改成老老实实以镜像自带的非 root 用户 `node`（uid 1000）跑。
#
# 构建上下文就是本目录：Dockerfile 不 COPY 仓库任何文件，仓库在运行时以 `-v <repo>:/src:ro`
# 挂进来。所以不需要 .dockerignore，构建上下文也不会把 .git 塞给 daemon。

FROM node:22-slim

# 钉版本用：默认 latest；要复现某次评测就传 --build-arg CLAUDE_CODE_VERSION=<版本>。
ARG CLAUDE_CODE_VERSION=latest

# git 是 harness 的硬依赖：fixture 仓与 WRITE 判据（`git status --porcelain` + HEAD）都靠它。
# tar 用于把只读的 /src 拷进可写目录；ca-certificates 用于出网。
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tar \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# /work 是容器内的可写工作区：只读的 /src 会被拷到 /work/repo 再跑。
# 必须在切到非 root 之前建好并交给 node，否则 uid 1000 在 root 拥有的 / 下建不出来。
RUN mkdir -p /work && chown node:node /work

# 非 root：之后的每一层、以及容器默认进程都以 uid 1000 跑。
USER node
ENV HOME=/home/node

# 把实际装到的版本打印出来（进构建日志）并留一份在镜像里，供结果记录与复现比对。
# 这一步顺便完成 CLI 的首次运行初始化，且落在 /home/node 而不是 root 的家目录。
RUN claude --version | tee /home/node/claude-code-version.txt \
 && node --version \
 && git --version \
 && echo "运行用户 uid=$(id -u) gid=$(id -g) user=$(id -un)"

WORKDIR /work

CMD ["bash", "-lc", "cat /home/node/claude-code-version.txt && id"]
