// @ts-check
// `agentkit` PATH 垫片自测（issue #15 的缺陷 1）。全部离线，不起任何会话、零模型费用。
//
// 要钉死的是一句话：**被测会话的环境里 `command -v agentkit` 能解析到垫片，
// 跑出来的版本等于被测 checkout 的版本。** 四个 SKILL.md 通篇指示调用 PATH 上的 `agentkit`，
// 这一条不成立，正向第 3–7 条量到的就不是协议路由，而是「模型会不会自己找入口」。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { AGENTKIT_BIN, REPO_ROOT } from '../lib/agentkit.mjs';
import { createAgentkitShim, prependToPath, shimScript } from '../lib/agentkit-shim.mjs';
import { extractAgentkitArgv } from '../lib/argv.mjs';
import { normalizeCall } from '../lib/classifier.mjs';
import { buildSessionEnv } from '../lib/session-env.mjs';

const CHECKOUT_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;

test('垫片在会话环境里可解析，且版本等于被测 checkout 的版本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-routing-shim-'));
  try {
    const shim = createAgentkitShim({ dir: join(dir, 'bin') });
    assert.equal(shim.target, AGENTKIT_BIN, '垫片必须指向被测 checkout 的 bin/agentkit.mjs');
    assert.ok(statSync(shim.path).mode & 0o111, '垫片必须可执行');

    // 和驱动器完全一样地构造会话环境：白名单继承 PATH，垫片目录在覆盖项里拼到最前。
    const env = buildSessionEnv(process.env, {
      PATH: prependToPath(shim.dir, process.env.PATH),
      HOME: join(dir, 'home'),
    });
    assert.ok(env.PATH.startsWith(`${shim.dir}${delimiter}`), '垫片目录必须在 PATH 最前');

    const resolved = execFileSync('sh', ['-c', 'command -v agentkit'], { env, encoding: 'utf8' }).trim();
    assert.equal(resolved, shim.path, '`command -v agentkit` 必须解析到垫片');

    const version = execFileSync('sh', ['-c', 'agentkit --version'], { env, encoding: 'utf8' }).trim();
    assert.equal(version, CHECKOUT_VERSION, `PATH 上的 agentkit 版本必须等于被测 checkout 的 ${CHECKOUT_VERSION}`);

    // 真的是同一份实现，不是碰巧同名：直接跑 checkout 的入口应当给出同一个版本。
    assert.equal(execFileSync(process.execPath, [AGENTKIT_BIN, '--version'], { encoding: 'utf8' }).trim(), version);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('垫片脚本是 exec 转发，路径里有空格和引号也成立', () => {
  const dir = mkdtempSync(join(tmpdir(), "protocol-routing-shim odd'quote-"));
  try {
    const shim = createAgentkitShim({ dir: join(dir, 'bin') });
    const script = readFileSync(shim.path, 'utf8');
    assert.match(script, /^#!\/bin\/sh\n/u);
    assert.match(script, /^exec .*"\$@"$/mu, '必须 exec 掉自己并原样透传参数');
    const env = buildSessionEnv(process.env, { PATH: prependToPath(shim.dir, process.env.PATH) });
    assert.equal(execFileSync('sh', ['-c', 'agentkit --version'], { env, encoding: 'utf8' }).trim(), CHECKOUT_VERSION);
    // 退出码原样透传：SKILL.md 里到处在看 agentkit 的退出码。
    assert.throws(() => execFileSync('sh', ['-c', 'agentkit no-such-domain'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('分类器把垫片形态与 node 入口形态归成同一类', () => {
  // 会话里写的是 `agentkit …`（垫片形态）；没有垫片时模型会摸到 `node <checkout>/bin/agentkit.mjs …`。
  // 两种都必须归到同一个域 + 动词，否则换成垫片之后历史结果不可比。
  const shimForm = extractAgentkitArgv('agentkit worktree spawn feature --agent claude-code')[0];
  const nodeForm = extractAgentkitArgv(`node ${AGENTKIT_BIN} worktree spawn feature --agent claude-code`)[0];
  assert.deepEqual(shimForm, nodeForm);
  assert.equal(normalizeCall(shimForm).label, 'agentkit worktree spawn');
  assert.equal(normalizeCall(nodeForm).label, 'agentkit worktree spawn');

  // 垫片脚本自己的正文（`exec <node> <bin> "$@"`）即便被当成命令文本喂进来，
  // 也只会解析出一个没有域没有动词的调用，因而不可观测——不会凭空多出一个观测量。
  const fromScript = extractAgentkitArgv(shimScript({ nodePath: '/usr/bin/node', binPath: AGENTKIT_BIN }));
  assert.deepEqual(fromScript, [['$@']]);
  assert.equal(normalizeCall(fromScript[0]).observable, false);
});

test('prependToPath 在父环境没有 PATH 时也给得出一个可用的 PATH', () => {
  assert.equal(prependToPath('/a', '/usr/bin:/bin'), `/a${delimiter}/usr/bin:/bin`);
  assert.equal(prependToPath('/a', undefined), '/a');
  assert.equal(prependToPath('/a', ''), '/a');
});
