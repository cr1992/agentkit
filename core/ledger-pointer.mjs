// @ts-check
// 仓级 ledger 指针：只回答「这个仓上的 ledger 放在哪」。
//
// state root 按设计落在业务仓库之外，因此一个新会话在主 checkout 里看不到任何线索，
// 只能靠人手传 `--ledger`。指针把「ledger_id → state_root」这一条映射写到
// `<git-common-dir>/agentkit/ledgers/<ledger_id>.json`，让 `agentkit status` 能把它找回来。
//
// **指针不是真源。** 它只存定位信息与两个用于展示/交叉核对的字段；ledger 的一切状态仍以
// state root 里的事件链为准。指针全部删掉不丢任何状态，代价只是重新手传 `--ledger`。
// 因此这里不提供任何「按指针内容下判断」的入口：调用方拿到 state_root 之后必须回读 state root。
//
// 目录单独设立（`agentkit/ledgers/`），不与 worktree 域的 `worktree-trace/v1/` 共享归属：
// 两者记录的是两类不同对象，合并目录会让它们变成同一个注册表。
//
// 本模块放在 core/ 而不是 orchestrate 域内，是因为 worktree 域要复用 ledger id 的格式规则、
// bin/ 的顶层 status 要读指针目录，而域与域之间禁止互相 import。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { atomicWriteJson } from './atomic-fs.mjs';

export const LEDGER_POINTER_SCHEMA_VERSION = 1;
// ledger id 的格式真源。orchestrate 域的 `--ledger-id` 与 worktree 域的 `spawn --ledger` 共用这一条，
// 两边不可能各自漂移；worktree 域只做格式校验，不 import orchestrate。
export const LEDGER_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
export const LEDGER_POINTER_FIELDS = ['schema_version', 'ledger_id', 'state_root', 'contract_digest', 'created_at'];
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
// 指针目录相对 git common dir 的位置。红线：只放在 .git/ 下，永远不进版本控制。
const POINTER_SEGMENTS = ['agentkit', 'ledgers'];

export class LedgerPointerError extends Error {}

/** @param {unknown} value */
export function isLedgerId(value) {
  return typeof value === 'string' && value.length > 0 && LEDGER_ID_PATTERN.test(value);
}

/** @param {unknown} value @param {string} label */
export function assertLedgerId(value, label = 'ledger id') {
  if (!isLedgerId(value)) {
    throw new LedgerPointerError(
      `${label} 无效：当前值 ${JSON.stringify(value ?? null)}；要求非空字符串且只含字母、数字、点、下划线与连字符（${LEDGER_ID_PATTERN.source}）`,
    );
  }
  return String(value);
}

/**
 * 解析一个路径所属仓库的 git common dir。linked worktree 下它指向主仓 `.git`，
 * 指针因此永远只有一份，不随 worktree 分裂。
 * @param {string} [from]
 * @returns {{ common_dir: string|null, reason: string|null }}
 */
export function resolveGitCommonDir(from) {
  const start = resolve(from ?? process.cwd());
  if (!existsSync(start)) return { common_dir: null, reason: `路径不存在：${start}` };
  try {
    if (!statSync(start).isDirectory()) return { common_dir: null, reason: `路径不是目录：${start}` };
  } catch (error) {
    return {
      common_dir: null,
      reason: `无法读取路径 ${start}：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: start, encoding: 'utf8' });
  if (result.error) return { common_dir: null, reason: `在 ${start} 执行 git 失败：${result.error.message}` };
  if (result.status !== 0) {
    return {
      common_dir: null,
      reason: `${start} 不在 git 仓库内：git rev-parse --git-common-dir 退出码 ${result.status}`,
    };
  }
  const output = String(result.stdout ?? '').trim();
  if (!output) return { common_dir: null, reason: `git rev-parse --git-common-dir 在 ${start} 返回空值` };
  return { common_dir: resolve(start, output), reason: null };
}

/** @param {string} commonDir */
export function pointerDirectory(commonDir) {
  return join(commonDir, ...POINTER_SEGMENTS);
}

/** @param {string} commonDir @param {string} ledgerId */
export function pointerPath(commonDir, ledgerId) {
  return join(pointerDirectory(commonDir), `${assertLedgerId(ledgerId)}.json`);
}

/**
 * 指针只存 state root；ledger 目录由 state root 与 ledger id 推导，与 `ledger init` 的回显一致。
 * @param {{ state_root: string, ledger_id: string }} pointer
 */
export function ledgerDirectory(pointer) {
  return join(pointer.state_root, 'ledgers', pointer.ledger_id);
}

/** @param {unknown} value @param {string} label */
export function validateLedgerPointer(value, label = 'ledger pointer') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LedgerPointerError(`${label} 必须是 JSON 对象，当前是 ${Array.isArray(value) ? 'array' : typeof value}`);
  }
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !LEDGER_POINTER_FIELDS.includes(key));
  if (unknown.length) {
    throw new LedgerPointerError(
      `${label} 含未知字段：${unknown.join('、')}；字段集合固定为 ${LEDGER_POINTER_FIELDS.join('、')}`,
    );
  }
  const missing = LEDGER_POINTER_FIELDS.filter((key) => !keys.includes(key));
  if (missing.length) throw new LedgerPointerError(`${label} 缺少字段：${missing.join('、')}`);
  const pointer = /** @type {Record<string, unknown>} */ (value);
  if (pointer.schema_version !== LEDGER_POINTER_SCHEMA_VERSION) {
    throw new LedgerPointerError(
      `${label}.schema_version 当前值 ${JSON.stringify(pointer.schema_version)}，要求 ${LEDGER_POINTER_SCHEMA_VERSION}`,
    );
  }
  assertLedgerId(pointer.ledger_id, `${label}.ledger_id`);
  if (typeof pointer.state_root !== 'string' || !pointer.state_root || !isAbsolute(pointer.state_root)) {
    throw new LedgerPointerError(
      `${label}.state_root 当前值 ${JSON.stringify(pointer.state_root ?? null)}；要求非空绝对路径`,
    );
  }
  if (typeof pointer.contract_digest !== 'string' || !DIGEST_PATTERN.test(pointer.contract_digest)) {
    throw new LedgerPointerError(
      `${label}.contract_digest 当前值 ${JSON.stringify(pointer.contract_digest ?? null)}；要求形如 sha256:<64 位十六进制>`,
    );
  }
  if (typeof pointer.created_at !== 'string' || Number.isNaN(Date.parse(pointer.created_at))) {
    throw new LedgerPointerError(
      `${label}.created_at 当前值 ${JSON.stringify(pointer.created_at ?? null)}；要求可解析的 ISO 8601 时间戳`,
    );
  }
  return /** @type {{ schema_version: number, ledger_id: string, state_root: string, contract_digest: string, created_at: string }} */ (
    value
  );
}

/**
 * @param {{ commonDir: string, ledgerId: string, stateRoot: string, contractDigest: string, createdAt?: string }} options
 */
export function writeLedgerPointer({ commonDir, ledgerId, stateRoot, contractDigest, createdAt }) {
  const pointer = validateLedgerPointer({
    schema_version: LEDGER_POINTER_SCHEMA_VERSION,
    ledger_id: assertLedgerId(ledgerId),
    state_root: resolve(stateRoot),
    contract_digest: contractDigest,
    created_at: createdAt ?? new Date().toISOString(),
  });
  const directory = pointerDirectory(commonDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${pointer.ledger_id}.json`);
  // 指针按 ledger_id 索引，同一个仓上同名 ledger 只能有一份指针。覆盖是允许的（换 state root
  // 重建同名 ledger 是正常操作），但被顶掉的那一份要交回给调用方说明，否则旧 ledger 会静默失联。
  let replaced = null;
  try {
    const previous = validateLedgerPointer(JSON.parse(readFileSync(path, 'utf8')), `既有指针 ${path}`);
    if (previous.state_root !== pointer.state_root) replaced = previous.state_root;
  } catch {
    /* 不存在或已损坏：直接覆盖，损坏的那份本来就会被 doctor 标为 malformed。 */
  }
  atomicWriteJson(path, pointer);
  return { path, pointer, replaced };
}

/** @param {string} path */
export function deleteLedgerPointerFile(path) {
  try {
    unlinkSync(path);
    return { removed: true, path, reason: null };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { removed: false, path, reason: `指针文件不存在：${path}` };
    }
    throw error;
  }
}

/**
 * 读取一个仓库下的全部指针。损坏的文件不抛异常，作为条目返回给 doctor 报告。
 * @param {string} commonDir
 */
export function listLedgerPointers(commonDir) {
  const directory = pointerDirectory(commonDir);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const path = join(directory, name);
      const ledgerId = basename(name, '.json');
      try {
        return {
          path,
          ledger_id: ledgerId,
          pointer: validateLedgerPointer(JSON.parse(readFileSync(path, 'utf8')), `指针 ${path}`),
          error: null,
        };
      } catch (error) {
        return {
          path,
          ledger_id: ledgerId,
          pointer: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
}

/**
 * `contract.environment.repository` 不是 git 仓时不写指针，并把原因原样交回给调用方回显。
 * 指针不是真源，写失败不能让 ledger 建立失败，因此这里只在解析阶段返回原因，
 * 真正的写入异常由调用方按 warning 处理。
 * @param {{ repository: unknown, ledgerId: string, stateRoot: string, contractDigest: string, createdAt?: string }} options
 */
export function recordLedgerPointer({ repository, ledgerId, stateRoot, contractDigest, createdAt }) {
  const skip = (reason) => ({ written: false, path: null, git_common_dir: null, reason });
  if (typeof repository !== 'string' || !repository || repository === 'none') {
    return skip(
      `contract.environment.repository 当前值 ${JSON.stringify(repository ?? null)}：没有指向 git 仓库，跳过仓级指针；后续命令需要手传 --ledger <ledger 目录>`,
    );
  }
  const found = resolveGitCommonDir(repository);
  if (!found.common_dir) {
    return skip(`${found.reason}；跳过仓级指针，后续命令需要手传 --ledger <ledger 目录>`);
  }
  const { path, replaced } = writeLedgerPointer({
    commonDir: found.common_dir,
    ledgerId,
    stateRoot,
    contractDigest,
    createdAt,
  });
  return { written: true, path, git_common_dir: found.common_dir, replaced, reason: null };
}

/**
 * @param {{ repository: unknown, ledgerId: string }} options
 */
export function removeLedgerPointer({ repository, ledgerId }) {
  const skip = (reason) => ({ removed: false, path: null, git_common_dir: null, reason });
  if (typeof repository !== 'string' || !repository || repository === 'none') {
    return skip(
      `contract.environment.repository 当前值 ${JSON.stringify(repository ?? null)}：init 时就没有写仓级指针，无需删除`,
    );
  }
  const found = resolveGitCommonDir(repository);
  if (!found.common_dir) return skip(`${found.reason}；无法定位仓级指针目录，跳过删除`);
  const path = pointerPath(found.common_dir, ledgerId);
  const result = deleteLedgerPointerFile(path);
  return { ...result, git_common_dir: found.common_dir };
}
