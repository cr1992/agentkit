#!/usr/bin/env bash
# 容器运行器的 shell 入口。真正的逻辑在同目录的 run-in-container.mjs：
# 拼容器命令行的那几个函数是纯函数，`npm test` 里有断言钉着安全面（:ro、--cap-drop、
# no-new-privileges、不含 token 取值、不含 docker.sock、不含 --privileged）。
#
#   ./run-in-container.sh --selftest --out /tmp/pr-selftest
#   ./run-in-container.sh --out /tmp/pr-smoke --model <模型 ID> --cases 1 --runs 1
#   ./run-in-container.sh --out /tmp/pr-eval  --model <模型 ID> --runs 3
#
# 认证只经环境变量传入（CLAUDE_CODE_OAUTH_TOKEN 或 ANTHROPIC_API_KEY），
# 在**你自己的终端**里 export，不要贴给任何 agent。
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec node "${here}/run-in-container.mjs" "$@"
