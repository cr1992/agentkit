import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GithubSubmitError,
  githubChangeRequestProvider,
  githubPrCreateArgs,
  githubPushArgs,
  parseGithubPullRequestUrl,
} from './worktree-provider-github.mjs';

const HEAD = 'a'.repeat(40);

// 不依赖真实 gh 与网络：构造注入了假 gitTry / runFileCapture 的 ctx，
// 把每次调用按序记入 calls，断言收到的 command + argv。
/** @param {{handler:(call:{command:string,args:string[]})=>any, description?:string|null, removeSourceBranch?:boolean}} options */
function makeCtx(options) {
  const calls = [];
  function record(command, args) {
    calls.push({ command, args });
    const reply = options.handler({ command, args }) ?? {};
    return { ok: true, status: 0, out: '', stdout: '', stderr: '', error: null, ...reply };
  }
  const ctx = {
    remote: 'origin',
    sourceBranch: 'agent/portable-submit',
    targetBranch: 'main',
    headSha: HEAD,
    title: 'feat: portable submit',
    description: options.description ?? null,
    changeRequest: { provider: 'github', remote: 'origin', target_branch: 'main', remove_source_branch: !!options.removeSourceBranch },
    cwd: '/fake/wt',
    fetchTimeoutMs: 5000,
    submitPushTimeoutMs: 5000,
    gitTry: (args) => record('git', args),
    runFileCapture: (command, args) => record(command, args),
  };
  return { ctx, calls };
}

/** @param {{command:string,args:string[]}[]} calls */
const stepKeys = (calls) => calls.map((call) => `${call.command} ${call.args[0]}`);

test('GitHub adapter 正常路径：argv 顺序 gh --version→gh auth→git ls-remote→git push→gh pr create，解析出 PR url', () => {
  const prUrl = 'https://github.com/acme/widgets/pull/42';
  const { ctx, calls } = makeCtx({
    handler({ command, args }) {
      if (command === 'gh' && args[0] === 'pr') return { ok: true, out: `${prUrl}\n`, stdout: `${prUrl}\n` };
      return { ok: true, out: '' };
    },
  });

  assert.equal(githubChangeRequestProvider.precheck(ctx), null);
  const result = githubChangeRequestProvider.submit(ctx);

  assert.deepEqual(stepKeys(calls), ['gh --version', 'gh auth', 'git ls-remote', 'git push', 'gh pr']);
  const lsRemote = calls.find((call) => call.command === 'git' && call.args[0] === 'ls-remote');
  assert.deepEqual(lsRemote.args, ['ls-remote', '--heads', 'origin', 'refs/heads/agent/portable-submit']);
  const push = calls.find((call) => call.command === 'git' && call.args[0] === 'push');
  assert.deepEqual(push.args, ['push', '--set-upstream', 'origin', 'HEAD:refs/heads/agent/portable-submit']);
  const pr = calls.find((call) => call.command === 'gh' && call.args[0] === 'pr');
  assert.deepEqual(pr.args, [
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    'agent/portable-submit',
    '--title',
    'feat: portable submit',
    '--body',
    '',
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.url, prUrl);
  assert.equal(result.change_ref, prUrl);
});

test('GitHub adapter：gh 不存在时 precheck 拒绝并给 manual 降级指引，之后没有任何 git/gh 调用', () => {
  const { ctx, calls } = makeCtx({
    handler({ command, args }) {
      if (command === 'gh' && args[0] === '--version') return { ok: false, status: null, error: new Error('spawn gh ENOENT') };
      return { ok: true };
    },
  });

  const reason = githubChangeRequestProvider.precheck(ctx);
  assert.ok(reason);
  assert.match(reason, /gh/);
  assert.match(reason, /manual/);
  assert.match(reason, /--change-ref/);
  // 探测失败即返回：只有 `gh --version` 一次调用，没有 auth status，也没有任何 git 调用。
  assert.deepEqual(stepKeys(calls), ['gh --version']);
  assert.equal(calls.some((call) => call.command === 'git'), false);
});

test('GitHub adapter：gh auth status 非 0 时 precheck 拒绝，止于 auth 探测、不触达 git', () => {
  const { ctx, calls } = makeCtx({
    handler({ command, args }) {
      if (command === 'gh' && args[0] === 'auth') return { ok: false, status: 1, out: 'not logged in', stderr: 'not logged in' };
      return { ok: true };
    },
  });

  const reason = githubChangeRequestProvider.precheck(ctx);
  assert.ok(reason);
  assert.match(reason, /auth|登录/);
  assert.deepEqual(stepKeys(calls), ['gh --version', 'gh auth']);
  assert.equal(calls.some((call) => call.command === 'git'), false);
});

test('GitHub adapter：push 成功但 gh pr create 失败时 ok:false，message 含“分支已推送”、detail 带 gh 输出', () => {
  const failOut = 'gh: pull request create failed';
  const { ctx, calls } = makeCtx({
    handler({ command, args }) {
      if (command === 'gh' && args[0] === 'pr') return { ok: false, status: 1, out: failOut, stderr: failOut };
      return { ok: true, out: '' };
    },
  });

  assert.equal(githubChangeRequestProvider.precheck(ctx), null);
  const result = githubChangeRequestProvider.submit(ctx);

  assert.ok(calls.some((call) => call.command === 'git' && call.args[0] === 'push'));
  assert.equal(result.ok, false);
  assert.equal(result.url, null);
  assert.equal(result.change_ref, null);
  assert.match(result.message, /分支已推送/);
  assert.match(result.detail, /pull request create failed/);
});

test('GitHub adapter：源分支已在 remote 且指向 headSha 时跳过 push，仍 gh pr create', () => {
  const prUrl = 'https://github.com/acme/widgets/pull/7';
  const { ctx, calls } = makeCtx({
    handler({ command, args }) {
      if (command === 'git' && args[0] === 'ls-remote') return { ok: true, out: `${HEAD}\trefs/heads/agent/portable-submit` };
      if (command === 'gh' && args[0] === 'pr') return { ok: true, out: prUrl };
      return { ok: true, out: '' };
    },
  });

  assert.equal(githubChangeRequestProvider.precheck(ctx), null);
  const result = githubChangeRequestProvider.submit(ctx);

  assert.equal(calls.some((call) => call.command === 'git' && call.args[0] === 'push'), false);
  assert.deepEqual(stepKeys(calls), ['gh --version', 'gh auth', 'git ls-remote', 'gh pr']);
  assert.equal(result.ok, true);
  assert.equal(result.url, prUrl);
});

test('GitHub adapter：无法解析 PR url 时 change_ref 退化，remove_source_branch=true 时附一次提示', () => {
  const { ctx } = makeCtx({
    removeSourceBranch: true,
    handler({ command, args }) {
      if (command === 'gh' && args[0] === 'pr') return { ok: true, out: 'opened pull request (no url printed)' };
      return { ok: true, out: '' };
    },
  });

  const result = githubChangeRequestProvider.submit(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.url, null);
  assert.equal(result.change_ref, 'GitHub PR agent/portable-submit -> main');
  assert.match(result.message, /remove_source_branch/);
});

test('GitHub adapter helper：固定 argv 与 PR URL 解析（末个匹配、去尾标点、无匹配返回 null）', () => {
  assert.deepEqual(githubPushArgs({ remote: 'origin', sourceBranch: 'agent/x' }), [
    'push',
    '--set-upstream',
    'origin',
    'HEAD:refs/heads/agent/x',
  ]);
  assert.deepEqual(githubPrCreateArgs({ targetBranch: 'main', sourceBranch: 'agent/x', title: 't', description: null }), [
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    'agent/x',
    '--title',
    't',
    '--body',
    '',
  ]);
  const url = 'https://github.com/acme/widgets/pull/99';
  assert.equal(parseGithubPullRequestUrl(`Creating pull request\n${url}\n`), url);
  assert.equal(parseGithubPullRequestUrl(`see (${url}).`), url);
  assert.equal(parseGithubPullRequestUrl('no url here'), null);
});

test('GitHub adapter：provider 名与 SubmitError 契约稳定', () => {
  assert.equal(githubChangeRequestProvider.name, 'github');
  const error = new githubChangeRequestProvider.SubmitError('GITHUB_X', 'boom');
  assert.equal(error.code, 'GITHUB_X');
  assert.equal(error instanceof GithubSubmitError, true);
});
