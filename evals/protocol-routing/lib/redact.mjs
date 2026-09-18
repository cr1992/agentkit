// @ts-check
// 认证材料脱敏兜底。
//
// harness 自己已经做到「取值不落盘」：`command.json` 只记 `env_keys`（键名），
// token 只经环境变量进入子进程，不进命令行参数。这个模块是**兜底**，不是主防线——
// 它在写 `report.json` / `report.md` 之前对文本做一次字面替换，防的是
// 「某条被测会话的输出、某段 stderr 恰好把取值带进了报告」这种漏网情形。
//
// ⚠️ 它管不住被测会话自己写进会话目录的东西（会话可以 `echo $CLAUDE_CODE_OAUTH_TOKEN`
// 到 `stream.jsonl` 里）。所以结果目录整体按敏感材料对待，见 README「已知盲区」。

/** 认定为「认证材料」的环境变量键。取值一旦出现在报告文本里就替换掉。 */
export const SECRET_ENV_KEYS = Object.freeze([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]);

/**
 * 太短的取值不替换：一个长度为 1、2 的变量值（例如某人把 ANTHROPIC_API_KEY 设成 `x`
 * 做占位）会把报告里所有同名字符全打成马赛克，那比不脱敏更糟。
 */
export const MIN_SECRET_LENGTH = 8;

/**
 * 从环境里挑出需要脱敏的取值，长的排前面——
 * 一个取值是另一个的前缀时，先替换长的才不会留下半截。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{ key: string, value: string }>}
 */
export function secretValues(env = process.env) {
  /** @type {Array<{ key: string, value: string }>} */
  const found = [];
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) found.push({ key, value });
  }
  return found.sort((a, b) => b.value.length - a.value.length);
}

/**
 * 把文本里出现的认证取值替换成 `«REDACTED:<键名>»`。
 * 用字面替换而不是正则：取值里可能含正则元字符。
 * 替换串不含引号与反斜杠，因此对 JSON 文本做替换后仍是合法 JSON。
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function redactSecrets(text, env = process.env) {
  let out = text;
  for (const { key, value } of secretValues(env)) out = out.split(value).join(`«REDACTED:${key}»`);
  return out;
}
