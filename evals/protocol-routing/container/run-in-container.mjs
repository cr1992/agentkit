#!/usr/bin/env node
// @ts-check
// 在一次性容器里跑协议路由评测。
//
//   # 容器自检：零模型费用、不起任何会话，只证明镜像 / 挂载 / 权限 / 非 root / skill 安装可用
//   node evals/protocol-routing/container/run-in-container.mjs --selftest --out /tmp/pr-selftest
//
//   # 冒烟（1 条用例 × 1 次）
//   node evals/protocol-routing/container/run-in-container.mjs \
//     --out /tmp/pr-smoke --model <模型 ID> --cases 1 --runs 1
//
//   # 全量（11 条 × 3 次）
//   node evals/protocol-routing/container/run-in-container.mjs \
//     --out /tmp/pr-eval --model <模型 ID> --runs 3
//
// 认证只经环境变量传入，二选一（都空则拒绝启动）：
//   CLAUDE_CODE_OAUTH_TOKEN  ← `claude setup-token`（需要 Claude 订阅），本机推荐这条
//   ANTHROPIC_API_KEY        ← 控制台 API key，CI 走这条
// `-e KEY`（不带取值）让容器引擎从调用者环境继承，token 因此不进命令行、不进日志、不落盘。
//
// 安全面（为什么这些不是可选项，见 README「本机容器运行（订阅 token）」）：
// - 仓库只读挂载到 /src，容器内先拷到 /work/repo 再跑；唯一可写的宿主目录是 --out；
// - 不挂宿主 HOME、不挂 docker.sock、不加 --privileged、不用 --network host；
// - --cap-drop ALL、--security-opt no-new-privileges、--pids-limit、--memory；
// - 容器以镜像自带的非 root 用户跑（bypassPermissions 在 uid 0 下会被宿主 CLI 直接拒绝）。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** evals/protocol-routing/container → 仓库根 */
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const DOCKERFILE = resolve(HERE, 'Dockerfile');
/** 构建上下文就是本目录：Dockerfile 不 COPY 仓库任何文件，上下文因此极小。 */
export const BUILD_CONTEXT = HERE;

export const DEFAULT_IMAGE = 'agentkit-protocol-routing-eval:latest';
export const DEFAULT_ENGINE = 'docker';
export const ENGINES = Object.freeze(['docker', 'podman']);
export const DEFAULT_MEMORY = '4g';
export const DEFAULT_PIDS_LIMIT = '512';

/** 认证变量，二选一；顺序即优先展示顺序。 */
export const AUTH_ENV_KEYS = Object.freeze(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);

export const MISSING_AUTH_MESSAGE = [
  '拒绝启动：容器里没有任何可用的认证材料。',
  '',
  'CLAUDE_CODE_OAUTH_TOKEN 与 ANTHROPIC_API_KEY 至少要有一个非空，两者都空就不跑。',
  '',
  '用 Claude 订阅额度跑（本机推荐）：在**你自己的终端**里执行',
  '    claude setup-token          # 需要 Claude 订阅，会走一次浏览器授权',
  '    export CLAUDE_CODE_OAUTH_TOKEN=<它打印出来的 token>',
  '把 token 贴给任何 agent 都等于交出订阅额度——它只该出现在你自己的 shell 里。',
  '用完可以在 claude.ai 的设置里把这个 token 吊销。',
  '',
  '用 API key 跑：export ANTHROPIC_API_KEY=<控制台 key>（按 token 计费，与订阅额度无关）。',
].join('\n');

/** 本脚本自己吃掉的选项；其余一律原样透传给 run.mjs。 */
const RUNNER_VALUE_OPTIONS = new Set(['engine', 'image', 'claude-version', 'out', 'repo', 'memory', 'pids-limit']);
const RUNNER_FLAGS = new Set(['selftest', 'no-build']);

/**
 * 切分参数：本脚本的选项 vs 透传给 run.mjs 的选项。
 * `--` 之后的一切无条件透传。
 * @param {string[]} argv
 * @returns {{ options: Record<string, string | boolean>, passthrough: string[] }}
 */
export function parseRunnerArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const options = {
    engine: DEFAULT_ENGINE,
    image: DEFAULT_IMAGE,
    'claude-version': 'latest',
    out: '',
    repo: REPO_ROOT,
    memory: DEFAULT_MEMORY,
    'pids-limit': DEFAULT_PIDS_LIMIT,
    selftest: false,
    'no-build': false,
  };
  /** @type {string[]} */
  const passthrough = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') { passthrough.push(...argv.slice(i + 1)); break; }
    if (!token.startsWith('--')) { passthrough.push(token); continue; }
    const key = token.slice(2);
    if (RUNNER_FLAGS.has(key)) { options[key] = true; continue; }
    if (RUNNER_VALUE_OPTIONS.has(key)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 需要取值`);
      options[key] = value;
      i += 1;
      continue;
    }
    // 不认识的一律透传：run.mjs 会对真正的笔误报「未知选项」，这里不重复一份选项表。
    passthrough.push(token);
    const value = argv[i + 1];
    if (value !== undefined && !value.startsWith('--')) { passthrough.push(value); i += 1; }
  }
  if (!ENGINES.includes(String(options.engine))) throw new Error(`--engine 只能是 ${ENGINES.join(' / ')}，收到 ${options.engine}`);
  if (!options.out) throw new Error('--out <宿主结果目录> 必填：它是唯一以读写方式挂进容器的宿主目录');
  return { options, passthrough };
}

/**
 * 挑出环境里非空的认证变量键。两者都空就拒绝——不能让评测在「没认证」上白烧半小时。
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function resolveAuthEnvKeys(env) {
  const keys = AUTH_ENV_KEYS.filter((key) => typeof env[key] === 'string' && env[key] !== '');
  if (!keys.length) throw new Error(MISSING_AUTH_MESSAGE);
  return keys;
}

/**
 * 构建镜像的 argv。
 * @param {{ engine?: string, image?: string, claudeVersion?: string, dockerfile?: string, context?: string }} [options]
 */
export function buildImageArgs(options = {}) {
  const { image = DEFAULT_IMAGE, claudeVersion = 'latest', dockerfile = DOCKERFILE, context = BUILD_CONTEXT } = options;
  return ['build', '-f', dockerfile, '--build-arg', `CLAUDE_CODE_VERSION=${claudeVersion}`, '-t', image, context];
}

/**
 * 起容器的 argv。**这是本文件最该被断言钉住的一段**：安全面全在这里。
 * token 只以 `-e KEY`（不带取值）出现，取值由引擎从调用者环境继承。
 *
 * @param {{
 *   image?: string, repoDir: string, outDir: string,
 *   memory?: string, pidsLimit?: string,
 *   authEnvKeys?: readonly string[], script: string,
 * }} options
 * @returns {string[]}
 */
export function buildRunArgs({ image = DEFAULT_IMAGE, repoDir, outDir, memory = DEFAULT_MEMORY, pidsLimit = DEFAULT_PIDS_LIMIT, authEnvKeys = [], script }) {
  if (!repoDir) throw new Error('buildRunArgs 需要 repoDir');
  if (!outDir) throw new Error('buildRunArgs 需要 outDir');
  if (!script) throw new Error('buildRunArgs 需要 script');
  const args = [
    'run', '--rm',
    // 容器进程不需要任何 Linux capability；也不允许通过 setuid 程序提权。
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    // 被测会话在 bypassPermissions 下能跑任意命令：给 fork 炸弹和内存吃尽一个上限。
    '--pids-limit', String(pidsLimit),
    '--memory', String(memory),
    // 仓库只读：会话改不到宿主的 checkout。容器内先拷到 /work/repo 再跑（见 script）。
    '-v', `${repoDir}:/src:ro`,
    // 唯一以读写方式挂进来的宿主目录。fixture 仓、state root、会话 HOME 全落在它下面。
    '-v', `${outDir}:/out`,
    '-w', '/work',
  ];
  // 不带取值：由引擎从调用者环境继承。token 因此不出现在 argv、ps 输出和留档里。
  for (const key of authEnvKeys) args.push('-e', key);
  args.push('--entrypoint', '/bin/bash', image, '-euo', 'pipefail', '-c', script);
  return args;
}

/** 把只读的 /src 拷进容器内可写目录。排除 .git / node_modules：harness 用不到，拷了只是慢。 */
const COPY_REPO = [
  'mkdir -p /work/repo',
  'tar -C /src -cf - --exclude=./.git --exclude=./node_modules . | tar -C /work/repo -xf -',
  'cd /work/repo',
].join('\n');

/** 容器内先自报身份：结果里「以非 root 运行」这条证据就是它。 */
const IDENTITY = [
  'echo "== 容器身份 =="',
  'id',
  'echo "HOME=$HOME"',
  'node --version',
  'git --version',
  'claude --version',
].join('\n');

/** /src 必须是只读挂载——写得进去就说明命令行拼错了，当场失败而不是跑完再说。 */
const ASSERT_READONLY_SRC = [
  'echo "== /src 必须是只读挂载 =="',
  'if touch /src/.protocol-routing-ro-probe 2>/dev/null; then rm -f /src/.protocol-routing-ro-probe; echo "FAIL: /src 可写，仓库没有以 :ro 挂载"; exit 1; fi',
  'echo "OK: /src 只读"',
].join('\n');

/**
 * 真实评测的容器内脚本。
 * @param {string[]} passthrough 透传给 run.mjs 的参数（--model / --cases / --runs / --budget-usd …）
 */
export function buildEvalScript(passthrough = []) {
  // 这三个由运行器自己定死：--driver / --out 再传一遍会让 run.mjs 取到后一个，
  // 评测结果会安静地写到别处或换成回放驱动器。宁可当场报错。
  for (const reserved of ['--driver', '--out']) {
    if (passthrough.includes(reserved)) throw new Error(`${reserved} 由容器运行器固定，不能透传（结果目录用运行器的 --out）`);
  }
  const forwarded = passthrough.map(shellQuote).join(' ');
  return [
    IDENTITY,
    ASSERT_READONLY_SRC,
    'echo "== 拷贝仓库到容器内可写目录 =="',
    COPY_REPO,
    'echo "== 跑评测 =="',
    // --allow-bypass-permissions 由本脚本无条件补上：容器就是它要求的那个一次性环境。
    `exec node evals/protocol-routing/run.mjs --driver claude-headless --allow-bypass-permissions --out /out${forwarded ? ` ${forwarded}` : ''}`,
  ].join('\n');
}

/** 不需要模型的容器自检：镜像、挂载、权限、非 root、skill 安装、回放基线全过一遍。 */
export function buildSelftestScript() {
  return [
    IDENTITY,
    ASSERT_READONLY_SRC,
    'echo "== 结果目录必须可写（非 root 写宿主挂载） =="',
    'mkdir -p /out/selftest && touch /out/selftest/.writable && rm -f /out/selftest/.writable',
    'echo "OK: /out 可写"',
    'echo "== 拷贝仓库到容器内可写目录 =="',
    COPY_REPO,
    'echo "== 仓内自测（node --test） =="',
    'node --test evals/protocol-routing/tests/*.test.mjs',
    'echo "== 回放驱动器平凡基线（零模型费用） =="',
    'node evals/protocol-routing/run.mjs --driver replay --replay evals/protocol-routing/fixtures/replay/always-none --runs 3 --out /out/selftest/replay-none --quiet',
    'node evals/protocol-routing/run.mjs --driver replay --replay evals/protocol-routing/fixtures/replay/always-write --runs 3 --out /out/selftest/replay-write --quiet',
    // 正向 6 条、禁止 5 条（第 7 条已从正向改成禁止），n=3。数字由回放实跑得出，
    // README、tests/baseline.test.mjs 与这里三处必须一致。
    'grep -qF "| 永远 NONE | 0/18 | 15/15 |" /out/selftest/replay-none/report.md',
    'grep -qF "| 正向 | 0/18 |" /out/selftest/replay-none/report.md',
    'grep -qF "| 禁止 | 15/15 |" /out/selftest/replay-none/report.md',
    'grep -qF "| 正向 | 6/18 |" /out/selftest/replay-write/report.md',
    'grep -qF "| 禁止 | 6/15 |" /out/selftest/replay-write/report.md',
    'echo "OK: 回放基线与 README 记载一致"',
    'echo "== 会话环境里 agentkit 可解析且版本正确 =="',
    'node evals/protocol-routing/container/selftest-agentkit-shim.mjs',
    'echo "== skill 安装（容器内、隔离配置目录） =="',
    'node evals/protocol-routing/container/selftest-skill-install.mjs',
    `echo "SELFTEST OK uid=$(id -u) user=$(id -un)"`,
  ].join('\n');
}

/** 极简 POSIX shell 单引号转义：只用于把透传参数塞进容器内脚本。 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

/** @param {string} engine @param {string[]} args @param {{ capture?: boolean }} [options] */
function runEngine(engine, args, options = {}) {
  const result = spawnSync(engine, args, {
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    // 原样把调用者环境交给引擎客户端：`-e KEY` 靠它继承 token 取值。
    env: process.env,
  });
  if (result.error) throw new Error(`无法执行容器引擎「${engine}」：${result.error.message}`);
  return result;
}

/** 镜像的 Id / RepoDigests：写进结果，和宿主版本、模型 ID、skill digest 并列。 */
function inspectImage(engine, image) {
  const result = runEngine(engine, ['image', 'inspect', image, '--format', '{{.Id}}\t{{json .RepoDigests}}'], { capture: true });
  if (result.status !== 0) return { image_id: null, repo_digests: [] };
  const [id, digests] = String(result.stdout).trim().split('\t');
  let parsed = [];
  try { parsed = JSON.parse(digests ?? '[]') ?? []; } catch { parsed = []; }
  return { image_id: id || null, repo_digests: parsed };
}

/**
 * 镜像里实际装到的 claude CLI 版本（构建时写进镜像的那份）。
 * 这次 run 只 cat 一个文件：不挂任何宿主目录、不传任何环境变量、连网都断掉。
 */
function imageClaudeVersion(engine, image) {
  const args = ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--entrypoint', '/bin/bash', image, '-lc', 'cat /home/node/claude-code-version.txt'];
  const result = runEngine(engine, args, { capture: true });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

/** @param {string[]} argv */
export async function main(argv) {
  const { options, passthrough } = parseRunnerArgs(argv);
  const engine = String(options.engine);
  const image = String(options.image);
  const outDir = resolve(String(options.out));
  const repoDir = resolve(String(options.repo));
  if (!existsSync(resolve(repoDir, 'evals', 'protocol-routing', 'run.mjs'))) {
    throw new Error(`--repo ${repoDir} 看起来不是 agentkit 仓库根（找不到 evals/protocol-routing/run.mjs）`);
  }
  const selftest = options.selftest === true;
  // 自检不发起任何模型会话，因此不要求认证；真实评测两者都空就当场拒绝。
  const authEnvKeys = selftest ? [] : resolveAuthEnvKeys(process.env);

  mkdirSync(outDir, { recursive: true });

  if (options['no-build'] !== true) {
    process.stderr.write(`[容器] 构建镜像 ${image}（引擎 ${engine}，claude-code@${options['claude-version']}）\n`);
    const build = runEngine(engine, buildImageArgs({ image, claudeVersion: String(options['claude-version']) }));
    if (build.status !== 0) throw new Error(`镜像构建失败（退出码 ${build.status}）`);
  }

  const inspected = inspectImage(engine, image);
  const claudeVersion = imageClaudeVersion(engine, image);
  const engineVersion = runEngine(engine, ['--version'], { capture: true });

  const script = selftest ? buildSelftestScript() : buildEvalScript(passthrough);
  const runArgs = buildRunArgs({ image, repoDir, outDir, memory: String(options.memory), pidsLimit: String(options['pids-limit']), authEnvKeys, script });

  // 留档：引擎、镜像、CLI 版本进结果，和 report.json 里的宿主版本 / 模型 ID / skill digest 并列。
  // 只记认证变量的**键名**，不记取值——取值从来没有进过 argv。
  const record = {
    schema_version: 1,
    recorded_at: new Date().toISOString(),
    mode: selftest ? 'selftest' : 'eval',
    engine,
    engine_version: engineVersion.status === 0 ? String(engineVersion.stdout).trim() : null,
    image,
    image_id: inspected.image_id,
    image_repo_digests: inspected.repo_digests,
    claude_code_version: claudeVersion,
    claude_code_version_requested: options['claude-version'],
    repo_dir: repoDir,
    out_dir: outDir,
    auth_env_keys: authEnvKeys,
    run_args: runArgs,
    passthrough,
  };
  writeFileSync(resolve(outDir, 'container.json'), `${JSON.stringify(record, null, 2)}\n`);
  process.stderr.write(`[容器] 镜像 ${image} id=${inspected.image_id ?? '未知'} claude=${claudeVersion ?? '未知'}\n`);
  process.stderr.write(`[容器] 认证变量（只传键名，取值由引擎继承）：${authEnvKeys.length ? authEnvKeys.join(', ') : '（自检模式，不需要）'}\n`);

  const run = runEngine(engine, runArgs);
  return run.status === null ? 2 : run.status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
}
