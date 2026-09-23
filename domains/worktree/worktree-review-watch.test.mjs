import assert from 'node:assert/strict';
import test from 'node:test';

import { createCommands } from './worktree-review-watch.mjs';
import { resolveChangeRequestProvider } from './worktree-provider-registry.mjs';

// manager() 走子进程 CLI，进程内注册的假适配器到不了子进程；因此这些用例直接
// createCommands({ …假 deps… })，把注册表查询函数替换成返回假适配器，走进程内注入，
// 不引入任何环境变量钩子或动态 import 外部路径。

/** cmdSubmit 只需要下面这些 deps；未列出的项在 submit 路径上不会被调用。 */
function buildSubmitHarness({ record, adapter, resolveProvider, currentStatusOverride }) {
  const logs = [];
  const traceEvents = [];
  const watchedEvents = [];
  const platformCalls = [];
  let latestRecord = record;
  let submittedRecord = null;

  function fakeAppendTraceEvent(event) {
    traceEvents.push({ eventType: event.eventType, details: event.details });
    // currentStatusOverride 只对 change_submitted 生效：模拟写 trace 时 record 状态被并发改动，
    // 让 mutate 命中 SUBMIT_STATE_CHANGED；不传时行为与既有用例完全一致。
    const base =
      currentStatusOverride && event.eventType === 'change_submitted'
        ? { ...latestRecord, task_status: currentStatusOverride }
        : latestRecord;
    const next = event.mutate ? event.mutate(base) : base;
    latestRecord = next;
    if (event.eventType === 'change_submitted') submittedRecord = next;
    return { record: next };
  }

  function fakeAppendWatchedEvent(_commonDir, rec, _token, eventType, mutate) {
    watchedEvents.push(eventType);
    const next = structuredClone(rec);
    if (mutate) mutate(next);
    return next;
  }

  const commands = createCommands({
    rejectUnknownFlags() {},
    flag: (flags, name) => flags.get(name) ?? null,
    log: (message) => logs.push(message),
    die(message) {
      throw new Error(message);
    },
    loadRepositoryProfile: () => ({
      profile: {
        change_request: { provider: adapter.name, remote: 'origin', target_branch: 'main', remove_source_branch: true },
      },
      context: { common_dir: '/fake/common', primary_worktree: '/fake/primary' },
      profile_path: '/fake/.worktree-trace.json',
    }),
    resolveChangeRequestProvider: resolveProvider ?? (() => adapter),
    loadRecords: () => [record],
    selectRecord: () => latestRecord,
    assertHistoryOperationIdle() {},
    liveGitSnapshot: () => ({ present: true, dirty: false, head: 'a'.repeat(40) }),
    gitTry: (args) =>
      args[0] === 'branch' && args[1] === '--show-current' ? { ok: true, out: record.branch } : { ok: true, out: '' },
    git: () => 'feat: fake subject',
    oneLine: (value) => String(value),
    refreshTargetRef: () => ({ ok: true, target_sha: 't'.repeat(40) }),
    parseWatchInterval: () => 100,
    parseNotifyMode: () => 'off',
    runFileCapture: (...callArgs) => {
      platformCalls.push(callArgs);
      return { ok: true, status: 0, out: '', stdout: '', stderr: '', error: null };
    },
    FETCH_TIMEOUT_MS: 5000,
    SUBMIT_PUSH_TIMEOUT_MS: 5000,
    appendTraceEvent: fakeAppendTraceEvent,
    appendWatchedEvent: fakeAppendWatchedEvent,
    writeWatcherHeartbeat() {},
    spawn: () => ({ pid: 4242, unref() {} }),
    randomUUID: () => '00000000-0000-4000-8000-000000000000',
    managerScript: '/fake/worktree-mgr.mjs',
    WorktreeTraceError: class WorktreeTraceError extends Error {
      constructor(code, message) {
        super(message);
        this.code = code;
      }
    },
  });

  return { commands, logs, traceEvents, watchedEvents, platformCalls, getSubmittedRecord: () => submittedRecord };
}

test('submit 走假适配器：precheck 通过后由适配器 submit，trace/record 记 adapter.name，通用层不 push', () => {
  const record = {
    worktree_id: '11111111-2222-4333-8444-555555555555',
    task: 'fake-submit',
    agent: 'codex',
    branch: 'codex/fake-submit',
    base_ref: 'origin/main',
    base_sha: 'b'.repeat(40),
    path: '/fake/worktree',
    task_status: 'active',
  };
  const precheckCtxs = [];
  const submitCtxs = [];
  const adapter = {
    name: 'fake',
    precheck(ctx) {
      precheckCtxs.push(ctx);
      return null;
    },
    submit(ctx) {
      submitCtxs.push(ctx);
      return {
        ok: true,
        change_ref: 'FAKE-CR-7',
        url: 'https://fake.example/cr/7',
        detail: null,
        message: 'fake change request 已提交: FAKE-CR-7',
      };
    },
    SubmitError: class extends Error {},
  };
  const resolvedNames = [];
  const harness = buildSubmitHarness({
    record,
    adapter,
    resolveProvider: (name) => {
      resolvedNames.push(name);
      return adapter;
    },
  });

  harness.commands.cmdSubmit({ flags: new Map([['notify', 'off']]), positionals: ['fake-submit'] });

  // 按名解析拿到假适配器。
  assert.deepEqual(resolvedNames, ['fake']);
  // precheck 恰好在 submit 之前各调一次，ctx 携带解析好的提交值。
  assert.equal(precheckCtxs.length, 1);
  assert.equal(submitCtxs.length, 1);
  const ctx = submitCtxs[0];
  assert.equal(ctx.remote, 'origin');
  assert.equal(ctx.sourceBranch, 'codex/fake-submit');
  assert.equal(ctx.targetBranch, 'main');
  assert.equal(ctx.headSha, 'a'.repeat(40));
  assert.equal(ctx.title, 'feat: fake subject');
  assert.equal(ctx.description, null);
  assert.equal(ctx.changeRequest.provider, 'fake');
  // 通用层不再自己 push：平台调用完全落在适配器里。
  assert.equal(harness.platformCalls.length, 0);
  // change_submitted 事件与 record 的 provider 取 adapter.name，change_ref/url 取 submit 结果。
  const submitted = harness.traceEvents.find((event) => event.eventType === 'change_submitted');
  assert.equal(submitted.details.provider, 'fake');
  assert.equal(submitted.details.change_ref, 'FAKE-CR-7');
  const finalRecord = harness.getSubmittedRecord();
  assert.equal(finalRecord.task_status, 'ready_for_review');
  assert.equal(finalRecord.change_request.provider, 'fake');
  assert.equal(finalRecord.change_request.change_ref, 'FAKE-CR-7');
  assert.equal(finalRecord.change_request.url, 'https://fake.example/cr/7');
  assert.equal(finalRecord.change_request.state, 'submitted');
  // arm watcher 后回显 submit 结果的 message。
  assert.ok(harness.logs.includes('fake change request 已提交: FAKE-CR-7'));
});

test('submit 在 provider 无提交能力（manual）时以平台中立文案 die，不触达 git 或提交', () => {
  const gitCalls = [];
  const commands = createCommands({
    rejectUnknownFlags() {},
    flag: (flags, name) => flags.get(name) ?? null,
    die(message) {
      throw new Error(message);
    },
    loadRepositoryProfile: () => ({
      profile: {
        change_request: { provider: 'manual', remote: 'origin', target_branch: null, remove_source_branch: true },
      },
      context: { common_dir: '/fake/common' },
      profile_path: '/fake/.worktree-trace.json',
    }),
    // 用真实注册表：证明 manual 是登记在册但没有 submit 能力的一项。
    resolveChangeRequestProvider,
    gitTry: (...args) => {
      gitCalls.push(args);
      return { ok: true, out: '' };
    },
    loadRecords: () => {
      throw new Error('manual 应在触达 record 加载前就 die');
    },
    selectRecord: () => {
      throw new Error('manual 应在触达 selectRecord 前就 die');
    },
  });

  assert.throws(
    () => commands.cmdSubmit({ flags: new Map(), positionals: ['whatever'] }),
    (error) => {
      const message = error.message;
      // die 是 CLI 的非 0 退出路径；文案不含任何平台名（GitLab/MR），改用中立的 change request。
      return (
        !/gitlab/i.test(message) &&
        !/\bMR\b/.test(message) &&
        /change request/.test(message) &&
        /不支持|没有/.test(message)
      );
    },
  );
  assert.equal(gitCalls.length, 0);
});

test('submit 成功但写 trace 撞上 SUBMIT_STATE_CHANGED：die 文案给出可照抄的 watch --change-ref 恢复命令，record 未变 submitted', () => {
  const record = {
    worktree_id: '99999999-8888-4777-8666-555555555555',
    task: 'race-submit',
    agent: 'codex',
    branch: 'codex/race-submit',
    base_ref: 'origin/main',
    base_sha: 'b'.repeat(40),
    path: '/fake/worktree',
    task_status: 'active',
  };
  // 平台中立：url 用非具体平台域名，证明恢复命令只依赖 result.url 非空，不感知具体 provider。
  const changeUrl = 'https://example.test/change/9';
  const adapter = {
    name: 'fake',
    precheck: () => null,
    submit: () => ({ ok: true, change_ref: changeUrl, url: changeUrl, detail: null, message: 'fake change request 已提交' }),
    SubmitError: class extends Error {},
  };
  const harness = buildSubmitHarness({ record, adapter, currentStatusOverride: 'integrating' });

  assert.throws(
    () => harness.commands.cmdSubmit({ flags: new Map(), positionals: ['race-submit'] }),
    (error) => error.message.includes(`worktree watch ${record.worktree_id} --change-ref ${changeUrl}`),
  );
  // 写 trace 抛出后 record 未落成 submitted。
  assert.equal(harness.getSubmittedRecord(), null);
});
