#!/usr/bin/env node
// @ts-check

import { ChangeRequestSubmitError } from './worktree-provider-contract.mjs';

/** @typedef {import('./worktree-provider-contract.mjs').ChangeRequestSubmitContext} ChangeRequestSubmitContext */
/** @typedef {import('./worktree-provider-contract.mjs').ChangeRequestSubmitResult} ChangeRequestSubmitResult */
/** @typedef {import('./worktree-provider-contract.mjs').ChangeRequestProvider} ChangeRequestProvider */

export class GithubSubmitError extends ChangeRequestSubmitError {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(code, message);
    this.name = 'GithubSubmitError';
  }
}

/**
 * 只生成固定的 push argv：把 HEAD 推到 remote 的源分支。不执行 shell，也不读凭据。
 * @param {{remote:string, sourceBranch:string}} options
 */
export function githubPushArgs(options) {
  return ['push', '--set-upstream', options.remote, `HEAD:refs/heads/${options.sourceBranch}`];
}

/**
 * 只生成固定的 `gh pr create` argv。title/description 由通用层预先 oneLine 归一，
 * 且各自落在独立 argv 元素里；description 为空时传空串，保持位置固定。
 * @param {{targetBranch:string, sourceBranch:string, title:string, description?:string|null}} options
 */
export function githubPrCreateArgs(options) {
  return [
    'pr',
    'create',
    '--base',
    options.targetBranch,
    '--head',
    options.sourceBranch,
    '--title',
    options.title,
    '--body',
    options.description ?? '',
  ];
}

/** @param {string} output */
export function parseGithubPullRequestUrl(output) {
  const matches = output.match(/https?:\/\/[^\s<>]+\/pull\/\d+/g) ?? [];
  return matches.at(-1)?.replace(/[),.;]+$/, '') ?? null;
}

/**
 * GitHub 走 `gh` CLI，凭据由 gh 自管；适配器不读、不存、不打印任何凭据。
 * 探测顺序：先确认 gh 可执行，再确认已登录。任一失败都返回可照抄的降级指引，
 * 让调用方改用 provider=manual 手工建 PR 后再 watch。
 * @param {ChangeRequestSubmitContext} ctx
 * @returns {string|null}
 */
function precheck(ctx) {
  const probe = ctx.runFileCapture('gh', ['--version']);
  if (!probe.ok) {
    return '未找到 gh CLI；可改用 provider=manual，手工建 PR 后运行 `worktree watch <selector> --change-ref <url>` 登记。';
  }
  const auth = ctx.runFileCapture('gh', ['auth', 'status']);
  if (!auth.ok) {
    return 'gh 未登录（gh auth status 退出码非 0）；请先 `gh auth login`，或改用 provider=manual 手工建 PR 后 `worktree watch <selector> --change-ref <url>`。';
  }
  return null;
}

/**
 * 执行 GitHub PR 提交：分支已完整推到 remote 则跳过 push（“HEAD 已在 remote 就拒绝”
 * 是 GitLab push-options 特有限制，GitHub 不适用），随后 `gh pr create` 建 PR。
 * push 成功但建 PR 失败时明确回报“分支已推送、PR 未创建”，供通用层 die 且不写 trace。
 * @param {ChangeRequestSubmitContext} ctx
 * @returns {ChangeRequestSubmitResult}
 */
function submit(ctx) {
  const lsRemote = ctx.gitTry(['ls-remote', '--heads', ctx.remote, `refs/heads/${ctx.sourceBranch}`], ctx.cwd, {
    timeoutMs: ctx.fetchTimeoutMs,
  });
  const remoteHeadSha = lsRemote.ok && lsRemote.out ? lsRemote.out.split(/\s+/)[0] : null;
  if (remoteHeadSha !== ctx.headSha) {
    const pushArgs = githubPushArgs({ remote: ctx.remote, sourceBranch: ctx.sourceBranch });
    const pushed = ctx.runFileCapture('git', pushArgs, { cwd: ctx.cwd, timeoutMs: ctx.submitPushTimeoutMs });
    if (!pushed.ok) {
      const detail = pushed.out || pushed.error?.message || `exit=${pushed.status}`;
      return {
        ok: false,
        change_ref: null,
        url: null,
        detail,
        message: `GitHub 分支 push 失败；trace/watcher 未更新。\n${detail}`,
      };
    }
  }

  const prArgs = githubPrCreateArgs({
    targetBranch: ctx.targetBranch,
    sourceBranch: ctx.sourceBranch,
    title: ctx.title,
    description: ctx.description,
  });
  const created = ctx.runFileCapture('gh', prArgs, { cwd: ctx.cwd, timeoutMs: ctx.submitPushTimeoutMs });
  if (!created.ok) {
    const detail = created.out || created.error?.message || `exit=${created.status}`;
    return {
      ok: false,
      change_ref: null,
      url: null,
      detail,
      message: `GitHub 分支已推送，但 gh pr create 失败，PR 未创建；trace/watcher 未更新。\n${detail}`,
    };
  }

  const url = parseGithubPullRequestUrl(created.out);
  const changeRef = url ?? `GitHub PR ${ctx.sourceBranch} -> ${ctx.targetBranch}`;
  // remove_source_branch 对 GitHub 不适用：源分支删除由仓库的 delete_branch_on_merge 决定，
  // 适配器无法也不应代管；配置里带了它就顺带提示一次，不作为拒绝理由。
  const ignoredHint = ctx.changeRequest?.remove_source_branch
    ? '\n提示：remove_source_branch 对 GitHub 无效，源分支删除由仓库 delete_branch_on_merge 设置决定。'
    : '';
  return {
    ok: true,
    change_ref: changeRef,
    url,
    detail: null,
    message: `GitHub PR 已提交: ${changeRef}${ignoredHint}`,
  };
}

/** @type {ChangeRequestProvider} */
export const githubChangeRequestProvider = {
  name: 'github',
  precheck,
  submit,
  SubmitError: GithubSubmitError,
};
