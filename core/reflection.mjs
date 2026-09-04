// @ts-check
// Reflection / Improvement Proposal 的共享构造与校验。
//
// 此前 orchestrate 一份、verify 与 loop 各一份（后两者字节相同）。两版不是简单重复，
// orchestrate 版是严格超集：Bearer 脱敏用 \S+、拒绝输入未知字段、evidence ref 额外做
// realpath 越界检查。统一到严格版会让 verify/loop 拒绝此前接受的输入，属于行为变更。
// 这里只做实现去重，严格度由调用方注入并保持各自现状；收敛严格度是一次独立决策。
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

import { digestBytes } from './digest.mjs';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const TRIGGERS = new Set(['repeated_failure', 'undecidable', 'user_correction', 'runtime_abort', 'workaround', 'protocol_conflict', 'unexpected_outcome', 'terminal_retrospective']);
const CLASSIFICATIONS = new Set(['contract_gap', 'skill_gap', 'verification_gap', 'tool_gap', 'environment_gap', 'false_positive', 'false_negative', 'inefficiency']);
const IMPACTS = new Set(['low', 'medium', 'high', 'safety']);
const CONFIDENCE = new Set(['low', 'medium', 'high']);
const DISPOSITIONS = new Set(['continue', 'undecidable', 'abort', 're_contract', 'human_gate']);
const REF_TYPES = new Set(['artifact', 'evidence', 'event', 'diagnostic']);
const PROBLEM_TYPES = new Set(['skill_gap', 'false_positive', 'false_negative', 'inefficiency']);
const REFLECTION_INPUT_KEYS = new Set(['contract_digest', 'trigger', 'classification', 'observation', 'evidence_refs', 'impact', 'confidence', 'recommended_disposition']);
const PROPOSAL_INPUT_KEYS = new Set(['problem_type', 'proposed_change', 'affected_scope', 'counterexamples', 'validation_plan', 'lifecycle']);
const VALIDATION_PLAN_KEYS = new Set(['replay_cases', 'regression_suites', 'independent_review', 'canary']);

// 宽松版只匹配 token 字符类，遇到 `Bearer hidden%token|suffix` 会漏脱敏；严格版用 \S+ 覆盖到空白为止。
const BEARER_STRICT = /\bBearer\s+\S+/giu;
const BEARER_LENIENT = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;

export function safeRelative(id) {
  if (typeof id !== 'string' || !id || isAbsolute(id) || id.includes('\\')) throw new Error('evidence ref id 必须是相对路径');
  const normalized = normalize(id);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) throw new Error('evidence ref 不能越出 state 目录');
  return normalized;
}

/** @param {{ strict?: boolean }} [options] strict 对应 orchestrate 侧此前的行为。 */
export function createReflectionKit({ strict = false } = {}) {
  const redact = (text) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('反思文本不能为空');
    return text
      .replace(strict ? BEARER_STRICT : BEARER_LENIENT, 'Bearer [REDACTED]')
      .replace(/\b(?:ghp|glpat|sk)-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED]')
      .replace(/\/(?:Users|home)\/[^\s"']+/gu, '[LOCAL_PATH]');
  };

  const eventDigest = (stateDir, id, parseJsonStrict, canonicalJson) => {
    const match = /^events\.ndjson#revision=(\d+)$/u.exec(id);
    if (!match) return null;
    const lines = readFileSync(join(stateDir, 'events.ndjson'), 'utf8').split('\n').filter(Boolean);
    const event = lines.map((line) => parseJsonStrict(line)).find((candidate) => candidate.revision === Number(match[1]));
    if (!event) throw new Error(`event revision 不存在: ${match[1]}`);
    return digestBytes(Buffer.from(canonicalJson(event), 'utf8'));
  };

  function verifyEvidenceRefs(stateDir, refs, parseJsonStrict, canonicalJson) {
    if (!Array.isArray(refs)) throw new Error('evidence_refs 必须是数组');
    return refs.map((ref) => {
      if (!ref || !REF_TYPES.has(ref.type) || typeof ref.id !== 'string' || !DIGEST.test(String(ref.digest ?? ''))) throw new Error('evidence ref 结构无效');
      const event = ref.type === 'event' ? eventDigest(stateDir, ref.id, parseJsonStrict, canonicalJson) : null;
      const actual = event ?? (() => {
        const relativeId = safeRelative(ref.id);
        const path = join(stateDir, relativeId);
        if (!existsSync(path)) throw new Error(`evidence ref 不存在: ${ref.id}`);
        if (!strict) return digestBytes(readFileSync(path));
        // 严格版额外解引用 symlink，防止 evidence ref 经软链越出 state 目录。
        const root = realpathSync(stateDir);
        const resolved = realpathSync(path);
        const fromRoot = relative(root, resolved);
        if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error(`evidence ref 越出 state 目录: ${ref.id}`);
        return digestBytes(readFileSync(resolved));
      })();
      if (actual !== ref.digest) throw new Error(`evidence ref digest 不匹配: ${ref.id}`);
      return { type: ref.type, id: ref.id, digest: ref.digest };
    });
  }

  function buildReflection({ input, stateDir, runDir, scope, skill, parseJsonStrict, canonicalJson, envelopeDigest }) {
    const root = stateDir ?? runDir;
    if (strict) {
      const unknown = Object.keys(input).filter((key) => !REFLECTION_INPUT_KEYS.has(key));
      if (unknown.length) throw new Error(`Reflection 未知字段: ${unknown.sort().join(', ')}`);
    }
    for (const forbidden of ['chain_of_thought', 'reasoning', 'scratchpad']) if (Object.hasOwn(input, forbidden)) throw new Error(`Reflection 禁止字段: ${forbidden}`);
    if (!TRIGGERS.has(input.trigger) || !CLASSIFICATIONS.has(input.classification) || !IMPACTS.has(input.impact) || !CONFIDENCE.has(input.confidence) || !DISPOSITIONS.has(input.recommended_disposition)) throw new Error('Reflection 枚举字段无效');
    const evidenceRefs = verifyEvidenceRefs(root, input.evidence_refs ?? [], parseJsonStrict, canonicalJson);
    if (evidenceRefs.length === 0 && input.confidence !== 'low') throw new Error('无稳定证据的 Reflection 只能是 low confidence');
    const record = {
      schema_version: 1,
      reflection_id: randomUUID(),
      trigger: input.trigger,
      scope,
      affected_skill: skill,
      classification: input.classification,
      observation: redact(input.observation),
      evidence_refs: evidenceRefs,
      impact: input.impact,
      confidence: input.confidence,
      recommended_disposition: input.recommended_disposition,
      recorded_at: new Date().toISOString(),
    };
    record.reflection_digest = envelopeDigest(record, 'reflection_digest');
    return record;
  }

  function readAndValidateReflection(path, expectedSkill, parseJsonStrict, envelopeDigest) {
    const reflection = parseJsonStrict(readFileSync(path, 'utf8'));
    if (reflection?.schema_version !== 1 || reflection.affected_skill?.name !== expectedSkill || !DIGEST.test(String(reflection.reflection_digest ?? '')) || envelopeDigest(reflection, 'reflection_digest') !== reflection.reflection_digest) throw new Error('Reflection 文件无效或目标 Skill 不匹配');
    return reflection;
  }

  function buildProposal({ input, reflections, skill, envelopeDigest }) {
    if (strict) {
      const unknown = Object.keys(input).filter((key) => !PROPOSAL_INPUT_KEYS.has(key));
      if (unknown.length) throw new Error(`Proposal 未知字段: ${unknown.sort().join(', ')}`);
    }
    if (input.lifecycle !== undefined && input.lifecycle !== 'proposed') throw new Error('执行 Skill 只能创建 proposed proposal');
    if (!PROBLEM_TYPES.has(input.problem_type)) throw new Error('proposal problem_type 无效');
    if (!Array.isArray(reflections) || reflections.length === 0) throw new Error('proposal 至少绑定一个 Reflection');
    const evidenceRefs = reflections.flatMap((item) => item.evidence_refs ?? []);
    if (evidenceRefs.length === 0) throw new Error('proposal 必须来自带证据的 Reflection');
    const validationPlan = input.validation_plan;
    if (strict && validationPlan && (typeof validationPlan !== 'object' || Array.isArray(validationPlan) || Object.keys(validationPlan).some((key) => !VALIDATION_PLAN_KEYS.has(key)))) throw new Error('proposal validation_plan 含未知字段');
    if (!validationPlan || !Array.isArray(validationPlan.replay_cases) || !Array.isArray(validationPlan.regression_suites) || validationPlan.independent_review !== 'required') throw new Error('proposal validation_plan 无效');
    const proposal = {
      schema_version: 1,
      proposal_id: randomUUID(),
      target_skill: { name: skill.name, based_on_version: skill.version, based_on_digest: skill.content_digest },
      source_reflections: reflections.map((item) => ({ reflection_id: item.reflection_id, reflection_digest: item.reflection_digest })),
      problem: { type: input.problem_type, evidence_refs: evidenceRefs },
      proposed_change: redact(input.proposed_change),
      affected_scope: Array.isArray(input.affected_scope) ? input.affected_scope.map(redact) : [],
      counterexamples: Array.isArray(input.counterexamples) ? input.counterexamples.map(redact) : [],
      validation_plan: { ...validationPlan },
      lifecycle: 'proposed',
    };
    proposal.proposal_digest = envelopeDigest(proposal, 'proposal_digest');
    return proposal;
  }

  return { buildProposal, buildReflection, readAndValidateReflection, safeRelative, verifyEvidenceRefs };
}
