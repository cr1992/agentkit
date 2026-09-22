import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function markdownFiles(root) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

test('操作文档只示范 agentkit 命令，不重新引入 Skill 兼容脚本', () => {
  const files = ['orchestrate', 'worktree', 'verify', 'loop'].flatMap((domain) =>
    markdownFiles(join(ROOT, 'docs', domain)),
  );
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(
      text,
      /node\s+(?:["']?\$SKILL_DIR\/scripts\/|["']?<skill-dir(?:ectory)?>\/scripts\/|scripts\/)/u,
      path,
    );
    assert.doesNotMatch(text, /Node\.js 18\+/u, path);
  }
});

// agent 读按需文档的唯一入口是 SKILL.md 里的 `agentkit docs <域> <主题>` 指针；没有任何 SKILL.md
// 提到的主题就是孤儿——文件在仓库里，但顺着协议走永远到不了。
test('每个按需文档主题都至少被一个 SKILL.md 指向，不留孤儿', () => {
  const skills = ['orchestrate-subagents', 'manage-worktrees', 'verify-agent-output', 'run-agent-verify-loop']
    .map((name) => readFileSync(join(ROOT, name, 'SKILL.md'), 'utf8'))
    .join('\n');

  const orphans = [];
  for (const domain of ['orchestrate', 'worktree', 'verify', 'loop']) {
    for (const path of markdownFiles(join(ROOT, 'docs', domain))) {
      const topic = path.slice(join(ROOT, 'docs', domain).length + 1, -'.md'.length);
      if (!skills.includes(`agentkit docs ${domain} ${topic}`)) orphans.push(`docs/${domain}/${topic}.md`);
    }
  }
  assert.deepEqual(orphans, [], `以下文档没有任何 SKILL.md 指向，agent 顺着协议走不到：${orphans.join('、')}`);
});

test('README 与维护约定声明 GitHub 仓为唯一真源并给出正式安装命令', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  assert.match(readme, /唯一真源/u);
  assert.match(agents, /产品代码不得从其他仓库生成、镜像或反向覆盖/u);
  assert.match(readme, /npm install -g @cr1992\/agentkit/u);
  assert.doesNotMatch(readme, /尚未发布到 npm registry/u);
  for (const invalid of ['agentkit orchestrate --help', 'agentkit host --help', 'agentkit loop --help']) {
    assert.ok(!readme.includes(invalid), `README 不应示范失败命令：${invalid}`);
  }
});
