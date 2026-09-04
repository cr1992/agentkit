// @ts-check
// 域级内容摘要：覆盖一个 Skill 实际执行所依赖的完整分发内容。
//
// 收敛前四个 Skill 各带一份实现，都只遍历自己的目录。schema 收敛与 core 抽取之后，
// 执行还依赖包根的 core/ 与 schemas/，只算 Skill 目录会漏掉真正会漂移的代码——
// 改这两处不会触发 skill_drift，冻结的任务却已经跑在不同的实现上。
//
// 因此摘要改为多根：每个根用固定的逻辑前缀（skill / domain / core / schemas）记录，
// 与安装绝对路径无关。CLI 路由（bin/）不在覆盖范围内：它决定命令怎么分发，
// 不参与任何 Skill 的执行语义，把它算进来会让改一行帮助文案就让四个域一起漂移。
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { createDigestKit, sha256 } from './digest.mjs';

// 摘要的序列化口径与各 Skill 的 canonicalJson 解耦：四处摘要必须算得出同一个结果，
// 不能因为某个 Skill 的严格度不同而分叉。
const { canonicalJson } = createDigestKit({ ValidationError: Error, strict: false });

const SKILL_ENTRIES = ['SKILL.md', 'agents', 'scripts'];

function collect(root, prefix, entries, output) {
  if (!existsSync(root)) return;
  const base = realpathSync(root);
  const visit = (absolute, relativePath) => {
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(join(absolute, name), `${relativePath}/${name}`);
      return;
    }
    if (stat.isFile() || stat.isSymbolicLink()) {
      const bytes = readFileSync(absolute);
      output.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) });
    }
  };
  if (!entries) { visit(base, prefix); return; }
  for (const name of entries) if (existsSync(join(base, name))) visit(join(base, name), `${prefix}/${name}`);
}

/** @param {{ prefix: string, path: string, entries?: string[] }[]} roots */
export function distributionManifest(roots) {
  const output = [];
  for (const { prefix, path, entries } of roots) collect(path, prefix, entries, output);
  // 码点序，不用 localeCompare：后者随运行环境的 collation 变化，摘要必须与环境无关。
  return output.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** @param {{ prefix: string, path: string, entries?: string[] }[]} roots */
export function distributionDigest(roots) {
  return sha256(Buffer.from(canonicalJson(distributionManifest(roots)), 'utf8'));
}

/**
 * 一个 Skill 的分发内容 = 自己的 Skill 目录 + 对应 domain 运行时 + 按需文档
 * + 共享 core + canonical schemas。
 * @param {{ packageRoot: string, skillRoot: string, domainRoot?: string, docsRoot?: string }} options
 */
export function skillDistributionRoots({ packageRoot, skillRoot, domainRoot, docsRoot }) {
  const roots = [{ prefix: 'skill', path: skillRoot, entries: SKILL_ENTRIES }];
  if (domainRoot) roots.push({ prefix: 'domain', path: domainRoot });
  if (docsRoot) roots.push({ prefix: 'docs', path: docsRoot });
  roots.push({ prefix: 'core', path: join(packageRoot, 'core') });
  roots.push({ prefix: 'schemas', path: join(packageRoot, 'schemas') });
  roots.push({ prefix: 'shell-manifest', path: join(packageRoot, 'shell-manifest.json') });
  return roots;
}
