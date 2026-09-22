import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeLog } from './verification-runtime.mjs';

// 样本在运行时拼出来，避免仓库里出现形似真 token 的字面量被密钥扫描器误报。
const body = (length, alphabet = 'a1B2c3D4') => alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);

const SHAPES = [
  ['GitHub classic PAT', `ghp_${body(36)}`],
  ['GitHub OAuth', `gho_${body(36)}`],
  ['GitHub server-to-server', `ghs_${body(36)}`],
  ['GitHub fine-grained PAT', `github_pat_${body(22)}_${body(40)}`],
  ['GitLab PAT', `glpat-${body(20)}`],
  ['sk- 系 API key', `sk-ant-${body(40)}`],
  ['Slack bot token', `xoxb-${body(12, '1234567890')}-${body(24)}`],
  ['AWS access key id', `AKIA${body(16, 'ABCD2345')}`],
];

for (const [name, token] of SHAPES) {
  test(`日志脱敏抹掉 ${name}`, () => {
    const out = sanitizeLog(`before ${token} after\nurl=https://x/?t=${token}&n=1`, {}, 4096);
    assert.equal(out.includes(token), false, out);
    assert.match(out, /before \[REDACTED\] after/);
    assert.match(out, /&n=1/);
  });
}

test('日志脱敏不碰形似但不是 token 的普通文本', () => {
  const text = 'ghp_short sk-1 task-runner xoxb AKIA skip-this-step glpat';
  assert.equal(sanitizeLog(text, {}, 4096), text);
});

test('名字像秘密的环境变量，其值无论形态都被抹掉；Bearer 同理', () => {
  const out = sanitizeLog(
    'v=hunter2-plain\nAuthorization: Bearer abc.def-ghi',
    { DEPLOY_PASSWORD: 'hunter2-plain', PATH: '/usr/bin' },
    4096,
  );
  assert.equal(out.includes('hunter2-plain'), false);
  assert.match(out, /Bearer \[REDACTED\]/);
  assert.match(out, /v=\[REDACTED\]/);
});

test('超过 max_log_bytes 时截断并标记，脱敏先于截断', () => {
  const token = `ghp_${body(36)}`;
  const out = sanitizeLog(`${token} ${'x'.repeat(200)}`, {}, 32);
  assert.equal(out.includes('ghp_'), false);
  assert.match(out, /\[TRUNCATED\]\n$/);
});
