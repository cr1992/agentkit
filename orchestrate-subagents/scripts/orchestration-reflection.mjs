#!/usr/bin/env node
// @ts-check

import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson, envelopeDigest, parseJsonStrict } from './contract-tool.mjs';
import { ORCHESTRATION_PROTOCOL_VERSION } from './orchestration-metadata.mjs';
import { skillContentDigest } from './orchestration-ledger.mjs';
import { buildProposal, buildReflection, readAndValidateReflection, safeRelative, verifyEvidenceRefs, writeNewJson } from './reflection-support.mjs';

const RUNTIME_VERSION = '1.0.0';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export class OrchestrationReflectionError extends Error {}

function readJson(path) {
  return parseJsonStrict(readFileSync(resolvePath(path), 'utf8'));
}

function skillProvenance() {
  return { name: 'orchestrate-subagents', version: ORCHESTRATION_PROTOCOL_VERSION, content_digest: skillContentDigest() };
}

export function recordStandalone(stateRoot, input) {
  const root = resolvePath(stateRoot);
  if (!DIGEST_PATTERN.test(String(input.contract_digest ?? ''))) throw new OrchestrationReflectionError('contract_digest 无效');
  mkdirSync(join(root, 'reflections'), { recursive: true, mode: 0o700 });
  const value = buildReflection({
    input,
    stateDir: root,
    scope: { contract_digest: input.contract_digest },
    skill: skillProvenance(),
    parseJsonStrict,
    canonicalJson,
    envelopeDigest,
  });
  const ref = `reflections/${value.reflection_id}.json`;
  writeNewJson(join(root, ref), value);
  return { reflection_id: value.reflection_id, reflection_digest: value.reflection_digest, ref };
}

export function proposeStandalone(stateRoot, reflectionRef, input) {
  const root = resolvePath(stateRoot);
  const relative = safeRelative(reflectionRef);
  const reflectionPath = join(root, relative);
  if (!existsSync(reflectionPath)) throw new OrchestrationReflectionError('Reflection 文件不存在');
  const reflection = readAndValidateReflection(reflectionPath, 'orchestrate-subagents', parseJsonStrict, envelopeDigest);
  verifyEvidenceRefs(root, reflection.evidence_refs, parseJsonStrict, canonicalJson);
  const value = buildProposal({ input, reflections: [reflection], skill: reflection.affected_skill, envelopeDigest });
  mkdirSync(join(root, 'proposals'), { recursive: true, mode: 0o700 });
  const ref = `proposals/${value.proposal_id}.json`;
  writeNewJson(join(root, ref), value);
  return { proposal_id: value.proposal_id, proposal_digest: value.proposal_digest, lifecycle: 'proposed', ref };
}

function parseCli(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!['--state-root', '--input', '--reflection'].includes(token) || argv[index + 1] === undefined || argv[index + 1].startsWith('--')) throw new OrchestrationReflectionError(`unknown or incomplete option: ${token}`);
    options[token.slice(2)] = argv[++index];
  }
  return { command, options };
}

export function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  if (command === 'capabilities') return { skill: 'orchestrate-subagents', protocol_version: ORCHESTRATION_PROTOCOL_VERSION, runtime_version: RUNTIME_VERSION, contracts: { reflection_record: [1], improvement_proposal: [1] }, modes: ['lightweight', 'full-reference'], content_digest: skillContentDigest() };
  if (!options['state-root']) throw new OrchestrationReflectionError('缺少 --state-root');
  if (command === 'record') {
    if (!options.input) throw new OrchestrationReflectionError('record requires --input');
    try { return recordStandalone(options['state-root'], readJson(options.input)); } catch (error) { throw error instanceof OrchestrationReflectionError ? error : new OrchestrationReflectionError(error.message); }
  }
  if (command === 'propose') {
    if (!options.reflection || !options.input) throw new OrchestrationReflectionError('propose requires --reflection and --input');
    try { return proposeStandalone(options['state-root'], options.reflection, readJson(options.input)); } catch (error) { throw error instanceof OrchestrationReflectionError ? error : new OrchestrationReflectionError(error.message); }
  }
  throw new OrchestrationReflectionError('command must be capabilities, record, or propose');
}

function entry() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(resolvePath(process.argv[1] ?? '')).href === import.meta.url;
  }
}

if (entry()) {
  try {
    process.stdout.write(`${JSON.stringify(main(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`orchestration reflection error: ${error.message}\n`);
    process.exit(error instanceof OrchestrationReflectionError ? 2 : 3);
  }
}
