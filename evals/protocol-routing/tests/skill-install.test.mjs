// @ts-check
// skill 安装缓存自测。**全程不触网、不起任何真实安装器**：安装器是可注入的，
// 这里换成一个只往磁盘铺假 SKILL.md 的桩，或者换成「一被调用就抛」的哨兵。
//
// 要钉住的三件事（issue #15 的后续项 3）：
// 1. 每轮只装一次——缓存已完整时 `prepareSkillCache()` 一个子进程都不起；
// 2. 各会话从缓存复制，复制是纯文件系统操作，**断网也成立**；
// 3. 装不上在开跑前就抛，不表现成逐会话丢样本。

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SKILL_NAMES, installSkills, prepareSkillCache, skillsComplete } from '../lib/skill-install.mjs';

/** 假安装器：把四份 SKILL.md 铺进 `<configDir>/skills/`，并记下自己被调用了几次。 */
function fakeInstaller(calls, { names = SKILL_NAMES, body = '# fake SKILL\n' } = {}) {
  return ({ source, configDir, home }) => {
    calls.push({ source, configDir, home });
    for (const name of names) {
      mkdirSync(join(configDir, 'skills', name), { recursive: true });
      writeFileSync(join(configDir, 'skills', name, 'SKILL.md'), body);
    }
    // 退出码故意非零：真实安装器就是这样（`--agent '*'` 下有 agent 不支持全局安装）。
    return {
      exit_code: 1,
      stdout: '[{"skill":"x","status":"failed"}]',
      stderr: 'Eve does not support global skill installation',
    };
  };
}

const withTemp = (fn) => {
  const base = mkdtempSync(join(tmpdir(), 'protocol-routing-skill-test-'));
  try {
    return fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

test('每轮装一次：缓存已完整时不起任何子进程，也不看安装器', () => {
  withTemp((base) => {
    /** @type {any[]} */
    const calls = [];
    const cacheDir = join(base, 'skill-cache');
    const first = prepareSkillCache({ cacheDir, install: fakeInstaller(calls) });
    assert.equal(calls.length, 1, '第一次必须真的装一遍');
    assert.equal(first.reused, false);
    assert.equal(skillsComplete(first.skills_dir), true);

    // 第二次：安装器换成哨兵——一旦被调用就抛。这条就是「断网也能起会话」的机械证据。
    const second = prepareSkillCache({
      cacheDir,
      install: () => {
        throw new Error('缓存已完整时不该再调用安装器');
      },
    });
    assert.equal(second.reused, true);
    assert.equal(second.skills_dir, first.skills_dir);
    assert.deepEqual(second.content_digests, first.content_digests);
    assert.equal(calls.length, 1, '第二次不得再起安装器');
  });
});

test('安装器退出码非零但四份 SKILL.md 都在时，判「装上了」', () => {
  withTemp((base) => {
    const cache = prepareSkillCache({ cacheDir: join(base, 'skill-cache'), install: fakeInstaller([]) });
    assert.equal(cache.installer?.exit_code, 1, '安装器的退出码只留档');
    assert.deepEqual(cache.installer?.report, [{ skill: 'x', status: 'failed' }]);
    assert.equal(skillsComplete(cache.skills_dir), true);
  });
});

test('装不上就抛，且报错点名缺了哪几个 skill、带上安装器 stderr', () => {
  withTemp((base) => {
    const partial = fakeInstaller([], { names: ['manage-worktrees'] });
    assert.throws(
      () => prepareSkillCache({ cacheDir: join(base, 'skill-cache'), install: partial }),
      (error) => {
        const message = /** @type {Error} */ (error).message;
        assert.match(message, /skill 安装不完整/u);
        for (const name of SKILL_NAMES.filter((name) => name !== 'manage-worktrees'))
          assert.ok(message.includes(name), name);
        assert.match(message, /Eve does not support global skill installation/u);
        return true;
      },
    );
  });
});

test('会话侧只从缓存复制：不触网、不起子进程，每个会话拿到自己的一份拷贝', () => {
  withTemp((base) => {
    const cache = prepareSkillCache({
      cacheDir: join(base, 'skill-cache'),
      install: fakeInstaller([], { body: '# from cache\n' }),
    });

    // 模拟断网：把 npm registry 指到一个不可达地址，再起两个会话。
    // 复制路径一个子进程都不起，所以这两句只是把意图写进测试；真正的机械保证是
    // installSkills 里根本没有 spawn。
    const saved = { registry: process.env.npm_config_registry, offline: process.env.npm_config_offline };
    process.env.npm_config_registry = 'http://127.0.0.1:1/';
    process.env.npm_config_offline = 'true';
    try {
      for (const name of ['session-a', 'session-b']) {
        const home = join(base, name, 'home');
        const configDir = join(home, '.claude');
        const result = installSkills({ configDir, home, cache });
        assert.equal(result.source, 'cache');
        assert.deepEqual(result.skills.map((item) => item.name).sort(), [...SKILL_NAMES].sort());
        assert.equal(skillsComplete(join(configDir, 'skills')), true);
        for (const skill of SKILL_NAMES) {
          assert.equal(readFileSync(join(configDir, 'skills', skill, 'SKILL.md'), 'utf8'), '# from cache\n');
        }
        // content_digest 与安装器回报从缓存带过来：报告里那个锚点不因为走缓存而丢。
        assert.deepEqual(result.content_digests, cache.content_digests);
        assert.equal(result.installer?.exit_code, 1);
      }
    } finally {
      if (saved.registry === undefined) delete process.env.npm_config_registry;
      else process.env.npm_config_registry = saved.registry;
      if (saved.offline === undefined) delete process.env.npm_config_offline;
      else process.env.npm_config_offline = saved.offline;
    }

    // 每个会话是**自己的一份拷贝**：改一个不影响另一个，也不影响缓存。
    const victim = join(base, 'session-a', 'home', '.claude', 'skills', 'manage-worktrees', 'SKILL.md');
    writeFileSync(victim, '# tampered\n');
    assert.equal(
      readFileSync(join(base, 'session-b', 'home', '.claude', 'skills', 'manage-worktrees', 'SKILL.md'), 'utf8'),
      '# from cache\n',
    );
    assert.equal(readFileSync(join(cache.skills_dir, 'manage-worktrees', 'SKILL.md'), 'utf8'), '# from cache\n');
  });
});

test('会话侧复制会覆盖掉上一次留下的残余，缺缓存时明确报错', () => {
  withTemp((base) => {
    const cache = prepareSkillCache({ cacheDir: join(base, 'skill-cache'), install: fakeInstaller([]) });
    const home = join(base, 'home');
    const configDir = join(home, '.claude');
    // 先塞一份脏的同名目录，复制必须把它整个换掉。
    mkdirSync(join(configDir, 'skills', 'verify-agent-output'), { recursive: true });
    writeFileSync(join(configDir, 'skills', 'verify-agent-output', 'STALE.md'), 'stale');
    installSkills({ configDir, home, cache });
    assert.equal(existsSync(join(configDir, 'skills', 'verify-agent-output', 'STALE.md')), false);
    assert.equal(existsSync(join(configDir, 'skills', 'verify-agent-output', 'SKILL.md')), true);

    assert.throws(
      () => installSkills({ configDir, home, cache: /** @type {any} */ (null) }),
      /需要 prepareSkillCache/u,
    );
    assert.throws(
      () => installSkills({ configDir, home, cache: /** @type {any} */ ({ skills_dir: join(base, 'nowhere') }) }),
      /skill 缓存不完整/u,
    );
  });
});
