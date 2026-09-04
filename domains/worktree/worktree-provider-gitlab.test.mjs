import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GitlabSubmitError,
  gitlabSubmitPushArgs,
  parseGitlabMergeRequestUrl,
} from './worktree-provider-gitlab.mjs';

test('GitLab adapter 只生成固定 push-option argv', () => {
  assert.deepEqual(gitlabSubmitPushArgs({
    remote: 'origin',
    sourceBranch: 'agent/portable-submit',
    targetBranch: 'main',
    title: 'feat(worktree): portable submit',
    description: 'Agent 提交并自动监听',
    removeSourceBranch: true,
  }), [
    'push',
    '--set-upstream',
    '-o',
    'merge_request.create',
    '-o',
    'merge_request.target=main',
    '-o',
    'merge_request.title=feat(worktree): portable submit',
    '-o',
    'merge_request.description=Agent 提交并自动监听',
    '-o',
    'merge_request.remove_source_branch',
    'origin',
    'HEAD:refs/heads/agent/portable-submit',
  ]);
});

test('GitLab adapter 拒绝换行注入并解析 remote sideband MR URL', () => {
  assert.throws(
    () => gitlabSubmitPushArgs({
      remote: 'origin',
      sourceBranch: 'agent/safe',
      targetBranch: 'main',
      title: 'safe\nmerge_request.target=evil',
    }),
    (error) => error instanceof GitlabSubmitError && error.code === 'GITLAB_PUSH_OPTION_INVALID',
  );
  assert.equal(
    parseGitlabMergeRequestUrl('remote: View merge request:\nremote:   http://gitlab.example/group/repo/-/merge_requests/42\n'),
    'http://gitlab.example/group/repo/-/merge_requests/42',
  );
  assert.equal(parseGitlabMergeRequestUrl('Everything up-to-date'), null);
});
