import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  OperationalAbort,
  RUNTIME_VERSION,
  ValidationError,
  acquireLock,
  canonicalJson,
  envelopeDigest,
  main,
  parseJsonStrict,
  releaseLock,
  skillContentDigest,
} from './verification-runtime.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeFixture(options = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), 'verification-runtime-test-'));
  const repo = join(sandbox, 'repo');
  const stateRoot = join(sandbox, 'state');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Verification Test']);
  git(repo, ['config', 'user.email', 'verification@example.invalid']);
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'chore: base']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'README.md'), 'artifact\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'feat: artifact']);
  const artifactSha = git(repo, ['rev-parse', 'HEAD']);
  const digest = skillContentDigest();
  const contract = {
    schema_version: 1,
    contract_id: 'contract-1',
    objective: '验证冻结 Artifact',
    scope: { include: ['README.md'], exclude: [] },
    acceptance: [{ contract_item_id: 'content', requirement: 'README 必须满足合同' }],
    permissions: { mode: 'read_only', writable_paths: [] },
    environment: { repository: repo, isolation: 'caller_supplied' },
    skill_set: [{ name: 'verify-agent-output', version: '1.0.0', content_digest: digest, provider_mode: 'primary' }],
    stop_conditions: [],
    extensions: options.contractExtensions ?? {},
  };
  contract.contract_digest = envelopeDigest(contract, 'contract_digest');
  const script = options.script ?? 'process.stdout.write("Bearer secret-token-value\\n")';
  const profile = {
    schema_version: 1,
    profile_id: 'profile-1',
    l0_checks: [{ check_id: 'unit', argv: ['node', '-e', script], cwd_rel: '.', stage: 'both', timeout_ms: 10_000, expected_exit_codes: [0] }],
    l1_review: [{ contract_item_id: 'content', lenses: ['functional', 'scope', 'verification_definition', 'safety'] }],
    protected_verifier_paths: options.protectedPaths ?? [],
    allowed_validation_changes: options.allowedPaths ?? [],
    runtime: {
      env_allowlist: ['PATH'],
      executable_paths: { node: process.execPath },
      cache_policy: 'trusted_identity',
      network_policy: 'contract_authorized',
      max_log_bytes: 64 * 1024,
    },
    human_gate: 'none',
  };
  profile.verification_profile_digest = envelopeDigest(profile, 'verification_profile_digest');
  const artifact = {
    schema_version: 1,
    provider: 'caller-supplied',
    repository_id: 'fixture-repository',
    object_format: 'sha1',
    base_sha: baseSha,
    artifact_sha: artifactSha,
  };
  for (const [name, value] of Object.entries({ contract, profile, artifact })) writeFileSync(join(sandbox, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  const cleanup = () => rmSync(sandbox, { recursive: true, force: true });
  return { sandbox, repo, stateRoot, contract, profile, artifact, cleanup };
}

function initialize(fixture) {
  const initialized = main(['init', '--contract', join(fixture.sandbox, 'contract.json'), '--profile', join(fixture.sandbox, 'profile.json'), '--artifact', join(fixture.sandbox, 'artifact.json'), '--workdir', fixture.repo, '--state-root', fixture.stateRoot, '--isolation-assurance', 'host_reported']);
  fixture.reviewNonce = initialized.review_challenge_nonce;
  return initialized;
}

function validReview(fixture, verdict = 'no_defect_found') {
  const review = {
    schema_version: 1,
    review_result_id: 'review-1',
    contract_digest: fixture.contract.contract_digest,
    verification_profile_digest: fixture.profile.verification_profile_digest,
    artifact_ref: fixture.artifact,
    challenge_nonce: fixture.reviewNonce,
    verdict,
    findings: verdict === 'no_defect_found' ? [] : [{ contract_item_id: 'content', class: 'functional', evidence: 'README mismatch', expected: 'contract content', actual: 'different content' }],
    forensics: verdict === 'no_defect_found' ? ['read README and checked contract'] : [],
  };
  review.review_result_digest = envelopeDigest(review, 'review_result_digest');
  return review;
}

test('strict JSON 拒绝重复 key，canonical digest 不依赖 key 顺序', () => {
  assert.throws(() => parseJsonStrict('{"a":1,"a":2}'), ValidationError);
  const proto = parseJsonStrict('{"__proto__":{"polluted":true}}');
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(proto.__proto__.polluted, true);
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalJson({ z: -0, a: 1e30, b: 1e-7, c: 0.000001 }), '{"a":1e+30,"b":1e-7,"c":0.000001,"z":0}');
  assert.throws(() => parseJsonStrict('"\\ud800"'), /surrogate/);
  assert.equal(envelopeDigest({ b: 2, a: 1 }, 'digest'), envelopeDigest({ a: 1, b: 2 }, 'digest'));
});

test('skill tree digest 不依赖安装绝对路径', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'skill-digest-test-'));
  try {
    for (const root of [join(sandbox, 'one'), join(sandbox, 'two')]) {
      mkdirSync(join(root, 'agents'), { recursive: true });
      mkdirSync(join(root, 'scripts'), { recursive: true });
      writeFileSync(join(root, 'SKILL.md'), 'same\n');
      writeFileSync(join(root, 'agents', 'openai.yaml'), 'same\n');
      writeFileSync(join(root, 'scripts', 'runtime.mjs'), 'same\n');
    }
    assert.equal(skillContentDigest(join(sandbox, 'one')), skillContentDigest(join(sandbox, 'two')));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('发布的 v1 JSON Schema 均为严格可解析 JSON', () => {
  const schemaDir = join(SCRIPT_DIR, '..', '..', 'schemas');
  for (const name of ['task-contract-v1.schema.json', 'verification-profile-v1.schema.json', 'artifact-ref-v1.schema.json', 'review-result-v1.schema.json', 'evidence-package-v1.schema.json', 'reflection-record-v1.schema.json', 'improvement-proposal-v1.schema.json']) {
    assert.doesNotThrow(() => parseJsonStrict(readFileSync(join(schemaDir, name), 'utf8')), name);
  }
});

test('scaffold/digest 生成可复用骨架并冻结当前 Skill 摘要', () => {
  const fixture = makeFixture();
  try {
    const contract = main(['scaffold', '--kind', 'contract', '--workdir', fixture.repo]);
    assert.equal(contract.contract_digest, envelopeDigest(contract, 'contract_digest'));
    assert.equal(contract.skill_set[0].content_digest, skillContentDigest());
    const profile = main(['scaffold', '--kind', 'profile']);
    assert.equal(profile.verification_profile_digest, envelopeDigest(profile, 'verification_profile_digest'));
    assert.equal(profile.runtime.cache_policy, 'trusted_identity');
    const artifact = main(['scaffold', '--kind', 'artifact', '--workdir', fixture.repo, '--base-sha', fixture.artifact.base_sha]);
    assert.equal(artifact.artifact_sha, fixture.artifact.artifact_sha);

    delete profile.verification_profile_digest;
    const path = join(fixture.sandbox, 'profile-without-digest.json');
    writeFileSync(path, JSON.stringify(profile));
    const digested = main(['digest', '--kind', 'profile', '--input', path]);
    assert.equal(digested.verification_profile_digest, envelopeDigest(digested, 'verification_profile_digest'));
    assert.throws(() => main(['scaffold']), /contract\|profile\|artifact\|review\|bundle/);
    assert.throws(() => main(['digest', '--unknown', 'value']), /digest --kind contract\|profile\|review --input/);
    assert.throws(() => main(['digest', '--kind', 'profile']), /digest --kind contract\|profile\|review --input/);
  } finally { fixture.cleanup(); }
});

test('prepare-run 只读规范化输入并一次完成 readiness、preflight 与 init', () => {
  const fixture = makeFixture();
  try {
    const contractPath = join(fixture.sandbox, 'contract.json');
    const profilePath = join(fixture.sandbox, 'profile.json');
    const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
    const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
    contract.contract_digest = 'placeholder';
    delete profile.verification_profile_digest;
    writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
    const before = { contract: readFileSync(contractPath, 'utf8'), profile: readFileSync(profilePath, 'utf8') };

    const cli = spawnSync(process.execPath, [
      join(SCRIPT_DIR, 'verification-runtime.mjs'), 'prepare-run',
      '--contract', contractPath, '--profile', profilePath, '--artifact', join(fixture.sandbox, 'artifact.json'),
      '--workdir', fixture.repo, '--state-root', fixture.stateRoot, '--isolation-assurance', 'host_reported',
    ], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    const compact = JSON.parse(cli.stdout);
    assert.equal(compact.prepared, true);
    assert.equal(compact.status, 'initialized');
    assert.deepEqual(compact.failed_checks, []);
    assert.equal(readFileSync(contractPath, 'utf8'), before.contract, '源 contract 不得被改写');
    assert.equal(readFileSync(profilePath, 'utf8'), before.profile, '源 profile 不得被改写');
    const frozenContract = JSON.parse(readFileSync(join(compact.run_dir, 'contract.json'), 'utf8'));
    const frozenProfile = JSON.parse(readFileSync(join(compact.run_dir, 'profile.json'), 'utf8'));
    assert.equal(frozenContract.contract_digest, envelopeDigest(frozenContract, 'contract_digest'));
    assert.equal(frozenProfile.verification_profile_digest, envelopeDigest(frozenProfile, 'verification_profile_digest'));
  } finally { fixture.cleanup(); }
});

test('CLI 子命令支持 --help，状态变更默认 compact 且 --verbose 保留完整 snapshot', () => {
  const fixture = makeFixture();
  try {
    const script = join(SCRIPT_DIR, 'verification-runtime.mjs');
    const help = spawnSync(process.execPath, [script, 'record-review', '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /record-review --run/);
    assert.equal(help.stderr, '');

    const initialized = initialize(fixture);
    const compactCli = spawnSync(process.execPath, [script, 'run-smoke', '--run', initialized.run_dir], { encoding: 'utf8' });
    assert.equal(compactCli.status, 0, compactCli.stderr);
    const compact = JSON.parse(compactCli.stdout);
    assert.deepEqual(Object.keys(compact), ['run_id', 'revision', 'status', 'failed_checks', 'evidence_digest']);
    assert.equal(compact.status, 'smoke_passed');
    assert.equal(compact.revision, 1);

    const nextFixture = makeFixture();
    try {
      const next = initialize(nextFixture);
      const verboseCli = spawnSync(process.execPath, [script, 'run-smoke', '--run', next.run_dir, '--verbose'], { encoding: 'utf8' });
      assert.equal(verboseCli.status, 0, verboseCli.stderr);
      const verbose = JSON.parse(verboseCli.stdout);
      assert.equal(verbose.status, 'smoke_passed');
      assert.equal(verbose.stages.smoke_l0.passed, true);
      assert.equal(verbose.contract_digest, nextFixture.contract.contract_digest);
    } finally { nextFixture.cleanup(); }
  } finally { fixture.cleanup(); }
});

test('record-review --stdin 接收结构化 reviewer 结果、自动补 digest 且不需要临时文件', () => {
  const fixture = makeFixture();
  try {
    const initialized = initialize(fixture);
    main(['run-smoke', '--run', initialized.run_dir]);
    const review = validReview(fixture);
    delete review.review_result_digest;
    const cli = spawnSync(process.execPath, [
      join(SCRIPT_DIR, 'verification-runtime.mjs'), 'record-review',
      '--run', initialized.run_dir, '--stdin', '--verifier-run-id', 'stdin-reviewer',
      '--isolation-assurance', 'host_reported', '--expected-revision', '1',
    ], { encoding: 'utf8', input: JSON.stringify(review) });
    assert.equal(cli.status, 0, cli.stderr);
    const compact = JSON.parse(cli.stdout);
    assert.equal(compact.status, 'review_recorded');
    assert.equal(compact.revision, 2);
    const persisted = JSON.parse(readFileSync(join(initialized.run_dir, 'review-result.json'), 'utf8'));
    assert.equal(persisted.review_result_digest, envelopeDigest(persisted, 'review_result_digest'));
  } finally { fixture.cleanup(); }
});

test('preflight 与 init 一次汇总 Profile 形状、枚举、摘要和隔离 assurance 错误', () => {
  const fixture = makeFixture();
  try {
    delete fixture.profile.runtime.cache_policy;
    fixture.profile.l1_review = [{}];
    fixture.profile.human_gate = 'sometimes';
    fixture.profile.runtime.network_policy = 'denied';
    fixture.profile.verification_profile_digest = 'sha256:bad';
    writeFileSync(join(fixture.sandbox, 'profile.json'), JSON.stringify(fixture.profile));
    const args = ['--contract', join(fixture.sandbox, 'contract.json'), '--profile', join(fixture.sandbox, 'profile.json'), '--artifact', join(fixture.sandbox, 'artifact.json')];
    const report = main(['preflight', ...args]);
    assert.equal(report.valid, false);
    const combined = report.errors.join('\n');
    for (const expected of ['cache_policy', 'contract_item_id', 'human_gate', 'verification_profile_digest', 'network-isolated']) assert.match(combined, new RegExp(expected));
    const cli = spawnSync(process.execPath, [join(SCRIPT_DIR, 'verification-runtime.mjs'), 'preflight', ...args], { encoding: 'utf8' });
    assert.equal(cli.status, 2);
    assert.equal(JSON.parse(cli.stdout).valid, false);
    assert.throws(() => main(['init', ...args, '--workdir', fixture.repo, '--state-root', fixture.stateRoot, '--isolation-assurance', 'host_reported']), /cache_policy[\s\S]*human_gate|human_gate[\s\S]*cache_policy/);
  } finally { fixture.cleanup(); }
});

test('Reflection 验证不可变证据并脱敏，Proposal 永远停留在 proposed', () => {
  const fixture = makeFixture();
  try {
    const initialized = initialize(fixture);
    main(['run-smoke', '--run', initialized.run_dir]);
    const reviewPath = join(fixture.sandbox, 'review-reflection.json');
    writeFileSync(reviewPath, JSON.stringify(validReview(fixture)));
    main(['record-review', '--run', initialized.run_dir, '--review', reviewPath, '--verifier-run-id', 'reflection-reviewer', '--isolation-assurance', 'host_reported']);
    const terminal = main(['run-final', '--run', initialized.run_dir]);
    const evidenceBytes = readFileSync(join(initialized.run_dir, 'evidence.json'));
    const evidenceDigest = `sha256:${createHash('sha256').update(evidenceBytes).digest('hex')}`;
    const reflectionInput = join(fixture.sandbox, 'reflection-input.json');
    writeFileSync(reflectionInput, JSON.stringify({ trigger: 'unexpected_outcome', classification: 'verification_gap', observation: `Bearer hidden-token at /Users/example/project`, evidence_refs: [{ type: 'evidence', id: 'evidence.json', digest: evidenceDigest }], impact: 'medium', confidence: 'high', recommended_disposition: 'continue' }));
    const reflected = main(['record-reflection', '--run', initialized.run_dir, '--input', reflectionInput]);
    assert.equal(reflected.terminal.evidence_digest, terminal.terminal.evidence_digest);
    const reflectionRef = reflected.reflection_refs[0].ref;
    const reflection = JSON.parse(readFileSync(join(initialized.run_dir, reflectionRef), 'utf8'));
    assert.equal(reflection.observation.includes('hidden-token'), false);
    assert.equal(reflection.observation.includes('/Users/'), false);

    const proposalInput = join(fixture.sandbox, 'proposal-input.json');
    writeFileSync(proposalInput, JSON.stringify({ problem_type: 'skill_gap', proposed_change: '增加一个可回放的边界检查', affected_scope: ['verification profile'], counterexamples: [], validation_plan: { replay_cases: ['case-1'], regression_suites: ['runtime'], independent_review: 'required' }, lifecycle: 'proposed' }));
    const proposed = main(['propose-improvement', '--run', initialized.run_dir, '--reflection', reflectionRef, '--input', proposalInput]);
    const proposal = JSON.parse(readFileSync(join(initialized.run_dir, proposed.improvement_proposal_refs[0].ref), 'utf8'));
    assert.equal(proposal.lifecycle, 'proposed');
    assert.equal(main(['validate', '--run', initialized.run_dir]).valid, true);
  } finally { fixture.cleanup(); }
});

test('反思面拒绝无证据高置信输入，且不改变验收终态', () => {
  const fixture = makeFixture();
  try {
    const initialized = initialize(fixture);
    main(['run-smoke', '--run', initialized.run_dir]);
    const bad = join(fixture.sandbox, 'bad-reflection.json');
    writeFileSync(bad, JSON.stringify({ trigger: 'runtime_abort', classification: 'tool_gap', observation: '没有稳定证据', evidence_refs: [], impact: 'low', confidence: 'high', recommended_disposition: 'continue' }));
    const before = main(['status', '--run', initialized.run_dir]);
    assert.throws(() => main(['record-reflection', '--run', initialized.run_dir, '--input', bad]), /只能是 low confidence/);
    const after = main(['status', '--run', initialized.run_dir]);
    assert.equal(after.revision, before.revision);
    assert.equal(after.status, before.status);
  } finally { fixture.cleanup(); }
});

test('一次性验收按 smoke → L1 → final 生成可验证 Evidence', () => {
  const fixture = makeFixture();
  try {
    const initialized = initialize(fixture);
    const smoke = main(['run-smoke', '--run', initialized.run_dir, '--expected-revision', '0']);
    assert.equal(smoke.status, 'smoke_passed');
    const input = main(['review-input', '--run', initialized.run_dir]);
    assert.equal(input.reviewer_view[0].contract_item_id, 'content');
    assert.equal(input.contract_digest, fixture.contract.contract_digest);
    assert.equal(input.verification_profile_digest, fixture.profile.verification_profile_digest);
    assert.equal(JSON.stringify(input).includes('Bearer secret-token-value'), true, 'argv 属于冻结验证入口');
    const reviewInputPath = join(fixture.sandbox, 'review-input.json');
    writeFileSync(reviewInputPath, JSON.stringify(input));
    const reviewScaffold = main(['scaffold', '--kind', 'review', '--review-input', reviewInputPath]);
    assert.equal(reviewScaffold.contract_digest, input.contract_digest);
    assert.equal(reviewScaffold.verification_profile_digest, input.verification_profile_digest);
    assert.equal(reviewScaffold.verdict, 'undecidable');
    assert.equal(reviewScaffold.findings[0].contract_item_id, 'content');
    const logPath = join(initialized.run_dir, smoke.stages.smoke_l0.checks[0].log_ref);
    assert.equal(readFileSync(logPath, 'utf8').includes('secret-token-value'), false, '日志必须预写脱敏');
    const review = validReview(fixture);
    const reviewPath = join(fixture.sandbox, 'review.json');
    writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    const recorded = main(['record-review', '--run', initialized.run_dir, '--review', reviewPath, '--verifier-run-id', 'verifier-opaque-1', '--isolation-assurance', 'host_reported', '--expected-revision', '1']);
    assert.equal(recorded.status, 'review_recorded');
    const terminal = main(['run-final', '--run', initialized.run_dir, '--expected-revision', '2']);
    assert.equal(terminal.terminal.outcome, 'pass');
    const validated = main(['validate', '--run', initialized.run_dir]);
    assert.equal(validated.valid, true);
    assert.match(validated.evidence_digest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    fixture.cleanup();
  }
});

test('smoke/L1 非 pass 终态都生成结构完整且可验证的 Evidence', () => {
  const cases = [
    { name: 'smoke fail', fixture: () => makeFixture({ script: 'process.exit(7)' }), outcome: 'fail', smokeOnly: true },
    { name: 'L1 fail', fixture: () => makeFixture(), outcome: 'fail', verdict: 'fail' },
    { name: 'L1 undecidable', fixture: () => makeFixture(), outcome: 'undecidable', verdict: 'undecidable' },
    { name: 'safety block', fixture: () => makeFixture(), outcome: 'blocked_safety', verdict: 'fail', findingClass: 'safety' },
  ];
  for (const item of cases) {
    const fixture = item.fixture();
    try {
      const initialized = initialize(fixture);
      let terminal = main(['run-smoke', '--run', initialized.run_dir]);
      if (!item.smokeOnly) {
        const review = validReview(fixture, item.verdict);
        if (item.findingClass) review.findings[0].class = item.findingClass;
        review.review_result_digest = envelopeDigest(review, 'review_result_digest');
        const reviewPath = join(fixture.sandbox, `${item.name.replaceAll(' ', '-')}.json`);
        writeFileSync(reviewPath, JSON.stringify(review));
        terminal = main(['record-review', '--run', initialized.run_dir, '--review', reviewPath, '--verifier-run-id', `reviewer-${item.outcome}`, '--isolation-assurance', 'host_reported']);
      }
      assert.equal(terminal.terminal.outcome, item.outcome, item.name);
      assert.equal(terminal.stages.smoke_l0.status === 'not_run', false, item.name);
      assert.ok(terminal.stages.final_l0, item.name);
      assert.equal(main(['validate', '--run', initialized.run_dir]).valid, true, item.name);
    } finally { fixture.cleanup(); }
  }
});

test('无 forensics 的 no_defect_found 被机械拒绝且不推进 revision', () => {
  const fixture = makeFixture();
  try {
    const initialized = initialize(fixture);
    main(['run-smoke', '--run', initialized.run_dir]);
    const review = validReview(fixture);
    review.forensics = [];
    review.review_result_digest = envelopeDigest(review, 'review_result_digest');
    const reviewPath = join(fixture.sandbox, 'bad-review.json');
    writeFileSync(reviewPath, JSON.stringify(review));
    assert.throws(() => main(['record-review', '--run', initialized.run_dir, '--review', reviewPath, '--verifier-run-id', 'v', '--isolation-assurance', 'host_reported']), ValidationError);
    assert.equal(main(['status', '--run', initialized.run_dir]).revision, 1);
  } finally {
    fixture.cleanup();
  }
});

test('CLI typo、Review replay 与伪造 journal 都 fail closed', () => {
  const fixture = makeFixture();
  try {
    const initialized = initialize(fixture);
    assert.throws(() => main(['run-smoke', '--run', initialized.run_dir, '--expected-revison', '0']), /未知选项/);
    main(['run-smoke', '--run', initialized.run_dir]);
    const review = validReview(fixture);
    review.challenge_nonce = 'replayed-from-another-run';
    review.review_result_digest = envelopeDigest(review, 'review_result_digest');
    const reviewPath = join(fixture.sandbox, 'replay-review.json');
    writeFileSync(reviewPath, JSON.stringify(review));
    assert.throws(() => main(['record-review', '--run', initialized.run_dir, '--review', reviewPath, '--verifier-run-id', 'other-run', '--isolation-assurance', 'host_reported']), /nonce/);
    const snapshot = main(['status', '--run', initialized.run_dir]);
    const forged = { schema_version: 1, revision: snapshot.revision + 1, kind: 'forged_pass', recorded_at: new Date().toISOString(), previous_event_digest: 'sha256:'.concat('0'.repeat(64)), snapshot: { ...snapshot, revision: snapshot.revision + 1, status: 'terminal' } };
    forged.event_digest = envelopeDigest(forged, 'event_digest');
    appendFileSync(join(initialized.run_dir, 'events.ndjson'), `${canonicalJson(forged)}\n`);
    assert.throws(() => main(['validate', '--run', initialized.run_dir]), /journal 链/);
  } finally { fixture.cleanup(); }
});

test('空 Profile、非法 H gate 与非字符串 finding 不能进入执行链', () => {
  for (const mutate of [
    (profile) => { profile.l0_checks = []; },
    (profile) => { profile.human_gate = 'sometimes'; },
  ]) {
    const fixture = makeFixture();
    try {
      mutate(fixture.profile);
      fixture.profile.verification_profile_digest = envelopeDigest(fixture.profile, 'verification_profile_digest');
      writeFileSync(join(fixture.sandbox, 'profile.json'), JSON.stringify(fixture.profile));
      assert.throws(() => initialize(fixture), ValidationError);
    } finally { fixture.cleanup(); }
  }
  const fixture = makeFixture();
  try {
    const initialized = initialize(fixture); main(['run-smoke', '--run', initialized.run_dir]);
    const review = validReview(fixture, 'fail'); review.findings[0].evidence = [];
    review.review_result_digest = envelopeDigest(review, 'review_result_digest');
    const path = join(fixture.sandbox, 'typed-review.json'); writeFileSync(path, JSON.stringify(review));
    assert.throws(() => main(['record-review', '--run', initialized.run_dir, '--review', path, '--verifier-run-id', 'typed-reviewer', '--isolation-assurance', 'host_reported']), /类型应为 string|非空字符串/);
  } finally { fixture.cleanup(); }
});

test('snapshot 丢失后从 journal 恢复，下一写入自动修复', () => {
  const fixture = makeFixture();
  try {
    const initialized = initialize(fixture);
    unlinkSync(join(initialized.run_dir, 'snapshot.json'));
    assert.equal(main(['status', '--run', initialized.run_dir]).recovery_needed, true);
    const smoke = main(['run-smoke', '--run', initialized.run_dir]);
    assert.equal(smoke.revision, 1);
    assert.equal(main(['doctor', '--run', initialized.run_dir]).snapshot_matches_journal, true);
  } finally {
    fixture.cleanup();
  }
});

test('journal 尾部半条 event 被截断到最后完整 revision 后继续', () => {
  const fixture = makeFixture();
  try {
    const initialized = initialize(fixture);
    appendFileSync(join(initialized.run_dir, 'events.ndjson'), '{"partial":');
    assert.equal(main(['status', '--run', initialized.run_dir]).recovery_needed, true);
    const smoke = main(['run-smoke', '--run', initialized.run_dir]);
    assert.equal(smoke.revision, 1);
    assert.doesNotThrow(() => main(['validate', '--run', initialized.run_dir]));
  } finally {
    fixture.cleanup();
  }
});

test('确认 owner PID 不存在时自动回收 stale run lock', () => {
  const fixture = makeFixture();
  try {
    const initialized = initialize(fixture);
    writeFileSync(join(initialized.run_dir, '.lock'), '{"pid":99999999,"acquired_at":"stale"}\n');
    const smoke = main(['run-smoke', '--run', initialized.run_dir]);
    assert.equal(smoke.status, 'smoke_passed');
  } finally {
    fixture.cleanup();
  }
});

test('并发 stale recovery 不会让两个 verifier writer 同时进入临界区', async () => {
  const fixture = makeFixture();
  try {
    const initialized = initialize(fixture);
    writeFileSync(join(initialized.run_dir, '.lock'), '{"pid":99999999,"acquired_at":"legacy-stale"}\n');
    const run = () => new Promise((resolvePromise) => execFile(process.execPath, [join(SCRIPT_DIR, 'verification-runtime.mjs'), 'run-smoke', '--run', initialized.run_dir, '--expected-revision', '0'], { encoding: 'utf8' }, (error, stdout, stderr) => resolvePromise({ error, stdout, stderr })));
    const results = await Promise.all([run(), run()]);
    assert.equal(results.filter((item) => !item.error).length, 1);
    assert.equal(main(['status', '--run', initialized.run_dir]).revision, 1);
    assert.equal(main(['validate', '--run', initialized.run_dir]).valid, true);
  } finally { fixture.cleanup(); }
});

test('dead owner 遗留的 reclaim 子锁可自愈，live 或 malformed reclaim 仍 fail closed', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'verification-reclaim-test-'));
  const lockPath = join(sandbox, '.lock');
  try {
    writeFileSync(lockPath, '{"pid":99999999,"token":"dead-main"}\n');
    writeFileSync(`${lockPath}.reclaim`, '{"pid":99999998,"token":"dead-reclaimer"}\n');
    const owner = acquireLock(lockPath);
    assert.equal(releaseLock(lockPath, owner), true);
    assert.equal(existsSync(`${lockPath}.reclaim`), false);

    writeFileSync(`${lockPath}.reclaim`, `${JSON.stringify({ pid: process.pid, token: 'live-reclaimer' })}\n`);
    assert.throws(() => acquireLock(lockPath), /stale recovery/);
    unlinkSync(`${lockPath}.reclaim`);
    writeFileSync(`${lockPath}.reclaim`, '{');
    assert.throws(() => acquireLock(lockPath), /reclaim 内容损坏/);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test('malformed lock fail closed，不在 owner 尚未写完时抢锁', () => {
  const fixture = makeFixture();
  try {
    const initialized = initialize(fixture);
    writeFileSync(join(initialized.run_dir, '.lock'), '{');
    assert.throws(() => main(['run-smoke', '--run', initialized.run_dir]), /拒绝自动接管/);
    assert.equal(readFileSync(join(initialized.run_dir, '.lock'), 'utf8'), '{');
  } finally {
    fixture.cleanup();
  }
});

test('lock 只由匹配 token 的 owner 释放', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'verification-lock-test-'));
  const lockPath = join(sandbox, '.lock');
  try {
    const owner = acquireLock(lockPath);
    writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, token: 'replacement-owner', acquired_at: new Date().toISOString() })}\n`);
    assert.equal(releaseLock(lockPath, owner), false);
    assert.match(readFileSync(lockPath, 'utf8'), /replacement-owner/);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});

test('冻结 workdir 外 argv 文件并在执行前检测替换', () => {
  const fixture = makeFixture();
  try {
    const runner = join(fixture.sandbox, 'external-runner.mjs');
    writeFileSync(runner, 'process.exit(0)\n');
    fixture.profile.l0_checks[0].argv = ['node', runner];
    fixture.profile.verification_profile_digest = envelopeDigest(fixture.profile, 'verification_profile_digest');
    writeFileSync(join(fixture.sandbox, 'profile.json'), JSON.stringify(fixture.profile));
    const initialized = initialize(fixture);
    writeFileSync(runner, 'process.exit(1)\n');
    assert.throws(() => main(['run-smoke', '--run', initialized.run_dir]), /冻结 argv 文件已变化/);
  } finally { fixture.cleanup(); }
});

test('冻结 workdir 内被 gitignore 的 argv 文件并检测替换', () => {
  const fixture = makeFixture();
  try {
    writeFileSync(join(fixture.repo, '.gitignore'), 'ignored-runner.mjs\n');
    git(fixture.repo, ['add', '.gitignore']);
    git(fixture.repo, ['commit', '-m', 'test: ignore runner']);
    fixture.artifact.artifact_sha = git(fixture.repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(fixture.sandbox, 'artifact.json'), JSON.stringify(fixture.artifact));
    const runner = join(fixture.repo, 'ignored-runner.mjs');
    writeFileSync(runner, 'process.exit(0)\n');
    fixture.profile.l0_checks[0].argv = ['node', 'ignored-runner.mjs'];
    fixture.profile.verification_profile_digest = envelopeDigest(fixture.profile, 'verification_profile_digest');
    writeFileSync(join(fixture.sandbox, 'profile.json'), JSON.stringify(fixture.profile));
    const initialized = initialize(fixture);
    writeFileSync(runner, 'process.exit(1)\n');
    assert.throws(() => main(['run-smoke', '--run', initialized.run_dir]), /冻结 argv 文件已变化/);
  } finally { fixture.cleanup(); }
});

test('capabilities --json 保持统一能力发现兼容', () => {
  const output = execFileSync(process.execPath, [join(SCRIPT_DIR, 'verification-runtime.mjs'), 'capabilities', '--json'], { encoding: 'utf8' });
  const value = JSON.parse(output);
  assert.equal(value.skill, 'verify-agent-output');
  assert.equal(value.runtime_version, RUNTIME_VERSION);
  for (const feature of ['review-bundle', 'readiness-preconditions', 'prepare-scaffold-chain']) assert.ok(value.features.includes(feature), feature);
});

test('review-bundle 打包自包含派发输入，并按投影标注 contract_kind', () => {
  for (const item of [
    { kind: 'public', extensions: {} },
    { kind: 'projected', extensions: { projection: { parent_contract_digest: `sha256:${'a'.repeat(64)}`, projected_item_ids: ['content'] } } },
  ]) {
    const fixture = makeFixture({ contractExtensions: item.extensions });
    try {
      const initialized = initialize(fixture);
      assert.throws(() => main(['review-bundle', '--run', initialized.run_dir]), /review-input 不接受状态 initialized/u);
      main(['run-smoke', '--run', initialized.run_dir]);
      const bundle = main(['review-bundle', '--run', initialized.run_dir]);

      assert.equal(bundle.contract_kind, item.kind, item.kind);
      assert.equal(bundle.bundle_kind, 'reviewer_dispatch');
      assert.equal(bundle.runtime_version, RUNTIME_VERSION);
      assert.equal(bundle.run_id, initialized.run_id);
      // review-input 全量（含两个 digest、nonce、reviewer_view）随 bundle 一起下发。
      assert.equal(bundle.review_input.contract_digest, fixture.contract.contract_digest);
      assert.equal(bundle.review_input.verification_profile_digest, fixture.profile.verification_profile_digest);
      assert.equal(bundle.review_input.challenge_nonce, initialized.review_challenge_nonce);
      assert.equal(bundle.review_input.reviewer_view[0].contract_item_id, 'content');
      // 投影场景下 bundle 的 contract 部分就是投影合同本身，不做二次裁剪。
      assert.equal(canonicalJson(bundle.review_input.contract.acceptance), canonicalJson(fixture.contract.acceptance));
      // 内联 Review Result v1 schema、Artifact、workdir、权限与停止条件。
      assert.equal(canonicalJson(bundle.review_result_schema), canonicalJson(parseJsonStrict(readFileSync(join(SCRIPT_DIR, '..', '..', 'schemas', 'review-result-v1.schema.json'), 'utf8'))));
      assert.equal(canonicalJson(bundle.artifact_ref), canonicalJson(fixture.artifact));
      assert.equal(bundle.workdir, main(['status', '--run', initialized.run_dir]).workdir);
      assert.equal(bundle.permissions.mode, 'read_only');
      assert.match(bundle.permissions.forbidden_operations.join('|'), /git commit/u);
      assert.match(bundle.permissions.forbidden_operations.join('|'), /git checkout/u);
      assert.ok(bundle.stop_conditions.length > 0);
      assert.match(bundle.digest_backfill.command, /digest --kind review --input/u);
      // 标准 reviewer 提示词：证伪任务原文 + 三态 + finding 五字段 + forensics + safety 不可抵消。
      const protocol = readFileSync(join(SCRIPT_DIR, '..', '..', 'docs', 'verify', 'verification-protocol.md'), 'utf8');
      const falsification = protocol.split(/^## /mu).find((part) => part.startsWith('证伪任务')).match(/```text\n([\s\S]*?)\n```/u)[1];
      assert.ok(bundle.reviewer_prompt.includes(falsification), '提示词必须内联协议真源的证伪任务原文');
      for (const token of ['fail | no_defect_found | undecidable', 'contract_item_id / class / evidence / expected / actual', 'forensics 必须是非空字符串数组', 'safety finding', 'blocked_safety', '只读审查']) {
        assert.ok(bundle.reviewer_prompt.includes(token), `${item.kind}: ${token}`);
      }
      assert.equal(bundle.reviewer_prompt.includes('投影合同'), item.kind === 'projected');

      const outPath = join(fixture.sandbox, 'bundle.json');
      const written = main(['review-bundle', '--run', initialized.run_dir, '--out', outPath]);
      assert.equal(written.out, outPath);
      assert.equal(written.contract_kind, item.kind);
      assert.equal(canonicalJson(parseJsonStrict(readFileSync(outPath, 'utf8'))), canonicalJson(bundle));
    } finally { fixture.cleanup(); }
  }
});

test('readiness 只判环境前提：正例 ready，缺可执行/坏 workdir/state-root 不可写都是 precondition blocker', () => {
  const fixture = makeFixture();
  try {
    const contractPath = join(fixture.sandbox, 'contract.json');
    const profilePath = join(fixture.sandbox, 'profile.json');
    const ready = main(['readiness', '--contract', contractPath, '--profile', profilePath, '--workdir', fixture.repo, '--state-root', fixture.stateRoot]);
    assert.equal(ready.ready, true);
    assert.deepEqual(ready.blockers, []);
    assert.equal(ready.blocker_semantics, 'blocked_precondition_not_artifact_defect');
    assert.ok(ready.checks.some((item) => item.check_id === 'workdir_git_root' && item.ok));
    assert.ok(ready.checks.some((item) => item.check_id === 'executable:node' && item.ok));
    // env_allowlist 是否必需无法机械判定：只记 note，不猜、不拦。
    assert.ok(ready.notes.some((note) => note.includes('env_allowlist')));
    assert.equal(ready.blockers.some((item) => item.check_id.startsWith('env')), false);

    // 坏 workdir：非 Git 仓库。
    const plain = join(fixture.sandbox, 'not-a-repo');
    mkdirSync(plain);
    const badWorkdir = main(['readiness', '--contract', contractPath, '--profile', profilePath, '--workdir', plain, '--state-root', fixture.stateRoot]);
    assert.equal(badWorkdir.ready, false);
    assert.equal(badWorkdir.blockers[0].kind, 'precondition');
    assert.match(badWorkdir.blockers.map((item) => item.detail).join('\n'), /不是 Git 仓库|不是 Git worktree 根目录/u);

    // state root 不可写。
    const stateFile = join(fixture.sandbox, 'state-root-is-a-file');
    writeFileSync(stateFile, 'not a directory\n');
    const badState = main(['readiness', '--contract', contractPath, '--profile', profilePath, '--workdir', fixture.repo, '--state-root', stateFile]);
    assert.equal(badState.ready, false);
    assert.ok(badState.blockers.some((item) => item.check_id === 'state_root_writable' && item.kind === 'precondition'));
    if (process.getuid?.() !== 0) {
      const locked = join(fixture.sandbox, 'locked-state');
      mkdirSync(locked, { mode: 0o500 });
      try {
        const denied = main(['readiness', '--contract', contractPath, '--profile', profilePath, '--workdir', fixture.repo, '--state-root', join(locked, 'runs-root')]);
        assert.equal(denied.ready, false);
        assert.ok(denied.blockers.some((item) => item.check_id === 'state_root_writable' && /不可写/u.test(item.detail)));
      } finally { chmodSync(locked, 0o700); }
    }

    // 缺可执行 + 不存在的 L0 cwd + 不可读的 argv 文件参数。
    const missingExecutable = join(fixture.sandbox, 'no-such-node');
    fixture.profile.runtime.executable_paths.node = missingExecutable;
    fixture.profile.l0_checks[0].cwd_rel = 'missing-subdir';
    fixture.profile.verification_profile_digest = envelopeDigest(fixture.profile, 'verification_profile_digest');
    const brokenPath = join(fixture.sandbox, 'broken-profile.json');
    writeFileSync(brokenPath, JSON.stringify(fixture.profile));
    const broken = main(['readiness', '--contract', contractPath, '--profile', brokenPath, '--workdir', fixture.repo, '--state-root', fixture.stateRoot]);
    assert.equal(broken.ready, false);
    assert.ok(broken.blockers.every((item) => item.kind === 'precondition'));
    assert.ok(broken.blockers.some((item) => item.check_id === 'executable:node' && /不存在/u.test(item.detail)));
    assert.ok(broken.blockers.some((item) => item.check_id === 'l0_cwd:unit' && /cwd 不存在/u.test(item.detail)));

    // 无法读取的输入本身也是 precondition，不是 Artifact 缺陷。
    const unreadable = main(['readiness', '--contract', join(fixture.sandbox, 'absent.json'), '--profile', profilePath, '--workdir', fixture.repo, '--state-root', fixture.stateRoot]);
    assert.equal(unreadable.ready, false);
    assert.equal(unreadable.blockers[0].check_id, 'contract_readable');

    // CLI 以 exit 2 表达 not ready，与 preflight 同口径。
    const cli = spawnSync(process.execPath, [join(SCRIPT_DIR, 'verification-runtime.mjs'), 'readiness', '--contract', contractPath, '--profile', brokenPath, '--workdir', fixture.repo, '--state-root', fixture.stateRoot], { encoding: 'utf8' });
    assert.equal(cli.status, 2);
    assert.equal(JSON.parse(cli.stdout).ready, false);
  } finally { fixture.cleanup(); }
});

test('run-smoke 前置不满足时报 stale_precondition，而不是把 L0 跑挂当产物缺陷', () => {
  const fixture = makeFixture();
  try {
    writeFileSync(join(fixture.repo, '.gitignore'), 'scratch/\n');
    git(fixture.repo, ['add', '.gitignore']);
    git(fixture.repo, ['commit', '-m', 'test: ignore scratch']);
    fixture.artifact.artifact_sha = git(fixture.repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(fixture.sandbox, 'artifact.json'), JSON.stringify(fixture.artifact));
    const scratch = join(fixture.repo, 'scratch');
    mkdirSync(scratch);
    fixture.profile.l0_checks[0].cwd_rel = 'scratch';
    fixture.profile.verification_profile_digest = envelopeDigest(fixture.profile, 'verification_profile_digest');
    writeFileSync(join(fixture.sandbox, 'profile.json'), JSON.stringify(fixture.profile));
    const initialized = initialize(fixture);
    rmSync(scratch, { recursive: true, force: true });
    assert.throws(() => main(['run-smoke', '--run', initialized.run_dir]), (error) => {
      assert.ok(error instanceof OperationalAbort);
      assert.equal(error.code, 'stale_precondition');
      assert.match(error.message, /readiness 前置检查未通过（环境问题，不是 Artifact 缺陷）[\s\S]*l0_cwd:unit/u);
      return true;
    });
    const snapshot = main(['status', '--run', initialized.run_dir]);
    assert.equal(snapshot.status, 'aborted');
    assert.equal(snapshot.operational_abort.code, 'stale_precondition');
    assert.equal(snapshot.terminal, null);
    assert.equal(snapshot.stages.smoke_l0, undefined, '前置未过时不得留下 L0 结果');
  } finally { fixture.cleanup(); }
});

test('prepare 只出骨架与 TODO，不猜测试命令；填最小 L0 后可过 preflight', () => {
  const fixture = makeFixture();
  try {
    const outDir = join(fixture.sandbox, 'prepared');
    const prepared = main(['prepare', '--workdir', fixture.repo, '--out-dir', outDir]);
    assert.equal(prepared.contract_path, join(outDir, 'contract.json'));
    assert.equal(prepared.profile_path, join(outDir, 'profile.json'));
    assert.match(prepared.notice, /l0_checks 需 controller 按项目实际填写并确认/u);
    assert.ok(prepared.todo.some((item) => item.includes('l0_checks 必须由 controller')));
    assert.ok(prepared.next_steps.some((item) => item.includes('readiness')) && prepared.next_steps.some((item) => item.includes('preflight')));
    const serialized = JSON.stringify(prepared);
    for (const guessed of ['flutter', 'pytest', 'npm test', 'just ', 'cargo', 'gradle']) assert.equal(serialized.toLowerCase().includes(guessed), false, guessed);
    assert.throws(() => main(['prepare', '--workdir', fixture.repo, '--out-dir', outDir]), /拒绝覆盖已存在的文件/u);

    const contract = JSON.parse(readFileSync(prepared.contract_path, 'utf8'));
    const profile = JSON.parse(readFileSync(prepared.profile_path, 'utf8'));
    assert.equal(profile.l0_checks[0].check_id, 'replace-with-real-check');
    // controller 自行填写并确认真实 L0，再重算摘要。
    profile.l0_checks = [{ check_id: 'unit', argv: ['node', '-e', 'process.exit(0)'], cwd_rel: '.', stage: 'both', timeout_ms: 10_000, expected_exit_codes: [0] }];
    delete profile.verification_profile_digest;
    writeFileSync(prepared.profile_path, JSON.stringify(profile));
    const digested = main(['digest', '--kind', 'profile', '--input', prepared.profile_path]);
    writeFileSync(prepared.profile_path, JSON.stringify(digested));
    const artifact = main(['scaffold', '--kind', 'artifact', '--workdir', fixture.repo, '--base-sha', fixture.artifact.base_sha]);
    const artifactPath = join(outDir, 'artifact.json');
    writeFileSync(artifactPath, JSON.stringify(artifact));
    assert.equal(main(['readiness', '--contract', prepared.contract_path, '--profile', prepared.profile_path, '--workdir', fixture.repo, '--state-root', fixture.stateRoot]).ready, true);
    const report = main(['preflight', '--contract', prepared.contract_path, '--profile', prepared.profile_path, '--artifact', artifactPath]);
    assert.deepEqual(report.errors, []);
    assert.equal(report.valid, true);
    assert.equal(report.contract_digest, contract.contract_digest);

    const inline = main(['prepare', '--workdir', fixture.repo]);
    assert.equal(inline.contract.skill_set[0].content_digest, skillContentDigest());
    assert.equal(inline.profile.verification_profile_digest, envelopeDigest(inline.profile, 'verification_profile_digest'));
  } finally { fixture.cleanup(); }
});

test('state root 通过祖先 symlink 指回仓库时仍拒绝', () => {
  const fixture = makeFixture();
  try {
    const link = join(fixture.sandbox, 'state-link');
    symlinkSync(fixture.repo, link, 'dir');
    fixture.stateRoot = join(link, 'runtime-state');
    assert.throws(() => initialize(fixture), /state root 位于仓库内/);
  } finally {
    fixture.cleanup();
  }
});

test('Evidence 已 write-new 但 terminal event 丢失时复用同一不可变 Evidence', () => {
  const fixture = makeFixture();
  try {
    const initialized = initialize(fixture);
    main(['run-smoke', '--run', initialized.run_dir]);
    const reviewPath = join(fixture.sandbox, 'review.json');
    writeFileSync(reviewPath, JSON.stringify(validReview(fixture)));
    main(['record-review', '--run', initialized.run_dir, '--review', reviewPath, '--verifier-run-id', 'v', '--isolation-assurance', 'host_reported']);
    const beforeEvents = readFileSync(join(initialized.run_dir, 'events.ndjson'));
    const beforeSnapshot = readFileSync(join(initialized.run_dir, 'snapshot.json'));
    const first = main(['run-final', '--run', initialized.run_dir]);
    const evidenceDigest = first.terminal.evidence_digest;
    writeFileSync(join(initialized.run_dir, 'events.ndjson'), beforeEvents);
    writeFileSync(join(initialized.run_dir, 'snapshot.json'), beforeSnapshot);
    const recovered = main(['run-final', '--run', initialized.run_dir]);
    assert.equal(recovered.terminal.evidence_digest, evidenceDigest);
    assert.equal(main(['validate', '--run', initialized.run_dir]).valid, true);
  } finally {
    fixture.cleanup();
  }
});

test('未授权 protected path 变化在 init 前 fail closed', () => {
  const fixture = makeFixture({ protectedPaths: ['README.md'] });
  try {
    assert.throws(() => initialize(fixture), OperationalAbort);
  } finally {
    fixture.cleanup();
  }
});

test('L0 使 workdir 变脏时记录 operational abort 而非 Evidence verdict', () => {
  const fixture = makeFixture({ script: 'require("node:fs").writeFileSync("dirty.txt", "dirty")' });
  try {
    const initialized = initialize(fixture);
    assert.throws(() => main(['run-smoke', '--run', initialized.run_dir]), OperationalAbort);
    const snapshot = main(['status', '--run', initialized.run_dir]);
    assert.equal(snapshot.status, 'aborted');
    assert.equal(snapshot.operational_abort.code, 'stale_precondition');
    assert.equal(snapshot.terminal, null);
  } finally {
    fixture.cleanup();
  }
});

test('冻结 executable 在执行前消失时记录 operational abort，不判 Artifact fail', () => {
  const fixture = makeFixture();
  try {
    const executable = join(fixture.sandbox, 'ephemeral-node');
    symlinkSync(process.execPath, executable, 'file');
    fixture.profile.runtime.executable_paths.node = executable;
    fixture.profile.verification_profile_digest = envelopeDigest(fixture.profile, 'verification_profile_digest');
    writeFileSync(join(fixture.sandbox, 'profile.json'), JSON.stringify(fixture.profile));
    const initialized = initialize(fixture);
    unlinkSync(executable);
    assert.throws(() => main(['run-smoke', '--run', initialized.run_dir]), OperationalAbort);
    const status = main(['status', '--run', initialized.run_dir]);
    assert.equal(status.status, 'aborted');
    assert.equal(status.operational_abort.code, 'check_runtime_failure');
  } finally {
    fixture.cleanup();
  }
});
