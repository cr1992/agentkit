import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  createCommands,
  launchAgentLabel,
  parseLaunchctlProgramArguments,
  parseServiceInterval,
  renderLaunchAgentPlist,
  resolveFirstPathNode,
  selectPinnedNodePath,
} from './worktree-watch-service.mjs';

test('LaunchAgent label 只由稳定 repository id 派生', () => {
  assert.equal(
    launchAgentLabel('273D2A64-BDCE-412A-88FD-DD9B9B9BD76B'),
    'io.github.cr1992.agentkit.worktree.273d2a64bdce412a88fddd9b9b9bd76b',
  );
  assert.throws(() => launchAgentLabel('---'), /repository id/);
});

test('LaunchAgent 使用固定 argv 且 XML 转义路径，不执行 shell 字符串', () => {
  const plist = renderLaunchAgentPlist({
    label: 'io.github.cr1992.agentkit.worktree.fixture',
    nodePath: '/opt/node & tools/bin/node',
    managerScript: '/tmp/agentkit/<runtime>/worktree-mgr.mjs',
    workingDirectory: '/tmp/repo & source',
    intervalSeconds: 60,
    logPath: '/tmp/repo & source/.git/watch.log',
    configPath: '/tmp/repo & source/profile.json',
  });
  assert.match(plist, /<key>ProgramArguments<\/key>/);
  assert.match(plist, /<string>\/opt\/node &amp; tools\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/tmp\/agentkit\/&lt;runtime&gt;\/worktree-mgr\.mjs<\/string>/);
  assert.match(plist, /<string>resume-all<\/string>/);
  assert.match(plist, /<string>--quiet<\/string>/);
  assert.match(plist, /<string>--config<\/string>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /sh -c|\/bin\/sh/);
});

test('watch-service interval 有界', () => {
  assert.equal(parseServiceInterval(null), 60);
  assert.equal(parseServiceInterval('30'), 30);
  assert.equal(parseServiceInterval(3600), 3600);
  assert.throws(() => parseServiceInterval(29), /30-3600/);
  assert.throws(() => parseServiceInterval(3601), /30-3600/);
  assert.throws(() => parseServiceInterval('nope'), /30-3600/);
});

test('watch-service install/status/uninstall 以固定 launchctl argv 管理且幂等清理 plist', (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), 'agentkit-watch-service-'));
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  const primary = join(sandbox, 'repo');
  const commonDir = join(primary, '.git');
  mkdirSync(commonDir, { recursive: true });
  let loaded = false;
  const calls = [];
  const logs = [];
  const profile = {
    context: { common_dir: commonDir, primary_worktree: primary },
    profile_source: 'defaults',
    profile_path: join(primary, '.worktree-trace.json'),
  };
  const commands = createCommands({
    processPlatform: 'darwin',
    processExecPath: '/fixture/node',
    processGetuid: () => 501,
    homedir: () => sandbox,
    randomUUID,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
    dirname,
    join,
    managerScript: '/fixture/worktree-mgr.mjs',
    runFileCapture(command, args) {
      calls.push([command, ...args]);
      if (args[0] === 'print') return { ok: loaded, out: loaded ? 'loaded' : 'not loaded' };
      if (args[0] === 'bootout') {
        loaded = false;
        return { ok: true, out: '' };
      }
      if (args[0] === 'bootstrap') {
        loaded = true;
        return { ok: true, out: '' };
      }
      if (args[0] === 'kickstart') return { ok: true, out: '' };
      return { ok: false, out: 'unexpected call' };
    },
    loadRepositoryProfile: () => profile,
    readRepositoryIdentity: () => ({ repository_id: 'fixture-repository-id' }),
    ensureRepositoryIdentity: () => ({ repository_id: 'fixture-repository-id' }),
    traceLayout: (value) => ({ root: join(value, 'worktree-trace', 'v1') }),
    flag: (flags, name) => flags.get(name) ?? null,
    rejectUnknownFlags() {},
    die(message) {
      throw new Error(message);
    },
    log(message) {
      logs.push(message);
    },
  });

  commands.cmdWatchService({ positionals: ['install'], flags: new Map([['interval-seconds', '45']]) });
  const status = commands.watchServiceStatus(profile);
  assert.equal(status.installed, true);
  assert.equal(status.loaded, true);
  assert.match(readFileSync(status.plist_path, 'utf8'), /<integer>45<\/integer>/);
  assert.equal(
    calls.some((call) => call[1] === 'bootstrap'),
    true,
  );
  assert.equal(
    calls.some((call) => call[1] === 'kickstart'),
    true,
  );

  commands.cmdWatchService({ positionals: ['uninstall'], flags: new Map() });
  assert.equal(existsSync(status.plist_path), false);
  assert.equal(loaded, false);
  assert.equal(
    calls.some((call) => call[1] === 'bootout'),
    true,
  );
  assert.equal(logs.length, 2);
});

test('selectPinnedNodePath 只在 PATH 软链与 execPath 同一真实文件且路径不同才钉 PATH 路径', () => {
  // Homebrew 典型：/opt/homebrew/bin/node 软链到 Cellar 版本目录，node 升级后 Cellar 目录会被删。
  const realpath = (p) =>
    p === '/opt/homebrew/bin/node' || p === '/opt/homebrew/Cellar/node/26.9.0/bin/node'
      ? '/opt/homebrew/Cellar/node/26.9.0/bin/node'
      : p;
  assert.equal(
    selectPinnedNodePath({
      execPath: '/opt/homebrew/Cellar/node/26.9.0/bin/node',
      pathNode: '/opt/homebrew/bin/node',
      realpath,
    }),
    '/opt/homebrew/bin/node',
  );
});

test('selectPinnedNodePath 在 PATH node 指向别处时回退 execPath', () => {
  const realpath = (p) => (p === '/usr/local/bin/node' ? '/usr/local/other/node' : p);
  assert.equal(
    selectPinnedNodePath({ execPath: '/cellar/node', pathNode: '/usr/local/bin/node', realpath }),
    '/cellar/node',
  );
});

test('selectPinnedNodePath 在无 PATH node、PATH 等于 execPath 或 realpath 抛错时回退 execPath', () => {
  assert.equal(selectPinnedNodePath({ execPath: '/cellar/node', pathNode: null, realpath: (p) => p }), '/cellar/node');
  assert.equal(
    selectPinnedNodePath({ execPath: '/cellar/node', pathNode: '/cellar/node', realpath: (p) => p }),
    '/cellar/node',
  );
  const throwing = () => {
    throw new Error('ENOENT');
  };
  assert.equal(
    selectPinnedNodePath({ execPath: '/cellar/node', pathNode: '/opt/bin/node', realpath: throwing }),
    '/cellar/node',
  );
});

test('resolveFirstPathNode 取 PATH 中第一个存在的 node，找不到返回 null', () => {
  const present = new Set(['/opt/homebrew/bin/node']);
  assert.equal(
    resolveFirstPathNode({
      pathEnv: '/missing/bin:/opt/homebrew/bin:/usr/bin',
      delimiter: ':',
      join,
      existsSync: (p) => present.has(p),
    }),
    '/opt/homebrew/bin/node',
  );
  assert.equal(
    resolveFirstPathNode({ pathEnv: '/a:/b', delimiter: ':', join, existsSync: () => false }),
    null,
  );
  assert.equal(resolveFirstPathNode({ pathEnv: '', delimiter: ':', join, existsSync: () => true }), null);
});

test('parseLaunchctlProgramArguments 从 arguments 块解析 argv，无块返回 null', () => {
  const text = 'foo = bar\n\targuments = {\n\t\t/opt/homebrew/bin/node\n\t\t/pkg/mgr.mjs\n\t\tresume-all\n\t}\nbaz = 1';
  assert.deepEqual(parseLaunchctlProgramArguments(text), ['/opt/homebrew/bin/node', '/pkg/mgr.mjs', 'resume-all']);
  assert.equal(parseLaunchctlProgramArguments('program = /opt/homebrew/bin/node'), null);
  assert.equal(parseLaunchctlProgramArguments(''), null);
});

// 状态与安装测试共用的假依赖：全部注入，不真的调用 launchctl / plutil / 文件系统。
function makeFixture(overrides = {}) {
  const files = new Set(['/pkg/worktree-mgr.mjs']);
  const contents = new Map();
  const loaded = {
    context: { common_dir: '/repo/.git', primary_worktree: '/repo' },
    profile_source: 'defaults',
    profile_path: '/repo/.worktree-trace.json',
  };
  const deps = {
    processPlatform: 'darwin',
    processExecPath: '/cellar/node',
    processGetuid: () => 501,
    homedir: () => '/home',
    randomUUID: () => 'fixed-uuid',
    existsSync: (p) => files.has(p),
    mkdirSync: () => {},
    readFileSync: (p) => contents.get(p) ?? '',
    renameSync: (from, to) => {
      if (!files.has(from)) return;
      files.delete(from);
      files.add(to);
      const value = contents.get(from);
      contents.delete(from);
      if (value !== undefined) contents.set(to, value);
    },
    rmSync: (p) => {
      files.delete(p);
      contents.delete(p);
    },
    writeFileSync: (p, data) => {
      files.add(p);
      contents.set(p, String(data));
    },
    realpathSync: (p) => p,
    processEnv: { PATH: '' },
    delimiter: ':',
    dirname,
    join,
    managerScript: '/pkg/worktree-mgr.mjs',
    runFileCapture: () => ({ ok: false, out: '' }),
    loadRepositoryProfile: () => loaded,
    readRepositoryIdentity: () => ({ repository_id: 'fixturerepo' }),
    ensureRepositoryIdentity: () => ({ repository_id: 'fixturerepo' }),
    traceLayout: (value) => ({ root: join(value, 'trace') }),
    flag: (flags, name) => flags.get(name) ?? null,
    rejectUnknownFlags() {},
    die(message) {
      throw new Error(message);
    },
    log() {},
    ...overrides,
  };
  const plistPath = '/home/Library/LaunchAgents/io.github.cr1992.agentkit.worktree.fixturerepo.plist';
  return { files, contents, loaded, deps, plistPath };
}

test('status：已安装 plist 钉的 node 已不存在 → program_available false 且 stale', () => {
  const fx = makeFixture();
  fx.files.add(fx.plistPath); // plist 仍在
  // 钉的旧 Cellar node 不加入 files，即已被 Homebrew 升级删除。
  fx.deps.runFileCapture = (command, args) => {
    if (command === '/bin/launchctl' && args[0] === 'print') return { ok: true, out: 'state = running' };
    if (command === '/usr/bin/plutil')
      return {
        ok: true,
        stdout: JSON.stringify({
          ProgramArguments: ['/opt/homebrew/Cellar/node/26.7.0/bin/node', '/pkg/worktree-mgr.mjs', 'resume-all', '--quiet'],
        }),
      };
    return { ok: false, out: '' };
  };
  const commands = createCommands(fx.deps);
  const status = commands.watchServiceStatus(fx.loaded);
  assert.equal(status.installed, true);
  assert.equal(status.loaded, true);
  assert.equal(status.installed_node_path, '/opt/homebrew/Cellar/node/26.7.0/bin/node');
  assert.equal(status.installed_manager_script, '/pkg/worktree-mgr.mjs');
  assert.equal(status.program_available, false);
  assert.equal(status.stale, true);
  assert.match(status.stale_reason, /pinned_node_missing/);
});

test('status：plist 已删除但 job 仍 loaded → stale（回退 launchctl print 解析）', () => {
  const fx = makeFixture();
  fx.files.add('/opt/homebrew/bin/node'); // 钉的 node 与 manager 都在，只是 plist 丢了
  fx.deps.runFileCapture = (command, args) => {
    if (command === '/bin/launchctl' && args[0] === 'print')
      return {
        ok: true,
        out: 'arguments = {\n\t\t/opt/homebrew/bin/node\n\t\t/pkg/worktree-mgr.mjs\n\t\tresume-all\n\t\t--quiet\n\t}',
      };
    return { ok: false, out: '' }; // plutil 不应被调用（plist 不存在）
  };
  const commands = createCommands(fx.deps);
  const status = commands.watchServiceStatus(fx.loaded);
  assert.equal(status.installed, false);
  assert.equal(status.loaded, true);
  assert.equal(status.installed_node_path, '/opt/homebrew/bin/node');
  assert.equal(status.program_available, true);
  assert.equal(status.stale, true);
  assert.equal(status.stale_reason, 'plist_missing_but_loaded');
});

test('status：完全未安装时 program_available 为 null 且不 stale', () => {
  const fx = makeFixture();
  fx.deps.runFileCapture = (command, args) => {
    if (command === '/bin/launchctl' && args[0] === 'print') return { ok: false, out: 'not loaded' };
    return { ok: false, out: '' };
  };
  const commands = createCommands(fx.deps);
  const status = commands.watchServiceStatus(fx.loaded);
  assert.equal(status.installed, false);
  assert.equal(status.loaded, false);
  assert.equal(status.program_available, null);
  assert.equal(status.stale, false);
  assert.equal(status.stale_reason, null);
});

test('install：PATH 稳定软链被选中并钉进 plist，健康安装 program_available true', () => {
  const fx = makeFixture({
    processExecPath: '/opt/homebrew/Cellar/node/26.9.0/bin/node',
    processEnv: { PATH: '/opt/homebrew/bin:/usr/bin' },
    realpathSync: (p) =>
      p === '/opt/homebrew/bin/node' ? '/opt/homebrew/Cellar/node/26.9.0/bin/node' : p,
  });
  fx.files.add('/opt/homebrew/bin/node'); // PATH 中第一个 node
  let jobLoaded = false;
  fx.deps.runFileCapture = (command, args) => {
    if (command === '/bin/launchctl') {
      if (args[0] === 'print') return { ok: jobLoaded, out: jobLoaded ? 'running' : 'not loaded' };
      if (args[0] === 'bootout') return ((jobLoaded = false), { ok: true, out: '' });
      if (args[0] === 'bootstrap') return ((jobLoaded = true), { ok: true, out: '' });
      if (args[0] === 'kickstart') return { ok: true, out: '' };
    }
    if (command === '/usr/bin/plutil')
      return {
        ok: true,
        stdout: JSON.stringify({
          ProgramArguments: ['/opt/homebrew/bin/node', '/pkg/worktree-mgr.mjs', 'resume-all', '--quiet'],
        }),
      };
    return { ok: false, out: 'unexpected' };
  };
  const commands = createCommands(fx.deps);
  const outputs = [];
  const original = console.log;
  console.log = (msg) => outputs.push(String(msg));
  try {
    commands.cmdWatchService({ positionals: ['install'], flags: new Map([['json', true], ['interval-seconds', '60']]) });
  } finally {
    console.log = original;
  }
  const result = JSON.parse(outputs.join('\n'));
  assert.equal(result.node_path, '/opt/homebrew/bin/node');
  assert.match(fx.contents.get(fx.plistPath), /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.doesNotMatch(fx.contents.get(fx.plistPath), /Cellar\/node\/26\.9\.0/);
  assert.equal(result.installed, true);
  assert.equal(result.installed_node_path, '/opt/homebrew/bin/node');
  assert.equal(result.program_available, true);
  assert.equal(result.stale, false);
});

test('status：钉的入口与本次调用不同但两条路径都在 → 不 stale，只记 manager_script_matches_current=false', () => {
  const fx = makeFixture();
  fx.files.add(fx.plistPath);
  fx.files.add('/opt/homebrew/bin/node');
  fx.files.add('/global/agentkit/worktree-mgr.mjs'); // 服务钉的是全局包，本次从开发 checkout /pkg 调用
  fx.deps.runFileCapture = (command, args) => {
    if (command === '/bin/launchctl' && args[0] === 'print') return { ok: true, out: 'state = not running' };
    if (command === '/usr/bin/plutil')
      return {
        ok: true,
        stdout: JSON.stringify({
          ProgramArguments: ['/opt/homebrew/bin/node', '/global/agentkit/worktree-mgr.mjs', 'resume-all', '--quiet'],
        }),
      };
    return { ok: false, out: '' };
  };
  const status = createCommands(fx.deps).watchServiceStatus(fx.loaded);
  assert.equal(status.program_available, true);
  assert.equal(status.manager_script_matches_current, false);
  assert.equal(status.stale, false);
  assert.equal(status.stale_reason, null);
});
