// @ts-check

// 跨域共享的进程级文件锁原语。loop / verify / orchestrate ledger 原本各复制一份算法相同、仅错误类型、
// 报错文案与 JSON 解析函数不同的实现，这里抽成一份注入式工厂。算法逐步等价于原三份：
//   - candidate 文件先 openSync('wx')+fsync，再 linkSync 到目标路径做原子占用；
//   - 目标已存在时读取当前 owner：owner 无效或存活 → fail closed；owner 已死 → 走 .reclaim 两阶段接管；
//   - owner 记录 hostname：跨主机共享 state root 时，owner.hostname 与本机不同则一律 fail closed，不按
//     pid 判活、不做基于时长的自动接管（无法验证异机进程存活）；缺 hostname 的旧锁按本机 pid 判定，保持兼容；
//   - .reclaim 自身也用 candidate+link 抢占，接管完成在 finally 里释放；
//   - 最多重试 4 次，token 校验保证只有写入者本人能释放锁。
//
// 注入点：
//   - ErrorClass：各域自己的校验错误类型（ValidationError / LoopValidationError / LedgerError）；
//   - label：锁的中文名，用于统一后的报错文案（如 'run lock' / 'state-root lock' / 'ledger lock'）；
//   - readJson(path)：各域原来用的「读文件并严格解析 JSON」函数，保持对损坏 / 重复 key 锁文件的处理不变，
//     且必须让 readFileSync 的 ENOENT 以 error.code === 'ENOENT' 形式透传。

import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';

/** @param {number} pid */
export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM');
  }
}

/**
 * @param {{ErrorClass: new (message: string) => Error, label: string, readJson: (path: string) => any}} config
 */
export function createLockKit({ ErrorClass, label, readJson }) {
  const reclaimCorrupt = `${label} reclaim 内容损坏；拒绝自动接管`;
  const reclaimOwnerInvalid = `${label} reclaim owner 无效；拒绝自动接管`;
  const staleRecovery = `${label} 正在执行 stale recovery`;
  const lockCorrupt = `${label} 内容损坏；拒绝自动接管`;
  const lockOwnerInvalid = `${label} owner 无效；拒绝自动接管`;
  const corruptDuringHold = `${label} 在持有期间损坏；拒绝删除未知 owner 的 lock`;
  const cannotAcquire = `无法获取 ${label}`;
  /** @param {unknown} pid */
  const heldBy = (pid) => `${label} 正被 PID ${pid} 持有`;
  /** @param {unknown} host @param {unknown} pid @param {string} lockPath */
  const heldByOtherHost = (host, pid, lockPath) =>
    `${label} 由其他主机 ${host} 上的 PID ${pid} 持有；state root 跨主机共享时无法验证该进程存活，拒绝自动接管。` +
    `请人工确认该进程确已退出后，手动删除锁文件 ${lockPath} 再重试`;

  /** @param {unknown} error */
  const isEnoent = (error) =>
    Boolean(error && typeof error === 'object' && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT');
  /** @param {unknown} error */
  const isEexist = (error) =>
    Boolean(error && typeof error === 'object' && /** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST');

  /** @param {string} path */
  function recoverOrphanReclaim(path) {
    const reclaimPath = `${path}.reclaim`;
    if (!existsSync(reclaimPath)) return;
    let owner;
    try {
      owner = readJson(reclaimPath);
    } catch {
      throw new ErrorClass(reclaimCorrupt);
    }
    if (!Number.isInteger(Number(owner.pid)) || Number(owner.pid) <= 0 || typeof owner.token !== 'string' || !owner.token)
      throw new ErrorClass(reclaimOwnerInvalid);
    if (typeof owner.hostname === 'string' && owner.hostname && owner.hostname !== hostname())
      throw new ErrorClass(heldByOtherHost(owner.hostname, owner.pid, reclaimPath));
    if (processIsAlive(Number(owner.pid))) throw new ErrorClass(staleRecovery);
    let latest;
    try {
      latest = readJson(reclaimPath);
    } catch (error) {
      if (isEnoent(error)) return;
      throw new ErrorClass(reclaimCorrupt);
    }
    if (Number(latest.pid) !== Number(owner.pid) || latest.token !== owner.token) return;
    try {
      unlinkSync(reclaimPath);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }

  /** @param {string} path */
  function writeOwnerCandidate(path, value) {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** @param {string} path */
  function acquireLock(path) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      recoverOrphanReclaim(path);
      const owner = { pid: process.pid, hostname: hostname(), token: randomUUID(), acquired_at: new Date().toISOString() };
      const candidate = `${path}.${owner.pid}.${owner.token}.candidate`;
      writeOwnerCandidate(candidate, owner);
      try {
        if (existsSync(`${path}.reclaim`)) throw new ErrorClass(staleRecovery);
        linkSync(candidate, path);
        unlinkSync(candidate);
        return owner;
      } catch (error) {
        try {
          unlinkSync(candidate);
        } catch {
          // candidate 可能已被 linkSync 消费或从未落地，清理失败无碍。
        }
        if (error instanceof ErrorClass) throw error;
        if (!isEexist(error)) throw error;
        let current;
        try {
          current = readJson(path);
        } catch {
          throw new ErrorClass(lockCorrupt);
        }
        if (!Number.isInteger(Number(current.pid)) || Number(current.pid) <= 0)
          throw new ErrorClass(lockOwnerInvalid);
        if (typeof current.hostname === 'string' && current.hostname && current.hostname !== hostname())
          throw new ErrorClass(heldByOtherHost(current.hostname, current.pid, path));
        if (processIsAlive(Number(current.pid))) throw new ErrorClass(heldBy(current.pid));
        const reclaimPath = `${path}.reclaim`;
        const reclaimOwner = { pid: process.pid, hostname: hostname(), token: randomUUID(), acquired_at: new Date().toISOString() };
        const reclaimCandidate = `${reclaimPath}.${reclaimOwner.pid}.${reclaimOwner.token}.candidate`;
        writeOwnerCandidate(reclaimCandidate, reclaimOwner);
        try {
          linkSync(reclaimCandidate, reclaimPath);
        } catch (reclaimError) {
          if (!isEexist(reclaimError)) throw reclaimError;
          throw new ErrorClass(staleRecovery);
        } finally {
          try {
            unlinkSync(reclaimCandidate);
          } catch {
            // reclaim candidate 清理失败同样无碍。
          }
        }
        try {
          let latest;
          try {
            latest = readJson(path);
          } catch (latestError) {
            if (isEnoent(latestError)) continue;
            throw new ErrorClass(lockCorrupt);
          }
          if (Number(latest.pid) !== Number(current.pid) || latest.token !== current.token) continue;
          if (processIsAlive(Number(latest.pid))) throw new ErrorClass(heldBy(latest.pid));
          unlinkSync(path);
        } finally {
          releaseLock(reclaimPath, reclaimOwner);
        }
      }
    }
    throw new ErrorClass(cannotAcquire);
  }

  /** @param {string} path @param {{pid:number, token:string}} owner */
  function releaseLock(path, owner) {
    let current;
    try {
      current = readJson(path);
    } catch (error) {
      if (isEnoent(error)) return false;
      throw new ErrorClass(corruptDuringHold);
    }
    if (current.pid !== owner.pid || current.token !== owner.token) return false;
    unlinkSync(path);
    return true;
  }

  /** @param {string} path @param {() => any} callback */
  function withLock(path, callback) {
    const owner = acquireLock(path);
    try {
      return callback();
    } finally {
      releaseLock(path, owner);
    }
  }

  return { acquireLock, releaseLock, withLock };
}
