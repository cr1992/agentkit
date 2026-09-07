import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  createCommands,
  launchAgentLabel,
  parseServiceInterval,
  renderLaunchAgentPlist,
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
      if (args[0] === 'bootout') { loaded = false; return { ok: true, out: '' }; }
      if (args[0] === 'bootstrap') { loaded = true; return { ok: true, out: '' }; }
      if (args[0] === 'kickstart') return { ok: true, out: '' };
      return { ok: false, out: 'unexpected call' };
    },
    loadRepositoryProfile: () => profile,
    readRepositoryIdentity: () => ({ repository_id: 'fixture-repository-id' }),
    ensureRepositoryIdentity: () => ({ repository_id: 'fixture-repository-id' }),
    traceLayout: (value) => ({ root: join(value, 'worktree-trace', 'v1') }),
    flag: (flags, name) => flags.get(name) ?? null,
    rejectUnknownFlags() {},
    die(message) { throw new Error(message); },
    log(message) { logs.push(message); },
  });

  commands.cmdWatchService({ positionals: ['install'], flags: new Map([['interval-seconds', '45']]) });
  const status = commands.watchServiceStatus(profile);
  assert.equal(status.installed, true);
  assert.equal(status.loaded, true);
  assert.match(readFileSync(status.plist_path, 'utf8'), /<integer>45<\/integer>/);
  assert.equal(calls.some((call) => call[1] === 'bootstrap'), true);
  assert.equal(calls.some((call) => call[1] === 'kickstart'), true);

  commands.cmdWatchService({ positionals: ['uninstall'], flags: new Map() });
  assert.equal(existsSync(status.plist_path), false);
  assert.equal(loaded, false);
  assert.equal(calls.some((call) => call[1] === 'bootout'), true);
  assert.equal(logs.length, 2);
});
