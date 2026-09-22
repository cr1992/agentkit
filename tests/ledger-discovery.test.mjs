// ledger 状态发现：仓级指针、worktree 级指针与顶层 `agentkit status`。
// 这些用例跨 orchestrate 与 worktree 两个域 + bin/ 顶层，因此放在共享 tests/ 下而不是某个域内。
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { collectJsonSchemaErrors } from '../core/json-schema-lite.mjs';
import {
  LEDGER_ID_PATTERN,
  listLedgerPointers,
  pointerDirectory,
  resolveGitCommonDir,
  validateLedgerPointer,
} from '../core/ledger-pointer.mjs';
import { canonicalJson, envelopeDigest } from '../domains/orchestrate/contract-tool.mjs';
import { skillContentDigest } from '../domains/orchestrate/orchestration-ledger.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'agentkit.mjs');
const LEDGER = join(ROOT, 'domains', 'orchestrate', 'orchestration-ledger.mjs');
const MANAGER = join(ROOT, 'domains', 'worktree', 'worktree-mgr.mjs');
const POINTER_SCHEMA = JSON.parse(readFileSync(join(ROOT, 'schemas', 'ledger-pointer-v1.schema.json'), 'utf8'));

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** @param {string} cwd @param {string[]} args */
function node(cwd, args) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** @param {string} cwd @param {string[]} args */
function ledgerJson(cwd, args) {
  const result = node(cwd, [LEDGER, ...args]);
  assert.equal(result.status, 0, `ledger ${args.join(' ')} 失败：${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

/** @param {string} cwd */
function statusJson(cwd) {
  const result = node(cwd, [CLI, 'status', '--json']);
  assert.equal(result.status, 0, `agentkit status 失败：${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout);
}

function makeFixture() {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-discovery-')));
  const repo = join(sandbox, 'repo');
  mkdirSync(repo);
  git(sandbox, ['init', '-q', '-b', 'main', 'repo']);
  git(repo, ['config', 'user.name', 'Discovery Test']);
  git(repo, ['config', 'user.email', 'discovery@example.invalid']);
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-q', '-m', 'chore: init']);
  return {
    sandbox,
    repo,
    stateRoot: join(sandbox, 'state'),
    pointerDir: join(repo, '.git', 'agentkit', 'ledgers'),
    cleanup: () => rmSync(sandbox, { recursive: true, force: true }),
  };
}

/** @param {{ sandbox: string, repo: string }} fixture */
function writeContract(fixture, { name = 'contract', repository = fixture.repo } = {}) {
  const contract = {
    schema_version: 1,
    contract_id: `discovery-${name}`,
    objective: '编排一个实现节点并在完成后收口',
    scope: { include: [], exclude: [] },
    acceptance: [{ contract_item_id: 'done', requirement: '必要节点均有稳定产物' }],
    permissions: { mode: 'read_only', writable_paths: [] },
    environment: { repository, isolation: 'caller_supplied' },
    skill_set: [
      {
        name: 'orchestrate-subagents',
        version: '1.1.0',
        content_digest: skillContentDigest(),
        provider_mode: 'primary',
      },
    ],
    stop_conditions: [],
    extensions: {},
  };
  contract.contract_digest = envelopeDigest(contract);
  const path = join(fixture.sandbox, `${name}.contract.json`);
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`);
  return { path, contract };
}

/** @param {{ sandbox: string, repo: string, stateRoot: string }} fixture */
function initLedger(fixture, ledgerId, options = {}) {
  const contract = writeContract(fixture, { name: ledgerId, ...options });
  const stateRoot = options.stateRoot ?? join(fixture.stateRoot, ledgerId);
  return {
    contract: contract.contract,
    ...ledgerJson(options.cwd ?? fixture.repo, [
      'init',
      '--contract',
      contract.path,
      '--state-root',
      stateRoot,
      '--ledger-id',
      ledgerId,
    ]),
  };
}

function inputFile(fixture, name, value) {
  const path = join(fixture.sandbox, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

// 把一个 required 节点推到 passed，使 ledger 达到 completion_ready，正常 close 才能成立。
function passOneNode(fixture, ledgerDir, id) {
  ledgerJson(fixture.repo, [
    'add-node',
    '--ledger',
    ledgerDir,
    '--input',
    inputFile(fixture, `${id}-node`, {
      node_id: id,
      objective: `完成 ${id}`,
      verification: { requirement: 'worker_self_check', provider: 'none', artifact_scope: 'node_output' },
    }),
  ]);
  ledgerJson(fixture.repo, [
    'dispatch-record',
    '--ledger',
    ledgerDir,
    '--node',
    id,
    '--input',
    inputFile(fixture, `${id}-dispatch`, {
      schema_version: 2,
      worker_id: id,
      orchestration_mode: 'full',
      attempt_id: `attempt-${id}`,
      attempt: 1,
      previous_attempt_id: null,
      tier: 'primary',
      model: 'provider-primary-current',
      reasoning_effort: 'medium',
      adjustment_action: 'initial',
      failure_kind: null,
      failure_ref: null,
      selection_reason: '明确实现任务，使用已确认的常规执行配置',
      config_source: ['global:/config/hosts/test.json'],
      configuration_state: 'persisted-config',
      model_resolution_state: 'discovered-and-validated',
      capability_source: 'cache:/config/capabilities/test.json+live-validation',
      capability_fingerprint: `sha256:${'e'.repeat(64)}`,
      dispatch_provenance: 'explicit',
      token_budget: 'unsupported',
      max_attempts: 2,
    }),
  ]);
  ledgerJson(fixture.repo, [
    'attach',
    '--ledger',
    ledgerDir,
    '--node',
    id,
    '--type',
    'report',
    '--input',
    inputFile(fixture, `${id}-report`, { report_id: `report-${id}` }),
  ]);
  ledgerJson(fixture.repo, [
    'update',
    '--ledger',
    ledgerDir,
    '--node',
    id,
    '--input',
    inputFile(fixture, `${id}-pass`, { state: 'passed' }),
  ]);
}

// 制造 skill_drift：改冻结的 content_digest 并重签整条事件链，等价于「这份 ledger 冻结在另一个 runtime 上」。
// 不动 core/ 的真实文件，因此不影响当前进程算出的分发摘要，也不污染其他用例。
function driftLedger(ledgerDir) {
  const journalPath = join(ledgerDir, 'events.ndjson');
  const frozen = `sha256:${'0'.repeat(64)}`;
  let previous = null;
  const rewritten = readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((event) => {
      const next = {
        ...event,
        previous_event_digest: previous,
        snapshot: {
          ...event.snapshot,
          skill_provenance: { ...event.snapshot.skill_provenance, content_digest: frozen },
        },
      };
      delete next.event_digest;
      next.event_digest = envelopeDigest(next, 'event_digest');
      previous = next.event_digest;
      return next;
    });
  writeFileSync(journalPath, `${rewritten.map((event) => canonicalJson(event)).join('\n')}\n`);
  writeFileSync(join(ledgerDir, 'snapshot.json'), `${JSON.stringify(rewritten.at(-1).snapshot, null, 2)}\n`);
}

test('ledger init 在 git common dir 下写仓级指针，指针不进版本控制，主 checkout 里 status 直接找到它', () => {
  const fixture = makeFixture();
  try {
    const initialized = initLedger(fixture, 'alpha');
    assert.equal(initialized.pointer.written, true, JSON.stringify(initialized.pointer));
    assert.equal(initialized.pointer.path, join(fixture.pointerDir, 'alpha.json'));
    assert.equal(initialized.pointer.git_common_dir, join(fixture.repo, '.git'));

    const pointer = JSON.parse(readFileSync(initialized.pointer.path, 'utf8'));
    assert.deepEqual(Object.keys(pointer).sort(), [
      'contract_digest',
      'created_at',
      'ledger_id',
      'schema_version',
      'state_root',
    ]);
    assert.equal(pointer.ledger_id, 'alpha');
    assert.equal(pointer.state_root, initialized.state_root);
    assert.equal(pointer.contract_digest, initialized.contract.contract_digest);

    // 红线：指针只在 .git/ 下，工作树必须仍然干净。
    assert.equal(git(fixture.repo, ['status', '--porcelain']), '');

    // 主 checkout、未 spawn 任何 worktree：status 就能找到刚 init 的 ledger。
    const report = statusJson(fixture.repo);
    assert.equal(report.scope, 'repository');
    assert.equal(report.pointer_dir, fixture.pointerDir);
    assert.deepEqual(
      report.ledgers.map((entry) => entry.ledger_id),
      ['alpha'],
    );
    assert.equal(report.ledgers[0].ledger_dir, initialized.ledger_dir);
    assert.equal(report.ledgers[0].skill_drift, false);
    assert.equal(report.ledgers[0].pointer_contract_digest_matches, true);
    assert.equal(report.ledgers[0].phase, 'empty');
    assert.deepEqual(report.drifted_ledgers, []);
    assert.deepEqual(report.dangling_pointers, []);

    // 文本档是单屏输出：阶段、活跃 worktree、阻塞项、未覆盖节点、下一步命令都在。
    const text = node(fixture.repo, [CLI, 'status']);
    assert.equal(text.status, 0, text.stderr);
    for (const fragment of ['阶段=', '活跃 worktree:', '阻塞项:', '未覆盖节点:', '下一步:']) {
      assert.ok(text.stdout.includes(fragment), `status 文本缺少「${fragment}」：\n${text.stdout}`);
    }
  } finally {
    fixture.cleanup();
  }
});

test('linked worktree 里 init 与 status 都落在主仓 .git 上，不会每棵树各写一份指针', () => {
  const fixture = makeFixture();
  try {
    const linked = join(fixture.sandbox, 'linked');
    git(fixture.repo, ['worktree', 'add', '-q', '-b', 'side', linked]);

    // 从 linked worktree init：--git-common-dir 指向主仓 .git，指针必须落在那里。
    const initialized = initLedger(fixture, 'beta', { repository: linked, cwd: linked });
    assert.equal(initialized.pointer.git_common_dir, join(fixture.repo, '.git'));
    assert.equal(initialized.pointer.path, join(fixture.pointerDir, 'beta.json'));
    assert.equal(existsSync(join(linked, '.git')), true);
    assert.equal(existsSync(join(linked, '.git', 'agentkit')), false, 'linked worktree 的 .git 文件下不应出现指针目录');

    // linked worktree 里 status 同样能发现它。
    for (const cwd of [fixture.repo, linked]) {
      const report = statusJson(cwd);
      assert.equal(report.git_common_dir, join(fixture.repo, '.git'));
      assert.deepEqual(
        report.ledgers.map((entry) => entry.ledger_id),
        ['beta'],
        `cwd=${cwd}`,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test('close 与 close --abandon 之后指针消失，status 不再列出该 ledger', () => {
  const fixture = makeFixture();
  try {
    const closed = initLedger(fixture, 'closing');
    const abandoned = initLedger(fixture, 'abandoning');
    assert.deepEqual(
      statusJson(fixture.repo)
        .ledgers.map((entry) => entry.ledger_id)
        .sort(),
      ['abandoning', 'closing'],
    );

    passOneNode(fixture, closed.ledger_dir, 'only');
    const closeResult = ledgerJson(fixture.repo, ['close', '--ledger', closed.ledger_dir]);
    assert.equal(closeResult.lifecycle.state, 'closed');
    assert.equal(closeResult.pointer.removed, true);
    assert.equal(existsSync(closed.pointer.path), false);

    const abandonResult = ledgerJson(fixture.repo, [
      'close',
      '--ledger',
      abandoned.ledger_dir,
      '--abandon',
      '--reason',
      '需求取消',
    ]);
    assert.equal(abandonResult.lifecycle.state, 'abandoned');
    assert.equal(abandonResult.pointer.removed, true);
    assert.equal(existsSync(abandoned.pointer.path), false);

    const report = statusJson(fixture.repo);
    assert.deepEqual(report.ledgers, []);
    assert.deepEqual(report.drifted_ledgers, []);
    assert.deepEqual(report.terminal_pointers, []);
    assert.deepEqual(readdirSync(fixture.pointerDir), []);
    const text = node(fixture.repo, [CLI, 'status']);
    assert.ok(text.stdout.includes('未发现 ledger。'), text.stdout);
  } finally {
    fixture.cleanup();
  }
});

test("environment.repository 为 'none' 时不写指针，init 输出说明原因", () => {
  const fixture = makeFixture();
  try {
    const initialized = initLedger(fixture, 'detached', { repository: 'none' });
    assert.equal(initialized.pointer.written, false);
    assert.equal(initialized.pointer.path, null);
    assert.match(initialized.pointer.reason, /contract\.environment\.repository 当前值 "none"/u);
    assert.match(initialized.pointer.reason, /--ledger/u);
    assert.ok(
      initialized.warnings.some((item) => item.includes('仓级指针未写入')),
      JSON.stringify(initialized.warnings),
    );
    assert.equal(existsSync(fixture.pointerDir), false);
    assert.deepEqual(statusJson(fixture.repo).ledgers, []);

    // 仓库路径不存在同样只是跳过，不让 init 失败。
    const missing = initLedger(fixture, 'gone', { repository: join(fixture.sandbox, 'not-a-repo') });
    assert.equal(missing.pointer.written, false);
    assert.match(missing.pointer.reason, /路径不存在/u);
    assert.equal(existsSync(join(missing.ledger_dir, 'events.ndjson')), true, '指针跳过不能影响 ledger 本身');
  } finally {
    fixture.cleanup();
  }
});

test('同名 ledger 换 state root 重建时指针被覆盖，init 明确说明旧 ledger 从此要手传 --ledger', () => {
  const fixture = makeFixture();
  try {
    const first = initLedger(fixture, 'same-id', { stateRoot: join(fixture.stateRoot, 'first') });
    assert.equal(first.pointer.replaced, null);
    const second = initLedger(fixture, 'same-id', { stateRoot: join(fixture.stateRoot, 'second') });
    assert.equal(second.pointer.written, true);
    assert.equal(second.pointer.replaced, first.state_root);
    assert.ok(
      second.warnings.some((item) => item.includes(first.state_root) && item.includes('手传 --ledger')),
      JSON.stringify(second.warnings),
    );

    // 指针按 ledger_id 索引，只剩一份，指向新的 state root；旧 ledger 本身没有被动过。
    assert.deepEqual(readdirSync(fixture.pointerDir), ['same-id.json']);
    const report = statusJson(fixture.repo);
    assert.deepEqual(
      report.ledgers.map((entry) => entry.ledger_dir),
      [second.ledger_dir],
    );
    assert.equal(existsSync(join(first.ledger_dir, 'events.ndjson')), true);
  } finally {
    fixture.cleanup();
  }
});

test('同时存在多个未终态 ledger 时全部列出，不做猜测', () => {
  const fixture = makeFixture();
  try {
    for (const id of ['one', 'three', 'two']) initLedger(fixture, id);
    const report = statusJson(fixture.repo);
    assert.deepEqual(
      report.ledgers.map((entry) => entry.ledger_id),
      ['one', 'three', 'two'],
    );
    for (const entry of report.ledgers) assert.ok(entry.next_commands.length > 0, entry.ledger_id);
  } finally {
    fixture.cleanup();
  }
});

test('悬空与终态指针被 doctor --repository 报告、由 reclaim-pointers 显式回收；drift 未终态的指针保留并在 status 单独成组', () => {
  const fixture = makeFixture();
  try {
    const dangling = initLedger(fixture, 'dangling');
    const drifted = initLedger(fixture, 'drifted');
    const terminal = initLedger(fixture, 'terminal');
    const healthy = initLedger(fixture, 'healthy');

    rmSync(dangling.state_root, { recursive: true, force: true });
    driftLedger(drifted.ledger_dir);
    // 终态 ledger 的指针留在原地：模拟 close 时删除失败后残留的那一份。
    const terminalClose = ledgerJson(fixture.repo, [
      'close',
      '--ledger',
      terminal.ledger_dir,
      '--abandon',
      '--reason',
      '升级后不再继续',
    ]);
    assert.equal(terminalClose.pointer.removed, true);
    writeFileSync(
      terminal.pointer.path,
      `${JSON.stringify({ schema_version: 1, ledger_id: 'terminal', state_root: terminal.state_root, contract_digest: terminal.contract.contract_digest, created_at: new Date().toISOString() }, null, 2)}\n`,
    );

    const doctor = ledgerJson(fixture.repo, ['doctor', '--repository', fixture.repo]);
    assert.equal(doctor.mode, 'repository');
    assert.equal(doctor.healthy, false);
    const byId = Object.fromEntries(doctor.pointers.map((item) => [item.ledger_id, item]));
    assert.equal(byId.dangling.state, 'dangling_state_root');
    assert.equal(byId.dangling.reclaimable, true);
    assert.equal(byId.terminal.state, 'terminal');
    assert.equal(byId.terminal.reclaimable, true);
    assert.equal(byId.drifted.state, 'skill_drift');
    assert.equal(byId.drifted.reclaimable, false, 'drift 但未终态的 ledger 指针必须保留');
    assert.equal(byId.healthy.state, 'active');
    assert.equal(byId.healthy.reclaimable, false);
    assert.deepEqual(doctor.retained_skill_drift, [drifted.pointer.path]);
    assert.match(doctor.remediation, /reclaim-pointers --repository/u);

    // doctor 是只读的：报告之后指针一个都不能少。
    assert.deepEqual(readdirSync(fixture.pointerDir).sort(), [
      'dangling.json',
      'drifted.json',
      'healthy.json',
      'terminal.json',
    ]);

    const report = statusJson(fixture.repo);
    assert.deepEqual(
      report.ledgers.map((entry) => entry.ledger_id),
      ['healthy'],
    );
    assert.deepEqual(
      report.drifted_ledgers.map((entry) => entry.ledger_id),
      ['drifted'],
    );
    assert.match(report.drifted_ledgers[0].skill_drift_remediation, /close --abandon --reason/u);
    // drift 的 ledger 只给放弃与 re-contract，不给续跑命令。
    assert.equal(report.drifted_ledgers[0].next_commands.length, 2);
    assert.match(report.drifted_ledgers[0].next_commands[0], /close --ledger .* --abandon --reason <text>/u);
    assert.match(report.drifted_ledgers[0].next_commands[1], /re-contract/u);
    assert.deepEqual(
      report.dangling_pointers.map((item) => item.ledger_id),
      ['dangling'],
    );
    assert.deepEqual(
      report.terminal_pointers.map((item) => item.ledger_id),
      ['terminal'],
    );

    const reclaimed = ledgerJson(fixture.repo, ['reclaim-pointers', '--repository', fixture.repo]);
    assert.deepEqual(reclaimed.reclaimed.map((item) => item.ledger_id).sort(), ['dangling', 'terminal']);
    assert.deepEqual(reclaimed.failures, []);
    assert.deepEqual(reclaimed.retained.map((item) => item.ledger_id).sort(), ['drifted', 'healthy']);
    assert.deepEqual(readdirSync(fixture.pointerDir).sort(), ['drifted.json', 'healthy.json']);
    assert.equal(ledgerJson(fixture.repo, ['doctor', '--repository', fixture.repo]).healthy, true);
  } finally {
    fixture.cleanup();
  }
});

test('doctor 的两个档位互斥，缺档位时 fail closed', () => {
  const fixture = makeFixture();
  try {
    const initialized = initLedger(fixture, 'modes');
    assert.equal(ledgerJson(fixture.repo, ['doctor', '--ledger', initialized.ledger_dir]).mode, 'ledger');
    const both = node(fixture.repo, [
      LEDGER,
      'doctor',
      '--ledger',
      initialized.ledger_dir,
      '--repository',
      fixture.repo,
    ]);
    assert.equal(both.status, 2);
    assert.match(both.stderr, /--ledger 与 --repository 互斥/u);
    const neither = node(fixture.repo, [LEDGER, 'doctor']);
    assert.equal(neither.status, 2);
    assert.match(neither.stderr, /doctor 需要 --ledger/u);
    const notRepo = node(fixture.repo, [LEDGER, 'doctor', '--repository', join(fixture.sandbox, 'state')]);
    assert.equal(notRepo.status, 2);
    assert.match(notRepo.stderr, /无法解析 git common dir/u);
  } finally {
    fixture.cleanup();
  }
});

test('worktree spawn --ledger 写进 record，非法 id 被拒，该 worktree 里 status 收窄到对应 ledger', () => {
  const fixture = makeFixture();
  try {
    initLedger(fixture, 'wide');
    const bound = initLedger(fixture, 'bound');

    const rejected = node(fixture.repo, [
      MANAGER,
      'spawn',
      'bad-binding',
      '--agent',
      'codex',
      '--agent-id',
      'thread-1',
      '--purpose',
      '非法 ledger id',
      '--codegraph',
      'off',
      '--ledger',
      'not a ledger id',
    ]);
    assert.notEqual(rejected.status, 0);
    const refusal = `${rejected.stdout}${rejected.stderr}`;
    assert.match(refusal, /--ledger 无效/u);
    assert.ok(refusal.includes(LEDGER_ID_PATTERN.source), `拒绝文案要写明格式要求：${refusal}`);

    const spawned = node(fixture.repo, [
      MANAGER,
      'spawn',
      'bound-task',
      '--agent',
      'codex',
      '--agent-id',
      'thread-1',
      '--purpose',
      '绑定 ledger 的实现树',
      '--codegraph',
      'off',
      '--root',
      join(fixture.sandbox, 'worktrees'),
      '--ledger',
      'bound',
    ]);
    assert.equal(spawned.status, 0, spawned.stderr || spawned.stdout);

    const recordsDir = join(fixture.repo, '.git', 'worktree-trace', 'v1', 'records');
    const records = readdirSync(recordsDir).map((name) => JSON.parse(readFileSync(join(recordsDir, name), 'utf8')));
    assert.equal(records.length, 1);
    assert.equal(records[0].ledger, 'bound');
    const worktreePath = records[0].path;

    // 仓级视角仍然两个都列；受管 worktree 里用 record 的 ledger 字段收窄到一个。
    assert.deepEqual(
      statusJson(fixture.repo)
        .ledgers.map((entry) => entry.ledger_id)
        .sort(),
      ['bound', 'wide'],
    );
    const narrowed = statusJson(worktreePath);
    assert.equal(narrowed.scope, 'worktree');
    assert.equal(narrowed.worktree_binding.ledger_id, 'bound');
    assert.deepEqual(
      narrowed.ledgers.map((entry) => entry.ledger_id),
      ['bound'],
    );
    assert.equal(narrowed.ledgers[0].ledger_dir, bound.ledger_dir);
    assert.deepEqual(
      narrowed.ledgers[0].worktrees.map((item) => item.path),
      [worktreePath],
    );

    // 不传 --ledger 的树保持 null，老 record 的缺省语义不变。
    const unbound = node(fixture.repo, [
      MANAGER,
      'spawn',
      'unbound-task',
      '--agent',
      'codex',
      '--agent-id',
      'thread-2',
      '--purpose',
      '不绑定 ledger',
      '--codegraph',
      'off',
      '--root',
      join(fixture.sandbox, 'worktrees'),
    ]);
    assert.equal(unbound.status, 0, unbound.stderr || unbound.stdout);
    const all = readdirSync(recordsDir).map((name) => JSON.parse(readFileSync(join(recordsDir, name), 'utf8')));
    assert.deepEqual(all.map((record) => record.ledger).sort(), ['bound', null].sort());
  } finally {
    fixture.cleanup();
  }
});

test('ledger-pointer schema 接受合法样例、拒绝多余字段与非法取值，运行时与 schema 判据一致', () => {
  const sample = {
    schema_version: 1,
    ledger_id: 'alpha.01_beta-2',
    state_root: '/tmp/orchestration-ledger-state',
    contract_digest: `sha256:${'a'.repeat(64)}`,
    created_at: '2026-09-18T00:00:00.000Z',
  };
  assert.deepEqual(collectJsonSchemaErrors(sample, POINTER_SCHEMA), []);
  assert.deepEqual(validateLedgerPointer(sample), sample);

  const extra = { ...sample, note: '夹带私货' };
  assert.equal(POINTER_SCHEMA.additionalProperties, false);
  assert.ok(
    collectJsonSchemaErrors(extra, POINTER_SCHEMA).some((message) => message.includes('note')),
    '多余字段必须被 schema 拒绝',
  );
  assert.throws(() => validateLedgerPointer(extra), /含未知字段：note/u);

  for (const [field, value, pattern] of [
    ['schema_version', 2, /schema_version/u],
    ['ledger_id', 'bad id', /ledger_id/u],
    ['state_root', 'relative/path', /state_root/u],
    ['contract_digest', 'sha256:short', /contract_digest/u],
    ['created_at', 'not-a-time', /created_at/u],
  ]) {
    assert.throws(() => validateLedgerPointer({ ...sample, [field]: value }), pattern, field);
  }
  for (const field of Object.keys(sample)) {
    const missing = { ...sample };
    delete missing[field];
    assert.throws(() => validateLedgerPointer(missing), /缺少字段/u, field);
    assert.ok(collectJsonSchemaErrors(missing, POINTER_SCHEMA).length > 0, field);
  }
});

test('agentkit status 在非 git 目录与未知选项上 fail closed，提示只写 stderr', () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-status-')));
  try {
    const outside = node(sandbox, [CLI, 'status']);
    assert.equal(outside.status, 2);
    assert.equal(outside.stdout, '');
    assert.ok(outside.stderr.includes(sandbox), outside.stderr);
    assert.match(outside.stderr, /请在仓库内运行/u);

    const unknown = node(sandbox, [CLI, 'status', '--repo', '/tmp']);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.stdout, '');
    assert.match(unknown.stderr, /未知选项「--repo」/u);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('core 的指针原语在非 git 目录上给出带路径的拒绝理由，不抛异常', () => {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-pointer-')));
  try {
    const plain = resolveGitCommonDir(sandbox);
    assert.equal(plain.common_dir, null);
    assert.ok(plain.reason.includes(sandbox), plain.reason);
    const absent = resolveGitCommonDir(join(sandbox, 'nope'));
    assert.equal(absent.common_dir, null);
    assert.match(absent.reason, /路径不存在/u);
    assert.deepEqual(listLedgerPointers(join(sandbox, 'missing-common-dir')), []);
    assert.equal(pointerDirectory('/x/.git'), join('/x/.git', 'agentkit', 'ledgers'));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
