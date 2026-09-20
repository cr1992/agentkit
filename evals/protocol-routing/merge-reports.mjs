#!/usr/bin/env node
// @ts-check
// 把若干分片的 report.json 合并成一份。
//
//   node evals/protocol-routing/merge-reports.mjs --out /tmp/pr-eval /tmp/pr-eval/shard-*
//
// 位置参数可以是分片的结果目录，也可以直接是 report.json 路径。
// 产出 `<out>/report.json` 与 `<out>/report.md`，形状与串行跑出来的完全一致。
//
// ⚠️ 合并**不自带任何口径**：两栏、逐条 k/n、无效运行、会话失败照搬，平凡基线拿合并后的
// 有效 n 重算一遍（走的是串行路径同一个 `trivialBaseline()`）。判据见 lib/merge.mjs。

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeReports } from './lib/merge.mjs';
import { redactSecrets } from './lib/redact.mjs';
import { renderMarkdown } from './lib/report.mjs';

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ out: string, quiet: boolean, inputs: string[] }} */
  const options = { out: '', quiet: false, inputs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--quiet') { options.quiet = true; continue; }
    if (token === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--out 需要取值');
      options.out = value;
      i += 1;
      continue;
    }
    if (token.startsWith('--')) throw new Error(`未知选项 ${token}，可选：--out --quiet`);
    options.inputs.push(token);
  }
  if (!options.out) throw new Error('--out <目录> 必填：合并后的 report.json / report.md 写在这里');
  if (options.inputs.length < 2) throw new Error('至少要给两份分片结果（目录或 report.json 路径）');
  return options;
}

/** 目录 → `<目录>/report.json`；已经是文件就原样用。 */
export function resolveReportPath(input) {
  const path = resolve(input);
  if (!existsSync(path)) throw new Error(`找不到 ${path}`);
  const target = statSync(path).isDirectory() ? join(path, 'report.json') : path;
  if (!existsSync(target)) throw new Error(`找不到 ${target}：分片目录里应当有一份 report.json`);
  return target;
}

/** @param {string[]} argv */
export async function main(argv) {
  const options = parseArgs(argv);
  const inputs = options.inputs.map((input) => {
    const path = resolveReportPath(input);
    return { path, report: JSON.parse(readFileSync(path, 'utf8')) };
  });
  const merged = mergeReports(inputs);

  const outDir = resolve(options.out);
  mkdirSync(outDir, { recursive: true });
  // 和 run.mjs 同一道脱敏兜底：合并只搬运文本，但搬的是可能带过会话输出的文本。
  writeFileSync(join(outDir, 'report.json'), redactSecrets(`${JSON.stringify(merged, null, 2)}\n`));
  const markdown = redactSecrets(renderMarkdown(merged));
  writeFileSync(join(outDir, 'report.md'), markdown);
  if (!options.quiet) process.stdout.write(markdown);
  if (merged.session_failures.length) {
    if (!options.quiet) process.stderr.write(redactSecrets(`\n${merged.session_failures.length} 个会话没有跑出记录：\n- ${merged.session_failures.join('\n- ')}\n`));
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
}
