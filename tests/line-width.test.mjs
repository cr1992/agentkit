import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 行宽门禁：全部已跟踪 .mjs 每行按 Unicode 码点数（[...line].length）不超过 MAX_WIDTH。
// 中文一个字算 1 个码点（不是字节），因此纯中文行不会因字节数被误判。
const MAX_WIDTH = 200;

// 豁免清单：按「文件路径 + 该行内容的一小段摘要（includes 匹配）」登记，不按行号登记，
// 这样行号漂移不会让豁免失效。只收录确实无法在不改变语义或严重损害可读性的前提下折行的少数行：
// 长正则、生成产物用的内嵌 SVG/CSS 文本、评测用例的 prompt 字面量。
const EXEMPTIONS = [
  {
    file: 'domains/worktree/worktree-merge-preview.mjs',
    includes: 'npm-shrinkwrap',
    reason: '单条 lockfile 识别正则，拆开会破坏可读性与匹配正确性',
  },
  {
    file: 'scripts/generate-skill-collaboration.mjs',
    includes: 'Controller explicitly selects Loop mode',
    reason: '生成 SVG 的内嵌 <desc> 文本，按原样写入产物',
  },
  {
    file: 'scripts/generate-skill-collaboration.mjs',
    includes: 'stroke-dasharray:7 7',
    reason: '生成 SVG 的内嵌 <style> CSS，按原样写入产物',
  },
  {
    file: 'evals/protocol-routing/cases.mjs',
    includes: 'sum-boundary.test.mjs',
    reason: '评测用例 prompt 字面量，需保持逐字节原样',
  },
];

function trackedMjsFiles() {
  return execFileSync('git', ['ls-files', '*.mjs'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function width(line) {
  return [...line].length;
}

function isExempt(file, line) {
  return EXEMPTIONS.some((exemption) => exemption.file === file && line.includes(exemption.includes));
}

test(`全部已跟踪 .mjs 每行不超过 ${MAX_WIDTH} 码点（豁免清单除外）`, () => {
  const violations = [];
  for (const file of trackedMjsFiles()) {
    const lines = readFileSync(resolve(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const codepoints = width(line);
      if (codepoints > MAX_WIDTH && !isExempt(file, line)) {
        violations.push(`${file}:${index + 1} 宽度 ${codepoints} 码点 > 上限 ${MAX_WIDTH}`);
      }
    });
  }
  assert.deepEqual(violations, [], `以下行超过 ${MAX_WIDTH} 码点上限：\n${violations.join('\n')}`);
});

test('豁免清单不含失效项：每条豁免都命中一条真实的超长行', () => {
  const stale = EXEMPTIONS.filter((exemption) => {
    const lines = readFileSync(resolve(ROOT, exemption.file), 'utf8').split('\n');
    return !lines.some((line) => width(line) > MAX_WIDTH && line.includes(exemption.includes));
  });
  assert.deepEqual(stale, [], `以下豁免已无对应的超长行，应清理：\n${JSON.stringify(stale, null, 2)}`);
});
