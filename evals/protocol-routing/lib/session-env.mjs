// @ts-check
// 被测会话的环境变量白名单。
//
// 会话在 `bypassPermissions` 下运行：它不经确认就能执行任意命令。把运行者的整个
// `process.env` 原样传下去，等于把运行者手上的每一份凭据（GH_TOKEN、NPM_TOKEN、
// GITLAB_TOKEN、云厂商 key……）都交给一个正在被测量「会不会越界」的会话，而且它有网。
// 所以这里是白名单而不是黑名单：没列进来的一律不传，漏掉一个只会让会话跑不起来，
// 不会悄悄外泄一份凭据。
//
// 白名单只放两类：宿主 CLI 跑起来必需的（PATH、TLS、代理、locale、临时目录），
// 以及 Claude Code 自己的认证项（API key 与订阅 token 同级，见下）。
// 第三方 provider（Bedrock / Vertex / Foundry）的
// AWS_* / GOOGLE_* / AZURE_* **不在**白名单里——要用那些 provider 跑评测，
// 得显式往 `INHERITED_ENV_KEYS` 里加，并且清楚自己在把什么交出去。

/** 精确匹配的键。 */
export const INHERITED_ENV_KEYS = Object.freeze([
  // 进程跑起来必需
  'PATH',
  'TERM',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE',
  // Node / TLS：企业内网自带 CA 时缺了就连不上
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // 代理：内网出口
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  // Claude Code 认证。HOME 被重定向到会话目录，交互式 OAuth / keychain 那条路走不通，
  // 能用的只有「由环境变量带进来」的两条，二者同级：
  // - ANTHROPIC_API_KEY：控制台 API key，`claude --help` 点名了它（CI 走这条）；
  // - CLAUDE_CODE_OAUTH_TOKEN：`claude setup-token` 生成的长期订阅 token，
  //   需要 Claude 订阅（`claude setup-token --help`：Set up a long-lived
  //   authentication token (requires Claude subscription)）。本机容器运行走这条。
  // ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL 是自建网关的常见配法，
  // **属于「拿不准但放进去了」**，见 README「已知盲区」。
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
]);

/** 前缀匹配的键。 */
export const INHERITED_ENV_PREFIXES = Object.freeze(['LC_']);

/**
 * 按白名单从父环境挑出要传给被测会话的变量，再叠加调用方显式给的覆盖项。
 * 覆盖项（HOME / CLAUDE_CONFIG_DIR / XDG_CONFIG_HOME / PROTOCOL_ROUTING_*）优先级最高。
 *
 * @param {NodeJS.ProcessEnv} parentEnv
 * @param {Record<string, string>} overrides
 * @returns {Record<string, string>}
 */
export function buildSessionEnv(parentEnv, overrides = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (INHERITED_ENV_KEYS.includes(key) || INHERITED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  return { ...env, ...overrides };
}
