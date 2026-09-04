import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 字符数是确定性的、与分词器无关的代理指标。预算按一轮实测重定：先把重复内容与细则迁进
// docs/<域>/、把调用改成 PATH 上的 agentkit 命令，再按迁移后的实际值加约 5% 余量取整。
// 余量只够吸收正常措辞调整；再有低频操作细节漂回常驻的 SKILL.md 就会撞线。
const BUDGETS = {
  'orchestrate-subagents': 8_100,
  'manage-worktrees': 4_700,
  'verify-agent-output': 4_700,
  'run-agent-verify-loop': 4_800,
};

test('四件套 SKILL.md 固定上下文保持在字符预算内', () => {
  const usage = Object.fromEntries(Object.entries(BUDGETS).map(([name, budget]) => {
    const text = readFileSync(resolve(ROOT, name, 'SKILL.md'), 'utf8');
    return [name, { chars: [...text].length, budget, approximate_tokens: Math.ceil([...text].length / 4) }];
  }));

  const exceeded = Object.entries(usage).filter(([name, value]) => value.chars > BUDGETS[name]);
  assert.deepEqual(exceeded, [], `固定上下文超出预算：${JSON.stringify(usage)}`);
});

test('四件套固定上下文总量不超过组合预算', () => {
  const total = Object.keys(BUDGETS).reduce((sum, name) => {
    return sum + [...readFileSync(resolve(ROOT, name, 'SKILL.md'), 'utf8')].length;
  }, 0);
  assert.ok(total <= 22_200, `四件套总字符数 ${total} 超过 22200`);
});

test('Skill 发现描述保持精简且可区分', () => {
  const descriptions = Object.fromEntries(Object.keys(BUDGETS).map((name) => {
    const text = readFileSync(resolve(ROOT, name, 'SKILL.md'), 'utf8');
    const description = text.match(/^description:\s*"([^"]+)"$/m)?.[1];
    assert.ok(description, `${name} 缺少单行 description`);
    return [name, [...description].length];
  }));
  assert.ok(Object.values(descriptions).every((chars) => chars <= 140), `description 单项超限：${JSON.stringify(descriptions)}`);
  assert.ok(Object.values(descriptions).reduce((sum, chars) => sum + chars, 0) <= 500, `description 总量超限：${JSON.stringify(descriptions)}`);
});
