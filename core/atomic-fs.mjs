// 文件写入原语。五处 writeNewJson 此前各带一份，两种写法只有选项顺序差异，语义相同。
import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';

// wx：目标已存在即失败，保证「只写新文件」不会覆盖既有状态。
/** @param {string} path @param {unknown} value */
export function writeNewJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

/** @param {string} path @param {unknown} value */
export function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

/** @param {string} path @param {string} value */
export function atomicWriteText(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}
