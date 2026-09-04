#!/usr/bin/env node
// @ts-check

import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ContractError, canonicalJson, envelopeDigest, parseJsonStrict, sha256, validateContract } from './contract-tool.mjs';
import { ORCHESTRATION_PROTOCOL_VERSION, ORCHESTRATION_RUNTIME_VERSION } from './orchestration-metadata.mjs';
import { isHelpRequest, renderCliHelp, specOptionNames } from '../../core/cli-help.mjs';
import { writeNewJson } from '../../core/atomic-fs.mjs';
import { createReflectionKit } from '../../core/reflection.mjs';
import { distributionDigest, skillDistributionRoots } from '../../core/content-digest.mjs';

const { buildProposal, buildReflection } = createReflectionKit({ strict: true });

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'orchestrate-subagents');
// 摘要覆盖 Skill 目录 + 共享 core + canonical schemas：执行真正依赖的全部分发内容。
// PACKAGE_ROOT 是模块常量，传入自定义 root 只替换 Skill 目录那一段，便于测试摘要与安装路径无关。
const PACKAGE_ROOT = resolve(SKILL_ROOT, '..');
const DOMAIN_ROOT = dirname(fileURLToPath(import.meta.url));
export function skillContentDigest(root = SKILL_ROOT) {
  return distributionDigest(skillDistributionRoots({ packageRoot: PACKAGE_ROOT, skillRoot: root, domainRoot: DOMAIN_ROOT, docsRoot: join(PACKAGE_ROOT, 'docs', 'orchestrate') }));
}

const NODE_STATES = new Set(['pending', 'running', 'blocked', 'awaiting_verification', 'passed', 'failed', 'cancelled']);
const TERMINAL_NODE_STATES = new Set(['passed', 'failed', 'cancelled']);
// 只读评审节点没有实现交付物，只能收口在 not_applicable；worker/judge 必须选实现档位。
const READ_ONLY_REVIEW_ROLES = new Set(['critic', 'scout']);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const DISPATCH_KEYS = new Set(['schema_version', 'worker_id', 'orchestration_mode', 'attempt_id', 'attempt', 'previous_attempt_id', 'tier', 'model', 'reasoning_effort', 'adjustment_action', 'failure_kind', 'failure_ref', 'selection_reason', 'config_source', 'configuration_state', 'model_resolution_state', 'capability_source', 'capability_fingerprint', 'dispatch_provenance', 'token_budget', 'max_attempts']);
const CONFIGURATION_STATES = new Set(['user-explicit', 'session-inferred', 'session-confirmed', 'persisted-config', 'host-default']);
const MODEL_RESOLUTION_STATES = new Set(['discovered-and-validated', 'user-explicit-unverifiable', 'host-default-unexposed']);
const DISPATCH_PROVENANCE = new Set(['explicit', 'inherited-controller', 'host-default']);
const ADJUSTMENT_ACTIONS = new Set(['initial', 'retry_same', 'raise_effort', 'switch_model', 'promote_tier', 'fresh_context', 'change_strategy']);
const FAILURE_KINDS = new Set(['implementation_defect', 'reasoning_gap', 'context_gap', 'strategy_gap']);
export class LedgerError extends Error {}

function readJson(path) { return parseJsonStrict(readFileSync(path, 'utf8')); }
function atomicJson(path, value) { const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
function writeNew(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return Boolean(error?.code === 'EPERM'); } }
function recoverReclaim(path) { const reclaimPath = `${path}.reclaim`; if (!existsSync(reclaimPath)) return; let owner; try { owner = readJson(reclaimPath); } catch { throw new LedgerError('ledger reclaim lock malformed；拒绝自动接管'); } if (!Number.isInteger(Number(owner.pid)) || Number(owner.pid) <= 0 || typeof owner.token !== 'string' || !owner.token) throw new LedgerError('ledger reclaim owner 无效；拒绝自动接管'); if (alive(Number(owner.pid))) throw new LedgerError('ledger lock stale recovery in progress'); let latest; try { latest = readJson(reclaimPath); } catch (error) { if (error?.code === 'ENOENT') return; throw new LedgerError('ledger reclaim lock malformed；拒绝自动接管'); } if (Number(latest.pid) !== Number(owner.pid) || latest.token !== owner.token) return; try { unlinkSync(reclaimPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
function lock(path) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    recoverReclaim(path);
    const owner = { pid: process.pid, token: randomUUID(), acquired_at: new Date().toISOString() }; const candidate = `${path}.${owner.pid}.${owner.token}.candidate`; const fd = openSync(candidate, 'wx', 0o600); try { writeFileSync(fd, `${JSON.stringify(owner)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    try { if (existsSync(`${path}.reclaim`)) throw new LedgerError('ledger lock stale recovery in progress'); linkSync(candidate, path); unlinkSync(candidate); return owner; }
    catch (error) { try { unlinkSync(candidate); } catch {} if (error instanceof LedgerError) throw error; if (error?.code !== 'EEXIST') throw error; let current; try { current = readJson(path); } catch { throw new LedgerError('ledger lock malformed；拒绝自动接管'); } if (!Number.isInteger(Number(current.pid)) || Number(current.pid) <= 0) throw new LedgerError('ledger lock owner 无效；拒绝自动接管'); if (alive(Number(current.pid))) throw new LedgerError(`ledger lock held by ${current.pid}`); const reclaimPath = `${path}.reclaim`; const reclaimOwner = { pid: process.pid, token: randomUUID(), acquired_at: new Date().toISOString() }; const reclaimCandidate = `${reclaimPath}.${reclaimOwner.pid}.${reclaimOwner.token}.candidate`; const reclaimFd = openSync(reclaimCandidate, 'wx', 0o600); try { writeFileSync(reclaimFd, `${JSON.stringify(reclaimOwner)}\n`); fsyncSync(reclaimFd); } finally { closeSync(reclaimFd); } try { linkSync(reclaimCandidate, reclaimPath); } catch (reclaimError) { if (reclaimError?.code !== 'EEXIST') throw reclaimError; throw new LedgerError('ledger lock stale recovery in progress'); } finally { try { unlinkSync(reclaimCandidate); } catch {} } try { let latest; try { latest = readJson(path); } catch (latestError) { if (latestError?.code === 'ENOENT') continue; throw new LedgerError('ledger lock malformed；拒绝自动接管'); } if (Number(latest.pid) !== Number(current.pid) || latest.token !== current.token) continue; if (alive(Number(latest.pid))) throw new LedgerError(`ledger lock held by ${latest.pid}`); unlinkSync(path); } finally { release(reclaimPath, reclaimOwner); } }
  }
  throw new LedgerError('无法获取 ledger lock');
}
function release(path, owner) { let current; try { current = readJson(path); } catch (error) { if (error?.code === 'ENOENT') return false; throw new LedgerError('ledger lock 在持有期间损坏；拒绝删除未知 owner 的 lock'); } if (current.pid !== owner.pid || current.token !== owner.token) return false; unlinkSync(path); return true; }
function withLock(dir, callback) { const path = join(dir, '.lock'); const owner = lock(path); try { return callback(); } finally { release(path, owner); } }
function future(path) { let cursor = resolve(path); const suffix = []; while (!existsSync(cursor)) { const parent = dirname(cursor); if (parent === cursor) break; suffix.unshift(cursor.slice(parent.length + 1)); cursor = parent; } return resolve(realpathSync(cursor), ...suffix); }
function inside(candidate, parent) { const rel = relative(realpathSync(parent), future(candidate)); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); }

function readJournal(dir) {
  const text = readFileSync(join(dir, 'events.ndjson'), 'utf8'); const last = text.lastIndexOf('\n'); const complete = last < 0 ? '' : text.slice(0, last + 1); const trailing = last === text.length - 1 ? '' : text.slice(last + 1);
  const events = complete.split('\n').filter(Boolean).map(parseJsonStrict); if (!events.length) throw new LedgerError('ledger journal 为空'); let previous = null; for (let index = 0; index < events.length; index += 1) { const event = events[index]; if (event.revision !== index || event.previous_event_digest !== previous || !/^sha256:[0-9a-f]{64}$/u.test(event.event_digest ?? '') || envelopeDigest(event, 'event_digest') !== event.event_digest) throw new LedgerError(`event journal 链在 revision ${index} 无效`); previous = event.event_digest; } return { events, complete, trailing };
}
function load(dir) { const journal = readJournal(dir); const latest = journal.events.at(-1).snapshot; const path = join(dir, 'snapshot.json'); if (!existsSync(path)) return { snapshot: latest, repair: true, journal }; const file = readJson(path); const drift = canonicalJson(file) !== canonicalJson(latest); return { snapshot: drift ? latest : file, repair: drift || Boolean(journal.trailing), journal }; }
function persist(dir, snapshot, kind) { const next = { ...snapshot, revision: snapshot.revision + 1, updated_at: new Date().toISOString() }; const previous = readJournal(dir).events.at(-1)?.event_digest ?? null; const event = { schema_version: 1, revision: next.revision, kind, recorded_at: next.updated_at, previous_event_digest: previous, snapshot: next }; event.event_digest = envelopeDigest(event, 'event_digest'); const fd = openSync(join(dir, 'events.ndjson'), 'a', 0o600); try { appendFileSync(fd, `${canonicalJson(event)}\n`); fsyncSync(fd); } finally { closeSync(fd); } atomicJson(join(dir, 'snapshot.json'), next); return next; }
function mutate(dir, expected, callback) { return withLock(dir, () => { const loaded = load(dir); if (loaded.journal.trailing) writeFileSync(join(dir, 'events.ndjson'), loaded.journal.complete, { mode: 0o600 }); if (loaded.repair) atomicJson(join(dir, 'snapshot.json'), loaded.snapshot); if (expected !== null && loaded.snapshot.revision !== expected) throw new LedgerError(`revision conflict: expected ${expected}, actual ${loaded.snapshot.revision}`); if (loaded.snapshot.skill_provenance.content_digest !== skillContentDigest()) throw new LedgerError('skill_drift：必须 re-contract'); const result = callback(loaded.snapshot); return persist(dir, result.snapshot, result.kind); }); }

// CLI 命令与参数的唯一真源：parseCli 的合法性判断和 `--help` 清单都从这里推导。
const CLI_SPEC = {
  capabilities: { flags: ['json'] },
  init: { required: ['contract'], optional: ['state-root', 'ledger-id'], flags: ['allow-repository-state'] },
  'add-node': { required: ['ledger', 'input'], optional: ['expected-revision'] },
  'add-edge': { required: ['ledger', 'input'], optional: ['expected-revision'] },
  'dispatch-record': { required: ['ledger', 'node', 'input'], optional: ['expected-revision'] },
  update: { required: ['ledger', 'node', 'input'], optional: ['expected-revision'] },
  attach: { required: ['ledger', 'node', 'type', 'input'], optional: ['expected-revision'] },
  'batch-init': { required: ['ledger', 'input'], optional: ['expected-revision'] },
  'batch-record': { required: ['ledger', 'batch', 'input'], optional: ['expected-revision'] },
  'batch-status': { required: ['ledger', 'batch'] },
  'batch-fuse': { required: ['ledger', 'batch'] },
  'record-reflection': { required: ['ledger', 'input'], optional: ['expected-revision'] },
  'propose-improvement': { required: ['ledger', 'reflection', 'input'], optional: ['expected-revision'] },
  status: { required: ['ledger'] },
  inspect: { required: ['ledger'] },
  rebuild: { required: ['ledger'], optional: ['expected-revision'] },
  doctor: { required: ['ledger'] },
};
const CLI_NOTES = [
  '--ledger 传 init 回显的 ledger 字段（<state-root>/ledgers/<ledger-id>），不是 --state-root 本身。',
  '--state-root 必须落在业务仓库之外；确需仓内时显式加 --allow-repository-state。',
  '所有修改命令都接受 --expected-revision 做乐观并发控制，冲突即 fail closed。',
];
function parseCli(argv) { const command = argv[0] ?? ''; const spec = CLI_SPEC[command]; if (!spec) throw new LedgerError('未知 ledger 命令'); const options = {}; const flags = new Set(); for (let i = 1; i < argv.length; i += 1) { const token = argv[i]; if (!token.startsWith('--')) throw new LedgerError(`未知位置参数 ${token}`); const name = token.slice(2); if ((spec.flags ?? []).includes(name)) { if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) throw new LedgerError(`--${name} 不接受值`); flags.add(name); } else if (specOptionNames(spec).includes(name)) { if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new LedgerError(`--${name} 缺少值`); options[name] = argv[++i]; } else throw new LedgerError(`未知选项: --${name}`); } return { command, options, flags }; }
// `--ledger` 要的是 init 回显的 ledger 目录。init 早期只回显 state root，最容易误传 state root，
// 而老实现要等到读 events.ndjson 才报 ENOENT；这里先识别 state root 形状并直接指出应传的路径。
function ledgerDir(options) {
  const dir = realpathSync(req(options, 'ledger'));
  if (existsSync(join(dir, 'events.ndjson'))) return dir;
  const ledgers = join(dir, 'ledgers');
  if (!existsSync(ledgers)) return dir;
  const ids = readdirSync(ledgers).filter((id) => existsSync(join(ledgers, id, 'events.ndjson'))).sort();
  if (ids.length === 1) throw new LedgerError(`--ledger 需要 ledger 目录而不是 state root；请传 ${join(ledgers, ids[0])}`);
  if (ids.length === 0) throw new LedgerError(`--ledger 需要 ledger 目录而不是 state root；${ledgers} 下还没有 ledger，请先 init`);
  throw new LedgerError(`--ledger 需要 ledger 目录而不是 state root；请从 ${ledgers} 下选一个：${ids.join(', ')}`);
}
function req(options, name) { if (!options[name]) throw new LedgerError(`缺少 --${name}`); return options[name]; }
function revision(options) { if (options['expected-revision'] === undefined) return null; const value = Number(options['expected-revision']); if (!Number.isInteger(value) || value < 0) throw new LedgerError('expected-revision 无效'); return value; }

function init(options, flags) {
  const contract = validateContract(readJson(req(options, 'contract')));
  const binding = contract.skill_set.find((item) => item.name === 'orchestrate-subagents');
  if (!binding || binding.content_digest !== skillContentDigest()) throw new LedgerError('Task Contract 未冻结当前 orchestrate-subagents content digest');
  const root = resolve(options['state-root'] ?? join(tmpdir(), 'orchestration-ledger-state')); const repository = contract.environment.repository;
  if (repository && repository !== 'none' && existsSync(repository) && inside(root, repository) && !flags.has('allow-repository-state')) throw new LedgerError('state root 位于业务仓库内');
  mkdirSync(join(root, 'ledgers'), { recursive: true, mode: 0o700 }); const id = options['ledger-id'] ?? randomUUID(); if (!/^[A-Za-z0-9._-]+$/u.test(id)) throw new LedgerError('ledger-id 无效'); const dir = join(root, 'ledgers', id); mkdirSync(dir, { mode: 0o700 }); const now = new Date().toISOString();
  const snapshot = { schema_version: 1, runtime_version: ORCHESTRATION_RUNTIME_VERSION, ledger_id: id, revision: 0, contract_digest: contract.contract_digest, nodes: {}, edges: [], attachments: [], batches: {}, reflection_refs: [], improvement_proposal_refs: [], skill_provenance: { name: 'orchestrate-subagents', version: ORCHESTRATION_PROTOCOL_VERSION, content_digest: skillContentDigest() }, created_at: now, updated_at: now };
  writeNew(join(dir, 'contract.json'), contract); const initialEvent = { schema_version: 1, revision: 0, kind: 'initialized', recorded_at: now, previous_event_digest: null, snapshot }; initialEvent.event_digest = envelopeDigest(initialEvent, 'event_digest'); writeFileSync(join(dir, 'events.ndjson'), `${canonicalJson(initialEvent)}\n`, { flag: 'wx', mode: 0o600 }); atomicJson(join(dir, 'snapshot.json'), snapshot); return { ledger_id: id, ledger_dir: dir, ledger: dir, state_root: root, revision: 0 };
}

function cycle(nodes, edges) { const adj = new Map(Object.keys(nodes).map((id) => [id, []])); for (const edge of edges) adj.get(edge.from)?.push(edge.to); const visiting = new Set(), done = new Set(); const visit = (id) => { if (visiting.has(id)) return true; if (done.has(id)) return false; visiting.add(id); for (const next of adj.get(id) ?? []) if (visit(next)) return true; visiting.delete(id); done.add(id); return false; }; return [...adj.keys()].some(visit); }
function validateNodeVerification(input, contract) {
  const value = input?.verification;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LedgerError('node verification 必须显式声明');
  const keys = Object.keys(value).sort();
  if (canonicalJson(keys) !== canonicalJson(['artifact_scope', 'provider', 'requirement'])) throw new LedgerError('node verification 字段无效');
  if (!['worker_self_check', 'controller_recheck', 'independent_evidence', 'not_applicable'].includes(value.requirement)) throw new LedgerError('verification requirement 无效');
  if (!['none', 'verify-agent-output'].includes(value.provider)) throw new LedgerError('verification provider 无效');
  if (!['node_output', 'integration_candidate', 'not_applicable'].includes(value.artifact_scope)) throw new LedgerError('verification artifact_scope 无效');
  if (value.requirement === 'not_applicable') {
    if (!READ_ONLY_REVIEW_ROLES.has(input?.role ?? 'worker')) throw new LedgerError(`not_applicable 只允许只读评审节点（role=${[...READ_ONLY_REVIEW_ROLES].join('/')}）；实现节点必须选 worker_self_check / controller_recheck / independent_evidence`);
    if (value.artifact_scope !== 'not_applicable') throw new LedgerError('not_applicable 节点的 artifact_scope 必须是 not_applicable');
  }
  if (value.requirement === 'independent_evidence') {
    if (value.provider !== 'verify-agent-output' || value.artifact_scope === 'not_applicable') throw new LedgerError('independent_evidence 必须由 verify-agent-output 验证冻结 Artifact');
    if (contract.extensions.verification?.provider !== 'verify-agent-output') throw new LedgerError('Task Contract 未声明 verify-agent-output provider');
    if (!contract.skill_set.some((skill) => skill.name === 'verify-agent-output')) throw new LedgerError('Task Contract 未冻结 verify-agent-output Skill');
  } else if (value.provider !== 'none') throw new LedgerError(`${value.requirement} 的 provider 必须为 none`);
  return { requirement: value.requirement, provider: value.provider, artifact_scope: value.artifact_scope };
}

function validateArtifactRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 1 || !['manage-worktrees', 'caller-supplied'].includes(value.provider) || typeof value.repository_id !== 'string' || !value.repository_id) throw new LedgerError('Artifact Ref 结构无效');
  const allowed = new Set(['schema_version', 'provider', 'repository_id', 'object_format', 'base_sha', 'artifact_sha', 'branch_hint', 'worktree_id', 'ownership_epoch', 'target_sha', 'ordered_input_shas', 'batch_fingerprint']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new LedgerError('Artifact Ref 含未知字段');
  const length = value.object_format === 'sha1' ? 40 : value.object_format === 'sha256' ? 64 : 0;
  const validSha = (candidate) => typeof candidate === 'string' && new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(candidate);
  if (!length || !validSha(value.base_sha) || !validSha(value.artifact_sha)) throw new LedgerError('Artifact Ref object format/SHA 无效');
  if (value.provider === 'manage-worktrees' && (typeof value.worktree_id !== 'string' || !value.worktree_id || !Number.isInteger(value.ownership_epoch) || value.ownership_epoch < 1)) throw new LedgerError('manage-worktrees Artifact Ref 缺少 ownership binding');
  if (value.branch_hint !== undefined && typeof value.branch_hint !== 'string') throw new LedgerError('Artifact Ref branch_hint 无效');
  if (value.worktree_id !== undefined && (typeof value.worktree_id !== 'string' || !value.worktree_id)) throw new LedgerError('Artifact Ref worktree_id 无效');
  if (value.ownership_epoch !== undefined && (!Number.isInteger(value.ownership_epoch) || value.ownership_epoch < 1)) throw new LedgerError('Artifact Ref ownership_epoch 无效');
  if (value.target_sha !== undefined && !validSha(value.target_sha)) throw new LedgerError('Artifact Ref target_sha 无效');
  if (value.ordered_input_shas !== undefined && (!Array.isArray(value.ordered_input_shas) || value.ordered_input_shas.some((sha) => !validSha(sha)))) throw new LedgerError('Artifact Ref ordered_input_shas 无效');
  if (value.batch_fingerprint !== undefined && typeof value.batch_fingerprint !== 'string') throw new LedgerError('Artifact Ref batch_fingerprint 无效');
  return value;
}

function attachmentValues(dir, node, type) {
  return node.stable_outputs.filter((entry) => entry.type === type).map((entry) => ({ entry, value: readJson(join(dir, entry.ref)) }));
}

// contract attachment 不是交付物，不进 stable_outputs，因此从 ledger attachment 索引回查。
function nodeAttachmentValues(dir, snapshot, nodeId, type) {
  return snapshot.attachments.filter((entry) => entry.node_id === nodeId && entry.type === type).map((entry) => ({ entry, value: readJson(join(dir, entry.ref)) }));
}

function acceptanceItemDigests(contract) { return new Set(contract.acceptance.map((item) => sha256(Buffer.from(canonicalJson(item), 'utf8')))); }

// 投影只允许改动这四项：换 id、收窄 acceptance、写入血缘、重签摘要。其余顶层字段一律 verbatim 钉死。
const PROJECTION_MUTABLE_FIELDS = new Set(['contract_id', 'acceptance', 'extensions', 'contract_digest']);

// 投影合同：节点级、产物专属的验证合同。ledger 校验血缘（parent digest）+ 条目子集（逐条摘要）
// + 其余字段逐字段全等，替代原先的合同摘要全等，同时保持反张冠李戴：换任务被 parent digest 拦，
// 改措辞被条目摘要拦，夹带私货被子集校验拦，改 objective / scope / permissions / environment /
// skill_set / stop_conditions / 其他 extensions 被逐字段全等拦。
function validateProjectedContract(projection, snapshot, parent) {
  try { validateContract(projection); } catch (error) { throw new LedgerError(`投影合同结构无效: ${error.message}`); }
  const meta = projection.extensions?.projection;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new LedgerError('投影合同缺少 extensions.projection');
  if (!DIGEST_PATTERN.test(meta.parent_contract_digest ?? '')) throw new LedgerError('投影合同 parent_contract_digest 无效');
  if (!Array.isArray(meta.projected_item_ids) || !meta.projected_item_ids.length || meta.projected_item_ids.some((id) => typeof id !== 'string' || !id)) throw new LedgerError('投影合同 projected_item_ids 无效');
  if (new Set(meta.projected_item_ids).size !== meta.projected_item_ids.length) throw new LedgerError('投影合同 projected_item_ids 重复');
  if (meta.parent_contract_digest !== snapshot.contract_digest) throw new LedgerError('投影合同 parent_contract_digest 与 ledger 公共合同不一致');
  const pinned = [...new Set([...Object.keys(parent), ...Object.keys(projection)])].sort().filter((key) => !PROJECTION_MUTABLE_FIELDS.has(key));
  for (const key of pinned) if (canonicalJson(projection[key] ?? null) !== canonicalJson(parent[key] ?? null)) throw new LedgerError(`投影合同字段 ${key} 必须与公共合同逐字节相同`);
  const inherited = { ...projection.extensions }; delete inherited.projection;
  if (canonicalJson(inherited) !== canonicalJson(parent.extensions)) throw new LedgerError('投影合同 extensions 除 projection 外必须与公共合同逐字节相同');
  const allowed = acceptanceItemDigests(parent);
  for (const item of projection.acceptance) if (!allowed.has(sha256(Buffer.from(canonicalJson(item), 'utf8')))) throw new LedgerError(`投影合同 acceptance 条目不属于公共合同: ${item.contract_item_id}`);
  const ids = projection.acceptance.map((item) => item.contract_item_id).sort();
  if (canonicalJson(ids) !== canonicalJson([...meta.projected_item_ids].sort())) throw new LedgerError('投影合同 acceptance id 集合与 projected_item_ids 不一致');
  return projection;
}

// 条目子集校验的条目集合来自 contract.json 文件，血缘校验对的是 snapshot.contract_digest；
// 二者必须先互锁，否则换一份"夹带额外 acceptance 条目"的 contract.json 就能放行私货投影。
function parentContract(dir, snapshot) {
  const parent = validateContract(readJson(join(dir, 'contract.json')));
  if (envelopeDigest(parent, 'contract_digest') !== snapshot.contract_digest) throw new LedgerError('ledger contract.json 与快照合同摘要不一致');
  return parent;
}

function projectedContractsForNode(dir, snapshot, nodeId) {
  const attachments = nodeAttachmentValues(dir, snapshot, nodeId, 'contract');
  if (attachments.length > 1) throw new LedgerError('节点至多绑定一份投影合同');
  if (!attachments.length) return [];
  const parent = parentContract(dir, snapshot);
  return attachments.map(({ value }) => validateProjectedContract(value, snapshot, parent));
}

function validateEvidencePackage(evidence, snapshot, artifacts, { requirePass = false, projections = [] } = {}) {
  const required = ['schema_version', 'run_id', 'protocol_version', 'runtime_version', 'contract_digest', 'verification_profile_digest', 'artifact_ref', 'stages', 'terminal_outcome', 'completion_scope', 'human_gate_required', 'provenance', 'evidence_digest'];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || required.some((field) => !Object.hasOwn(evidence, field))) throw new LedgerError('Evidence Package 结构无效');
  if (evidence.schema_version !== 1 || evidence.protocol_version !== 1 || typeof evidence.run_id !== 'string' || !evidence.run_id || !SEMVER_PATTERN.test(evidence.runtime_version ?? '')) throw new LedgerError('Evidence Package identity/version 无效');
  const boundContractDigests = [snapshot.contract_digest, ...projections.map((item) => item.contract_digest)];
  if (!boundContractDigests.includes(evidence.contract_digest) || !DIGEST_PATTERN.test(evidence.verification_profile_digest ?? '')) throw new LedgerError('Evidence Package contract/profile binding 无效');
  validateArtifactRef(evidence.artifact_ref);
  if (!artifacts.some((artifact) => canonicalJson(artifact) === canonicalJson(evidence.artifact_ref))) throw new LedgerError('Evidence Package Artifact binding 不匹配');
  if (!evidence.stages || typeof evidence.stages !== 'object' || ['smoke_l0', 'l1_review', 'final_l0'].some((stage) => !evidence.stages[stage] || typeof evidence.stages[stage] !== 'object')) throw new LedgerError('Evidence Package stages 无效');
  if (!['pass', 'fail', 'undecidable', 'blocked_safety'].includes(evidence.terminal_outcome) || evidence.completion_scope !== 'verification_only' || typeof evidence.human_gate_required !== 'boolean') throw new LedgerError('Evidence Package terminal fields 无效');
  const provenance = evidence.provenance;
  if (!provenance || provenance.provider !== 'verify-agent-output' || typeof provenance.verifier_run_id !== 'string' || !provenance.verifier_run_id || typeof provenance.verified_at !== 'string' || !provenance.verified_at || !['host_reported', 'user_relayed'].includes(provenance.isolation_assurance) || !Array.isArray(provenance.limitations) || provenance.limitations.some((item) => typeof item !== 'string')) throw new LedgerError('Evidence Package provenance 无效');
  if (!DIGEST_PATTERN.test(evidence.evidence_digest ?? '') || envelopeDigest(evidence, 'evidence_digest') !== evidence.evidence_digest) throw new LedgerError('Evidence Package digest 无效');
  if (requirePass && evidence.terminal_outcome !== 'pass') throw new LedgerError(`Evidence terminal_outcome=${evidence.terminal_outcome}，不能 passed`);
  if (requirePass && evidence.human_gate_required) throw new LedgerError('Evidence 仍要求 human gate，不能 passed');
  return evidence;
}

function controllerOutputs(dir, node) {
  return node.stable_outputs.filter((entry) => {
    if (entry.type !== 'report') return true;
    return readJson(join(dir, entry.ref)).report_type !== 'controller_recheck';
  });
}

function validateControllerRecheck(report, snapshot, outputs) {
  const fields = ['checked_at', 'contract_digest', 'outcome', 'report_type', 'schema_version', 'stable_output_digests'];
  if (!report || typeof report !== 'object' || Array.isArray(report) || canonicalJson(Object.keys(report).sort()) !== canonicalJson(fields) || report.schema_version !== 1 || report.report_type !== 'controller_recheck' || report.contract_digest !== snapshot.contract_digest || report.outcome !== 'pass' || typeof report.checked_at !== 'string' || Number.isNaN(Date.parse(report.checked_at)) || !Array.isArray(report.stable_output_digests) || !report.stable_output_digests.length || new Set(report.stable_output_digests).size !== report.stable_output_digests.length) throw new LedgerError('Controller Recheck Record 结构或合同绑定无效');
  const expected = [...new Set(outputs.map((entry) => entry.digest))].sort();
  const actual = [...new Set(report.stable_output_digests)].sort();
  if (!expected.length || actual.some((digest) => !DIGEST_PATTERN.test(digest)) || canonicalJson(actual) !== canonicalJson(expected)) throw new LedgerError('Controller Recheck Record 未覆盖当前稳定输出');
  return report;
}

function assuranceForNode(dir, snapshot, node, verificationRef) {
  const requirement = node.verification.requirement;
  if (requirement === 'not_applicable') {
    if (!node.stable_outputs.some((entry) => entry.type === 'report')) throw new LedgerError('critic/scout 节点需先 attach report 才能 passed');
    return requirement;
  }
  if (node.stable_outputs.length === 0) throw new LedgerError('实现节点没有稳定交付物，不能 passed');
  if (requirement === 'worker_self_check') return requirement;
  if (!DIGEST_PATTERN.test(verificationRef ?? '')) throw new LedgerError(`${requirement} 必须用 verification_ref 绑定精确 attachment digest`);
  if (requirement === 'controller_recheck') {
    const outputs = controllerOutputs(dir, node);
    const report = attachmentValues(dir, node, 'report').find(({ entry, value }) => entry.digest === verificationRef && value.report_type === 'controller_recheck');
    if (!report) throw new LedgerError('verification_ref 未指向 Controller Recheck Record');
    validateControllerRecheck(report.value, snapshot, outputs);
    return requirement;
  }
  const artifacts = attachmentValues(dir, node, 'artifact').map(({ value }) => validateArtifactRef(value));
  if (artifacts.length !== 1) throw new LedgerError('independent_evidence 节点必须且只能绑定一个 Artifact Ref');
  const evidence = attachmentValues(dir, node, 'evidence').find(({ entry }) => entry.digest === verificationRef);
  if (!evidence) throw new LedgerError('verification_ref 未指向 Evidence Package');
  const projections = projectedContractsForNode(dir, snapshot, node.node_id);
  validateEvidencePackage(evidence.value, snapshot, artifacts, { requirePass: true, projections });
  return requirement;
}

function addNode(options) { const dir = ledgerDir(options); const input = readJson(req(options, 'input')); const contract = validateContract(readJson(join(dir, 'contract.json'))); return mutate(dir, revision(options), (snapshot) => { if (!/^[A-Za-z0-9._-]+$/u.test(input.node_id ?? '') || snapshot.nodes[input.node_id]) throw new LedgerError('node_id 无效或重复'); if (!['scout', 'worker', 'critic', 'judge'].includes(input.role ?? 'worker')) throw new LedgerError('node role 无效'); const permissions = input.permissions ?? { mode: 'read_only', writable_paths: [] }; if (!['read_only', 'write'].includes(permissions.mode) || !Array.isArray(permissions.writable_paths) || permissions.writable_paths.some((path) => typeof path !== 'string' || !path || isAbsolute(path) || path.split('/').includes('..'))) throw new LedgerError('node permissions 无效'); if (contract.permissions.mode === 'read_only' && (permissions.mode !== 'read_only' || permissions.writable_paths.length)) throw new LedgerError('node permissions 超出只读合同'); if (permissions.mode === 'write' && permissions.writable_paths.some((path) => !contract.permissions.writable_paths.some((allowed) => path === allowed || path.startsWith(`${allowed.replace(/\/$/u, '')}/`)))) throw new LedgerError('node writable_paths 超出合同边界'); const verification = validateNodeVerification(input, contract); const node = { node_id: input.node_id, objective: String(input.objective ?? ''), role: input.role ?? 'worker', required: input.required !== false, state: 'pending', permissions, dependencies: [], dispatch: null, stable_outputs: [], evidence: [], verification, verification_assurance: 'none', verification_ref: null, tokens: null, duration_ms: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; if (!node.objective) throw new LedgerError('node objective 不能为空'); return { snapshot: { ...snapshot, nodes: { ...snapshot.nodes, [node.node_id]: node } }, kind: 'node_added' }; }); }
function addEdge(options) { const dir = ledgerDir(options); const input = readJson(req(options, 'input')); return mutate(dir, revision(options), (snapshot) => { if (!snapshot.nodes[input.from] || !snapshot.nodes[input.to] || input.from === input.to || !['dependency', 'barrier'].includes(input.kind)) throw new LedgerError('edge 无效'); const edge = { from: input.from, to: input.to, kind: input.kind }; const edges = [...snapshot.edges, edge]; if (cycle(snapshot.nodes, edges)) throw new LedgerError('任务图不能形成环'); const target = { ...snapshot.nodes[input.to], dependencies: [...new Set([...snapshot.nodes[input.to].dependencies, input.from])] }; return { snapshot: { ...snapshot, edges, nodes: { ...snapshot.nodes, [input.to]: target } }, kind: 'edge_added' }; }); }
function validateDispatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LedgerError('dispatch 必须为对象');
  const keys = Object.keys(value);
  if (keys.length !== DISPATCH_KEYS.size || keys.some((key) => !DISPATCH_KEYS.has(key))) throw new LedgerError('dispatch 字段不完整或包含未知字段');
  if (value.schema_version !== 2) throw new LedgerError('dispatch schema_version 必须为 2');
  const textFields = ['worker_id', 'attempt_id', 'tier', 'model', 'reasoning_effort', 'selection_reason', 'capability_source'];
  if (textFields.some((key) => typeof value[key] !== 'string' || !value[key].trim() || /[\r\n]/u.test(value[key]))) throw new LedgerError('dispatch 文本字段为空或含非法换行');
  if (!['lightweight', 'full'].includes(value.orchestration_mode)) throw new LedgerError('dispatch orchestration_mode 无效');
  if (!Number.isSafeInteger(value.attempt) || value.attempt < 1 || !Number.isSafeInteger(value.max_attempts) || value.max_attempts < value.attempt) throw new LedgerError('dispatch attempt/max_attempts 无效');
  if (!ADJUSTMENT_ACTIONS.has(value.adjustment_action)) throw new LedgerError('dispatch adjustment_action 无效');
  if (value.attempt === 1) {
    if (value.adjustment_action !== 'initial' || value.previous_attempt_id !== null || value.failure_kind !== null || value.failure_ref !== null) throw new LedgerError('首次 dispatch 必须使用 initial 且没有失败沿袭');
  } else {
    if (value.adjustment_action === 'initial' || typeof value.previous_attempt_id !== 'string' || !value.previous_attempt_id || !FAILURE_KINDS.has(value.failure_kind) || !DIGEST_PATTERN.test(value.failure_ref ?? '')) throw new LedgerError('重派 dispatch 必须绑定前序 attempt 与可重路由失败证据');
  }
  if (!CONFIGURATION_STATES.has(value.configuration_state)) throw new LedgerError('dispatch configuration_state 无效');
  if (!MODEL_RESOLUTION_STATES.has(value.model_resolution_state)) throw new LedgerError('dispatch model_resolution_state 无效');
  if (value.model_resolution_state === 'user-explicit-unverifiable' && value.configuration_state !== 'user-explicit') throw new LedgerError('user-explicit-unverifiable 只允许用户当轮显式模型');
  if (value.model_resolution_state === 'host-default-unexposed' && (value.model !== 'host-default' || value.configuration_state !== 'host-default' || value.dispatch_provenance !== 'host-default')) throw new LedgerError('host-default-unexposed 必须绑定宿主默认派发');
  if (!DISPATCH_PROVENANCE.has(value.dispatch_provenance)) throw new LedgerError('dispatch dispatch_provenance 无效');
  if (!Array.isArray(value.config_source) || !value.config_source.length || value.config_source.some((item) => typeof item !== 'string' || !item.trim() || /[\r\n]/u.test(item))) throw new LedgerError('dispatch config_source 必须为非空字符串数组');
  if (value.capability_fingerprint !== null && !DIGEST_PATTERN.test(value.capability_fingerprint)) throw new LedgerError('dispatch capability_fingerprint 无效');
  if (value.orchestration_mode === 'full' && !DIGEST_PATTERN.test(value.capability_fingerprint ?? '')) throw new LedgerError('full dispatch 必须绑定 capability_fingerprint');
  if (value.token_budget !== 'unsupported' && (!Number.isSafeInteger(value.token_budget) || value.token_budget < 0)) throw new LedgerError('dispatch token_budget 必须为非负安全整数或 unsupported');
  return value;
}
function dispatchRecord(options) { const dir = ledgerDir(options); const input = validateDispatch(readJson(req(options, 'input'))); const nodeId = req(options, 'node'); return mutate(dir, revision(options), (snapshot) => { const node = snapshot.nodes[nodeId]; if (!node || node.state !== 'pending') throw new LedgerError('只有 pending node 可登记 dispatch'); if (node.dependencies.some((id) => snapshot.nodes[id].state !== 'passed')) throw new LedgerError('依赖/barrier 尚未通过'); const existingAttempts = Object.values(snapshot.nodes).map((item) => item.dispatch).filter(Boolean); if (existingAttempts.some((item) => item.attempt_id === input.attempt_id)) throw new LedgerError('dispatch attempt_id 重复'); if (input.attempt > 1) { const previousNode = Object.values(snapshot.nodes).find((item) => item.dispatch?.attempt_id === input.previous_attempt_id); if (!previousNode || previousNode.state !== 'failed' || previousNode.dispatch.attempt !== input.attempt - 1) throw new LedgerError('重派前序 attempt 不存在、未失败或序号不连续'); if (!snapshot.attachments.some((item) => item.digest === input.failure_ref && item.node_id === previousNode.node_id && ['report', 'evidence'].includes(item.type))) throw new LedgerError('重派 failure_ref 未绑定前序失败证据'); } const next = { ...node, state: 'running', dispatch: input, updated_at: new Date().toISOString() }; return { snapshot: { ...snapshot, nodes: { ...snapshot.nodes, [nodeId]: next } }, kind: input.attempt === 1 ? 'node_dispatched' : 'node_rerouted' }; }); }
function validateDuration(val) { if (val === undefined || val === null) return null; if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0) throw new LedgerError('duration_ms 必须为非负安全整数'); return val; }
function validateTokens(val) { if (val === undefined || val === null) return null; if (typeof val === 'number') { if (!Number.isSafeInteger(val) || val < 0) throw new LedgerError('tokens 必须为非负安全整数'); return val; } if (typeof val === 'object' && val !== null && !Array.isArray(val)) { const required = ['input_tokens', 'output_tokens', 'total_tokens']; const keys = Object.keys(val).sort(); if (canonicalJson(keys) !== canonicalJson(required)) throw new LedgerError('tokens 对象必须且只能包含 input_tokens、output_tokens、total_tokens'); for (const key of required) { const num = val[key]; if (typeof num !== 'number' || !Number.isSafeInteger(num) || num < 0) throw new LedgerError(`tokens.${key} 必须为非负安全整数`); } if (val.total_tokens !== val.input_tokens + val.output_tokens) throw new LedgerError('tokens.total_tokens 必须等于 input_tokens + output_tokens'); return val; } throw new LedgerError('tokens 必须为非负安全整数或合法结构体对象'); }

function update(options) { const dir = ledgerDir(options); const input = readJson(req(options, 'input')); const nodeId = req(options, 'node'); return mutate(dir, revision(options), (snapshot) => { const node = snapshot.nodes[nodeId]; if (!node || !NODE_STATES.has(input.state)) throw new LedgerError('node/state 无效'); const assurance = input.state === 'passed' ? assuranceForNode(dir, snapshot, node, input.verification_ref) : node.verification_assurance; const validTokens = input.tokens !== undefined ? validateTokens(input.tokens) : (node.tokens ?? null); const validDuration = input.duration_ms !== undefined ? validateDuration(input.duration_ms) : (node.duration_ms ?? null); const next = { ...node, state: input.state, verification_assurance: assurance, verification_ref: input.state === 'passed' ? input.verification_ref ?? null : node.verification_ref, checkpoint: input.checkpoint ?? null, reason: input.reason ?? null, tokens: validTokens, duration_ms: validDuration, updated_at: new Date().toISOString() }; return { snapshot: { ...snapshot, nodes: { ...snapshot.nodes, [nodeId]: next } }, kind: `node_${input.state}` }; }); }
function attach(options) { const dir = ledgerDir(options); const input = readJson(req(options, 'input')); const nodeId = req(options, 'node'); const type = req(options, 'type'); if (!['worktree', 'artifact', 'evidence', 'loop', 'report', 'contract'].includes(type)) throw new LedgerError('attachment type 无效'); return mutate(dir, revision(options), (snapshot) => { const current = snapshot.nodes[nodeId]; if (!current) throw new LedgerError('node 不存在'); if (TERMINAL_NODE_STATES.has(current.state)) throw new LedgerError('终态 node 不接受新 attachment'); if (type === 'artifact') { validateArtifactRef(input); if (current.verification.requirement === 'independent_evidence' && attachmentValues(dir, current, 'artifact').length) throw new LedgerError('independent_evidence 节点只能绑定一个冻结 Artifact Ref'); } if (type === 'contract') { if (current.verification.requirement !== 'independent_evidence') throw new LedgerError('只有 independent_evidence 节点可绑定投影合同'); if (nodeAttachmentValues(dir, snapshot, nodeId, 'contract').length) throw new LedgerError('节点至多绑定一份投影合同'); validateProjectedContract(input, snapshot, parentContract(dir, snapshot)); } if (type === 'evidence') validateEvidencePackage(input, snapshot, attachmentValues(dir, current, 'artifact').map(({ value }) => validateArtifactRef(value)), { projections: projectedContractsForNode(dir, snapshot, nodeId) }); if (type === 'report' && input.report_type === 'controller_recheck') validateControllerRecheck(input, snapshot, controllerOutputs(dir, current)); const digest = sha256(Buffer.from(canonicalJson(input), 'utf8')); mkdirSync(join(dir, 'attachments'), { recursive: true, mode: 0o700 }); const ref = `attachments/${digest.slice(7)}.json`; if (existsSync(join(dir, ref))) { if (canonicalJson(readJson(join(dir, ref))) !== canonicalJson(input)) throw new LedgerError('attachment digest collision'); } else writeNew(join(dir, ref), input); const entry = { attachment_id: randomUUID(), node_id: nodeId, type, digest, ref }; const node = { ...current, stable_outputs: ['artifact', 'evidence', 'loop', 'report'].includes(type) ? [...current.stable_outputs, entry] : current.stable_outputs, evidence: type === 'evidence' ? [...current.evidence, entry] : current.evidence }; return { snapshot: { ...snapshot, attachments: [...snapshot.attachments, entry], nodes: { ...snapshot.nodes, [nodeId]: node } }, kind: 'attachment_added' }; }); }

function batchInit(options) { const dir = ledgerDir(options); const input = readJson(req(options, 'input')); return mutate(dir, revision(options), (snapshot) => { if (!input.batch_id || snapshot.batches[input.batch_id] || !Array.isArray(input.loop_ids) || !input.loop_ids.length) throw new LedgerError('batch 输入无效'); const batch = { batch_id: input.batch_id, loop_ids: [...new Set(input.loop_ids)], mode: input.mode ?? 'ordered', limits: { max_failures: Number(input.limits?.max_failures ?? input.loop_ids.length), consecutive_identical_signature: Number(input.limits?.consecutive_identical_signature ?? 3) }, records: [], state: 'active', fuse: null, created_at: new Date().toISOString() }; if (!Number.isInteger(batch.limits.max_failures) || !Number.isInteger(batch.limits.consecutive_identical_signature) || batch.limits.max_failures <= 0 || batch.limits.consecutive_identical_signature <= 0) throw new LedgerError('batch limits 无效'); return { snapshot: { ...snapshot, batches: { ...snapshot.batches, [batch.batch_id]: batch } }, kind: 'batch_initialized' }; }); }
export function evaluateBatchFuse(batch) { const failures = batch.records.filter((item) => item.state === 'stopped'); const signature = failures.at(-1)?.failure_key ?? null; let consecutive = 0; if (signature) for (let i = batch.records.length - 1; i >= 0 && batch.records[i].state === 'stopped' && batch.records[i].failure_key === signature; i -= 1) consecutive += 1; if (failures.length >= batch.limits.max_failures) return { kind: 'max_failures', failures: failures.length }; if (signature && consecutive >= batch.limits.consecutive_identical_signature) return { kind: 'identical_failure_fuse', failure_key: signature, consecutive }; return null; }
function batchRecord(options) { const dir = ledgerDir(options); const input = readJson(req(options, 'input')); const id = req(options, 'batch'); return mutate(dir, revision(options), (snapshot) => { const batch = snapshot.batches[id]; if (!batch || batch.state !== 'active' || !batch.loop_ids.includes(input.loop_id) || batch.records.some((item) => item.loop_id === input.loop_id) || !['completed', 'stopped'].includes(input.state)) throw new LedgerError('batch record 无效或重放'); const records = [...batch.records, { loop_id: input.loop_id, state: input.state, failure_key: input.state === 'stopped' ? input.failure_key ?? null : null, result_ref: input.result_ref ?? null, recorded_at: new Date().toISOString() }]; let next = { ...batch, records }; const fuse = evaluateBatchFuse(next); if (fuse) next = { ...next, state: 'fused', fuse }; else if (records.length === batch.loop_ids.length) next = { ...next, state: 'completed' }; return { snapshot: { ...snapshot, batches: { ...snapshot.batches, [id]: next } }, kind: fuse ? 'batch_fused' : 'batch_recorded' }; }); }
function batchStatus(options) { const snapshot = load(ledgerDir(options)).snapshot; const batch = snapshot.batches[req(options, 'batch')]; if (!batch) throw new LedgerError('batch 不存在'); return batch; }
function batchFuse(options) { const batch = batchStatus(options); return { batch_id: batch.batch_id, state: batch.state, fuse: batch.fuse ?? evaluateBatchFuse(batch) }; }

function recordReflection(options) { const dir = ledgerDir(options); const input = readJson(req(options, 'input')); return mutate(dir, revision(options), (snapshot) => { const event = readJournal(dir).events.at(-1); const eventDigest = sha256(Buffer.from(canonicalJson(event), 'utf8')); let value; try { value = buildReflection({ input: { ...input, trigger: input.trigger ?? 'unexpected_outcome', impact: input.impact ?? 'medium', confidence: 'high', recommended_disposition: input.recommended_disposition ?? 'continue', evidence_refs: [{ type: 'event', id: `events.ndjson#revision=${event.revision}`, digest: eventDigest }] }, stateDir: dir, scope: { contract_digest: snapshot.contract_digest }, skill: snapshot.skill_provenance, parseJsonStrict, canonicalJson, envelopeDigest }); } catch (error) { throw new LedgerError(error.message); } mkdirSync(join(dir, 'reflections'), { recursive: true, mode: 0o700 }); const ref = `reflections/${value.reflection_id}.json`; writeNewJson(join(dir, ref), value); return { snapshot: { ...snapshot, reflection_refs: [...snapshot.reflection_refs, { reflection_id: value.reflection_id, reflection_digest: value.reflection_digest, ref }] }, kind: 'reflection_recorded' }; }); }
function propose(options) { const dir = ledgerDir(options); const input = readJson(req(options, 'input')); const reflectionId = req(options, 'reflection'); return mutate(dir, revision(options), (snapshot) => { const ref = snapshot.reflection_refs.find((item) => item.reflection_id === reflectionId); if (!ref) throw new LedgerError('Reflection 未登记'); const reflection = readJson(join(dir, ref.ref)); let value; try { value = buildProposal({ input: { ...input, problem_type: input.problem_type ?? 'skill_gap', validation_plan: { replay_cases: input.validation_plan?.replay_cases ?? [], regression_suites: input.validation_plan?.regression_suites ?? [], independent_review: 'required' } }, reflections: [reflection], skill: snapshot.skill_provenance, envelopeDigest }); } catch (error) { throw new LedgerError(error.message); } mkdirSync(join(dir, 'proposals'), { recursive: true, mode: 0o700 }); const path = `proposals/${value.proposal_id}.json`; writeNewJson(join(dir, path), value); return { snapshot: { ...snapshot, improvement_proposal_refs: [...snapshot.improvement_proposal_refs, { proposal_id: value.proposal_id, proposal_digest: value.proposal_digest, ref: path }] }, kind: 'improvement_proposed' }; }); }

function status(options) { const loaded = load(ledgerDir(options)); const nodes = Object.values(loaded.snapshot.nodes); const totalTokens = nodes.reduce((acc, n) => acc + (typeof n.tokens === 'number' ? n.tokens : (n.tokens?.total_tokens ?? 0)), 0); const tokensByRole = {}; for (const n of nodes) { const t = typeof n.tokens === 'number' ? n.tokens : (n.tokens?.total_tokens ?? 0); tokensByRole[n.role] = (tokensByRole[n.role] || 0) + t; } return { ...loaded.snapshot, recovery_needed: loaded.repair, summary: { pending: nodes.filter((n) => n.state === 'pending').length, active: nodes.filter((n) => ['running', 'blocked', 'awaiting_verification'].includes(n.state)).length, terminal: nodes.filter((n) => TERMINAL_NODE_STATES.has(n.state)).length, completion_ready: nodes.filter((n) => n.required).every((n) => n.state === 'passed'), verification_assurance: { none: nodes.filter((n) => !n.verification_assurance || n.verification_assurance === 'none').length, worker_self_check: nodes.filter((n) => n.verification_assurance === 'worker_self_check').length, controller_recheck: nodes.filter((n) => n.verification_assurance === 'controller_recheck').length, independent_evidence: nodes.filter((n) => n.verification_assurance === 'independent_evidence').length, not_applicable: nodes.filter((n) => n.verification_assurance === 'not_applicable').length }, token_accounting: { total_tokens: totalTokens, by_role: tokensByRole } } }; }
function rebuild(options) { const dir = ledgerDir(options); return withLock(dir, () => { const loaded = load(dir); const expected = revision(options); if (expected !== null && loaded.snapshot.revision !== expected) throw new LedgerError(`revision conflict: expected ${expected}, actual ${loaded.snapshot.revision}`); if (loaded.journal.trailing) writeFileSync(join(dir, 'events.ndjson'), loaded.journal.complete, { mode: 0o600 }); atomicJson(join(dir, 'snapshot.json'), loaded.snapshot); return { rebuilt: true, revision: loaded.snapshot.revision }; }); }
function doctor(options) { const dir = ledgerDir(options); const loaded = load(dir); const snapshot = loaded.snapshot; const contract = validateContract(readJson(join(dir, 'contract.json'))); const findings = []; if (cycle(snapshot.nodes, snapshot.edges)) findings.push('graph_cycle'); for (const node of Object.values(snapshot.nodes)) { if (node.state === 'running' && !node.dispatch) findings.push(`missing_dispatch:${node.node_id}`); if (node.dispatch) { try { validateDispatch(node.dispatch); } catch { findings.push(`dispatch_invalid:${node.node_id}`); } } try { validateNodeVerification(node, contract); } catch { findings.push(`verification_policy_invalid:${node.node_id}`); } if (node.state === 'passed') { try { const assurance = assuranceForNode(dir, snapshot, node, node.verification_ref); if (assurance !== node.verification_assurance) findings.push(`verification_assurance_mismatch:${node.node_id}`); } catch { findings.push(`verification_gate_invalid:${node.node_id}`); } } if (node.tokens !== null && node.tokens !== undefined) { try { validateTokens(node.tokens); } catch { findings.push(`tokens_invalid:${node.node_id}`); } } if (node.duration_ms !== null && node.duration_ms !== undefined) { try { validateDuration(node.duration_ms); } catch { findings.push(`duration_invalid:${node.node_id}`); } } } for (const item of snapshot.attachments) { const path = join(dir, item.ref); if (!existsSync(path) || sha256(Buffer.from(canonicalJson(readJson(path)), 'utf8')) !== item.digest) findings.push(`attachment_invalid:${item.attachment_id}`); } for (const ref of snapshot.reflection_refs) { const value = readJson(join(dir, ref.ref)); if (envelopeDigest(value, 'reflection_digest') !== value.reflection_digest || value.reflection_digest !== ref.reflection_digest) findings.push(`reflection_invalid:${ref.reflection_id}`); for (const evidence of value.evidence_refs ?? []) { const match = /^events\.ndjson#revision=(\d+)$/u.exec(evidence.id ?? ''); const event = match ? loaded.journal.events.find((item) => item.revision === Number(match[1])) : null; if (!event || sha256(Buffer.from(canonicalJson(event), 'utf8')) !== evidence.digest) findings.push(`reflection_evidence_invalid:${ref.reflection_id}`); } } for (const ref of snapshot.improvement_proposal_refs) { const value = readJson(join(dir, ref.ref)); if (value.lifecycle !== 'proposed' || envelopeDigest(value, 'proposal_digest') !== value.proposal_digest || value.proposal_digest !== ref.proposal_digest) findings.push(`proposal_invalid:${ref.proposal_id}`); } const currentDigest = skillContentDigest(); if (currentDigest !== snapshot.skill_provenance.content_digest) findings.push('skill_drift'); return { healthy: !loaded.repair && !existsSync(join(dir, '.lock')) && !findings.length, recovery_needed: loaded.repair, findings, frozen_content_digest: snapshot.skill_provenance.content_digest, current_content_digest: currentDigest }; }
function capabilities() { return { skill: 'orchestrate-subagents', protocol_version: ORCHESTRATION_PROTOCOL_VERSION, runtime_version: ORCHESTRATION_RUNTIME_VERSION, contracts: { task_contract: [1], orchestration_ledger: [1], dispatch_record: [2], controller_recheck_record: [1], reflection_record: [1], improvement_proposal: [1], effective_worker_capability: [1], worker_capability_requirements: [1], review_policy: [1] }, features: ['task-graph', 'barriers', 'revision-lock', 'journal-rebuild', 'stable-attachments', 'verification-obligations', 'evidence-binding-gate', 'contract-projection', 'verification-assurance-audit', 'read-only-node-not-applicable-verification', 'dispatch-audit', 'local-tier-routing', 'evidence-bound-dynamic-reroute', 'worker-capability-preflight', 'lightweight-reflection', 'batch-fuse', 'incident-reflection', 'proposed-only-improvement', 'token-accounting', 'review-budget-gate'], content_digest: skillContentDigest() }; }

export function main(argv = process.argv.slice(2)) { if (isHelpRequest(argv)) return { help: renderCliHelp('orchestration-ledger.mjs', CLI_SPEC, CLI_NOTES) }; const { command, options, flags } = parseCli(argv); if (command === 'capabilities') return capabilities(); if (command === 'init') return init(options, flags); if (command === 'add-node') return addNode(options); if (command === 'add-edge') return addEdge(options); if (command === 'dispatch-record') return dispatchRecord(options); if (command === 'update') return update(options); if (command === 'attach') return attach(options); if (command === 'batch-init') return batchInit(options); if (command === 'batch-record') return batchRecord(options); if (command === 'batch-status') return batchStatus(options); if (command === 'batch-fuse') return batchFuse(options); if (command === 'record-reflection') return recordReflection(options); if (command === 'propose-improvement') return propose(options); if (command === 'status') return status(options); if (command === 'inspect') return status(options); if (command === 'rebuild') return rebuild(options); if (command === 'doctor') return doctor(options); throw new LedgerError('未知 ledger 命令'); }
function entry() { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url; } }
export function runCli(argv = process.argv.slice(2)) {
  try {
    const result = main(argv);
    process.stdout.write(typeof result?.help === 'string' ? result.help : `${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof LedgerError || error instanceof ContractError ? 'invalid_input' : 'runtime_error';
    process.stderr.write(`${JSON.stringify({ error: code, message: error.message })}\n`);
    return code === 'invalid_input' ? 2 : 3;
  }
}
if (entry()) process.exitCode = runCli();
