// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isHelpRequest, renderCliHelp, specOptionNames } from './cli-help.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

// 每个脚本至少验一条“真实命令 + 真实参数”的行，确保清单来自 CLI_SPEC 而不是占位文案。
const CLIS = [
  ['contract-tool.mjs', ['normalize --input <value>', 'project --input <value> --items <value> [--contract-id <value>]']],
  ['orchestration-ledger.mjs', ['init --contract <value> [--state-root <value>]', 'attach --ledger <value> --node <value> --type <value>']],
  ['worker-capability-preflight.mjs', ['check --requirements <value> [--effective <value>]']],
  ['review-budget.mjs', ['evaluate --policy <value> --history <value> --request <value>']],
  ['orchestration-reflection.mjs', ['propose --state-root <value> --reflection <value> --input <value>']],
];

test('五个 CLI 对 --help / -h / help / 无参数都打印命令与参数清单并退出 0', () => {
  for (const [script, expected] of CLIS) {
    for (const argv of [['--help'], ['-h'], ['help'], []]) {
      const result = spawnSync(process.execPath, [join(SCRIPTS, script), ...argv], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${script} ${argv.join(' ') || '<无参数>'}: ${result.stderr}`);
      assert.match(result.stdout, /^用法: node /u, script);
      assert.match(result.stdout, /\n命令:\n/u, script);
      for (const line of expected) assert.ok(result.stdout.includes(line), `${script} 帮助缺少「${line}」`);
    }
  }
});

test('未知命令仍返回各脚本原有的错误形状与非零退出，不被 --help 吞掉', () => {
  const run = (script) => spawnSync(process.execPath, [join(SCRIPTS, script), 'definitely-not-a-command'], { encoding: 'utf8' });
  for (const script of ['contract-tool.mjs', 'orchestration-ledger.mjs', 'review-budget.mjs']) {
    const result = run(script);
    assert.equal(result.status, 2, `${script}: ${result.stdout}`);
    assert.ok(JSON.parse(result.stderr).error, script);
  }
  for (const [script, prefix] of [['worker-capability-preflight.mjs', 'worker capability preflight error'], ['orchestration-reflection.mjs', 'orchestration reflection error']]) {
    const result = run(script);
    assert.equal(result.status, 2, `${script}: ${result.stdout}`);
    assert.ok(result.stderr.startsWith(prefix), `${script}: ${result.stderr}`);
  }
});

test('帮助清单由 CLI_SPEC 表机械渲染，required / optional / flag 各自成形', () => {
  const help = renderCliHelp('demo.mjs', { only: {}, run: { required: ['a'], optional: ['b'], flags: ['c'] } }, ['说明行']);
  assert.match(help, /^用法: node demo\.mjs <command> \[options\]\n/u);
  assert.match(help, /\n {2}only\n/u);
  assert.match(help, /\n {2}run --a <value> \[--b <value>\] \[--c\]\n/u);
  assert.match(help, /\n说明:\n {2}说明行\n/u);
  assert.deepEqual(specOptionNames({ required: ['a'], optional: ['b'], flags: ['c'] }), ['a', 'b']);
});

test('无参数与三个求助 token 都算求助，真实命令不算', () => {
  for (const argv of [[], ['--help'], ['-h'], ['help']]) assert.equal(isHelpRequest(argv), true, JSON.stringify(argv));
  for (const argv of [['status'], ['helper'], ['--helpful']]) assert.equal(isHelpRequest(argv), false, JSON.stringify(argv));
});
