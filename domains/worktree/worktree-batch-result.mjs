// @ts-check

/**
 * @param {Record<string, any>} deps
 */
export function createCommands(deps) {
  const {
    existsSync,
    readFileSync,
    resolve,
    loadRepositoryProfile,
    DIGEST_PATTERN,
    contentDigest,
    log,
    die,
    flag,
    rejectUnknownFlags,
    oneLine,
    loadRecords,
    selectRecord,
    liveGitSnapshot,
    updateRecord,
    canonicalJson,
    exactCommitOid,
    gitOperationState,
    isAncestor,
  } = deps;

  function plainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) die(`${label} 必须是 JSON object。`, 2);
    return /** @type {Record<string,any>} */ (value);
  }

  /** @param {Record<string,any>} value @param {string[]} allowed @param {string} label */
  function rejectUnknownJsonKeys(value, allowed, label) {
    const allow = new Set(allowed);
    const unknown = Object.keys(value).filter((key) => !allow.has(key));
    if (unknown.length) die(`${label} 包含未知字段: ${unknown.join(', ')}。`, 2);
  }

  /**
   * 批次证据只冻结可审计摘要，不接收原始日志、环境变量或凭证。
   * @param {string} path
   */
  function readBatchEvidenceFile(path) {
    if (!existsSync(path)) die(`--evidence 文件不存在: ${path}`, 2);
    const bytes = readFileSync(path);
    if (bytes.length > 128 * 1024) die('--evidence 最大 128 KiB；原始日志应放在外部证据存储。', 2);
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch (error) {
      die(`--evidence 文件不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`, 2);
    }
    const root = plainObject(parsed, '--evidence 根节点');
    rejectUnknownJsonKeys(root, ['schema_version', 'contract_digest', 'checks'], '--evidence');
    if (root.schema_version !== 1) die('--evidence schema_version 必须是 1。', 2);
    if (root.contract_digest !== undefined && root.contract_digest !== null && !DIGEST_PATTERN.test(root.contract_digest)) {
      die('--evidence contract_digest 必须是 sha256 digest 或 null。', 2);
    }
    if (!Array.isArray(root.checks) || root.checks.length === 0 || root.checks.length > 100) {
      die('--evidence checks 必须包含 1-100 项。', 2);
    }
    const names = new Set();
    const checks = root.checks.map((raw, index) => {
      const check = plainObject(raw, `checks[${index}]`);
      rejectUnknownJsonKeys(check, ['name', 'environment', 'argv', 'outcome', 'exit_code', 'evidence_refs'], `checks[${index}]`);
      const name = oneLine(String(check.name ?? ''), `checks[${index}].name`, 120);
      if (names.has(name)) die(`--evidence check name 重复: ${name}`, 2);
      names.add(name);
      const environment = plainObject(check.environment, `checks[${index}].environment`);
      const environmentEntries = Object.entries(environment);
      if (environmentEntries.length > 50 || environmentEntries.some(([key, value]) => (
        !/^[a-z][a-z0-9_.-]{0,63}$/u.test(key) ||
        /(?:secret|token|password|credential|private[_-]?key|api[_-]?key)/u.test(key) ||
        !['string', 'number', 'boolean'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value)) ||
        (typeof value === 'string' && (value.length > 500 || /[\u0000\r\n]/u.test(value)))
      ))) {
        die(`checks[${index}].environment 只接受不含敏感键的有界标量元数据。`, 2);
      }
      if (!Array.isArray(check.argv) || check.argv.length === 0 || check.argv.length > 100 || check.argv.some((item) => typeof item !== 'string' || !item || item.length > 1000 || /[\u0000\r\n]/u.test(item))) {
        die(`checks[${index}].argv 必须是 1-100 个安全字符串组成的 argv。`, 2);
      }
      if (!['passed', 'failed', 'undecidable'].includes(check.outcome)) {
        die(`checks[${index}].outcome 只接受 passed / failed / undecidable。`, 2);
      }
      if (!Number.isInteger(check.exit_code) || check.exit_code < 0 || check.exit_code > 255) {
        die(`checks[${index}].exit_code 必须是 0-255 整数。`, 2);
      }
      if (check.outcome === 'passed' && check.exit_code !== 0) die(`checks[${index}] passed 时 exit_code 必须为 0。`, 2);
      if (check.outcome === 'failed' && check.exit_code === 0) die(`checks[${index}] failed 时 exit_code 不能为 0。`, 2);
      if (!Array.isArray(check.evidence_refs) || check.evidence_refs.length === 0 || check.evidence_refs.length > 20) {
        die(`checks[${index}].evidence_refs 必须包含 1-20 项。`, 2);
      }
      const evidenceRefs = check.evidence_refs.map((rawRef, refIndex) => {
        const ref = plainObject(rawRef, `checks[${index}].evidence_refs[${refIndex}]`);
        rejectUnknownJsonKeys(ref, ['kind', 'id', 'digest'], `checks[${index}].evidence_refs[${refIndex}]`);
        const kind = oneLine(String(ref.kind ?? ''), 'evidence kind', 40);
        const id = oneLine(String(ref.id ?? ''), 'evidence id', 1000);
        if (!DIGEST_PATTERN.test(ref.digest ?? '')) die(`checks[${index}].evidence_refs[${refIndex}].digest 必须是 sha256 digest。`, 2);
        return { kind, id, digest: ref.digest };
      });
      return { name, environment: canonicalJson(environment), argv: check.argv, outcome: check.outcome, exit_code: check.exit_code, evidence_refs: evidenceRefs };
    });
    const manifest = canonicalJson({ schema_version: 1, contract_digest: root.contract_digest ?? null, checks });
    return { manifest, digest: contentDigest(Buffer.from(JSON.stringify(manifest))) };
  }

  /**
   * 登记 Profile 声明的合成后步骤的执行结果。工具只记录 controller 的回报，从不代跑。
   * @param {{positionals:string[],flags:Map<string,unknown>}} args
   */
  function cmdBatchStep(args) {
    rejectUnknownFlags(args.flags, ['step', 'state', 'note', 'id', 'json', 'config']);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
    const stepName = flag(args.flags, 'step');
    const state = flag(args.flags, 'state');
    if (!stepName) die('batch-step 需要 --step <name>。', 2);
    if (!['done', 'skipped', 'failed'].includes(state ?? '')) die('--state 只接受 done / skipped / failed。', 2);
    const batch = record.batch_integration;
    if (!batch || batch.state !== 'composed') die(`${record.task} 不是已合成的集成候选，无法登记合成后步骤。`);
    if (record.batch_result) die('batch_result 已冻结，不能再修改合成后步骤。', 2);
    const steps = batch.post_integrate_steps ?? [];
    const target = steps.find((step) => step.name === stepName);
    if (!target) {
      die(
        `未声明的步骤名: ${stepName}；当前候选只登记 Profile 声明过的步骤` +
        `${steps.length ? `：${steps.map((step) => step.name).join(', ')}` : '（该 Profile 未声明任何步骤）'}。`,
        2,
      );
    }
    const note = flag(args.flags, 'note') ? oneLine(flag(args.flags, 'note'), 'note', 240) : null;
    const now = new Date().toISOString();
    const updated = updateRecord(record, 'batch_post_step_recorded', (next) => {
      const step = next.batch_integration.post_integrate_steps.find((item) => item.name === stepName);
      step.state = state;
      step.note = note;
      step.recorded_at = now;
      next.last_seen_at = now;
    }, { step: stepName, state, note, fingerprint: batch.fingerprint }, loaded.context.common_dir);
    const recorded = updated.batch_integration.post_integrate_steps;
    if (args.flags.get('json')) {
      console.log(JSON.stringify({ schema_version: 1, worktree_id: updated.worktree_id, post_integrate_steps: recorded }, null, 2));
      return;
    }
    log(`已登记 ${stepName} -> ${state}`);
    const pending = recorded.filter((step) => step.state === 'pending');
    console.log(pending.length === 0
      ? '  合成后步骤已全部登记。'
      : `  仍待登记: ${pending.map((step) => step.name).join(', ')}`);
  }

  /**
   * 冻结一次性集成候选的终态验收结果。结果不可覆盖；新 target/input/contract 必须另起候选。
   * @param {{positionals:string[],flags:Map<string,unknown>}} args
   */
  function cmdBatchResult(args) {
    rejectUnknownFlags(args.flags, ['state', 'candidate', 'evidence', 'reason', 'id', 'json', 'config']);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    let record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
    const outcome = flag(args.flags, 'state');
    if (!['passed', 'failed', 'stale'].includes(outcome ?? '')) die('--state 只接受 passed / failed / stale。', 2);
    const candidateInput = flag(args.flags, 'candidate');
    if (!candidateInput) die('batch-result 需要 --candidate <exact-object-id>。', 2);
    const candidateSha = exactCommitOid(loaded.context.current_worktree, candidateInput, '--candidate');
    const evidencePath = flag(args.flags, 'evidence');
    if (outcome !== 'stale' && !evidencePath) die(`${outcome} 结果需要 --evidence <json>。`, 2);
    const evidence = evidencePath ? readBatchEvidenceFile(resolve(evidencePath)) : null;
    const reason = flag(args.flags, 'reason') ? oneLine(flag(args.flags, 'reason'), '--reason', 500) : null;
    if (outcome === 'stale' && !reason) die('stale 结果需要 --reason <原因>。', 2);
    if (outcome !== 'stale' && !evidence.manifest.contract_digest) {
      die(`${outcome} 结果的 Evidence 必须提供非空 contract_digest；合同变化必须另起候选。`, 2);
    }
    if (outcome === 'passed' && evidence.manifest.checks.some((check) => check.outcome !== 'passed')) {
      die('passed 结果要求所有 evidence checks 都为 passed。', 2);
    }
    if (outcome === 'failed' && !evidence.manifest.checks.some((check) => check.outcome === 'failed')) {
      die('failed 结果至少需要一个 failed evidence check。', 2);
    }
    const batch = record.batch_integration;
    if (!batch || batch.state !== 'composed') die(`${record.task} 不是已合成的集成候选。`, 2);
    if (!['integrating', 'done'].includes(record.task_status)) die(`batch-result 不接受 ${record.task_status} 候选。`, 2);
    const requested = canonicalJson({
      schema_version: 1,
      outcome,
      candidate_sha: candidateSha,
      fingerprint: batch.fingerprint,
      target_ref: batch.target_ref,
      target_sha: batch.target_sha,
      ordered_input_shas: (batch.ordered_inputs ?? []).map((item) => item.head),
      evidence_manifest_digest: evidence?.digest ?? null,
      evidence_manifest: evidence?.manifest ?? null,
      reason,
    });
    const requestedDigest = contentDigest(Buffer.from(JSON.stringify(requested)));
    if (record.batch_result) {
      if (record.batch_result.result_digest !== requestedDigest) die('batch_result 已冻结且与本次输入不同；不得覆盖终态结果。', 2);
      if (args.flags.get('json')) console.log(JSON.stringify(record.batch_result, null, 2));
      else log(`批次结果已冻结（幂等） ${record.task} ${outcome} ${candidateSha.slice(0, 12)}`);
      return;
    }
    if (record.worktree_state !== 'present') die(`batch-result 只接受 present 候选；当前 ${record.worktree_state}。`, 2);
    const live = liveGitSnapshot(record);
    if (!live.present) die(`候选 worktree missing: ${record.path}`, 2);
    if (live.dirty !== false) die(`候选 worktree 必须干净：${record.path}`, 2);
    const operation = gitOperationState(record.path);
    if (operation) die(`候选仍处于 ${operation} 中间态，拒绝冻结结果。`, 2);
    if (live.head?.toLowerCase() !== candidateSha) die(`--candidate 与 live HEAD 不一致：expected ${live.head}`, 2);
    if (!isAncestor(record.path, batch.composed_sha, candidateSha)) {
      die(`candidate SHA 不是 composed_sha ${batch.composed_sha} 的后继，拒绝冻结。`, 2);
    }
    if (outcome === 'passed') {
      const incomplete = (batch.post_integrate_steps ?? []).filter((step) => !['done', 'skipped'].includes(step.state));
      if (incomplete.length) die(`passed 前仍有未通过的合成后步骤: ${incomplete.map((step) => `${step.name}=${step.state}`).join(', ')}`, 2);
    }
    const recordedAt = new Date().toISOString();
    record = updateRecord(record, 'batch_result_recorded', (next) => {
      next.batch_result = { ...requested, result_digest: requestedDigest, recorded_at: recordedAt };
      next.task_status = 'done';
      next.last_head = candidateSha;
      next.last_seen_at = recordedAt;
    }, {
      outcome,
      candidate_sha: candidateSha,
      fingerprint: batch.fingerprint,
      result_digest: requestedDigest,
      evidence_manifest_digest: evidence?.digest ?? null,
      reason,
    }, loaded.context.common_dir);
    if (args.flags.get('json')) console.log(JSON.stringify(record.batch_result, null, 2));
    else log(`已冻结批次结果 ${record.task} ${outcome} sha=${candidateSha.slice(0, 12)} evidence=${evidence?.digest ?? 'none'}`);
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded */


  return {
    cmdBatchStep,
    cmdBatchResult,
  };
}
