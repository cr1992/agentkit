// @ts-check
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { distributionDigest, skillDistributionRoots } from '../../core/content-digest.mjs';

export const ORCHESTRATION_PROTOCOL_VERSION = '1.1.0';
export const ORCHESTRATION_RUNTIME_VERSION = '1.8.0';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'orchestrate-subagents');
// 摘要覆盖 Skill 目录 + 共享 core + canonical schemas：执行真正依赖的全部分发内容。
// PACKAGE_ROOT 是模块常量，传入自定义 root 只替换 Skill 目录那一段，便于测试摘要与安装路径无关。
const PACKAGE_ROOT = resolve(SKILL_ROOT, '..');
const DOMAIN_ROOT = dirname(fileURLToPath(import.meta.url));

// 台账与 contract-tool 都要冻结同一个域摘要，而台账已经 import contract-tool（反向会成环），
// 所以摘要住在这个无依赖的元数据模块里，两边各自 import。
export function skillContentDigest(root = SKILL_ROOT) {
  return distributionDigest(
    skillDistributionRoots({
      packageRoot: PACKAGE_ROOT,
      skillRoot: root,
      domainRoot: DOMAIN_ROOT,
      docsRoot: join(PACKAGE_ROOT, 'docs', 'orchestrate'),
    }),
  );
}
