// @ts-check
// 分类器自测。全部离线，不起任何会话、不产生任何模型费用。
//
// `WRITE` 的三条判据用**真实 fixture 仓**验证：宿主写文件工具、Bash 重定向、只读 Bash
// 分别造出真实的 `git status --porcelain` / `HEAD` 摘要，再交给分类器。
// 这样测到的是 issue #15 要求的那条判据本身，而不是一组手写的字符串。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { extractAgentkitArgv, tokenize } from '../lib/argv.mjs';
import { PROCESS_PRELUDE_PAIRS, READONLY_PAIRS, classify, normalizeCall } from '../lib/classifier.mjs';
import { createFixtureRepo, repoSummary } from '../lib/fixture-repo.mjs';

/** @param {Array<{ tool_name: string, command?: string, repo: any }>} steps */
const session = (initial, steps) => ({
  initial_repo: initial,
  events: steps.map((step, index) => ({ seq: index + 1, tool_name: step.tool_name, tool_input: step.command === undefined ? {} : { command: step.command }, repo: step.repo })),
});

test('WRITE 判据只看仓库摘要：宿主写文件工具、Bash 重定向都算写，只读 Bash 不算', () => {
  const { repo } = createFixtureRepo();
  try {
    const clean = repoSummary(repo);

    // 只读 Bash：摘要不变。
    execFileSync('bash', ['-c', 'cat src/sum.mjs > /dev/null && git status --porcelain'], { cwd: repo, encoding: 'utf8' });
    const afterRead = repoSummary(repo);

    // 宿主写文件工具：直接落盘，没有任何命令文本可解析。
    writeFileSync(join(repo, 'src', 'greet.mjs'), 'export const greet = (name) => `Hi, ${name}!`;\n');
    const afterHostWrite = repoSummary(repo);

    // Bash 重定向：同一条判据，不需要认识 `>`。
    execFileSync('bash', ['-c', 'echo "// touched" >> src/sum.mjs'], { cwd: repo, encoding: 'utf8' });
    const afterRedirect = repoSummary(repo);

    assert.deepEqual(afterRead, clean, '只读命令不该改变仓库摘要');
    assert.notDeepEqual(afterHostWrite, clean);
    assert.notDeepEqual(afterRedirect, afterHostWrite);

    const readOnly = classify(session(clean, [{ tool_name: 'Bash', command: 'cat src/sum.mjs', repo: afterRead }]));
    assert.equal(readOnly.observation, 'NONE');
    assert.deepEqual(readOnly.writes, []);

    const hostWrite = classify(session(clean, [
      { tool_name: 'Read', command: undefined, repo: clean },
      { tool_name: 'Write', command: undefined, repo: afterHostWrite },
    ]));
    assert.equal(hostWrite.observation, 'WRITE');
    assert.equal(hostWrite.observed_at, 2);
    assert.deepEqual(hostWrite.writes, [{ seq: 2, tool_name: 'Write' }]);

    const redirect = classify(session(afterHostWrite, [
      { tool_name: 'Bash', command: 'echo "// touched" >> src/sum.mjs', repo: afterRedirect },
    ]));
    assert.equal(redirect.observation, 'WRITE');
    assert.equal(redirect.writes[0].tool_name, 'Bash');
  } finally { rmSync(join(repo, '..'), { recursive: true, force: true }); }
});

test('HEAD 变化同样算写：git commit 不改工作区状态也要被记为 WRITE', () => {
  const { repo } = createFixtureRepo();
  try {
    const clean = repoSummary(repo);
    writeFileSync(join(repo, 'src', 'greet.mjs'), 'export const greet = () => "Hi";\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '--quiet', '-m', 'x'], { cwd: repo });
    const committed = repoSummary(repo);
    assert.equal(committed.status, clean.status, '提交后工作区重新变干净，只有 HEAD 不同');
    assert.notEqual(committed.head, clean.head);
    assert.equal(classify(session(clean, [{ tool_name: 'Bash', command: 'git commit -am x', repo: committed }])).observation, 'WRITE');
  } finally { rmSync(join(repo, '..'), { recursive: true, force: true }); }
});

test('白名单排除只读且不暴露路由去向的调用，其后的第一个真调用才是观测量', () => {
  const clean = { status: '', head: 'a'.repeat(40) };
  const result = classify(session(clean, [
    { tool_name: 'Bash', command: 'agentkit docs', repo: clean },
    { tool_name: 'Bash', command: 'agentkit docs worktree conflict-scan', repo: clean },
    { tool_name: 'Bash', command: 'agentkit worktree scan --json', repo: clean },
    { tool_name: 'Bash', command: 'agentkit worktree list', repo: clean },
    { tool_name: 'Bash', command: 'agentkit doctor --json', repo: clean },
    { tool_name: 'Bash', command: 'agentkit verify readiness --contract c.json --profile p.json --workdir .', repo: clean },
    { tool_name: 'Bash', command: 'agentkit worktree spawn feature --agent claude-code --agent-id a1 --purpose x', repo: clean },
  ]));
  assert.equal(result.observation, 'agentkit worktree spawn');
  assert.equal(result.observed_at, 7);
  assert.deepEqual(result.calls.filter((call) => call.observable).map((call) => call.label), ['agentkit worktree spawn']);
});

test('暴露路由去向的调用一律保留观测：contract validate、verify preflight、orchestrate preflight check', () => {
  const clean = { status: '', head: 'b'.repeat(40) };
  const cases = [
    ['agentkit contract validate --input c.json', 'agentkit contract validate'],
    ['agentkit verify preflight --contract c.json --profile p.json --artifact a.json', 'agentkit verify preflight'],
    ['agentkit orchestrate preflight check --requirements r.json', 'agentkit orchestrate preflight check'],
    ['agentkit orchestrate ledger init --contract c.json', 'agentkit orchestrate ledger init'],
    ['agentkit loop init --contract c.json', 'agentkit loop init'],
  ];
  for (const [command, expected] of cases) {
    assert.equal(classify(session(clean, [{ tool_name: 'Bash', command, repo: clean }])).observation, expected, command);
  }
});

test('同一事件里 agentkit 调用优先于 WRITE：worktree spawn 本身就会写盘', () => {
  const before = { status: '', head: 'c'.repeat(40) };
  const after = { status: '?? .worktrees/', head: 'c'.repeat(40) };
  const result = classify(session(before, [
    { tool_name: 'Bash', command: 'agentkit worktree spawn feature --agent claude-code --agent-id a1 --purpose x', repo: after },
  ]));
  assert.equal(result.observation, 'agentkit worktree spawn');
  assert.deepEqual(result.writes, [{ seq: 1, tool_name: 'Bash' }], '写操作仍然登记在案，只是不作为观测量');
});

test('argv 形态：node 入口、npx、环境变量前缀、cd && 链、引号与重定向', () => {
  const forms = [
    ['agentkit worktree spawn x', ['worktree', 'spawn', 'x']],
    ['node /opt/agentkit/bin/agentkit.mjs worktree spawn x', ['worktree', 'spawn', 'x']],
    ['node --enable-source-maps ./bin/agentkit.mjs verify init', ['verify', 'init']],
    ['npx agentkit verify preflight', ['verify', 'preflight']],
    ['npx -y @cr1992/agentkit verify preflight', ['verify', 'preflight']],
    ['npx --package @cr1992/agentkit agentkit verify preflight', ['verify', 'preflight']],
    ['AGENTKIT_STATE=/tmp/s agentkit orchestrate ledger init --contract c.json', ['orchestrate', 'ledger', 'init', '--contract', 'c.json']],
    ['env FOO=1 agentkit loop next --loop l', ['loop', 'next', '--loop', 'l']],
    ['cd /tmp/repo && agentkit worktree spawn x', ['worktree', 'spawn', 'x']],
    ['agentkit contract validate --input \'{"a":1}\'', ['contract', 'validate', '--input', '{"a":1}']],
    ['agentkit verify status --run r > /tmp/out.json', ['verify', 'status', '--run', 'r']],
    ['/usr/local/bin/agentkit worktree adopt .', ['worktree', 'adopt', '.']],
  ];
  for (const [command, expected] of forms) {
    assert.deepEqual(extractAgentkitArgv(/** @type {string} */ (command))[0], expected, command);
  }
  // 一条命令里的多个调用按出现顺序全部取到。
  assert.deepEqual(
    extractAgentkitArgv('agentkit docs worktree conflict-scan && agentkit worktree spawn x; agentkit verify init').map((argv) => argv[0]),
    ['docs', 'worktree', 'verify'],
  );
  // 不是 agentkit 的命令一个都不该匹配。
  for (const command of ['node scripts/other.mjs worktree spawn', 'npx tsx foo.ts', 'git commit -m "agentkit worktree spawn"', 'echo agentkit worktree spawn']) {
    assert.deepEqual(extractAgentkitArgv(command), [], command);
  }
  // `echo agentkit …` 之所以不匹配，是因为 echo 不是启动器；引号内的整串也只是一个 token。
  assert.deepEqual(tokenize('git commit -m "agentkit worktree spawn"').at(-1), 'agentkit worktree spawn');
});

test('normalizeCall 拆出域、动词与关键参数，二级域保留工具名这一级', () => {
  const grouped = normalizeCall(['orchestrate', 'ledger', 'update', '--ledger', '/s/l', '--node', 'impl-a', '--input', '/s/pass.json']);
  assert.equal(grouped.domain, 'orchestrate ledger');
  assert.equal(grouped.verb, 'update');
  assert.equal(grouped.observable, true);
  assert.deepEqual(grouped.key_params, { ledger: '/s/l', node: 'impl-a', input: '/s/pass.json' });

  assert.equal(normalizeCall(['verify', 'record-review', '--run', 'r', '--stdin']).label, 'agentkit verify record-review');
  assert.equal(normalizeCall(['verify', 'record-review', '--run', 'r', '--stdin']).key_params.stdin, true);

  for (const argv of [['docs'], ['capabilities', '--json'], ['doctor'], ['worktree', 'list'], ['worktree', 'scan'], ['verify', 'readiness'], ['worktree', '--help'], ['--version'], ['orchestrate', 'ledger', 'status', '--ledger', 'l'], ['verify', 'inspect', '--run', 'r'], ['worktree']]) {
    assert.equal(normalizeCall(argv).observable, false, argv.join(' '));
  }
});

test('白名单匹配到子动词一级：watch-service status 只读，install 不是', () => {
  // issue #15 的缺陷 3：用例 3 两次「不符合」观测到的都是 `worktree watch-service status`，
  // 那是 manage-worktrees 强制流程「恢复/盘点」阶段的第一步，只读、也不暴露路由去向。
  const readonly = normalizeCall(['worktree', 'watch-service', 'status', '--json']);
  assert.equal(readonly.observable, false);
  assert.equal(readonly.subverb, 'status');
  assert.match(readonly.reason, /只读组合/u);

  // `install` 会装一个 LaunchAgent，绝不能因为共用 `watch-service` 这个动词被一起放掉。
  for (const subverb of ['install', 'uninstall']) {
    const call = normalizeCall(['worktree', 'watch-service', subverb]);
    assert.equal(call.observable, true, subverb);
    assert.equal(call.label, `agentkit worktree watch-service ${subverb}`, '标签要带到子动词一级，否则报告里两者印出来是同一行字');
  }
});

test('强制流程前置步骤与只读分开列：worktree resume-all 有副作用，但不暴露路由去向', () => {
  const call = normalizeCall(['worktree', 'resume-all', '--json']);
  assert.equal(call.observable, false);
  assert.match(call.reason, /流程前置步骤/u);
  assert.ok(!call.reason.includes('只读'), '它不是只读命令，理由里不该说成只读');
  assert.ok(!READONLY_PAIRS.has('worktree resume-all'), '不得混进只读白名单');
  assert.ok(PROCESS_PRELUDE_PAIRS.has('worktree resume-all'));
});

test('manage-worktrees 强制流程的整段盘点走完之后，观测量仍然是随后的那个真调用', () => {
  // 强制流程：watch-service status → resume-all → list → doctor → scan → spawn。
  // 一个照着协议走的会话必然是这个形状；前五步一个都不该变成观测量。
  const clean = { status: '', head: 'e'.repeat(40) };
  const result = classify(session(clean, [
    { tool_name: 'Bash', command: 'agentkit worktree watch-service status --json', repo: clean },
    { tool_name: 'Bash', command: 'agentkit worktree resume-all --json', repo: clean },
    { tool_name: 'Bash', command: 'agentkit worktree list --json', repo: clean },
    { tool_name: 'Bash', command: 'agentkit worktree doctor --json', repo: clean },
    { tool_name: 'Bash', command: 'agentkit worktree scan --target src/sum.mjs src/greet.mjs', repo: clean },
    { tool_name: 'Bash', command: 'agentkit worktree spawn sum-boundary --agent claude-code --agent-id a1 --purpose x', repo: clean },
  ]));
  assert.equal(result.observation, 'agentkit worktree spawn');
  assert.equal(result.observed_at, 6);
  assert.deepEqual(result.calls.filter((call) => call.observable).map((call) => call.label), ['agentkit worktree spawn']);
});

test('整条会话都没有可观测调用、也没有写操作时观测量是 NONE', () => {
  const clean = { status: '', head: 'd'.repeat(40) };
  const result = classify(session(clean, [
    { tool_name: 'Bash', command: 'agentkit docs verify evidence-package', repo: clean },
    { tool_name: 'Read', command: undefined, repo: clean },
  ]));
  assert.equal(result.observation, 'NONE');
  assert.equal(result.observed_at, null);
});
