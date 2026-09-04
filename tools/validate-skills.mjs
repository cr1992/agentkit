#!/usr/bin/env node
// Skill 规范校验：frontmatter、命名唯一性、README 收录、相对链接有效性、敏感信息。
// 本地与 CI 共用：node tools/validate-skills.mjs；发现 error 退出码 1，warning 不阻断。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP_DIRS = new Set(['.git', 'node_modules', 'tests', 'docs', 'tools', '.worktrees']);
const MAX_DESCRIPTION = 1024;
const WARN_SKILL_LINES = 500;

const errors = [];
const warnings = [];

function findSkillDirs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) continue;
    if (existsSync(join(full, 'SKILL.md'))) out.push(full);
    else out.push(...findSkillDirs(full));
  }
  return out;
}

function parseFrontmatter(text, rel) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) { errors.push(`${rel}: 缺少 frontmatter（--- 包围块）`); return {}; }
  const fields = {};
  let current = null;
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) { current = kv[1]; fields[current] = kv[2]; }
    else if (current && /^\s+\S/.test(line)) fields[current] += ' ' + line.trim();
  }
  for (const key of ['name', 'description']) {
    if (fields[key]) fields[key] = fields[key].trim().replace(/^["']|["']$/g, '');
  }
  return fields;
}

function walkFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

const SENSITIVE = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥块'],
  [/glpat-[0-9A-Za-z_-]{10,}/, 'GitLab PAT'],
  [/xox[baprs]-[0-9A-Za-z-]{10,}/, 'Slack token'],
  [/AKIA[0-9A-Z]{16}/, 'AWS AccessKey'],
  [/\bou_[0-9a-f]{16,}\b/i, '飞书 open_id'],
];
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const IP_ALLOW = new Set(['0.0.0.0', '127.0.0.1', '255.255.255.255']);

const skillDirs = findSkillDirs(ROOT);
const seen = new Map();
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

for (const dir of skillDirs) {
  const rel = dir.slice(ROOT.length + 1);
  const skillMd = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const base = dir.split('/').pop();
  const { name, description } = parseFrontmatter(skillMd, `${rel}/SKILL.md`);

  if (name !== base) errors.push(`${rel}: frontmatter name「${name}」与目录名「${base}」不一致`);
  if (name && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) errors.push(`${rel}: name 必须是 kebab-case`);
  if (!description) errors.push(`${rel}: 缺少 description（宿主路由唯一依据）`);
  else {
    if (description.length > MAX_DESCRIPTION) errors.push(`${rel}: description 超长（${description.length} > ${MAX_DESCRIPTION}）`);
    if (!/当|时使用|时触发|Use when|use when/.test(description)) errors.push(`${rel}: description 缺少触发条件句（如「当用户说…时使用」或 Use when …）`);
  }
  if (seen.has(name)) errors.push(`${rel}: name「${name}」与 ${seen.get(name)} 重复（安装按名字平铺，必须全仓唯一）`);
  seen.set(name, rel);

  if (name && !readme.includes(name)) errors.push(`${rel}: README.md 未收录该 skill`);

  const lineCount = skillMd.split('\n').length;
  if (lineCount > WARN_SKILL_LINES) warnings.push(`${rel}: SKILL.md ${lineCount} 行，建议将细节拆进 references/`);

  for (const file of walkFiles(dir)) {
    const frel = file.slice(ROOT.length + 1);
    if (basename(file) === 'config.json' && !frel.includes('/examples/')) {
      let tracked = true;
      try { execFileSync('git', ['ls-files', '--error-unmatch', frel], { cwd: ROOT, stdio: 'ignore' }); }
      catch { tracked = false; }
      if (tracked) errors.push(`${frel}: 个人配置文件不应入库（个性化取值放 ~/.config/<skill-name>/）`);
      else warnings.push(`${frel}: 本地个人配置建议移到 ~/.config/<skill-name>/，避免被安装更新覆盖`);
      continue;
    }
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    if (/[\x00]/.test(text.slice(0, 512))) continue;

    for (const [re, label] of SENSITIVE) {
      if (re.test(text)) errors.push(`${frel}: 疑似${label}，禁止提交敏感信息`);
    }
    const ip = text.match(IP_RE);
    if (ip && !IP_ALLOW.has(ip[0])) warnings.push(`${frel}: 出现 IP「${ip[0]}」，确认是否应改为配置项`);

    if (file.endsWith('.md')) {
      for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
        const target = m[1].split('#')[0].trim();
        if (!target || /^(https?:|mailto:|@)/.test(target)) continue;
        if (!existsSync(resolve(dirname(file), target))) {
          errors.push(`${frel}: 相对链接失效 → ${target}`);
        }
      }
    }
  }
}

console.log(`扫描 ${skillDirs.length} 个 skill`);
for (const w of warnings) console.log(`WARN  ${w}`);
for (const e of errors) console.log(`ERROR ${e}`);
if (errors.length) { console.log(`\n${errors.length} 个 error，${warnings.length} 个 warning`); process.exit(1); }
console.log(`全部通过（${warnings.length} 个 warning）`);
