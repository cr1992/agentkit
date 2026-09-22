#!/usr/bin/env node
// @ts-check

import { ChangeRequestSubmitError } from './worktree-provider-contract.mjs';

/** @typedef {import('./worktree-provider-contract.mjs').ChangeRequestSubmitContext} ChangeRequestSubmitContext */
/** @typedef {import('./worktree-provider-contract.mjs').ChangeRequestSubmitResult} ChangeRequestSubmitResult */
/** @typedef {import('./worktree-provider-contract.mjs').ChangeRequestProvider} ChangeRequestProvider */

export class GitlabSubmitError extends ChangeRequestSubmitError {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(code, message);
    this.name = 'GitlabSubmitError';
  }
}

/** @param {unknown} value @param {string} label @param {number} max */
function pushOptionText(value, label, max) {
  if (typeof value !== 'string') {
    throw new GitlabSubmitError('GITLAB_PUSH_OPTION_INVALID', `${label} 必须是字符串。`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000\r\n]/.test(normalized)) {
    throw new GitlabSubmitError('GITLAB_PUSH_OPTION_INVALID', `${label} 必须是 1-${max} 字符且不能含 NUL/换行。`);
  }
  return normalized;
}

/**
 * 只生成固定 git argv；不执行 shell，也不读取 token。
 * @param {{remote:string,sourceBranch:string,targetBranch:string,title:string,description?:string|null,removeSourceBranch?:boolean}} options
 */
export function gitlabSubmitPushArgs(options) {
  const remote = pushOptionText(options.remote, 'remote', 120);
  const sourceBranch = pushOptionText(options.sourceBranch, 'source branch', 240);
  const targetBranch = pushOptionText(options.targetBranch, 'target branch', 240);
  const title = pushOptionText(options.title, 'MR title', 240);
  const args = [
    'push',
    '--set-upstream',
    '-o',
    'merge_request.create',
    '-o',
    `merge_request.target=${targetBranch}`,
    '-o',
    `merge_request.title=${title}`,
  ];
  if (options.description) {
    args.push('-o', `merge_request.description=${pushOptionText(options.description, 'MR description', 1000)}`);
  }
  if (options.removeSourceBranch ?? true) args.push('-o', 'merge_request.remove_source_branch');
  args.push(remote, `HEAD:refs/heads/${sourceBranch}`);
  return args;
}

/** @param {string} output */
export function parseGitlabMergeRequestUrl(output) {
  const matches = output.match(/https?:\/\/[^\s<>]+\/-\/merge_requests\/\d+/g) ?? [];
  return matches.at(-1)?.replace(/[),.;]+$/, '') ?? null;
}

/**
 * push-options 只在实际 push 时生效：HEAD 已完整存在于 remote 时不 push 就建不了 MR，
 * 这是 GitLab 特有限制，不是通用规则，因此收在适配器的 precheck 里。
 * @param {ChangeRequestSubmitContext} ctx
 * @returns {string|null}
 */
function precheck(ctx) {
  const upstreamHead = ctx.gitTry(['rev-parse', '@{upstream}^{commit}'], ctx.cwd);
  const remoteHead = ctx.gitTry(['ls-remote', '--heads', ctx.remote, `refs/heads/${ctx.sourceBranch}`], ctx.cwd, {
    timeoutMs: ctx.fetchTimeoutMs,
  });
  const remoteHeadSha = remoteHead.ok && remoteHead.out ? remoteHead.out.split(/\s+/)[0] : null;
  if ((upstreamHead.ok && upstreamHead.out === ctx.headSha) || remoteHeadSha === ctx.headSha) {
    return '当前 HEAD 已完整存在于 remote；GitLab 只在实际 push 时处理 MR push-options。请使用 API/UI 创建 MR 后运行 watch，工具不会为触发 push-option 改写历史或 force push。';
  }
  return null;
}

/**
 * 执行 GitLab MR push-options 提交；失败与成功文案逐字保留在此，供通用层回显。
 * @param {ChangeRequestSubmitContext} ctx
 * @returns {ChangeRequestSubmitResult}
 */
function submit(ctx) {
  const pushArgs = gitlabSubmitPushArgs({
    remote: ctx.remote,
    sourceBranch: ctx.sourceBranch,
    targetBranch: ctx.targetBranch,
    title: ctx.title,
    description: ctx.description,
    removeSourceBranch: ctx.changeRequest.remove_source_branch,
  });
  const pushed = ctx.runFileCapture('git', pushArgs, { cwd: ctx.cwd, timeoutMs: ctx.submitPushTimeoutMs });
  if (!pushed.ok) {
    const detail = pushed.out || pushed.error?.message || `exit=${pushed.status}`;
    return {
      ok: false,
      change_ref: null,
      url: null,
      detail,
      message: `GitLab MR push 失败；trace/watcher 未更新。\n${detail}`,
    };
  }
  const url = parseGitlabMergeRequestUrl(pushed.out);
  const changeRef = url ?? `GitLab MR ${ctx.sourceBranch} -> ${ctx.targetBranch}`;
  return {
    ok: true,
    change_ref: changeRef,
    url,
    detail: null,
    message: `GitLab MR 已提交: ${changeRef}`,
  };
}

/** @type {ChangeRequestProvider} */
export const gitlabChangeRequestProvider = {
  name: 'gitlab',
  precheck,
  submit,
  SubmitError: GitlabSubmitError,
};
