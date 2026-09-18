// @ts-check
// 从宿主工具事件里把 `agentkit` 调用还原成 argv。
//
// 判据只认 argv 形态，不做语义理解：命令文本先按 shell 词法切成 token，再按分隔符拆成若干段，
// 每段剥掉环境变量前缀和启动器（node / npx / bunx …），剩下的就是 `agentkit` 之后的参数。
// 这样 `cd x && FOO=1 node ./bin/agentkit.mjs worktree spawn` 与 `agentkit worktree spawn` 同解。

/** 命令分隔符：跨段的调用各自独立判定。 */
const SEPARATORS = new Set(['&&', '||', ';', '|', '|&', '&', '\n']);
/** 重定向算子：出现即认为该段的参数列表结束。 */
const REDIRECTIONS = /^(?:\d*(?:>>|>|<)&?\d*|<<<?|&>>?)$/u;
/** 透明包装器：剥掉之后继续按同一规则找启动器。 */
const WRAPPERS = new Set(['command', 'exec', 'builtin', 'nohup', 'time', 'stdbuf', 'nice']);
const NODE_BINARIES = new Set(['node', 'nodejs', 'node22', 'node24']);
const NPX_LIKE = new Set(['npx', 'bunx', 'pnpx']);
/** npx 自身的选项：带值的要多吃一个 token。 */
const NPX_FLAGS_WITH_VALUE = new Set(['-p', '--package', '-c', '--call', '--shell', '--node-arg', '--node-options']);
const AGENTKIT_PACKAGES = new Set(['agentkit', '@cr1992/agentkit']);

/**
 * 最小 shell 词法分析：处理单引号、双引号与反斜杠转义，保留分隔符为独立 token。
 * 不展开 `$(...)`、反引号与变量——这是已知盲区，见 README。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const tokens = [];
  let current = '';
  let started = false;
  const push = () => { if (started) { tokens.push(current); current = ''; started = false; } };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) { current += text[i + 1]; started = true; i += 1; continue; }
    if (ch === '\'' || ch === '"') {
      const quote = ch;
      started = true;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (quote === '"' && text[i] === '\\' && i + 1 < text.length) { current += text[i + 1]; i += 2; continue; }
        current += text[i];
        i += 1;
      }
      continue;
    }
    if (ch === '\n') { push(); tokens.push('\n'); continue; }
    if (/\s/u.test(ch)) { push(); continue; }
    if (ch === '&' || ch === '|' || ch === ';') {
      push();
      let op = ch;
      if (text[i + 1] === ch && ch !== ';') { op += ch; i += 1; }
      else if (ch === '|' && text[i + 1] === '&') { op += '&'; i += 1; }
      tokens.push(op);
      continue;
    }
    current += ch;
    started = true;
  }
  push();
  return tokens;
}

/** @param {string} token */
const basename = (token) => token.split('/').pop() ?? token;

/** 环境变量前缀，例如 `FOO=1`。 */
const isAssignment = (/** @type {string} */ token) => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token);

/**
 * 从单个命令段里取出 `agentkit` 之后的 argv；不是 agentkit 调用则返回 null。
 * @param {string[]} segment
 * @returns {string[] | null}
 */
function agentkitArgvFromSegment(segment) {
  let index = 0;
  // `env FOO=1 …` 与裸的 `FOO=1 …` 都先剥掉。
  while (index < segment.length && (isAssignment(segment[index]) || segment[index] === 'env' || WRAPPERS.has(segment[index]))) index += 1;
  if (index >= segment.length) return null;
  const head = basename(segment[index]);

  if (head === 'agentkit' || head === 'agentkit.mjs') return segment.slice(index + 1);

  if (NODE_BINARIES.has(head)) {
    for (let i = index + 1; i < segment.length; i += 1) {
      const name = basename(segment[i]);
      if (name === 'agentkit.mjs' || name === 'agentkit' || name === 'cli.mjs') return segment.slice(i + 1);
      if (segment[i].startsWith('-')) continue;  // node 自身的选项
      return null;                                // 第一个非选项不是 agentkit 入口
    }
    return null;
  }

  if (NPX_LIKE.has(head)) {
    let i = index + 1;
    while (i < segment.length && segment[i].startsWith('-')) {
      if (NPX_FLAGS_WITH_VALUE.has(segment[i])) i += 1;
      i += 1;
    }
    if (i >= segment.length) return null;
    if (!AGENTKIT_PACKAGES.has(segment[i]) && basename(segment[i]) !== 'agentkit') return null;
    // `npx --package @cr1992/agentkit agentkit worktree spawn`：包名之后还可能跟命令名。
    let next = i + 1;
    if (segment[i] !== 'agentkit' && segment[next] === 'agentkit') next += 1;
    return segment.slice(next);
  }

  return null;
}

/**
 * 从一段命令文本里取出全部 `agentkit` 调用的 argv，按出现顺序。
 * @param {string} command
 * @returns {string[][]}
 */
export function extractAgentkitArgv(command) {
  if (typeof command !== 'string' || !command) return [];
  const tokens = tokenize(command);
  /** @type {string[][]} */
  const segments = [[]];
  for (const token of tokens) {
    if (SEPARATORS.has(token)) { segments.push([]); continue; }
    if (REDIRECTIONS.test(token)) { segments.push([]); continue; }
    segments[segments.length - 1].push(token);
  }
  /** @type {string[][]} */
  const found = [];
  for (const segment of segments) {
    const argv = agentkitArgvFromSegment(segment);
    if (argv) found.push(argv);
  }
  return found;
}
