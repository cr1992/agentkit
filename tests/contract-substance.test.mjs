import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  SCAFFOLD_ARGV, SCAFFOLD_CHECK_ID, contractSubstance, profileSubstance,
} from '../core/contract-substance.mjs';
import { main as contractMain } from '../domains/orchestrate/contract-tool.mjs';
import { main as ledgerMain } from '../domains/orchestrate/orchestration-ledger.mjs';
import { main as verifyMain } from '../domains/verify/verification-runtime.mjs';
import { main as loopMain } from '../domains/loop/loop-runtime.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// 一个干净的单提交仓库，外加由 verify scaffold 原样生成的三件套。
function scaffoldFixture() {
  const sandbox = mkdtempSync(join(tmpdir(), 'contract-substance-'));
  const repo = join(sandbox, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Substance Test']);
  git(repo, ['config', 'user.email', 'substance@example.invalid']);
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'chore: base']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  const write = (name, value) => { const path = join(sandbox, name); writeFileSync(path, JSON.stringify(value)); return path; };
  const contract = verifyMain(['scaffold', '--kind', 'contract', '--workdir', repo]);
  const profile = verifyMain(['scaffold', '--kind', 'profile']);
  const artifact = verifyMain(['scaffold', '--kind', 'artifact', '--workdir', repo, '--base-sha', head]);
  return {
    sandbox, repo, contract, profile,
    contractPath: write('contract.json', contract),
    profilePath: write('profile.json', profile),
    artifactPath: write('artifact.json', artifact),
    cleanup: () => rmSync(sandbox, { recursive: true, force: true }),
  };
}

/** 断言 message 含全部 expected 原因且不含任何 absent 原因。 */
function carries(message, expected, absent = []) {
  for (const reason of expected) assert.ok(message.includes(reason), `缺少原因：${reason}\n实际：${message}`);
  for (const reason of absent) assert.ok(!message.includes(reason), `不应出现：${reason}\n实际：${message}`);
  return true;
}

test('scaffold 原样生成的契约与 profile 在全部创建入口被拒，契约层原因逐字一致', () => {
  const f = scaffoldFixture();
  try {
    const contractReasons = contractSubstance(f.contract).errors;
    const profileReasons = profileSubstance(f.profile).errors;
    assert.equal(contractReasons.length, 3);
    assert.equal(profileReasons.length, 2);

    // 只有契约的入口：只报契约层。
    assert.throws(() => contractMain(['validate', '--input', f.contractPath]),
      (error) => carries(error.message, contractReasons, profileReasons));
    assert.throws(() => ledgerMain(['init', '--contract', f.contractPath, '--state-root', join(f.sandbox, 'ledger-state')]),
      (error) => carries(error.message, contractReasons, profileReasons));

    // 带 profile 的入口：两层都报。
    const report = verifyMain(['preflight', '--contract', f.contractPath, '--profile', f.profilePath, '--artifact', f.artifactPath]);
    assert.equal(report.valid, false);
    carries(report.errors.join('\n'), [...contractReasons, ...profileReasons]);
    assert.throws(() => verifyMain(['init', '--contract', f.contractPath, '--profile', f.profilePath, '--artifact', f.artifactPath,
      '--workdir', f.repo, '--isolation-assurance', 'host_reported', '--state-root', join(f.sandbox, 'verify-state')]),
    (error) => carries(error.message, [...contractReasons, ...profileReasons]));
    assert.throws(() => loopMain(['init', '--contract', f.contractPath, '--profile', f.profilePath,
      '--provider', 'embedded', '--state-root', join(f.sandbox, 'loop-state')]),
    (error) => carries(error.message, [...contractReasons, ...profileReasons]));

    // prepare-run 默认输出紧凑结果，拒绝原因也要带出来，不能只剩 invalid_input。
    const cli = spawnSync(process.execPath, [join(ROOT, 'domains', 'verify', 'verification-runtime.mjs'), 'prepare-run',
      '--contract', f.contractPath, '--profile', f.profilePath, '--artifact', f.artifactPath, '--workdir', f.repo,
      '--isolation-assurance', 'host_reported', '--state-root', join(f.sandbox, 'prepare-state')], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0);
    const compact = JSON.parse(cli.stdout);
    assert.equal(compact.status, 'invalid_input');
    assert.equal(compact.prepared, false);
    carries(compact.errors.join('\n'), [...contractReasons, ...profileReasons]);
  } finally { f.cleanup(); }
});

test('profile 哨兵的两个分支各自独立触发，只改名或只换命令都绕不过去', () => {
  const real = { check_id: 'unit', argv: ['node', '-e', 'process.exit(0)'] };
  const scaffold = { check_id: SCAFFOLD_CHECK_ID, argv: [...SCAFFOLD_ARGV] };
  const reasons = (checks) => profileSubstance({ l0_checks: checks }).errors;

  const renamedOnly = reasons([{ ...scaffold, check_id: 'renamed' }]);
  assert.equal(renamedOnly.length, 1);
  assert.match(renamedOnly[0], /^l0_checks\[\*\]\.argv/u);

  const argvOnly = reasons([{ ...scaffold, argv: real.argv }]);
  assert.equal(argvOnly.length, 1);
  assert.match(argvOnly[0], /^l0_checks\[0\]\.check_id/u);

  // 只要还有一条真实检查，argv 分支就不触发；占位 check_id 仍逐条报出。
  assert.deepEqual(reasons([real, { ...scaffold, check_id: 'env' }]), []);
  assert.equal(reasons([real, scaffold]).length, 1);
  assert.deepEqual(reasons([real]), []);
});

test('契约层判据按不可信输入读取，缺字段时不抛异常', () => {
  for (const value of [null, undefined, {}, { acceptance: 'x', scope: { include: 'x' } }]) {
    assert.deepEqual(contractSubstance(value), { errors: [], warnings: [] });
    assert.deepEqual(profileSubstance(value), { errors: [], warnings: [] });
  }
});

// 续跑与恢复入口若重判实质性，升级前冻结的状态会在续跑或崩溃恢复时失败。
// 升级前的状态无法用当前 runtime 构造，所以这里用结构断言把接入点钉在创建入口上。
test('实质性检查只接在创建入口，五份校验实现共用同一模块', () => {
  const source = (path) => readFileSync(join(ROOT, path), 'utf8').split('\n');
  const callSites = (path, pattern) => {
    let current = '<top>';
    const sites = new Set();
    for (const line of source(path)) {
      const declared = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/u);
      if (declared) current = declared[1];
      if (pattern.test(line) && !/^\s*(?:\/\/|\*)/u.test(line) && !/^import\b/u.test(line)) sites.add(current);
    }
    return [...sites].sort();
  };
  const substanceCall = /\b(?:contractSubstance|profileSubstance)\(/u;

  for (const path of ['domains/orchestrate/contract-tool.mjs', 'domains/verify/verification-runtime.mjs', 'domains/loop/loop-runtime.mjs']) {
    assert.match(readFileSync(join(ROOT, path), 'utf8'), /from '\.\.\/\.\.\/core\/contract-substance\.mjs'/u, `${path} 未引用共享模块`);
  }

  // orchestrate：只有 validate 命令与 ledger init 打开 substance。
  assert.deepEqual(callSites('domains/orchestrate/contract-tool.mjs', substanceCall), ['validateContract']);
  assert.deepEqual(callSites('domains/orchestrate/contract-tool.mjs', /substance: true/u), ['main']);
  assert.deepEqual(callSites('domains/orchestrate/orchestration-ledger.mjs', /substance: true/u), ['init']);

  // verify：只在 inspectValues 里判定，而 inspectValues 只服务 preflight、init、prepare-run。
  const verify = 'domains/verify/verification-runtime.mjs';
  assert.deepEqual(callSites(verify, substanceCall), ['inspectValues']);
  assert.deepEqual(callSites(verify, /\binspectValues\(/u), ['inspectInputs', 'inspectValues', 'prepareRun']);
  assert.deepEqual(callSites(verify, /\binspectInputs\(/u), ['initialize', 'inspectInputs', 'preflight']);

  // loop：只在 initialize 里判定，adopt-root、record-embedded-review、validate 不重判。
  assert.deepEqual(callSites('domains/loop/loop-runtime.mjs', substanceCall), ['initialize']);
});
