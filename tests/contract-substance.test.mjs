import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  SCAFFOLD_ARGV, SCAFFOLD_CHECK_ID, contractSubstance, coverageSubstance, profileSubstance, substanceWarnings,
} from '../core/contract-substance.mjs';
import { main as contractMain } from '../domains/orchestrate/contract-tool.mjs';
import { main as ledgerMain, skillContentDigest as ledgerSkillDigest } from '../domains/orchestrate/orchestration-ledger.mjs';
import { main as verifyMain } from '../domains/verify/verification-runtime.mjs';
import { canonicalJson, envelopeDigest, main as loopMain, skillContentDigest as loopSkillDigest } from '../domains/loop/loop-runtime.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTRACT_TOOL = join(ROOT, 'domains', 'orchestrate', 'contract-tool.mjs');

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

// 把 scaffold 三件套填成"判据 #1、#2 都已通过"的样子，再按用例覆盖单个字段，
// 这样一次只暴露一条判据。摘要一律交给 verify digest 重算，测试不自己实现第二套摘要口径。
function filledFixture({ contract: contractOverrides = {}, profile: profileOverrides = {} } = {}) {
  const base = scaffoldFixture();
  const sign = (name, kind, value) => {
    const path = join(base.sandbox, `${name}.json`);
    writeFileSync(path, JSON.stringify(value));
    const signed = verifyMain(['digest', '--kind', kind, '--input', path]);
    writeFileSync(path, JSON.stringify(signed));
    return { path, value: signed };
  };
  const contract = sign('filled-contract', 'contract', {
    ...base.contract,
    objective: '让 README 的安装章节与真实命令一致',
    scope: { include: ['README.md'], exclude: [] },
    acceptance: [
      { contract_item_id: 'install-steps', requirement: 'README 安装命令与 package.json bin 逐字一致' },
      { contract_item_id: 'no-dead-link', requirement: 'README 中的相对链接都指向现存文件' },
    ],
    // loop init 与 ledger init 各自要求绑定本域当前摘要，否则连形状校验都到不了。
    skill_set: [...base.contract.skill_set,
      { name: 'run-agent-verify-loop', version: '1.0.0', content_digest: loopSkillDigest(), provider_mode: 'primary' },
      { name: 'orchestrate-subagents', version: '1.1.0', content_digest: ledgerSkillDigest(), provider_mode: 'primary' }],
    ...contractOverrides,
  });
  const profile = sign('filled-profile', 'profile', {
    ...base.profile,
    l0_checks: [{ check_id: 'readme-links', argv: ['node', '-e', 'process.exit(0)'], cwd_rel: '.', stage: 'both', timeout_ms: 30_000, expected_exit_codes: [0] }],
    l1_review: [{ contract_item_id: 'install-steps', lenses: ['functional', 'scope', 'verification_definition', 'safety'] }],
    ...profileOverrides,
  });
  return { ...base, contract: contract.value, contractPath: contract.path, profile: profile.value, profilePath: profile.path };
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

test('没被任何 L1 审到的 acceptance 在带 profile 的创建入口被拒，只有契约的入口报不出来', () => {
  const f = filledFixture();
  try {
    // profile 的 l1_review 只覆盖 install-steps，no-dead-link 一次都不会被审。
    const reason = 'acceptance[1].contract_item_id = "no-dead-link"：未被任何 l1_review 条目引用';
    assert.deepEqual(coverageSubstance(f.contract, f.profile).errors, [reason]);

    const report = verifyMain(['preflight', '--contract', f.contractPath, '--profile', f.profilePath, '--artifact', f.artifactPath]);
    assert.equal(report.valid, false);
    carries(report.errors.join('\n'), [reason]);
    assert.throws(() => loopMain(['init', '--contract', f.contractPath, '--profile', f.profilePath,
      '--provider', 'embedded', '--workdir', f.repo, '--state-root', join(f.sandbox, 'loop-state')]),
    (error) => carries(error.message, [reason]));

    // 单向绑定已有实现负责的方向不变：L1 引用不存在的 acceptance 仍然是形状错误。
    // 覆盖判据补的是反方向，而只拿到契约的入口做不到，所以不能在那里报。
    assert.equal(contractMain(['validate', '--input', f.contractPath]).valid, true);

    // 补齐覆盖后同一组入口放行；这条同时证明拒绝理由指向的就是可修的那一处。
    const covered = filledFixture({ profile: { l1_review: [
      { contract_item_id: 'install-steps', lenses: ['functional', 'scope'] },
      { contract_item_id: 'no-dead-link', lenses: ['functional', 'scope'] },
    ] } });
    try {
      assert.deepEqual(coverageSubstance(covered.contract, covered.profile).errors, []);
      assert.equal(verifyMain(['preflight', '--contract', covered.contractPath, '--profile', covered.profilePath, '--artifact', covered.artifactPath]).valid, true);
    } finally { covered.cleanup(); }
  } finally { f.cleanup(); }
});

test('write 合同缺 exclude / stop_conditions 只报 warning：valid 仍为 true，退出码仍为 0', () => {
  const write = { permissions: { mode: 'write', writable_paths: ['README.md'] }, scope: { include: ['README.md'], exclude: [] }, stop_conditions: [] };
  const f = filledFixture({ contract: write, profile: { l1_review: [
    { contract_item_id: 'install-steps', lenses: ['functional'] },
    { contract_item_id: 'no-dead-link', lenses: ['functional'] },
  ] } });
  try {
    const { errors, warnings } = contractSubstance(f.contract);
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 2);
    carries(warnings.join('\n'), ['scope.exclude 为空', 'stop_conditions 为空']);

    // contract validate：结论仍是 valid，退出码仍是 0，warning 只出现在输出里。
    const validated = contractMain(['validate', '--input', f.contractPath]);
    assert.equal(validated.valid, true);
    assert.deepEqual(validated.warnings, warnings);
    const cli = spawnSync(process.execPath, [CONTRACT_TOOL, 'validate', '--input', f.contractPath], { encoding: 'utf8' });
    assert.equal(cli.status, 0);
    assert.deepEqual(JSON.parse(cli.stdout).warnings, warnings);

    // 带 profile 的入口同样只是多带一段 warning，不改变 valid。
    const report = verifyMain(['preflight', '--contract', f.contractPath, '--profile', f.profilePath, '--artifact', f.artifactPath]);
    assert.equal(report.valid, true);
    assert.deepEqual(report.warnings, warnings);
    assert.deepEqual(report.errors, []);

    // ledger init 也是创建入口：照样放行，照样带出 warning。
    const ledger = ledgerMain(['init', '--contract', f.contractPath, '--state-root', join(f.sandbox, 'ledger-state')]);
    assert.deepEqual(ledger.warnings, warnings);
    // ledger doctor 把同一批理由降级：不进 findings，healthy 不变。
    const health = ledgerMain(['doctor', '--ledger', ledger.ledger_dir]);
    assert.equal(health.healthy, true);
    assert.deepEqual(health.findings, []);
    assert.deepEqual(health.substance_warnings, warnings);

    // 只要写入面划出了边界，或者声明了终止条件，对应那条就不再出现。
    const bounded = filledFixture({ contract: { ...write, scope: { include: ['README.md'], exclude: ['src/**'] }, stop_conditions: ['连续两轮同一失败指纹'] } });
    try { assert.deepEqual(contractSubstance(bounded.contract).warnings, []); } finally { bounded.cleanup(); }

    // read_only 合同本来就不靠 exclude / stop_conditions 划边界，不该被打扰。
    const readOnly = filledFixture();
    try {
      assert.equal(readOnly.contract.permissions.mode, 'read_only');
      assert.deepEqual(contractSubstance(readOnly.contract).warnings, []);
      assert.equal('warnings' in contractMain(['validate', '--input', readOnly.contractPath]), false);
    } finally { readOnly.cleanup(); }
  } finally { f.cleanup(); }
});

test('契约层判据按不可信输入读取，缺字段时不抛异常', () => {
  for (const value of [null, undefined, {}, { acceptance: 'x', scope: { include: 'x' } }]) {
    assert.deepEqual(contractSubstance(value), { errors: [], warnings: [] });
    assert.deepEqual(profileSubstance(value), { errors: [], warnings: [] });
  }
});

// 手工铺一个"判据出现之前冻结"的 loop state root：契约与 profile 都是原样 scaffold，
// 而 skill_provenance 的摘要与当前 runtime 一致，所以它不会被 skill drift 拦住。
// 当前 runtime 的 init 已经拒绝这种输入，只能绕过 init 直接落盘。
function frozenScaffoldStateRoot() {
  const f = scaffoldFixture();
  const stateRoot = join(f.sandbox, 'legacy-state');
  const loopId = 'legacy-loop';
  const loopDir = join(stateRoot, 'loops', loopId);
  mkdirSync(loopDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(loopDir, 'contract.json'), JSON.stringify(f.contract));
  writeFileSync(join(loopDir, 'profile.json'), JSON.stringify(f.profile));
  const now = '2026-01-01T00:00:00.000Z';
  const snapshot = {
    schema_version: 1,
    runtime_version: '1.0.0',
    loop_id: loopId,
    goal_ref: null,
    revision: 0,
    state: 'active',
    contract_digest: f.contract.contract_digest,
    verification_profile_digest: f.profile.verification_profile_digest,
    provider: 'verify-agent-output',
    limits: { max_iterations: 3, consecutive_identical_signature: 2 },
    policy: { on_failure: 'retry', escalation: [] },
    workdir: null,
    network_isolation_assurance: 'not_required',
    runtime_repository_identity: null,
    executable_identities: {},
    argv_file_identities: {},
    current_iteration: null,
    iterations: [],
    consumed_verification_run_ids: [],
    human_gate: { required: false, status: 'not_required' },
    skill_provenance: { name: 'run-agent-verify-loop', version: '1.0.0', content_digest: loopSkillDigest() },
    reflection_refs: [],
    improvement_proposal_refs: [],
    convergence_report_ref: null,
    terminal: null,
    created_at: now,
    updated_at: now,
  };
  const event = { schema_version: 1, revision: 0, kind: 'initialized', recorded_at: now, previous_event_digest: null, snapshot };
  event.event_digest = envelopeDigest(event, 'event_digest');
  writeFileSync(join(loopDir, 'events.ndjson'), `${canonicalJson(event)}\n`, { mode: 0o600 });
  writeFileSync(join(loopDir, 'snapshot.json'), `${canonicalJson(snapshot)}\n`, { mode: 0o600 });
  return { ...f, stateRoot, loopDir };
}

test('判据出现之前冻结的 loop：adopt-root 与 validate 仍然成功，doctor 只多一条 warning', () => {
  const f = frozenScaffoldStateRoot();
  try {
    // 崩溃恢复路径不重判实质性，否则历史状态在升级后连接管都做不到。
    assert.equal(loopMain(['adopt-root', '--state-root', f.stateRoot]).adopted, true);
    assert.equal(loopMain(['validate', '--loop', f.loopDir]).valid, true);

    // doctor 是只读回看：报得出来，但不改变 healthy，也不进 findings。
    const health = loopMain(['doctor', '--loop', f.loopDir]);
    assert.equal(health.healthy, true);
    assert.deepEqual(health.findings, []);
    assert.deepEqual(health.substance_warnings, substanceWarnings(f.contract, f.profile));
    carries(health.substance_warnings.join('\n'), [...contractSubstance(f.contract).errors, ...profileSubstance(f.profile).errors]);

    // 同一份契约走创建入口仍然被拒：降级只发生在回看路径上。
    assert.throws(() => loopMain(['init', '--contract', f.contractPath, '--profile', f.profilePath,
      '--provider', 'embedded', '--workdir', f.repo, '--state-root', join(f.sandbox, 'fresh-state')]),
    (error) => carries(error.message, contractSubstance(f.contract).errors));
  } finally { f.cleanup(); }
});

// 续跑与恢复入口若重判实质性，升级前冻结的状态会在续跑或崩溃恢复时失败。
// 上一个用例从行为上钉住了这一点，这里再用结构断言把接入点逐个钉在创建入口和 doctor 上。
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
  const substanceCall = /\b(?:contractSubstance|profileSubstance|coverageSubstance)\(/u;
  // doctor 口径单独一个入口，调用它就等于"只报不判"。
  const doctorCall = /\bsubstanceWarnings\(/u;

  for (const path of ['domains/orchestrate/contract-tool.mjs', 'domains/verify/verification-runtime.mjs', 'domains/loop/loop-runtime.mjs']) {
    assert.match(readFileSync(join(ROOT, path), 'utf8'), /from '\.\.\/\.\.\/core\/contract-substance\.mjs'/u, `${path} 未引用共享模块`);
  }

  // orchestrate：只有 validate 命令与 ledger init 打开 substance；doctor 只走降级口径。
  assert.deepEqual(callSites('domains/orchestrate/contract-tool.mjs', substanceCall), ['validateContract']);
  assert.deepEqual(callSites('domains/orchestrate/contract-tool.mjs', /substance: true/u), ['main']);
  assert.deepEqual(callSites('domains/orchestrate/orchestration-ledger.mjs', /substance: true/u), ['init']);
  assert.deepEqual(callSites('domains/orchestrate/orchestration-ledger.mjs', doctorCall), ['doctor']);

  // verify：只在 inspectValues 里判定，而 inspectValues 只服务 preflight、init、prepare-run。
  const verify = 'domains/verify/verification-runtime.mjs';
  assert.deepEqual(callSites(verify, substanceCall), ['inspectValues']);
  assert.deepEqual(callSites(verify, doctorCall), ['doctor']);
  assert.deepEqual(callSites(verify, /\binspectValues\(/u), ['inspectInputs', 'inspectValues', 'prepareRun']);
  assert.deepEqual(callSites(verify, /\binspectInputs\(/u), ['initialize', 'inspectInputs', 'preflight']);

  // loop：只在 initialize 里判定，adopt-root、record-embedded-review、validate 不重判。
  assert.deepEqual(callSites('domains/loop/loop-runtime.mjs', substanceCall), ['initialize']);
  assert.deepEqual(callSites('domains/loop/loop-runtime.mjs', doctorCall), ['doctor']);
});
