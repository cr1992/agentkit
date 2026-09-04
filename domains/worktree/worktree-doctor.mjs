// @ts-check

/**
 * Domain command factory. Dependencies are injected once by the thin CLI composition root,
 * keeping this module acyclic and independently reviewable.
 * @param {Record<string, any>} deps
 */
export function createCommands(deps) {
  const {
    existsSync,
    readFileSync,
    readdirSync,
    join,
    PROFILE_FILENAME,
    WorktreeProfileError,
    classifyStorage,
    loadRepositoryProfile,
    validateTaskNaming,
    inspectRecordLock,
    listRecordCacheEntries,
    readEventChain,
    traceLayout,
    gitTry,
    contentDigest,
    watcherPath,
    readWatcherHeartbeat,
    watcherHealth,
    log,
    flag,
    rejectUnknownFlags,
    canonicalSelectorPath,
    canonicalJson,
    gitOperationState,
    primaryProfileDriftFinding,
    buildListing,
    learningRoot,
    isSettledWorktreeState,
  } = deps;

  function collectDoctorRecordMetadataFindings(loaded, listing, recordsById, record, findings) {
    if (record.storage_class === 'ephemeral' && record.worktree_state !== 'reclaimed') findings.push({ code: 'EPHEMERAL_WORKTREE', severity: 'warning', worktree_id: record.worktree_id, path: record.path });
    if (record.history_operation) {
      findings.push({
        code: 'MANAGED_HISTORY_OPERATION_PENDING',
        severity: 'error',
        worktree_id: record.worktree_id,
        path: record.path,
        operation: record.history_operation.kind ?? 'unknown',
        state: record.history_operation.state ?? 'unknown',
        token: record.history_operation.token ?? null,
        detail: '受控历史操作尚未 finalize；用 selector + rebase --continue 恢复（可选参数若提供会校验一致性），或显式 --abort。',
      });
    }
    if (record.review_refresh) {
      findings.push({
        code: 'REVIEW_REFRESH_PENDING',
        severity: 'error',
        worktree_id: record.worktree_id,
        path: record.path,
        state: record.review_refresh.state ?? 'unknown',
        target_ref: record.review_refresh.target_ref ?? null,
        target_sha: record.review_refresh.target_sha ?? null,
        detail: record.review_refresh.state === 'aborting'
          ? `评审刷新正在回滚；运行 refresh-review ${record.task} --abort 收口。`
          : `评审刷新尚未完成；运行 refresh-review ${record.task} --continue 恢复，或在冲突/暂停 push 状态用 --abort 放弃。`,
      });
    }
    if (record.stack_parent) {
      const parent = recordsById.get(record.stack_parent.worktree_id);
      if (!parent) {
        findings.push({
          code: 'STACK_PARENT_MISSING',
          severity: 'error',
          worktree_id: record.worktree_id,
          parent_worktree_id: record.stack_parent.worktree_id,
          detail: '堆叠父记录不存在，无法证明 base attribution。',
        });
      } else {
        if (parent.branch !== record.stack_parent.branch) {
          findings.push({
            code: 'STACK_PARENT_BRANCH_MISMATCH',
            severity: 'error',
            worktree_id: record.worktree_id,
            parent_worktree_id: parent.worktree_id,
            recorded_branch: record.stack_parent.branch,
            current_branch: parent.branch,
          });
        }
        const parentRow = listing.rows.find((row) => row.record?.worktree_id === parent.worktree_id);
        const parentHead = parentRow?.head ?? parent.last_head ?? null;
        if (parentHead && parentHead !== record.stack_parent.parent_head_sha) {
          findings.push({
            code: 'STACK_PARENT_ADVANCED',
            severity: 'warning',
            worktree_id: record.worktree_id,
            parent_worktree_id: parent.worktree_id,
            recorded_parent_head: record.stack_parent.parent_head_sha,
            current_parent_head: parentHead,
            detail: '父任务 HEAD 已前进；根据新目标选择 managed rebase 或 retarget。',
          });
        }
      }
    }
    if (
      record.worktree_state !== 'reclaimed' &&
      loaded.profile.default_base &&
      record.base_ref &&
      record.base_ref !== loaded.profile.default_base
    ) {
      findings.push({
        code: 'BASE_OVERRIDE',
        severity: 'warning',
        worktree_id: record.worktree_id,
        path: record.path,
        base_ref: record.base_ref,
        default_base: loaded.profile.default_base,
        base_reason: record.base_reason ?? null,
        detail: record.base_reason ? `非默认基线：${record.base_reason}` : '非默认基线未记录原因（legacy record）。',
      });
    }
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {ReturnType<typeof buildListing>} listing @param {Record<string,any>} record @param {Record<string,any>[]} findings */
  function collectDoctorRecordLifecycleFindings(loaded, listing, record, findings) {
    const present = listing.rows.some((row) => row.path === canonicalSelectorPath(record.path));
    const liveRow = listing.rows.find((row) => row.path === canonicalSelectorPath(record.path));
    if (present && record.batch_integration?.state === 'composed' && record.task_status === 'done' && !record.batch_result) {
      findings.push({
        code: 'DONE_BATCH_CANDIDATE_RESULT_UNRECORDED',
        severity: 'warning',
        worktree_id: record.worktree_id,
        path: record.path,
        candidate_sha: liveRow?.head ?? record.last_head ?? null,
        detail: `候选已标记 done，但 passed/failed/stale 尚未冻结；运行 batch-result ${record.task} --state <state> --candidate <exact-sha>。`,
      });
    }
    if (present && record.task_status === 'done' && ['passed', 'failed', 'stale'].includes(record.batch_result?.outcome)) {
      const candidateSha = record.batch_result.candidate_sha;
      findings.push({
        code: 'DONE_EVIDENCE_WORKTREE_RECLAIM_PENDING',
        severity: 'warning',
        worktree_id: record.worktree_id,
        path: record.path,
        candidate_sha: candidateSha,
        archive_ref: record.evidence_archive?.archive_ref ?? null,
        detail: `固定验收候选仍占用 worktree；运行 reclaim ${record.task} --archive-evidence ${candidateSha} --reason <原因>。`,
      });
    }
    if (present && record.worktree_state !== 'reclaimed' && record.task_status === 'abandoned') {
      findings.push({
        code: record.superseded_by ? 'SUPERSEDED_WORKTREE_RECLAIM_PENDING' : 'ABANDONED_WORKTREE_RECLAIM_PENDING',
        severity: 'warning',
        worktree_id: record.worktree_id,
        path: record.path,
        replacement_worktree_id: record.superseded_by?.worktree_id ?? null,
        detail: record.superseded_by
          ? '被替代 worktree 仍占用目录；保存独有提交后应执行 reclaim --superseded-by。'
          : 'abandoned 只冻结任务，不会回收目录；补登记 supersede 关系或使用已有 pushed 证据回收。',
      });
    }
    if (liveRow && record.worktree_state !== 'reclaimed') {
      const operation = gitOperationState(record.path);
      if (operation) {
        findings.push({
          code: 'GIT_OPERATION_IN_PROGRESS',
          severity: 'error',
          worktree_id: record.worktree_id,
          path: record.path,
          detail: `检测到 ${operation}；禁止把该树作为交付或批次验收输入。`,
        });
      }
      if (record.branch && liveRow.branch !== record.branch) {
        findings.push({
          code: 'LIVE_BRANCH_MISMATCH',
          severity: 'error',
          worktree_id: record.worktree_id,
          path: record.path,
          recorded_branch: record.branch,
          live_branch: liveRow.branch,
        });
      }
      if (record.last_head && liveRow.head && record.last_head !== liveRow.head) {
        findings.push({
          code: 'HEAD_DRIFT',
          severity: ['ready_for_review', 'integrating'].includes(record.task_status) ? 'error' : 'warning',
          worktree_id: record.worktree_id,
          path: record.path,
          recorded_head: record.last_head,
          live_head: liveRow.head,
          detail: 'live HEAD 与最后登记 SHA 不一致；先 touch/audit 并重新确认交付边界。',
        });
      }
      if (liveRow.dirty === true && ['ready_for_review', 'integrating'].includes(record.task_status)) {
        findings.push({
          code: 'REVIEW_STATE_DIRTY',
          severity: 'error',
          worktree_id: record.worktree_id,
          path: record.path,
          task_status: record.task_status,
          detail: 'ready_for_review/integrating worktree 必须保持干净；当前验收边界已失效。',
        });
      }
    }
    if (record.worktree_state === 'reclaim_ready') {
      findings.push({
        code: 'RECLAIM_INTERRUPTED',
        severity: 'warning',
        worktree_id: record.worktree_id,
        path: record.path,
        phase: present ? 'before_remove' : 'after_remove',
        last_reclaim_error: record.last_reclaim_error ?? null,
      });
    } else if (!present && record.worktree_state !== 'reclaimed') {
      findings.push({ code: 'WORKTREE_MISSING', severity: 'warning', worktree_id: record.worktree_id, path: record.path });
    }
    if (present && record.worktree_state === 'reclaimed') {
      const reusedByNewerRecord = listing.records.some((candidate) =>
        candidate.worktree_id !== record.worktree_id &&
        candidate.worktree_state !== 'reclaimed' &&
        canonicalSelectorPath(candidate.path) === canonicalSelectorPath(record.path) &&
        String(candidate.created_at) > String(record.created_at),
      );
      if (!reusedByNewerRecord) findings.push({ code: 'RECLAIMED_PATH_CONFLICT', severity: 'error', worktree_id: record.worktree_id, path: record.path });
    }
    if (record.worktree_state === 'reclaimed') {
      const branchExists = Boolean(record.branch) && gitTry(
        ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`],
        loaded.context.current_worktree,
      ).ok;
      if (record.branch_cleanup?.status === 'failed' || branchExists) {
        findings.push({
          code: 'LOCAL_BRANCH_CLEANUP_FAILED',
          severity: 'warning',
          worktree_id: record.worktree_id,
          branch: record.branch ?? null,
          status: record.branch_cleanup?.status ?? 'legacy',
          branch_exists: branchExists,
          detail: record.branch_cleanup?.reason ?? (branchExists ? 'local branch ref still exists' : 'cleanup failure not reconciled'),
        });
      }
    }
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {Record<string,any>[]} findings */
  function collectDoctorRecordWatcherFindings(loaded, record, findings) {
    if (record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state) && record.worktree_state !== 'reclaimed') {
      const heartbeat = readWatcherHeartbeat(loaded.context.common_dir, record.worktree_id);
      const health = watcherHealth(record, heartbeat);
      const advance = record.auto_reclaim.target_advance;
      if (advance) {
        const prediction = advance.prediction?.state ?? 'unknown';
        findings.push({
          code: prediction === 'conflict'
            ? 'REBASE_NEEDED'
            : prediction === 'clean'
              ? 'TARGET_ADVANCED_REFRESH_CLEAN'
              : 'TARGET_ADVANCED_PREDICTION_UNKNOWN',
          severity: 'warning',
          worktree_id: record.worktree_id,
          path: record.path,
          target_ref: record.auto_reclaim.target_ref,
          target_sha: advance.target_sha,
          recorded_base_sha: advance.recorded_base_sha,
          prediction: advance.prediction,
          detail: prediction === 'conflict'
            ? `目标已前进且 merge-tree 预判冲突；预留人工解冲突时间后运行 refresh-review ${record.task}。`
            : prediction === 'clean'
              ? `目标已前进且 merge-tree 干跑无冲突；可运行 refresh-review ${record.task}。`
              : `目标已前进但无法可靠预判；核对后运行 refresh-review ${record.task}。`,
        });
      }
      if (!health.healthy) {
        findings.push({
          code: 'AUTO_RECLAIM_WATCHER_STALE',
          severity: 'error',
          worktree_id: record.worktree_id,
          path: watcherPath(loaded.context.common_dir, record.worktree_id),
          detail: health.reason,
        });
      } else if (heartbeat.state?.blocked_reason && !advance) {
        findings.push({
          code: 'AUTO_RECLAIM_BLOCKED',
          severity: 'warning',
          worktree_id: record.worktree_id,
          detail: heartbeat.state.blocked_reason,
        });
      }
    }
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {ReturnType<typeof buildListing>} listing @param {Map<string,Record<string,any>>} recordsById @param {Record<string,any>[]} findings */
  function collectDoctorRecordFindings(loaded, listing, recordsById, findings) {
    for (const entry of listRecordCacheEntries(loaded.context.common_dir)) {
      if (entry.error) { findings.push({ code: 'RECORD_CACHE_INVALID', severity: 'error', path: entry.path, detail: entry.error }); continue; }
      const record = entry.record;
      try { readEventChain(loaded.context.common_dir, record.worktree_id); } catch (error) { findings.push({ code: error.code ?? 'EVENT_CHAIN_INVALID', severity: 'error', worktree_id: record.worktree_id, detail: error.message }); }
      // archived 是"已经确认安全、停止刷屏"的历史 record：event chain / record cache 完整性仍然
      // 检查（上面两步），但命名 DoD 与全部生命周期/元数据/watcher finding 一律不再生成——
      // 这些都是"这条 worktree 还要不要处理"的提示，archive 已经回答过这个问题。
      if (record.worktree_state === 'archived') continue;
      if (record.worktree_state !== 'reclaimed') {
        try {
          validateTaskNaming(record.task, loaded.profile.task_naming);
        } catch (error) {
          findings.push({
            code: error instanceof WorktreeProfileError ? error.code : 'TASK_NAMING_DOD_FAILED',
            severity: 'error',
            worktree_id: record.worktree_id,
            path: record.path,
            task: record.task,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      collectDoctorRecordMetadataFindings(loaded, listing, recordsById, record, findings);
      collectDoctorRecordLifecycleFindings(loaded, listing, record, findings);
      collectDoctorRecordWatcherFindings(loaded, record, findings);
    }
  }


  /** @param {ReturnType<typeof buildListing>} listing @param {Record<string,any>[]} findings */
  function collectDoctorSupersessionFindings(listing, findings) {
    const relationPairs = new Map();
    for (const record of listing.records) {
      if (record.delivery_relation?.kind === 'supersedes' && record.delivery_relation.superseded_worktree_id) {
        const oldId = record.delivery_relation.superseded_worktree_id;
        relationPairs.set(`${oldId}\u0000${record.worktree_id}`, { oldId, replacementId: record.worktree_id });
      }
      if (record.superseded_by?.worktree_id) {
        const replacementId = record.superseded_by.worktree_id;
        relationPairs.set(`${record.worktree_id}\u0000${replacementId}`, { oldId: record.worktree_id, replacementId });
      }
    }
    for (const { oldId, replacementId } of relationPairs.values()) {
      const oldRecord = listing.records.find((record) => record.worktree_id === oldId);
      const replacement = listing.records.find((record) => record.worktree_id === replacementId);
      const reciprocal = Boolean(
        oldRecord &&
        replacement &&
        oldRecord.superseded_by?.worktree_id === replacementId &&
        replacement.delivery_relation?.kind === 'supersedes' &&
        replacement.delivery_relation.superseded_worktree_id === oldId &&
        replacement.delivery_relation.related_worktree_ids?.includes(oldId),
      );
      if (!reciprocal) {
        findings.push({
          code: 'SUPERSESSION_RELATION_BROKEN',
          severity: 'error',
          worktree_id: oldId,
          replacement_worktree_id: replacementId,
          detail: 'superseded_by 与 delivery_relation 必须双向一致；使用 supersede 命令补齐后再回收。',
        });
      }
    }
  }

  /** @param {ReturnType<typeof buildListing>} listing @param {Record<string,any>[]} findings */
  function collectDoctorSessionFindings(listing, findings) {
    const unreclaimedBySession = new Map();
    for (const record of listing.records.filter((candidate) => !isSettledWorktreeState(candidate.worktree_state))) {
      const key = `${record.agent?.host ?? 'unknown'}\u0000${record.agent?.id ?? 'unknown'}`;
      const group = unreclaimedBySession.get(key) ?? [];
      group.push(record);
      unreclaimedBySession.set(key, group);
    }
    for (const group of unreclaimedBySession.values()) {
      if (group.length < 2) continue;
      const ordered = [...group].sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
      const earlierIds = new Set();
      const undeclared = [];
      for (const record of ordered) {
        const related = record.delivery_relation?.related_worktree_ids ?? [];
        if (earlierIds.size > 0 && !related.some((id) => earlierIds.has(id))) undeclared.push(record);
        earlierIds.add(record.worktree_id);
      }
      if (undeclared.length > 0) {
        findings.push({
          code: 'UNDECLARED_SESSION_WORKTREE_MULTIPLICITY',
          severity: 'warning',
          agent: ordered[0].agent,
          worktree_ids: ordered.map((record) => record.worktree_id),
          tasks: ordered.map((record) => record.task),
          undeclared_worktree_ids: undeclared.map((record) => record.worktree_id),
          detail: '同一 Agent 会话存在多棵未回收 worktree，且后建树未声明 parallel/supersedes 关系；复查是否应复用或回收。',
        });
      }
    }
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>[]} findings */
  function collectDoctorRuntimeFindings(loaded, findings) {
    const locks = traceLayout(loaded.context.common_dir).locks;
    if (existsSync(locks)) for (const name of readdirSync(locks)) if (name.endsWith('.lock')) {
      const id = name.slice(0, -5); const finding = inspectRecordLock(loaded.context.common_dir, id);
      if (finding.state === 'stale' || finding.state === 'malformed') findings.push({ code: `LOCK_${finding.state.toUpperCase()}`, severity: 'error', worktree_id: id, detail: finding });
    }
    if (loaded.context.current_worktree !== loaded.context.primary_worktree) {
      const local = join(loaded.context.current_worktree, PROFILE_FILENAME);
      if (existsSync(local) && existsSync(loaded.profile_path) && readFileSync(local, 'utf8') !== readFileSync(loaded.profile_path, 'utf8')) findings.push({ code: 'PROFILE_DRIFT', severity: 'warning', path: local, authoritative: loaded.profile_path });
    }
    const learning = learningRoot(loaded.context.common_dir);
    const reflectionById = new Map();
    const reflectionDir = join(learning, 'reflections');
    if (existsSync(reflectionDir)) for (const name of readdirSync(reflectionDir).filter((item) => item.endsWith('.json'))) {
      const path = join(reflectionDir, name);
      try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        const clone = { ...value }; delete clone.reflection_digest;
        if (contentDigest(Buffer.from(JSON.stringify(canonicalJson(clone)))) !== value.reflection_digest) throw new Error('reflection digest mismatch');
        const eventRef = value.evidence_refs?.find((item) => item.type === 'event');
        const match = /^([^:]+):(.+)$/u.exec(eventRef?.id ?? '');
        if (!match) throw new Error('event ref invalid');
        const event = readEventChain(loaded.context.common_dir, match[1]).find((item) => item.event_id === match[2]);
        if (!event || contentDigest(Buffer.from(JSON.stringify(canonicalJson(event)))) !== eventRef.digest) throw new Error('event evidence digest mismatch');
        reflectionById.set(value.reflection_id, value);
      } catch (error) {
        findings.push({ code: 'LEARNING_REFLECTION_INVALID', severity: 'error', path, detail: error instanceof Error ? error.message : String(error) });
      }
    }
    const proposalDir = join(learning, 'proposals');
    if (existsSync(proposalDir)) for (const name of readdirSync(proposalDir).filter((item) => item.endsWith('.json'))) {
      const path = join(proposalDir, name);
      try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        const clone = { ...value }; delete clone.proposal_digest;
        if (value.lifecycle !== 'proposed' || contentDigest(Buffer.from(JSON.stringify(canonicalJson(clone)))) !== value.proposal_digest) throw new Error('proposal digest/lifecycle invalid');
        if (!(value.source_reflections ?? []).every((item) => reflectionById.get(item.reflection_id)?.reflection_digest === item.reflection_digest)) throw new Error('proposal reflection binding invalid');
      } catch (error) {
        findings.push({ code: 'LEARNING_PROPOSAL_INVALID', severity: 'error', path, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /** WORKTREE_MISSING/BASE_OVERRIDE/EPHEMERAL_WORKTREE 三类 warning 只在目录已经不存在的
   * record 上折叠；archived 已经被上游整段跳过、不会再产生这三类 finding，这里只需要覆盖
   * "还没 archive、但目录已经不见了"的存量噪声。 */
  const FOLDABLE_MISSING_CODES = new Set(['WORKTREE_MISSING', 'BASE_OVERRIDE', 'EPHEMERAL_WORKTREE']);

  /** @param {ReturnType<typeof buildListing>} listing */
  function missingWorktreeIds(listing) {
    return new Set(
      listing.records
        .filter((record) => !isSettledWorktreeState(record.worktree_state))
        .filter((record) => !listing.rows.some((row) => row.path === canonicalSelectorPath(record.path)))
        .map((record) => record.worktree_id),
    );
  }

  function cmdDoctor(args) {
  rejectUnknownFlags(args.flags, ['json', 'verbose', 'config']);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const findings = [];
    const listing = buildListing(true, loaded);
    const recordsById = new Map(listing.records.map((record) => [record.worktree_id, record]));
    const profileDrift = primaryProfileDriftFinding(loaded);
    if (profileDrift) findings.push(profileDrift);
    for (const row of listing.rows.filter((row) => row.kind === 'UNTRACKED')) {
      findings.push({ code: 'UNTRACKED_WORKTREE', severity: 'warning', path: row.path, branch: row.branch });
      if (classifyStorage(row.path, loaded.profile.ephemeral_path_patterns) === 'ephemeral') {
        findings.push({ code: 'EPHEMERAL_UNTRACKED', severity: 'warning', path: row.path, branch: row.branch });
      }
    }
    collectDoctorRecordFindings(loaded, listing, recordsById, findings);
    collectDoctorSupersessionFindings(listing, findings);
    collectDoctorSessionFindings(listing, findings);
    collectDoctorRuntimeFindings(loaded, findings);
    if (args.flags.get('json')) { console.log(JSON.stringify({ findings }, null, 2)); return; }
    // JSON 输出永远是完整 findings，机器消费不受展示折叠影响；下面的折叠只发生在给人看的文本模式。
    log(`doctor findings=${findings.length}`);
    if (args.flags.get('verbose')) {
      for (const finding of findings) console.log(`  [${finding.severity}] ${finding.code} ${finding.path ?? finding.worktree_id ?? ''}`);
      return;
    }
    const missingIds = missingWorktreeIds(listing);
    const foldedIds = new Set();
    for (const finding of findings) {
      const foldable = finding.severity === 'warning'
        && FOLDABLE_MISSING_CODES.has(finding.code)
        && finding.worktree_id
        && missingIds.has(finding.worktree_id);
      if (foldable) { foldedIds.add(finding.worktree_id); continue; }
      console.log(`  [${finding.severity}] ${finding.code} ${finding.path ?? finding.worktree_id ?? ''}`);
    }
    if (foldedIds.size > 0) console.log(`  [summary] missing_worktrees=${foldedIds.size} (run doctor --verbose to expand)`);
  }



  return {
    cmdDoctor,
  };
}
