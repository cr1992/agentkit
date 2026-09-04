// @ts-check
// 安装身份真源：把 PATH 上的 CLI、四个 Skill shell 与随包 domain 绑定在一起。
// 域级 content_digest 负责状态漂移；本模块负责安装不完整或 CLI/shell 版本错配。
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { distributionDigest } from './content-digest.mjs';

const DEFAULT_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST_NAME = 'shell-manifest.json';
const SKILLS = ['orchestrate-subagents', 'manage-worktrees', 'verify-agent-output', 'run-agent-verify-loop'];
const HELP_COMMANDS = new Set([undefined, '--help', '-h', 'help', 'capabilities']);

export class RuntimeBundleError extends Error {}

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new RuntimeBundleError(`${label} 无法解析：${error instanceof Error ? error.message : String(error)}`); }
}

function safeExistingPath(packageRoot, value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value)) throw new RuntimeBundleError(`${label} 必须是包内相对路径`);
  const absolute = resolve(packageRoot, value);
  const lexical = relative(packageRoot, absolute);
  if (!lexical || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new RuntimeBundleError(`${label} 越出包根`);
  if (!existsSync(absolute)) throw new RuntimeBundleError(`${label} 不存在：${value}`);
  const realRoot = realpathSync(packageRoot);
  const real = realpathSync(absolute);
  const resolved = relative(realRoot, real);
  if (resolved === '..' || resolved.startsWith(`..${sep}`) || isAbsolute(resolved)) throw new RuntimeBundleError(`${label} 通过符号链接越出包根`);
  return absolute;
}

export function readShellManifest(packageRoot = DEFAULT_PACKAGE_ROOT) {
  return readJson(resolve(packageRoot, MANIFEST_NAME), MANIFEST_NAME);
}

export function validateShellManifest(packageRoot = DEFAULT_PACKAGE_ROOT) {
  const manifest = readShellManifest(packageRoot);
  const pkg = readJson(resolve(packageRoot, 'package.json'), 'package.json');
  if (manifest.schema_version !== 1) throw new RuntimeBundleError('shell manifest schema_version 必须为 1');
  if (manifest.package_name !== pkg.name || manifest.package_version !== pkg.version) {
    throw new RuntimeBundleError(`CLI/shell 版本不匹配：package ${pkg.name}@${pkg.version}，manifest ${manifest.package_name}@${manifest.package_version}`);
  }
  if (manifest.cli?.command !== 'agentkit') throw new RuntimeBundleError('shell manifest CLI 命令必须为 agentkit');
  safeExistingPath(packageRoot, manifest.cli?.entry, 'shell manifest cli.entry');

  const names = Object.keys(manifest.skills ?? {}).sort();
  if (JSON.stringify(names) !== JSON.stringify([...SKILLS].sort())) throw new RuntimeBundleError('shell manifest 必须且只能声明四件套 Skill');
  for (const skill of SKILLS) {
    const descriptor = manifest.skills[skill];
    if (!descriptor || typeof descriptor.domain !== 'string' || !descriptor.domain) throw new RuntimeBundleError(`${skill} 缺少 domain`);
    safeExistingPath(packageRoot, descriptor.shell, `${skill}.shell`);
    const scriptsDir = resolve(packageRoot, skill, 'scripts');
    safeExistingPath(packageRoot, `${skill}/scripts`, `${skill}.scripts`);
    const actualEntries = readdirSync(scriptsDir).filter((name) => name.endsWith('.mjs')).sort();
    const declaredEntries = Object.keys(descriptor.entries ?? {}).sort();
    if (JSON.stringify(actualEntries) !== JSON.stringify(declaredEntries)) throw new RuntimeBundleError(`${skill} 的兼容入口与 shell manifest 不一致`);
    for (const entryName of declaredEntries) {
      const entry = descriptor.entries[entryName];
      safeExistingPath(packageRoot, entry?.target, `${skill}.${entryName}.target`);
      if (entry.mutates_state !== false && (!Array.isArray(entry.read_only_commands) || entry.read_only_commands.some((item) => typeof item !== 'string' || !item))) {
        throw new RuntimeBundleError(`${skill}.${entryName} 必须声明 read_only_commands 或 mutates_state:false`);
      }
    }
  }
  return { package_name: pkg.name, package_version: pkg.version, manifest };
}

function entryDescriptor(packageRoot, skill, entryName) {
  const manifest = readShellManifest(packageRoot);
  const entry = manifest.skills?.[skill]?.entries?.[entryName];
  if (!entry) throw new RuntimeBundleError(`shell manifest 未声明 ${skill}/scripts/${entryName}`);
  return entry;
}

export function commandMutatesState({ packageRoot = DEFAULT_PACKAGE_ROOT, skill, entryName, command }) {
  if (HELP_COMMANDS.has(command)) return false;
  const entry = entryDescriptor(packageRoot, skill, entryName);
  if (entry.mutates_state === false) return false;
  return !Array.isArray(entry.read_only_commands) || !entry.read_only_commands.includes(command);
}

export function assertPublicCommandCompatibility({ packageRoot = DEFAULT_PACKAGE_ROOT, skill, entryName, command }) {
  if (!commandMutatesState({ packageRoot, skill, entryName, command })) return;
  validateShellManifest(packageRoot);
}

export function runtimeBundleDigest(packageRoot = DEFAULT_PACKAGE_ROOT) {
  const roots = [
    { prefix: 'package', path: packageRoot, entries: ['package.json', 'LICENSE', MANIFEST_NAME] },
    { prefix: 'bin', path: resolve(packageRoot, 'bin') },
    { prefix: 'core', path: resolve(packageRoot, 'core') },
    { prefix: 'schemas', path: resolve(packageRoot, 'schemas') },
    { prefix: 'domains', path: resolve(packageRoot, 'domains') },
  ];
  for (const domain of ['orchestrate', 'worktree', 'verify', 'loop']) roots.push({ prefix: `docs/${domain}`, path: resolve(packageRoot, 'docs', domain) });
  for (const skill of SKILLS) roots.push({ prefix: `skills/${skill}`, path: resolve(packageRoot, skill), entries: ['SKILL.md', 'agents', 'scripts'] });
  return distributionDigest(roots);
}
