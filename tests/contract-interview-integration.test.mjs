// interview 与 verify 域的交叉用例。
// domains/ 之间禁止互相 import，所以同时拿两个域说话的断言只能住在这里。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { contractSubstance } from '../core/contract-substance.mjs';
import { answer, completion } from '../domains/orchestrate/contract-interview.mjs';
import { main as contractMain, validateContract } from '../domains/orchestrate/contract-tool.mjs';
import {
  main as verifyMain,
  skillContentDigest as verifySkillDigest,
  RUNTIME_VERSION as VERIFY_RUNTIME_VERSION,
} from '../domains/verify/verification-runtime.mjs';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'interview-integration-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('contract scaffold 与 verify scaffold --kind contract 输出同一份骨架', () => {
  const box = sandbox();
  try {
    const fromContract = contractMain(['scaffold', '--workdir', box.dir]);
    const fromVerify = verifyMain(['scaffold', '--kind', 'contract', '--workdir', box.dir]);
    // 字段集合与字段顺序都必须一致：骨架只有 core/contract-scaffold.mjs 一处出处。
    assert.deepEqual(Object.keys(fromContract), Object.keys(fromVerify));
    // contract_id 是随机 UUID，contract_digest 随之不同；其余字段逐字段相等。
    for (const field of [
      'schema_version',
      'objective',
      'scope',
      'acceptance',
      'permissions',
      'environment',
      'stop_conditions',
      'extensions',
    ]) {
      assert.deepEqual(fromContract[field], fromVerify[field], `骨架字段漂移：${field}`);
    }
    assert.match(fromContract.contract_id, /^[0-9a-f-]{36}$/u);
    assert.notEqual(fromContract.contract_id, fromVerify.contract_id);
    // skill_set 是有意的唯一差异：各自冻结自己域的 content digest。
    // ledger init 要求契约里有当前 orchestrate-subagents 的摘要，verify 侧则绑 verify-agent-output；
    // 把对方的摘要算进来就得跨域取路径，所以这一条不收敛。
    assert.deepEqual(
      fromContract.skill_set.map((item) => item.name),
      ['orchestrate-subagents'],
    );
    assert.deepEqual(
      fromVerify.skill_set.map((item) => item.name),
      ['verify-agent-output'],
    );
    for (const skeleton of [fromContract, fromVerify]) {
      assert.equal(skeleton.skill_set[0].provider_mode, 'primary');
      assert.match(skeleton.skill_set[0].content_digest, /^sha256:[0-9a-f]{64}$/u);
      // 两份骨架都必须是实质性判据眼里的"原样 scaffold"，否则占位判据就拦不住它。
      assert.equal(contractSubstance(skeleton).errors.length, 3);
      validateContract(skeleton);
    }
  } finally {
    box.cleanup();
  }
});

test('interview 冻结的契约配一份合规 profile 能通过 verify preflight', () => {
  const box = sandbox();
  try {
    const repo = join(box.dir, 'repo');
    mkdirSync(repo);
    const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Interview Test']);
    git(['config', 'user.email', 'interview@example.invalid']);
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'chore: base']);
    const head = git(['rev-parse', 'HEAD']);

    // preflight 另外要求契约冻结 verify-agent-output；skill_set 不是 interview 会问、会改的字段，
    // 所以调用方要在开访谈之前就把这条绑定写进草稿。
    const draft = contractMain(['scaffold', '--workdir', repo]);
    draft.skill_set.push({
      name: 'verify-agent-output',
      version: VERIFY_RUNTIME_VERSION,
      content_digest: verifySkillDigest(),
      provider_mode: 'primary',
    });
    const filled = answer(draft, [
      { field: 'permissions', options: ['read_only', 'write'], selected: 0, source: 'user' },
      { field: 'objective', options: ['核对 README 仍然存在', '重写整个仓库'], selected: 0, source: 'user' },
      { field: 'acceptance', options: ['README.md 可被 node 读到', '作者自己看过一遍'], selected: 0, source: 'user' },
      { field: 'scope.include', options: ['README.md', 'core/'], selected: 0, source: 'user' },
    ]).contract;
    assert.equal(completion(filled).complete, true);

    const write = (name, value) => {
      const path = join(box.dir, name);
      writeFileSync(path, JSON.stringify(value));
      return path;
    };
    const frozen = contractMain(['interview-freeze', '--input', write('draft.json', filled)]).contract;
    const contractPath = write('contract.json', frozen);

    const profile = verifyMain(['scaffold', '--kind', 'profile']);
    profile.l0_checks = [
      {
        check_id: 'readme-present',
        argv: ['node', '-e', 'require("node:fs").statSync("README.md")'],
        cwd_rel: '.',
        stage: 'both',
        timeout_ms: 30_000,
        expected_exit_codes: [0],
      },
    ];
    profile.l1_review = [
      {
        contract_item_id: frozen.acceptance[0].contract_item_id,
        lenses: ['functional', 'scope', 'verification_definition', 'safety'],
      },
    ];
    const profilePath = write('profile.json', profile);
    writeFileSync(profilePath, JSON.stringify(verifyMain(['digest', '--kind', 'profile', '--input', profilePath])));
    const artifactPath = write(
      'artifact.json',
      verifyMain(['scaffold', '--kind', 'artifact', '--workdir', repo, '--base-sha', head]),
    );

    const result = verifyMain([
      'preflight',
      '--contract',
      contractPath,
      '--profile',
      profilePath,
      '--artifact',
      artifactPath,
    ]);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(result.contract_digest, frozen.contract_digest);
  } finally {
    box.cleanup();
  }
});
