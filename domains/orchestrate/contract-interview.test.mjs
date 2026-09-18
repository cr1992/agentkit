import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 跨域用例（与 verify scaffold 的一致性、verify preflight）住在 tests/contract-interview-integration.test.mjs：
// domains/ 之间禁止互相 import，域内测试也守同一条边界。
import { contractSubstance } from '../../core/contract-substance.mjs';
import { main as contractMain } from './contract-tool.mjs';
import { main as ledgerMain } from './orchestration-ledger.mjs';
import { MAX_ROUNDS, ask, completion, outstandingFields, routeFinding } from './contract-interview.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'bin', 'agentkit.mjs');
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'contract-interview-'));
  const write = (name, value) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value, null, 2)); return path; };
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  return { dir, write, read, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 一轮回填：把草稿与作答落盘，走 CLI，返回 { status, stdout, stderr, payload }。 */
function answerRound(box, draft, answers, tag) {
  const draftPath = box.write(`draft-${tag}.json`, draft);
  const answersPath = box.write(`answers-${tag}.json`, { answers });
  const result = run(['contract', 'interview-answer', '--input', draftPath, '--answers', answersPath]);
  return { ...result, payload: result.status === 0 ? JSON.parse(result.stdout) : null };
}

const FIRST_ROUND = [
  { field: 'permissions', options: ['read_only', 'write'], selected: 1, source: 'user' },
  { field: 'objective', options: ['把 interview 状态机落到 contract 域', '只补一份说明文档'], selected: 0, source: 'user' },
  { field: 'acceptance', options: ['npm test 全绿且新增用例逐条通过', '作者自己看过一遍'], selected: 0, source: 'user' },
  { field: 'scope.include', options: ['domains/orchestrate/', 'bin/'], selected: 0, source: 'user' },
];
const SECOND_ROUND = [
  { field: 'scope.exclude', options: ['schemas/ 与四个 SKILL.md', 'tests/'], selected: 0, source: 'user' },
  { field: 'stop_conditions', options: ['需要改 schema 才能通过时停止上报', '改点别的继续往下做'], selected: 0, source: 'user' },
];

test('从 scaffold 出发，两轮合规回填得到的契约通过 contract validate 与 ledger init', () => {
  const box = sandbox();
  try {
    const scaffold = contractMain(['scaffold', '--workdir', box.dir]);
    const first = answerRound(box, scaffold, FIRST_ROUND, 'r1');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.payload.round, 1);
    assert.equal(first.payload.complete, false);
    // 权限一答成 write，第二轮的题就换成了边界与刹车。
    assert.deepEqual(first.payload.next.questions.map((item) => item.field), ['scope.exclude', 'stop_conditions']);

    const second = answerRound(box, first.payload.contract, SECOND_ROUND, 'r2');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.payload.round, 2);
    assert.equal(second.payload.complete, true);
    assert.equal(second.payload.next, null);

    const draftPath = box.write('ready.json', second.payload.contract);
    const freeze = run(['contract', 'interview-freeze', '--input', draftPath]);
    assert.equal(freeze.status, 0, freeze.stderr);
    const frozen = JSON.parse(freeze.stdout);
    assert.equal(frozen.frozen, true);
    // extensions.interview 进入 digest 是预期的：作答记录是契约的一部分，冻结后不可变。
    assert.equal(frozen.contract.extensions.interview.answers.length, 6);
    assert.equal(frozen.contract.permissions.mode, 'write');

    const frozenPath = box.write('frozen.json', frozen.contract);
    assert.equal(contractMain(['validate', '--input', frozenPath]).valid, true);
    const ledger = ledgerMain(['init', '--contract', frozenPath, '--state-root', join(box.dir, 'ledger'), '--allow-repository-state']);
    assert.match(ledger.ledger_id, /^[0-9a-f-]{36}$/u);
  } finally { box.cleanup(); }
});

test('write 权限下必问 scope.exclude 与 stop_conditions，read_only 下不问', () => {
  const box = sandbox();
  try {
    const scaffold = contractMain(['scaffold', '--workdir', box.dir]);
    const readOnly = answerRound(box, scaffold, [
      { field: 'permissions', options: ['read_only', 'write'], selected: 0, source: 'user' },
      ...FIRST_ROUND.slice(1),
    ], 'ro');
    assert.equal(readOnly.status, 0, readOnly.stderr);
    assert.equal(readOnly.payload.complete, true);
    assert.deepEqual(outstandingFields(readOnly.payload.contract), []);
    assert.deepEqual(readOnly.payload.contract.extensions.interview.answers.map((item) => item.field), ['permissions', 'objective', 'acceptance', 'scope.include']);

    const write = answerRound(box, scaffold, FIRST_ROUND, 'wr');
    assert.deepEqual(outstandingFields(write.payload.contract), ['scope.exclude', 'stop_conditions']);
    // permissions 最先问：不先定权限，写任务会一路走完却从没被问到边界和刹车。
    assert.equal(ask(scaffold).questions[0].field, 'permissions');
  } finally { box.cleanup(); }
});

test('只把 TODO 换成任意文字、没有作答记录：实质性判据通过，interview 不冻结并按字段路径列出缺失记录', () => {
  const box = sandbox();
  try {
    const contract = contractMain(['scaffold', '--workdir', box.dir]);
    contract.objective = '随手写的目标';
    contract.scope.include = ['src/'];
    contract.acceptance = [{ contract_item_id: 'acceptance-1', requirement: '随手写的要求' }];
    // 实质性判据的创建入口口径：error 为零。
    assert.deepEqual(contractSubstance(contract).errors, []);
    const unsignedPath = box.write('filled-unsigned.json', contract);
    const path = box.write('filled.json', contractMain(['normalize', '--input', unsignedPath]));
    assert.equal(contractMain(['validate', '--input', path]).valid, true);

    const freeze = run(['contract', 'interview-freeze', '--input', path]);
    assert.notEqual(freeze.status, 0);
    assert.equal(freeze.stdout, '');
    const error = JSON.parse(freeze.stderr);
    assert.equal(error.error, 'interview_rejected');
    for (const field of ['permissions', 'objective', 'acceptance', 'scope.include']) {
      assert.match(error.message, new RegExp(`${field.replace('.', '\\.')}：缺少 source`, 'u'), `未列出缺失的作答记录：${field}`);
    }
    assert.deepEqual(
      completion(contract).missing.map((item) => item.criterion),
      ['missing_answer', 'missing_answer', 'missing_answer', 'missing_answer'],
    );
  } finally { box.cleanup(); }
});

test('作答记录与字段当前值不一致时不冻结', () => {
  const box = sandbox();
  try {
    const scaffold = contractMain(['scaffold', '--workdir', box.dir]);
    const done = answerRound(box, scaffold, [
      { field: 'permissions', options: ['read_only', 'write'], selected: 0, source: 'user' },
      ...FIRST_ROUND.slice(1),
    ], 'ok');
    assert.equal(done.payload.complete, true);

    // 事后手改字段而不更新记录：契约本身仍然通过实质性判据，但完成判据第 3 条不成立。
    const tampered = structuredClone(done.payload.contract);
    tampered.objective = '被事后改写的目标';
    delete tampered.contract_digest;
    const path = box.write('tampered.json', tampered);
    assert.deepEqual(contractSubstance(tampered).errors, []);

    const freeze = run(['contract', 'interview-freeze', '--input', path]);
    assert.notEqual(freeze.status, 0);
    assert.match(JSON.parse(freeze.stderr).message, /与 objective 的当前值不一致/u);
    assert.deepEqual(completion(tampered).missing.map((item) => item.criterion), ['answer_field_mismatch']);
  } finally { box.cleanup(); }
});

test('"都行"进 assumptions[]，不进 scope.exclude，且视为已作答', () => {
  const box = sandbox();
  try {
    const scaffold = contractMain(['scaffold', '--workdir', box.dir]);
    const first = answerRound(box, scaffold, FIRST_ROUND, 'r1');
    const second = answerRound(box, first.payload.contract, [
      { field: 'scope.exclude', options: ['schemas/ 与四个 SKILL.md', 'tests/'], deferred: true, assumed: '保留 scaffold 的空 exclude，不预设任何禁止面' },
      SECOND_ROUND[1],
    ], 'r2');
    assert.equal(second.status, 0, second.stderr);
    const contract = second.payload.contract;
    assert.deepEqual(contract.extensions.interview.assumptions, [
      { field: 'scope.exclude', assumed: '保留 scaffold 的空 exclude，不预设任何禁止面', reason: 'user_deferred' },
    ]);
    // "无所谓"不等于"排除"：assumed 的原话一个字都没写进 scope.exclude。
    assert.deepEqual(contract.scope.exclude, []);
    assert.equal(contract.extensions.interview.answers.some((item) => item.field === 'scope.exclude'), false);
    // 带 assumption 的字段视为已作答：exclude 为空的 warning 仍在，但不再拦住冻结。
    assert.equal(second.payload.complete, true);
    assert.equal(second.payload.warnings.length, 1);
    assert.match(second.payload.warnings[0], /scope\.exclude 为空/u);
    assert.deepEqual(outstandingFields(contract), []);

    const path = box.write('deferred.json', contract);
    const freeze = run(['contract', 'interview-freeze', '--input', path]);
    assert.equal(freeze.status, 0, freeze.stderr);
    assert.match(JSON.parse(freeze.stdout).warnings[0], /scope\.exclude 为空/u);
  } finally { box.cleanup(); }
});

test('选项数为 1 或 5、选项重复都被拒绝', () => {
  const box = sandbox();
  try {
    const scaffold = contractMain(['scaffold', '--workdir', box.dir]);
    const cases = [
      [[{ field: 'objective', options: ['唯一一条'], selected: 0, source: 'user' }], /有 1 项/u],
      [[{ field: 'objective', options: ['a', 'b', 'c', 'd', 'e'], selected: 0, source: 'user' }], /有 5 项/u],
      [[{ field: 'objective', options: ['同一句话', '同一句话'], selected: 0, source: 'user' }], /存在重复项/u],
      [[{ field: 'objective', options: ['正常一条', '   '], selected: 0, source: 'user' }], /options\[1\] 为空/u],
      [[{ field: 'objective', options: ['正常一条', '另一条'], selected: 5, source: 'user' }], /必须是 options 的下标/u],
      [[{ field: 'objective', options: ['正常一条', '另一条'], selected: 0, source: 'model' }], /只接受 "user"/u],
    ];
    for (const [answers, pattern] of cases) {
      const result = answerRound(box, scaffold, answers, `bad-${pattern.source.slice(0, 6)}`);
      assert.notEqual(result.status, 0, `本应拒绝：${JSON.stringify(answers)}`);
      assert.match(JSON.parse(result.stderr).message, pattern);
    }
  } finally { box.cleanup(); }
});

test(`第 ${MAX_ROUNDS} 轮回填后完成判据仍未满足时非零退出并建议拆分任务`, () => {
  const box = sandbox();
  try {
    const scaffold = contractMain(['scaffold', '--workdir', box.dir]);
    const first = answerRound(box, scaffold, FIRST_ROUND, 'x1');
    assert.equal(first.status, 0, first.stderr);
    // 第 2 轮只补 scope.exclude，stop_conditions 始终缺一条作答记录。
    const second = answerRound(box, first.payload.contract, [SECOND_ROUND[0]], 'x2');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.payload.round, 2);

    const third = answerRound(box, second.payload.contract, [
      { field: 'scope.include', options: ['domains/orchestrate/contract-interview.mjs', 'core/'], selected: 0, source: 'user' },
    ], 'x3');
    assert.notEqual(third.status, 0);
    assert.equal(third.stdout, '');
    const error = JSON.parse(third.stderr);
    assert.equal(error.error, 'interview_rejected');
    assert.match(error.message, new RegExp(`已用满 ${MAX_ROUNDS}/${MAX_ROUNDS} 轮`, 'u'));
    assert.match(error.message, /stop_conditions：缺少 source/u);
    assert.match(error.message, /建议把任务拆开/u);
  } finally { box.cleanup(); }
});

test('core 的每条契约层判据都能路由到一道题上', () => {
  const box = sandbox();
  try {
    // 原样 scaffold 切到 write：一次拿到全部 error 与全部 warning。
    const contract = contractMain(['scaffold', '--workdir', box.dir]);
    contract.permissions.mode = 'write';
    const report = contractSubstance(contract);
    assert.ok(report.errors.length >= 3 && report.warnings.length >= 2, '判据样本不足，路由表可能已经失效');
    for (const finding of [...report.errors, ...report.warnings]) {
      assert.notEqual(routeFinding(finding), null, `core 新增判据未接入提问路由：${finding}`);
    }
  } finally { box.cleanup(); }
});
