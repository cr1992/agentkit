import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BUDGETS, DESCRIPTION_LIMIT_PER_SKILL, DESCRIPTION_LIMIT_TOTAL, TOTAL_BUDGET } from './skill-budgets.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 预算数字（BUDGETS/TOTAL_BUDGET/DESCRIPTION_LIMIT_*）的定义与标定依据见 ./skill-budgets.mjs。

test('四件套 SKILL.md 固定上下文保持在字符预算内', () => {
  const usage = Object.fromEntries(Object.entries(BUDGETS).map(([name, budget]) => {
    const text = readFileSync(resolve(ROOT, name, 'SKILL.md'), 'utf8');
    return [name, { chars: [...text].length, budget }];
  }));

  const exceeded = Object.entries(usage).filter(([name, value]) => value.chars > BUDGETS[name]);
  assert.deepEqual(exceeded, [], `固定上下文超出预算：${JSON.stringify(usage)}`);
});

test('四件套固定上下文总量不超过组合预算', () => {
  const total = Object.keys(BUDGETS).reduce((sum, name) => {
    return sum + [...readFileSync(resolve(ROOT, name, 'SKILL.md'), 'utf8')].length;
  }, 0);
  assert.ok(total <= TOTAL_BUDGET, `四件套总字符数 ${total} 超过 ${TOTAL_BUDGET}`);
});

test('Skill 发现描述保持精简且可区分', () => {
  const descriptions = Object.fromEntries(Object.keys(BUDGETS).map((name) => {
    const text = readFileSync(resolve(ROOT, name, 'SKILL.md'), 'utf8');
    const description = text.match(/^description:\s*"([^"]+)"$/m)?.[1];
    assert.ok(description, `${name} 缺少单行 description`);
    return [name, [...description].length];
  }));
  assert.ok(Object.values(descriptions).every((chars) => chars <= DESCRIPTION_LIMIT_PER_SKILL), `description 单项超限：${JSON.stringify(descriptions)}`);
  assert.ok(Object.values(descriptions).reduce((sum, chars) => sum + chars, 0) <= DESCRIPTION_LIMIT_TOTAL, `description 总量超限：${JSON.stringify(descriptions)}`);
});
