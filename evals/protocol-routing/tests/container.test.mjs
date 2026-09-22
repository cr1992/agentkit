// @ts-check
// 容器运行器与脱敏兜底的自测。**全程不需要 docker / podman**：
// 「拼容器命令行」被抽成纯函数，这里只断言拼出来的那条命令行。
//
// 为什么这些断言值得单独钉：容器是 `bypassPermissions` 唯一的风险兜底。
// 少一个 `:ro`、多一个 `--privileged`、把 token 写进 argv，容器就不再是一次性环境，
// 而这三种错误在真实评测里都不会报错——它们只会安静地扩大爆炸半径。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  AUTH_ENV_KEYS,
  DEFAULT_IMAGE,
  ENGINES,
  MISSING_AUTH_MESSAGE,
  buildEvalScript,
  buildImageArgs,
  buildRunArgs,
  buildSelftestScript,
  buildShardJobs,
  parseRunnerArgs,
  resolveAuthEnvKeys,
  shellQuote,
} from '../container/run-in-container.mjs';
import { MIN_SECRET_LENGTH, SECRET_ENV_KEYS, redactSecrets, secretValues } from '../lib/redact.mjs';
import { INHERITED_ENV_KEYS, buildSessionEnv } from '../lib/session-env.mjs';
import { main } from '../run.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_TOKEN = 'sk-ant-oat01-FAKE-TOKEN-FOR-REDACTION-TEST-0123456789';
const FAKE_KEY = 'sk-ant-api03-FAKE-KEY-FOR-REDACTION-TEST-9876543210';

/** 一条典型的真实评测命令行。 */
function typicalRunArgs(overrides = {}) {
  return buildRunArgs({
    repoDir: '/host/agentkit',
    outDir: '/host/out',
    authEnvKeys: ['CLAUDE_CODE_OAUTH_TOKEN'],
    script: buildEvalScript(['--model', 'some-model-id', '--cases', '1', '--runs', '1']),
    ...overrides,
  });
}

test('容器命令行：仓库只读挂载，唯一可写的宿主目录是 --out', () => {
  const args = typicalRunArgs();
  assert.ok(args.includes('/host/agentkit:/src:ro'), '仓库必须以 :ro 挂载');
  assert.ok(args.includes('/host/out:/out'), '结果目录以读写挂载');
  // 除了这两处 -v，不该再挂任何宿主路径。
  const mounts = args.filter((_, index) => args[index - 1] === '-v');
  assert.deepEqual(mounts, ['/host/agentkit:/src:ro', '/host/out:/out']);
});

test('容器命令行：降权与资源上限一个都不能少', () => {
  const args = typicalRunArgs();
  const joined = args.join(' ');
  assert.ok(joined.includes('--cap-drop ALL'), '必须 --cap-drop ALL');
  assert.ok(joined.includes('--security-opt no-new-privileges'), '必须禁止 setuid 提权');
  assert.ok(joined.includes('--pids-limit 512'), '必须给进程数上限');
  assert.ok(joined.includes('--memory 4g'), '必须给内存上限');
  assert.ok(args.includes('--rm'), '一次性容器：跑完即删');
});

test('容器命令行：不碰 docker.sock、不提权、不共享宿主网络与宿主 HOME', () => {
  const joined = typicalRunArgs().join(' ');
  assert.ok(!joined.includes('docker.sock'), '不得挂载 docker.sock——那等于把宿主的容器引擎交出去');
  assert.ok(!joined.includes('--privileged'), '不得 --privileged');
  assert.ok(!joined.includes('--network host'), '不得使用宿主网络');
  assert.ok(!joined.includes('--net=host'), '不得使用宿主网络');
  assert.ok(!joined.includes('--cap-add'), '不得加回任何 capability');
  assert.ok(!joined.includes('--security-opt seccomp=unconfined'), '不得关掉 seccomp');
  assert.ok(!/(^|\s)-v\s+[^\s]*\$HOME/u.test(joined), '不得挂载宿主 HOME');
  assert.ok(
    !/(^|\s)-v\s+\/(?:Users|home|root)\/[^\s]*:\/(?:root|home)/u.test(joined),
    '不得把宿主家目录挂进容器家目录',
  );
});

test('容器命令行：token 只以键名出现，取值绝不进 argv', () => {
  const args = buildRunArgs({
    repoDir: '/host/agentkit',
    outDir: '/host/out',
    authEnvKeys: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    script: buildEvalScript(['--model', 'm']),
  });
  // `-e KEY`（不带 `=值`）：由引擎从调用者环境继承。
  assert.ok(args.includes('-e'), '认证变量以 -e 传入');
  assert.ok(args.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.ok(args.includes('ANTHROPIC_API_KEY'));
  const joined = args.join(' ');
  assert.ok(!joined.includes('CLAUDE_CODE_OAUTH_TOKEN='), '不得写成 -e KEY=值');
  assert.ok(!joined.includes('ANTHROPIC_API_KEY='), '不得写成 -e KEY=值');
  assert.ok(!joined.includes(FAKE_TOKEN));
  assert.ok(!joined.includes(FAKE_KEY));
});

test('容器内脚本：以 run.mjs + claude-headless + --allow-bypass-permissions 起评测，结果写 /out', () => {
  const script = buildEvalScript(['--model', 'some-model-id', '--cases', '7,8', '--runs', '10']);
  assert.match(
    script,
    /node evals\/protocol-routing\/run\.mjs --driver claude-headless --allow-bypass-permissions --out \/out/u,
  );
  assert.match(script, /'--model' 'some-model-id'/u);
  assert.match(script, /'--cases' '7,8'/u);
  assert.match(script, /'--runs' '10'/u);
  // 只读挂载是前提，脚本自己先验一遍再跑。
  assert.match(script, /\/src\/\.protocol-routing-ro-probe/u);
  // 只读的 /src 先拷进容器内可写目录，harness 的 fixture 仓与 state root 因此都落在容器里。
  assert.match(script, /tar -C \/src -cf - .*\| tar -C \/work\/repo -xf -/u);
  assert.match(script, /cd \/work\/repo/u);
  // --driver / --out 由运行器定死：再透传一遍会让 run.mjs 取到后一个，结果安静地写去别处。
  assert.throws(() => buildEvalScript(['--out', '/elsewhere']), /--out 由容器运行器固定/u);
  assert.throws(() => buildEvalScript(['--driver', 'replay']), /--driver 由容器运行器固定/u);
});

test('容器自检脚本：不含任何真实会话，只跑回放与仓内自测', () => {
  const script = buildSelftestScript();
  assert.match(script, /node --test evals\/protocol-routing\/tests\/\*\.test\.mjs/u);
  assert.match(script, /--driver replay/u);
  assert.match(script, /selftest-skill-install\.mjs/u);
  // 会话环境里 PATH 上有没有 agentkit 是 issue #15 缺陷 1 的容器侧闸门：
  // 镜像里故意不做全局安装，垫片必须由驱动器建，且在容器里也成立。
  assert.match(script, /selftest-agentkit-shim\.mjs/u);
  assert.match(script, /id -u/u, '自检要留下「以非 root 运行」的证据');
  assert.ok(!script.includes('claude-headless'), '自检不得起真实会话');
  assert.ok(!script.includes('--allow-bypass-permissions'), '自检不得开 bypassPermissions');
});

test('容器自检脚本里的平凡基线数字与用例表一致（正向 6 条、禁止 5 条）', async () => {
  const { CASES } = await import('../cases.mjs');
  const { trivialBaseline } = await import('../lib/report.mjs');
  const script = buildSelftestScript();
  const none = trivialBaseline(CASES, 'NONE', 3);
  const write = trivialBaseline(CASES, 'WRITE', 3);
  // 自检脚本里那几条 grep 是「README 记载的数字」的唯一机械闸门；
  // 它们和用例表必须由同一个函数算出来，不能各写各的。
  assert.ok(
    script.includes(`| 永远 NONE | ${none.positive.k}/${none.positive.n} | ${none.forbidden.k}/${none.forbidden.n} |`),
    script,
  );
  assert.ok(script.includes(`| 正向 | ${none.positive.k}/${none.positive.n} |`));
  assert.ok(script.includes(`| 禁止 | ${none.forbidden.k}/${none.forbidden.n} |`));
  assert.ok(script.includes(`| 正向 | ${write.positive.k}/${write.positive.n} |`));
  assert.ok(script.includes(`| 禁止 | ${write.forbidden.k}/${write.forbidden.n} |`));
});

test('构建镜像：上下文是 container/ 目录，版本可钉', () => {
  const args = buildImageArgs({ image: 'x:1', claudeVersion: '2.1.251' });
  assert.ok(args.includes('--build-arg'));
  assert.ok(args.includes('CLAUDE_CODE_VERSION=2.1.251'));
  assert.deepEqual([args[0], args[1]], ['build', '-f']);
  assert.equal(args.at(-1), resolve(ROOT, 'container'), '构建上下文只有 container/，不把整个仓库交给 daemon');
  assert.ok(buildImageArgs().includes('CLAUDE_CODE_VERSION=latest'), '默认 latest');
});

test('参数切分：本脚本吃掉自己的选项，其余原样透传给 run.mjs', () => {
  const { options, passthrough } = parseRunnerArgs([
    '--out',
    '/tmp/x',
    '--engine',
    'podman',
    '--model',
    'm',
    '--cases',
    '1',
    '--runs',
    '1',
  ]);
  assert.equal(options.out, '/tmp/x');
  assert.equal(options.engine, 'podman');
  assert.equal(options.image, DEFAULT_IMAGE);
  assert.deepEqual(passthrough, ['--model', 'm', '--cases', '1', '--runs', '1']);
  // `--` 之后的一切无条件透传，包括和本脚本同名的选项。
  assert.deepEqual(parseRunnerArgs(['--out', '/tmp/x', '--', '--image', 'z']).passthrough, ['--image', 'z']);
  assert.deepEqual(parseRunnerArgs(['--out', '/tmp/x', '--selftest']).options.selftest, true);
});

test('分片：每片一条命令行、一个独立结果目录，安全面逐片成立', () => {
  const jobs = buildShardJobs({
    shards: 3,
    selftest: false,
    passthrough: ['--model', 'm', '--runs', '3'],
    image: DEFAULT_IMAGE,
    repoDir: '/host/agentkit',
    outDir: '/host/out',
    options: { memory: '4g', 'pids-limit': '512' },
    authEnvKeys: ['CLAUDE_CODE_OAUTH_TOKEN'],
  });
  assert.deepEqual(
    jobs.map((job) => job.index),
    [1, 2, 3],
  );
  assert.deepEqual(
    jobs.map((job) => job.outDir),
    ['/host/out/shard-1', '/host/out/shard-2', '/host/out/shard-3'],
  );
  for (const job of jobs) {
    const joined = job.args.join(' ');
    // 每片各自挂自己的结果目录；仓库仍然只读，降权项一个都不少。
    assert.ok(job.args.includes(`${job.outDir}:/out`), '每片挂自己的结果目录');
    assert.ok(job.args.includes('/host/agentkit:/src:ro'));
    assert.ok(joined.includes('--cap-drop ALL') && joined.includes('--security-opt no-new-privileges'));
    assert.ok(joined.includes('--pids-limit 512') && joined.includes('--memory 4g'));
    assert.ok(!joined.includes('--privileged') && !joined.includes('docker.sock'));
    // 分片参数由运行器派；透传的原参数原样在。
    assert.ok(joined.includes(`'--shard' '${job.index}/3'`), joined);
    assert.ok(joined.includes(`'--model' 'm'`) && joined.includes(`'--runs' '3'`));
  }
  // 单片退化成原来那一条：结果直接写 --out，不加 --shard。
  const single = buildShardJobs({
    shards: 1,
    selftest: false,
    passthrough: ['--model', 'm'],
    image: DEFAULT_IMAGE,
    repoDir: '/host/agentkit',
    outDir: '/host/out',
    options: { memory: '4g', 'pids-limit': '512' },
    authEnvKeys: [],
  });
  assert.equal(single.length, 1);
  assert.equal(single[0].outDir, '/host/out');
  assert.ok(!single[0].args.join(' ').includes('--shard'));
});

test('分片参数校验：正整数，且不与手动透传的 --shard 叠用', () => {
  assert.equal(parseRunnerArgs(['--out', '/tmp/x']).options.shards, '1', '默认不分片');
  assert.equal(parseRunnerArgs(['--out', '/tmp/x', '--shards', '3']).options.shards, '3');
  assert.throws(() => parseRunnerArgs(['--out', '/tmp/x', '--shards', '0']), /--shards 必须是正整数/u);
  assert.throws(() => parseRunnerArgs(['--out', '/tmp/x', '--shards', 'x']), /--shards 必须是正整数/u);
  // 两层分片叠在一起没人看得懂：run.mjs 会取到后一个 --shard，结果安静地跑错。
  assert.throws(() => parseRunnerArgs(['--out', '/tmp/x', '--shards', '3', '--shard', '1/2']), /不能同时用/u);
  // 单片时手动 --shard 仍然透传得下去（给「只补跑某一片」留的口子）。
  assert.deepEqual(parseRunnerArgs(['--out', '/tmp/x', '--shard', '1/3']).passthrough, ['--shard', '1/3']);
});

test('参数切分：缺 --out 或引擎不认识当场报错', () => {
  assert.throws(() => parseRunnerArgs([]), /--out .*必填/u);
  assert.throws(() => parseRunnerArgs(['--out', '/tmp/x', '--engine', 'lxc']), /--engine 只能是/u);
  assert.throws(() => parseRunnerArgs(['--out']), /--out 需要取值/u);
  assert.deepEqual([...ENGINES], ['docker', 'podman']);
});

test('认证：两者都空就拒绝启动，报错要说清怎么拿 token', () => {
  assert.deepEqual([...AUTH_ENV_KEYS], ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  assert.throws(
    () => resolveAuthEnvKeys({}),
    (error) => {
      assert.equal(/** @type {Error} */ (error).message, MISSING_AUTH_MESSAGE);
      return true;
    },
  );
  assert.throws(() => resolveAuthEnvKeys({ CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' }), /拒绝启动/u);
  assert.match(MISSING_AUTH_MESSAGE, /claude setup-token/u);
  assert.match(MISSING_AUTH_MESSAGE, /订阅/u);
  // API key 是替代路径，不是必须项。
  assert.deepEqual(resolveAuthEnvKeys({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }), ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.deepEqual(resolveAuthEnvKeys({ ANTHROPIC_API_KEY: 'key' }), ['ANTHROPIC_API_KEY']);
  assert.deepEqual(resolveAuthEnvKeys({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', ANTHROPIC_API_KEY: 'key' }), [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
  ]);
});

test('透传参数走单引号转义，塞不进额外的 shell 命令', () => {
  assert.equal(shellQuote('abc'), `'abc'`);
  assert.equal(shellQuote(`a'b`), `'a'\\''b'`);
  // 真正的判据不是「长得像转义过」，而是 bash 自己拆出来的 argv 与原串逐字相等。
  // 拿一批带元字符、换行、命令替换的取值交给 bash 复原一遍。
  const hostile = [
    `m'; rm -rf /; echo '`,
    '$(touch /tmp/pwned)',
    '`id`',
    'a b\tc\nd',
    '--runs 3; curl evil.example',
    `"double" 'single' \\backslash`,
  ];
  const script = `printf '%s\\0' ${hostile.map(shellQuote).join(' ')}`;
  const restored = execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8' }).split('\0').slice(0, -1);
  assert.deepEqual(restored, hostile, 'bash 拆出来的 argv 必须与原串逐字相等');
  // 透传到容器内脚本时用的是同一个转义。
  assert.ok(buildEvalScript(['--model', hostile[0]]).includes(shellQuote(hostile[0])));
});

test('CLAUDE_CODE_OAUTH_TOKEN 进了会话环境白名单，与 ANTHROPIC_API_KEY 同级', () => {
  assert.ok(INHERITED_ENV_KEYS.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.ok(INHERITED_ENV_KEYS.includes('ANTHROPIC_API_KEY'));
  const env = buildSessionEnv(
    { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, GH_TOKEN: 'leak' },
    { HOME: '/session' },
  );
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, FAKE_TOKEN, '订阅 token 要能传进被测会话，否则会话起不来');
  assert.ok(!Object.hasOwn(env, 'GH_TOKEN'));
  // 白名单是精确键集合，加一个认证项不等于放开一类前缀。
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_OAUTH_TOKEN', 'HOME', 'PATH']);
});

test('脱敏：认证取值出现在报告文本里会被替换掉，太短的取值不替换', () => {
  assert.deepEqual([...SECRET_ENV_KEYS], ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
  const env = { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, ANTHROPIC_API_KEY: FAKE_KEY };
  const text = `会话输出：${FAKE_TOKEN} 与 ${FAKE_KEY} 各一次`;
  const safe = redactSecrets(text, env);
  assert.ok(!safe.includes(FAKE_TOKEN));
  assert.ok(!safe.includes(FAKE_KEY));
  assert.match(safe, /«REDACTED:CLAUDE_CODE_OAUTH_TOKEN»/u);
  assert.match(safe, /«REDACTED:ANTHROPIC_API_KEY»/u);
  // 太短的取值（占位符）不参与替换，否则整份报告会被打成马赛克。
  assert.equal(redactSecrets('xxx', { ANTHROPIC_API_KEY: 'x' }), 'xxx');
  assert.equal(secretValues({ ANTHROPIC_API_KEY: 'x'.repeat(MIN_SECRET_LENGTH - 1) }).length, 0);
  // 一个取值是另一个的前缀时，先替换长的，不留半截。
  const prefixed = redactSecrets('AAAAAAAABBBB', {
    ANTHROPIC_API_KEY: 'AAAAAAAA',
    CLAUDE_CODE_OAUTH_TOKEN: 'AAAAAAAABBBB',
  });
  assert.equal(prefixed, '«REDACTED:CLAUDE_CODE_OAUTH_TOKEN»');
  // 替换串不含引号与反斜杠，对 JSON 文本替换后仍是合法 JSON。
  JSON.parse(redactSecrets(JSON.stringify({ note: FAKE_TOKEN }), env));
});

test('端到端：带着假 token 跑一遍回放路径，扫描整个输出目录确认取值不出现', async () => {
  const out = mkdtempSync(join(tmpdir(), 'protocol-routing-redact-'));
  const saved = { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, key: process.env.ANTHROPIC_API_KEY };
  try {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = FAKE_TOKEN;
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    const code = await main([
      '--driver',
      'replay',
      '--replay',
      join(ROOT, 'fixtures', 'replay', 'always-write'),
      '--runs',
      '1',
      '--out',
      out,
      '--quiet',
    ]);
    assert.equal(code, 0);
    const files = walk(out);
    assert.ok(files.length >= 2, '至少应当产出 report.json 与 report.md');
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      assert.ok(!content.includes(FAKE_TOKEN), `${file} 里出现了 CLAUDE_CODE_OAUTH_TOKEN 的取值`);
      assert.ok(!content.includes(FAKE_KEY), `${file} 里出现了 ANTHROPIC_API_KEY 的取值`);
    }
  } finally {
    if (saved.token === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.token;
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    rmSync(out, { recursive: true, force: true });
  }
});

test('端到端：会话留档只记环境变量键名，不记取值', () => {
  // 无头驱动器写 command.json 时只落 Object.keys(env)。这里直接钉住那份形状：
  // 取值一旦进了 command.json，整个结果目录就成了凭据外泄面。
  const env = buildSessionEnv({ PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN }, { HOME: '/session' });
  const record = JSON.stringify({
    bin: 'claude',
    args: ['-p', 'prompt'],
    cwd: '/session/repo',
    env_keys: Object.keys(env).sort(),
  });
  assert.ok(record.includes('CLAUDE_CODE_OAUTH_TOKEN'), '键名要留，供复现时核对');
  assert.ok(!record.includes(FAKE_TOKEN), '取值不得进留档');
});

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
