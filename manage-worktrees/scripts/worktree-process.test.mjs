import assert from 'node:assert/strict';
import test from 'node:test';

import { runFileTry } from './worktree-process.mjs';

test('外部命令超过 timeout 后有界失败，不无限阻塞 spawn', () => {
  const result = runFileTry(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 5_000)'],
    { timeoutMs: 50 },
  );
  assert.equal(result.ok, false);
  // 必须断言超时的可观察签名：只断 ok=false 的话，子进程压根没启动（ENOENT、argv 形状错）
  // 也会立刻返回 false 而误报绿，超时管线整个丢失都测不出来；墙钟上限则在高负载 runner 上抖动。
  assert.equal(result.error?.code, 'ETIMEDOUT');
});
