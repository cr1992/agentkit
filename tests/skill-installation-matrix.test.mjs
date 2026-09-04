import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILLS = ['orchestrate-subagents', 'manage-worktrees', 'verify-agent-output', 'run-agent-verify-loop'];
const CLI_ENTRY = {
  'orchestrate-subagents': ['orchestrate', 'ledger', 'capabilities', '--json'],
  'manage-worktrees': ['worktree', 'capabilities', '--json'],
  'verify-agent-output': ['verify', 'capabilities', '--json'],
  'run-agent-verify-loop': ['loop', 'capabilities'],
};
const ENTRY = {
  'orchestrate-subagents': ['scripts/orchestration-ledger.mjs', 'capabilities'],
  'manage-worktrees': ['scripts/worktree-mgr.mjs', 'capabilities', '--json'],
  'verify-agent-output': ['scripts/verification-runtime.mjs', 'capabilities'],
  'run-agent-verify-loop': ['scripts/loop-runtime.mjs', 'capabilities'],
};

// 安装单元的口径变化：schema 收敛与 core 抽取之后，Skill 目录不再自带 schema 与公共运行时，
// 包（bin/core/schemas + Skill 目录）才是安装单元。原断言「把裸 Skill 目录拷进沙箱后可运行」
// 因此不再成立，也不再是要守的东西——它守的是一个已经不存在的分发形态。
// 现在守方案第 9 节的真实门禁：装好 CLI 后，四个 Skill 的任意非空组合都能从临时 PATH
// 执行 capabilities，且缺席的 Skill 不会让其他 Skill 或聚合命令崩溃。
const PACKAGE_PARTS = ['package.json', 'bin', 'core', 'schemas'];
// 运行时住在 domains/<域>/，随对应 Skill 一起安装；缺席的 Skill 连它的 domain 一起不装。
const DOMAIN_OF = { 'orchestrate-subagents': 'orchestrate', 'manage-worktrees': 'worktree', 'verify-agent-output': 'verify', 'run-agent-verify-loop': 'loop' };

test('真实 npm tarball 安装后，临时 PATH 覆盖四个 Skill 的 15 种 shell 组合', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'skill-tarball-matrix-'));
  const cache = join(sandbox, 'npm-cache');
  try {
    const packed = spawnSync('npm', ['pack', '--pack-destination', sandbox, '--json'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, NPM_CONFIG_CACHE: cache },
    });
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = join(sandbox, JSON.parse(packed.stdout)[0].filename);
    const prefix = join(sandbox, 'prefix');
    const installed = spawnSync('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', '--offline', tarball], {
      cwd: sandbox, encoding: 'utf8', env: { ...process.env, NPM_CONFIG_CACHE: cache },
    });
    assert.equal(installed.status, 0, installed.stderr);
    const npmRoot = spawnSync('npm', ['root', '--global', '--prefix', prefix], { cwd: sandbox, encoding: 'utf8' });
    assert.equal(npmRoot.status, 0, npmRoot.stderr);
    const packageRoot = join(npmRoot.stdout.trim(), '@cr1992', 'agentkit');
    const env = { ...process.env, PATH: `${join(prefix, 'bin')}${delimiter}${process.env.PATH}` };

    for (let mask = 1; mask < (1 << SKILLS.length); mask += 1) {
      const present = SKILLS.filter((_, index) => mask & (1 << index));
      const shellRoot = join(sandbox, `shell-combo-${mask}`);
      for (const skill of present) {
        cpSync(join(packageRoot, skill), join(shellRoot, skill), { recursive: true });
        assert.match(readFileSync(join(shellRoot, skill, 'SKILL.md'), 'utf8'), /bins:\s*\["agentkit"\]/u);
        const result = spawnSync('agentkit', CLI_ENTRY[skill], { cwd: shellRoot, encoding: 'utf8', env });
        assert.equal(result.status, 0, `${present.join('+')} / ${skill}: ${result.stderr}`);
        assert.equal(JSON.parse(result.stdout).skill, skill);
      }
      const doctor = spawnSync('agentkit', ['doctor', '--json'], { cwd: shellRoot, encoding: 'utf8', env });
      assert.equal(doctor.status, 0, `${present.join('+')} / doctor: ${doctor.stderr}`);
      assert.equal(JSON.parse(doctor.stdout).checks.manifest.healthy, true);
    }
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test('人为裁剪 engine 时在场域仍可只读诊断，安装级 doctor 对不完整 manifest fail closed', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'skill-install-matrix-'));
  try {
    for (let mask = 1; mask < (1 << SKILLS.length); mask += 1) {
      const install = join(sandbox, `combo-${mask}`);
      const present = SKILLS.filter((_, index) => mask & (1 << index));
      for (const part of PACKAGE_PARTS) cpSync(join(ROOT, part), join(install, part), { recursive: true });
      for (const skill of present) {
        cpSync(join(ROOT, skill), join(install, skill), { recursive: true });
        cpSync(join(ROOT, 'domains', DOMAIN_OF[skill]), join(install, 'domains', DOMAIN_OF[skill]), { recursive: true });
      }

      const cli = join(install, 'bin', 'agentkit.mjs');
      for (const skill of present) {
        const [relative, ...args] = ENTRY[skill];
        const direct = execFileSync(process.execPath, [join(install, skill, relative), ...args], { cwd: install, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        assert.equal(JSON.parse(direct).skill, skill, `${present.join('+')} / ${skill} 直调`);
        const viaCli = execFileSync(process.execPath, [cli, ...CLI_ENTRY[skill]], { cwd: install, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        assert.equal(JSON.parse(viaCli).skill, skill, `${present.join('+')} / ${skill} 经 CLI`);
      }

      // 缺席的 Skill 只让对应域报「未随本安装分发」，不影响在场的 Skill，也不让聚合命令崩溃。
      for (const skill of SKILLS.filter((item) => !present.includes(item))) {
        const absent = spawnSync(process.execPath, [cli, ...CLI_ENTRY[skill]], { cwd: install, encoding: 'utf8' });
        assert.equal(absent.status, 127, `${present.join('+')} / 缺席 ${skill}`);
        assert.equal(absent.stdout, '', '缺席提示不得写 stdout');
        assert.match(absent.stderr, /未随本安装分发/u);
      }
      const aggregate = spawnSync(process.execPath, [cli, 'capabilities', '--json'], { cwd: install, encoding: 'utf8' });
      assert.equal(aggregate.status, 0, `${present.join('+')} / 聚合 capabilities`);
      assert.deepEqual(Object.keys(JSON.parse(aggregate.stdout).skills).sort(), [...present].sort());
      const doctor = spawnSync(process.execPath, [cli, 'doctor', '--json'], { cwd: install, encoding: 'utf8' });
      assert.equal(doctor.status, 1, `${present.join('+')} / 安装级 doctor: ${doctor.stderr}`);
      const health = JSON.parse(doctor.stdout);
      assert.equal(health.healthy, false);
      assert.equal(health.checks.manifest.healthy, false);
      for (const skill of SKILLS) assert.equal(health.skills[skill].installed, present.includes(skill));
    }
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

// 开发者 home 路径不得进入可分发内容。用户名在运行时从 homedir() 推导，而不是写死：
// 本文件本身会随 Skill 一起进入公开镜像，写死用户名等于把它一并发布。
const HOME_OWNER = basename(homedir());
const HOME_LEAK = /^[A-Za-z0-9._-]+$/u.test(HOME_OWNER)
  ? new RegExp(`/(?:Users|home)/${HOME_OWNER}(?:/|\\b)`, 'u')
  : null;

// 方案要求 Skill 目录里不得残留运行时实现，兼容 stub 只能做固定转发。用源文本约束守住：
// 去掉 shebang、注释与空行之后，每个 stub 只允许导入共享 runner、导入已加载 domain 的 runCli、
// 透传导出并在直接执行时调用 runner；不得再 fork 第二个 Node 进程。
test('Skill 目录只剩薄壳：scripts/ 下全是固定转发 stub，不含任何实现', () => {
  const DOMAIN_FOR = DOMAIN_OF;
  for (const skill of SKILLS) {
    const scripts = join(ROOT, skill, 'scripts');
    const entries = readdirSync(scripts);
    assert.ok(entries.length > 0, `${skill} 缺少兼容入口`);
    for (const name of entries) {
      assert.ok(name.endsWith('.mjs'), `${skill}/scripts/${name} 不是 stub`);
      const domain = DOMAIN_FOR[skill];
      const target = `../../domains/${domain}/${name}`;
      const statements = readFileSync(join(scripts, name), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('//') && !line.startsWith('#!'));
      assert.deepEqual(statements, [
        "import { forwardLegacyEntry } from '../../core/legacy-entry.mjs';",
        `import { runCli } from '${target}';`,
        `export * from '${target}';`,
        'const status = forwardLegacyEntry(import.meta.url, runCli);',
        'if (status !== undefined) process.exitCode = status;',
      ], `${skill}/scripts/${name} 不是纯转发 stub`);
      assert.ok(existsSync(join(ROOT, 'domains', domain, name)), `${target} 不存在`);
    }
  }
});

test('全部兼容 stub 可安全 import，且共享 runner 不再派生第二个 Node 进程', () => {
  const entries = [];
  for (const skill of SKILLS) {
    for (const name of readdirSync(join(ROOT, skill, 'scripts'))) entries.push(join(ROOT, skill, 'scripts', name));
  }
  const program = [
    "import { pathToFileURL } from 'node:url';",
    'const paths = process.argv.slice(1);',
    "process.argv[1] = 'import-harness';",
    'for (const path of paths) await import(pathToFileURL(path).href);',
    "process.stdout.write('imports-ok\\n');",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program, ...entries], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'imports-ok\n');
  assert.doesNotMatch(readFileSync(join(ROOT, 'core', 'legacy-entry.mjs'), 'utf8'), /node:child_process/u);
});

test('可分发 Skill 不含本机绝对路径、凭证样式或跨 sibling runtime import', () => {
  const findings = [];
  const visit = (path) => {
    const stat = statSync(path);
    if (stat.isDirectory()) { for (const name of readdirSync(path)) if (name !== '.DS_Store') visit(join(path, name)); return; }
    const text = readFileSync(path, 'utf8');
    if (HOME_LEAK && HOME_LEAK.test(text)) findings.push(`${path}:absolute-path`);
    if (/\b(?:ghp|glpat|sk)-[A-Za-z0-9_-]{20,}\b/u.test(text)) findings.push(`${path}:credential-pattern`);
    for (const sibling of SKILLS) if (!path.includes(`/${sibling}/`) && text.includes(`../${sibling}/`)) findings.push(`${path}:sibling-import:${sibling}`);
  };
  for (const skill of SKILLS) visit(join(ROOT, skill));
  assert.deepEqual(findings, []);
});
