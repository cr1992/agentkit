// @ts-check

// 五个编排脚本共用的 `--help` 渲染。命令与参数清单只从各脚本已有的 CLI_SPEC 表推导，
// 不允许在正文里手写第二份清单——否则表和帮助会各自漂移。

/** @typedef {{ required?: string[], optional?: string[], flags?: string[] }} CommandSpec */

const HELP_TOKENS = new Set(['--help', '-h', 'help']);

/**
 * 无参数、`help`、`--help`、`-h` 都按求助处理。
 * @param {string[]} argv
 */
export function isHelpRequest(argv) {
  return argv.length === 0 || HELP_TOKENS.has(argv[0]);
}

/**
 * CLI_SPEC 中一条命令接受的全部带值选项（required + optional）。
 * @param {CommandSpec} spec
 */
export function specOptionNames(spec) {
  return [...(spec.required ?? []), ...(spec.optional ?? [])];
}

/**
 * CLI_SPEC 全部命令接受的带值选项并集，供只做全局选项校验的脚本使用。
 * @param {Record<string, CommandSpec>} cliSpec
 */
export function allOptionNames(cliSpec) {
  return new Set(Object.values(cliSpec).flatMap((spec) => specOptionNames(spec)));
}

/**
 * @param {string} script 脚本文件名
 * @param {Record<string, CommandSpec>} cliSpec
 * @param {string[]} notes 额外说明行
 */
export function renderCliHelp(script, cliSpec, notes = []) {
  const lines = [`用法: node ${script} <command> [options]`, '', '命令:'];
  for (const [command, spec] of Object.entries(cliSpec)) {
    const parts = [command];
    for (const name of spec.required ?? []) parts.push(`--${name} <value>`);
    for (const name of spec.optional ?? []) parts.push(`[--${name} <value>]`);
    for (const name of spec.flags ?? []) parts.push(`[--${name}]`);
    lines.push(`  ${parts.join(' ')}`);
  }
  if (notes.length) {
    lines.push('', '说明:');
    for (const note of notes) lines.push(`  ${note}`);
  }
  lines.push('', '无参数 / help / --help / -h 打印本清单并退出 0；未知命令与非法输入仍按各脚本原有错误形状返回并非零退出。');
  return `${lines.join('\n')}\n`;
}
