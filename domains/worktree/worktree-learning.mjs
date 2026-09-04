// @ts-check

/**
 * Domain command factory. Dependencies are injected once by the thin CLI composition root,
 * keeping this module acyclic and independently reviewable.
 * @param {Record<string, any>} deps
 */
export function createCommands(deps) {
  const {
    randomUUID,
    existsSync,
    mkdirSync,
    writeFileSync,
    join,
    resolve,
    loadRepositoryProfile,
    readEventChain,
    traceLayout,
    DIGEST_PATTERN,
    contentDigest,
    worktreeSkillDigest,
    die,
    flag,
    readJsonFileOrDie,
    rejectUnknownFlags,
    oneLine,
    canonicalJson,
    worktreeEnvelopeContext,
  } = deps;

  function sanitizeLearningText(value) {
    return oneLine(String(value ?? '').replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]').replace(/\/(?:Users|home)\/[^\s"']+/gu, '[LOCAL_PATH]'), 'reflection text', 1000);
  }

  function learningRoot(commonDir) {
    return join(traceLayout(commonDir).root, 'learning');
  }

  function cmdIncident(args) {
    rejectUnknownFlags(args.flags, ['input', 'id', 'config']);
    const inputPath = flag(args.flags, 'input');
    if (!inputPath) die('incident 需要 --input <json>。', 2);
    const { loaded, record } = worktreeEnvelopeContext(args);
    const input = readJsonFileOrDie(resolve(inputPath), 'incident --input 文件');
    if (!DIGEST_PATTERN.test(String(input.contract_digest ?? ''))) die('incident contract_digest 无效。', 2);
    if (!['contract_gap', 'skill_gap', 'verification_gap', 'tool_gap', 'environment_gap', 'false_positive', 'false_negative', 'inefficiency'].includes(input.classification)) die('incident classification 无效。', 2);
    const chain = readEventChain(loaded.context.common_dir, record.worktree_id);
    const latest = chain.at(-1);
    if (!latest) die('worktree record 没有可引用事件。', 2);
    const eventDigest = contentDigest(Buffer.from(JSON.stringify(canonicalJson(latest))));
    const reflection = {
      schema_version: 1,
      reflection_id: randomUUID(),
      trigger: input.trigger ?? 'unexpected_outcome',
      scope: { contract_digest: input.contract_digest },
      affected_skill: { name: 'manage-worktrees', version: 'unversioned', content_digest: worktreeSkillDigest() },
      classification: input.classification,
      observation: sanitizeLearningText(input.observation),
      evidence_refs: [{ type: 'event', id: `${record.worktree_id}:${latest.event_id}`, digest: eventDigest }],
      impact: input.impact ?? 'medium',
      confidence: input.confidence ?? 'high',
      recommended_disposition: input.recommended_disposition ?? 'continue',
      recorded_at: new Date().toISOString(),
    };
    reflection.reflection_digest = contentDigest(Buffer.from(JSON.stringify(canonicalJson(reflection))));
    const directory = join(learningRoot(loaded.context.common_dir), 'reflections');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${reflection.reflection_id}.json`);
    writeFileSync(path, `${JSON.stringify(reflection, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ reflection, ref: path }, null, 2));
  }

  function cmdProposeImprovement(args) {
    rejectUnknownFlags(args.flags, ['reflection', 'input', 'config']);
    const reflectionId = flag(args.flags, 'reflection');
    const inputPath = flag(args.flags, 'input');
    if (!reflectionId || !inputPath || !/^[0-9a-f-]{36}$/iu.test(reflectionId)) die('propose-improvement 需要 --reflection <uuid> --input <json>。', 2);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const reflectionPath = join(learningRoot(loaded.context.common_dir), 'reflections', `${reflectionId}.json`);
    if (!existsSync(reflectionPath)) die('Reflection 不存在。', 2);
    const reflection = readJsonFileOrDie(reflectionPath, 'Reflection 文件');
    const input = readJsonFileOrDie(resolve(inputPath), 'propose-improvement --input 文件');
    if (!reflection.evidence_refs?.length) die('Proposal 必须来自有证据的 Reflection。', 2);
    const proposal = {
      schema_version: 1,
      proposal_id: randomUUID(),
      target_skill: { name: 'manage-worktrees', based_on_version: 'unversioned', based_on_digest: reflection.affected_skill.content_digest },
      source_reflections: [{ reflection_id: reflection.reflection_id, reflection_digest: reflection.reflection_digest }],
      problem: { type: input.problem_type ?? 'skill_gap', evidence_refs: reflection.evidence_refs },
      proposed_change: sanitizeLearningText(input.proposed_change),
      affected_scope: (input.affected_scope ?? []).map(sanitizeLearningText),
      counterexamples: (input.counterexamples ?? []).map(sanitizeLearningText),
      validation_plan: { replay_cases: input.validation_plan?.replay_cases ?? [], regression_suites: input.validation_plan?.regression_suites ?? [], independent_review: 'required', ...(input.validation_plan?.canary ? { canary: input.validation_plan.canary } : {}) },
      lifecycle: 'proposed',
    };
    proposal.proposal_digest = contentDigest(Buffer.from(JSON.stringify(canonicalJson(proposal))));
    const directory = join(learningRoot(loaded.context.common_dir), 'proposals');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${proposal.proposal_id}.json`);
    writeFileSync(path, `${JSON.stringify(proposal, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ proposal, ref: path }, null, 2));
  }


  return {
    learningRoot,
    cmdIncident,
    cmdProposeImprovement,
  };
}
