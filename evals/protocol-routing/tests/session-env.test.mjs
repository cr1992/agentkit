// @ts-check
// 被测会话的两条安全面自测。全部离线：只测 env 构造函数与驱动器的启动闸门，不起真实会话。
//
// 为什么这两条值得单独钉：被测会话在 bypassPermissions 下运行，不经确认就能执行任意命令、
// 而且有网。一旦运行者的凭据随环境变量传进去，评测本身就成了外泄通道；
// 一旦 bypassPermissions 变成静默默认，在开发机上随手跑一次评测就等于交出整台机器。

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BYPASS_REFUSAL, createHeadlessClaudeDriver } from '../drivers/claude-headless.mjs';
import { INHERITED_ENV_KEYS, INHERITED_ENV_PREFIXES, buildSessionEnv } from '../lib/session-env.mjs';
import { main, parseArgs } from '../run.mjs';

/** 一份「运行者环境」：正常项 + 一堆与评测无关的凭据。 */
const PARENT = {
  PATH: '/usr/bin:/bin',
  LANG: 'zh_CN.UTF-8',
  LC_ALL: 'zh_CN.UTF-8',
  TMPDIR: '/tmp',
  TERM: 'xterm-256color',
  NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
  HTTPS_PROXY: 'http://proxy.internal:3128',
  ANTHROPIC_API_KEY: 'sk-ant-fake-for-test',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-fake-for-test',
  // 以下一个都不该出现在被测会话里
  GH_TOKEN: 'gh-secret',
  GITHUB_TOKEN: 'gh-secret-2',
  NPM_TOKEN: 'npm-secret',
  GITLAB_TOKEN: 'glpat-secret',
  AWS_SECRET_ACCESS_KEY: 'aws-secret',
  GOOGLE_APPLICATION_CREDENTIALS: '/home/me/gcp.json',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  HOME: '/home/runner',
  OPENAI_API_KEY: 'sk-openai',
};

const OVERRIDES = {
  HOME: '/session/home',
  CLAUDE_CONFIG_DIR: '/session/home/.claude',
  XDG_CONFIG_HOME: '/session/home/.config',
  PROTOCOL_ROUTING_REPO: '/session/repo',
  PROTOCOL_ROUTING_PROBE: '/session/probe.jsonl',
};

test('会话环境走白名单：运行者的凭据一个都不传下去', () => {
  const env = buildSessionEnv(PARENT, OVERRIDES);
  for (const leaked of ['GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'GITLAB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'SSH_AUTH_SOCK', 'OPENAI_API_KEY']) {
    assert.ok(!Object.hasOwn(env, leaked), `被测会话的环境里不该出现 ${leaked}`);
  }
  // 取值也不该以别的键名溜进去。
  assert.ok(!Object.values(env).some((value) => /gh-secret|npm-secret|glpat-secret|aws-secret|sk-openai/u.test(value)), '凭据取值不得出现在会话环境里');
});

test('白名单放行宿主跑起来必需的项与 Claude Code 自己的认证项', () => {
  const env = buildSessionEnv(PARENT, OVERRIDES);
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.LANG, 'zh_CN.UTF-8');
  assert.equal(env.LC_ALL, 'zh_CN.UTF-8', 'LC_* 按前缀放行');
  assert.equal(env.TMPDIR, '/tmp');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.NODE_EXTRA_CA_CERTS, '/etc/ssl/corp.pem');
  assert.equal(env.HTTPS_PROXY, 'http://proxy.internal:3128');
  // 两条认证路径同级：API key（CI）与 `claude setup-token` 生成的订阅 token（本机容器）。
  // 少了任何一条，对应那条路的会话都起不来。
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-fake-for-test');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-fake-for-test');
});

test('白名单的键集合是完整常量：改动必须是显式的', () => {
  assert.deepEqual([...INHERITED_ENV_KEYS], [
    'PATH',
    'TERM',
    'TMPDIR', 'TMP', 'TEMP',
    'LANG', 'LANGUAGE',
    'NODE_EXTRA_CA_CERTS',
    'NODE_OPTIONS',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);
  assert.deepEqual([...INHERITED_ENV_PREFIXES], ['LC_']);
  // CLAUDE_CODE_* 只放行这一个键，不是整类前缀：别的 CLAUDE_CODE_* 会改变宿主行为。
  assert.deepEqual(INHERITED_ENV_KEYS.filter((key) => key.startsWith('CLAUDE_CODE_')), ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.ok(!INHERITED_ENV_PREFIXES.some((prefix) => 'CLAUDE_CODE_X'.startsWith(prefix)));
});

test('隔离用的覆盖项优先级最高，会盖掉父环境的同名变量', () => {
  const env = buildSessionEnv(PARENT, OVERRIDES);
  assert.equal(env.HOME, '/session/home', '父环境的 HOME 必须被会话目录覆盖');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/session/home/.claude');
  assert.equal(env.XDG_CONFIG_HOME, '/session/home/.config');
  assert.equal(env.PROTOCOL_ROUTING_REPO, '/session/repo');
  assert.equal(env.PROTOCOL_ROUTING_PROBE, '/session/probe.jsonl');
  // 除了白名单命中的和覆盖项，不该多出任何东西。
  const expected = new Set([...Object.keys(PARENT).filter((key) => INHERITED_ENV_KEYS.includes(key) || key.startsWith('LC_')), ...Object.keys(OVERRIDES)]);
  assert.deepEqual(Object.keys(env).sort(), [...expected].sort());
});

test('白名单是常量且不含第三方 provider 的凭据键', () => {
  assert.ok(Object.isFrozen(INHERITED_ENV_KEYS));
  for (const key of INHERITED_ENV_KEYS) {
    assert.ok(!/^(?:AWS_|GOOGLE_|AZURE_|GH_|GITHUB_|GITLAB_|NPM_|OPENAI_)/u.test(key), `白名单不该包含 ${key}`);
  }
});

test('无头驱动器默认拒绝启动：bypassPermissions 必须运行者当轮显式同意', () => {
  assert.throws(
    () => createHeadlessClaudeDriver({ model: 'test-model', outDir: '/tmp/never-created' }),
    (error) => {
      assert.equal(/** @type {Error} */ (error).message, BYPASS_REFUSAL);
      return true;
    },
  );
  // 报错要把「为什么危险」「为什么不能换更弱的模式」「怎么继续」都说清楚。
  assert.match(BYPASS_REFUSAL, /不经确认就能执行任意命令/u);
  assert.match(BYPASS_REFUSAL, /不是沙箱/u);
  assert.match(BYPASS_REFUSAL, /一次性环境（CI runner \/ 容器 \/ 虚拟机）/u);
  assert.match(BYPASS_REFUSAL, /WRITE 判据会失真/u);
  assert.match(BYPASS_REFUSAL, /--allow-bypass-permissions/u);
});

test('run.mjs 不显式加 --allow-bypass-permissions 时非零退出，且不建输出目录', async () => {
  assert.equal(parseArgs([])['allow-bypass-permissions'], false);
  assert.equal(parseArgs(['--allow-bypass-permissions'])['allow-bypass-permissions'], true);
  const out = join(tmpdir(), `protocol-routing-refused-${process.pid}`);
  await assert.rejects(
    () => main(['--driver', 'claude-headless', '--model', 'test-model', '--out', out, '--quiet']),
    /拒绝启动真实会话/u,
  );
  assert.equal(existsSync(out), false, '被拒绝时不该留下空的输出目录');
});
