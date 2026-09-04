#!/usr/bin/env node
// @ts-check

export class GitlabSubmitError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'GitlabSubmitError';
    this.code = code;
  }
}

/** @param {unknown} value @param {string} label @param {number} max */
function pushOptionText(value, label, max) {
  if (typeof value !== 'string') {
    throw new GitlabSubmitError('GITLAB_PUSH_OPTION_INVALID', `${label} 必须是字符串。`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000\r\n]/.test(normalized)) {
    throw new GitlabSubmitError(
      'GITLAB_PUSH_OPTION_INVALID',
      `${label} 必须是 1-${max} 字符且不能含 NUL/换行。`,
    );
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
