// @ts-check
// Runs examples/quickstart/run.mjs against the in-tree CLI and asserts the two
// verdicts and both Evidence validations. AGENTKIT_BIN pins bin/agentkit.mjs so
// this exercises the runtime in this repo, not whatever `agentkit` is on PATH.
// It is also a regression test of the public `agentkit verify` CLI contract: the
// example never imports agentkit internals.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'examples', 'quickstart', 'run.mjs');
const AGENTKIT_BIN = join(ROOT, 'bin', 'agentkit.mjs');

test('quickstart 示例跑通两个固定 SHA，两份 Evidence 都通过 validate', { timeout: 120_000 }, () => {
  // The script writes its git repo and run state under os.tmpdir() and cleans them
  // in a finally block; cwd is an isolated temp dir purely so a stray write cannot
  // land in the repository.
  const sandbox = mkdtempSync(join(tmpdir(), 'agentkit-quickstart-test-'));
  try {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...process.env, AGENTKIT_BIN },
    });

    assert.equal(result.status, 0, `脚本应以 0 退出\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const out = result.stdout;

    // 两个 terminal_outcome：缺陷版非 pass，修复版 pass。
    const outcomes = [...out.matchAll(/terminal_outcome = (\w+)/gu)].map((m) => m[1]);
    assert.equal(outcomes.length, 2, `应出现两个 terminal_outcome，实际：${JSON.stringify(outcomes)}`);
    assert.ok(outcomes.includes('fail'), `缺陷版 terminal_outcome 应为 fail，实际：${JSON.stringify(outcomes)}`);
    assert.ok(outcomes.includes('pass'), `修复版 terminal_outcome 应为 pass，实际：${JSON.stringify(outcomes)}`);
    const nonPass = outcomes.filter((outcome) => outcome !== 'pass');
    assert.equal(nonPass.length, 1, `应恰有一个非 pass 结论，实际：${JSON.stringify(outcomes)}`);

    // 两份 Evidence 都能过 agentkit verify validate。
    const validated = [...out.matchAll(/verify validate: valid = (\w+)/gu)].map((m) => m[1]);
    assert.deepEqual(validated, ['true', 'true'], `两份 Evidence 都应 validate 通过，实际：${JSON.stringify(validated)}`);

    // 冻结 Artifact 不变量：HEAD 偏离后 prepare-run 拒绝并给出 stale_precondition。
    assert.match(out, /stale_precondition/u, '应演示冻结 Artifact 的 stale_precondition 拒绝');

    // 诚实性说明必须出现：user_relayed 是调用方声明，L1 是预置文案。
    assert.match(out, /user_relayed/u);
    assert.match(out, /agentkit does NOT review code itself/u);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
