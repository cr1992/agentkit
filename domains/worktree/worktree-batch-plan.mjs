// @ts-check

/**
 * @param {Record<string, any>} deps
 */
export function createCommands(deps) {
  const {
    createHash,
    computeConflictScan,
    printConflictScan,
    loadRepositoryProfile,
    readRepositoryIdentity,
    resolveBaseRef,
    gitTry,
    isAncestor,
    log,
    die,
    flag,
    rejectUnknownFlags,
    loadRecords,
    selectRecord,
    liveGitSnapshot,
    canonicalJson,
    gitOperationState,
  } = deps;

  /** @param {string} targetSha @param {string[]} orderedInputShas */
  function batchFingerprint(targetSha, orderedInputShas) {
    const input = { schema_version: 1, target_sha: targetSha, ordered_input_shas: orderedInputShas };
    return `sha256:${createHash('sha256').update(JSON.stringify(canonicalJson(input))).digest('hex')}`;
  }

  /** @param {Record<string,any>} item @param {string} code @param {string} detail */
  function blockBatchItem(item, code, detail) {
    item.state = 'blocked';
    item.reasons.push({ code, detail });
  }

  /**
   * 为同一 repository identity 内的多个 feature 生成只读、可复现的集成候选计划。
   * 不 fetch、不 merge、不创建 worktree；调用者必须把 target SHA 和有序输入 SHA 当作冻结契约。
   *
   * 与 cmdPlanBatch 分离是为了让 batch-integrate 能用同一套规则重算计划做新鲜度校验，
   * 避免「规划口径」和「合成口径」各写一份而悄悄漂移。
   * @param {ReturnType<typeof loadRepositoryProfile>} loaded
   * @param {string[]} selectors
   * @param {string|null} targetOverride
   */
  function computeBatchPlan(loaded, selectors, targetOverride) {
    const records = loadRecords(loaded.context.common_dir);
    const target = resolveBaseRef(
      loaded.context.current_worktree,
      loaded.profile.default_base,
      targetOverride,
    );
    const targetCommit = gitTry(['rev-parse', '--verify', `${target.ref}^{commit}`], loaded.context.current_worktree);
    if (!targetCommit.ok || !targetCommit.out) die(`无法解析批次 target commit: ${target.ref}`, 2);

    const seenRecords = new Set();
    const requested = selectors.map((selector) => {
      const record = selectRecord(records, selector, null);
      if (seenRecords.has(record.worktree_id)) die(`重复 selector 指向同一 record: ${selector}`, 2);
      seenRecords.add(record.worktree_id);
      const snapshot = liveGitSnapshot(record);
      const item = {
        selector,
        worktree_id: record.worktree_id,
        task: record.task,
        branch: record.branch ?? null,
        path: record.path,
        task_status: record.task_status,
        worktree_state: record.worktree_state,
        base_ref: record.base_ref ?? null,
        base_sha: record.base_sha ?? null,
        head: snapshot.head ?? null,
        upstream_ref: snapshot.upstream ?? null,
        upstream_sha: null,
        state: 'candidate',
        reasons: [],
      };

      if (!snapshot.head) {
        blockBatchItem(item, 'HEAD_UNREADABLE', '无法读取 feature HEAD。');
        return item;
      }
      if (isAncestor(loaded.context.current_worktree, snapshot.head, targetCommit.out)) {
        item.state = 'already_integrated';
        item.reasons.push({ code: 'ALREADY_IN_TARGET', detail: `${snapshot.head} 已被 ${target.ref} 包含。` });
        return item;
      }
      if (!snapshot.present || record.worktree_state === 'reclaimed') {
        blockBatchItem(item, 'WORKTREE_NOT_PRESENT', '尚未进入 target 的批次输入必须来自仍存在的 tracked worktree。');
        return item;
      }
      if (!['ready_for_review', 'integrating'].includes(record.task_status)) {
        blockBatchItem(item, 'NOT_READY_FOR_REVIEW', `task_status=${record.task_status}`);
      }
      if (snapshot.dirty !== false) {
        blockBatchItem(item, 'DIRTY_WORKTREE', '批次只接受干净 worktree 的固定提交。');
      }
      const operation = gitOperationState(record.path);
      if (operation) blockBatchItem(item, 'GIT_OPERATION_IN_PROGRESS', `检测到 ${operation}。`);
      if (record.last_head && record.last_head !== snapshot.head) {
        blockBatchItem(item, 'HEAD_DRIFT', `trace=${record.last_head} live=${snapshot.head}`);
      }
      if (!snapshot.upstream) {
        blockBatchItem(item, 'UPSTREAM_MISSING', 'feature branch 尚未登记 upstream，无法证明已推送。');
        return item;
      }
      const upstreamCommit = gitTry(['rev-parse', '--verify', `${snapshot.upstream}^{commit}`], record.path);
      item.upstream_sha = upstreamCommit.ok ? upstreamCommit.out : null;
      if (!upstreamCommit.ok || upstreamCommit.out !== snapshot.head) {
        blockBatchItem(
          item,
          'UPSTREAM_NOT_AT_HEAD',
          upstreamCommit.ok ? `upstream=${upstreamCommit.out} live=${snapshot.head}` : `无法解析 ${snapshot.upstream}`,
        );
      }
      return item;
    });

    const candidates = requested.filter((item) => item.state === 'candidate');
    for (let index = 0; index < candidates.length; index++) {
      const item = candidates[index];
      const duplicate = candidates.slice(0, index).find((other) => other.state === 'candidate' && other.head === item.head);
      if (duplicate) {
        item.state = 'covered';
        item.reasons.push({ code: 'DUPLICATE_HEAD', detail: `与 ${duplicate.task} 指向同一 HEAD。` });
        continue;
      }
      const covering = candidates.find((other) =>
        other !== item &&
        other.state === 'candidate' &&
        other.head !== item.head &&
        isAncestor(loaded.context.current_worktree, item.head, other.head),
      );
      if (covering) {
        item.state = 'covered';
        item.reasons.push({ code: 'COVERED_BY_DESCENDANT', detail: `${item.task} 已包含在 ${covering.task}。` });
      }
    }

    const included = requested.filter((item) => item.state === 'candidate');
    const blockers = requested
      .filter((item) => item.state === 'blocked')
      .flatMap((item) => item.reasons.map((reason) => ({ task: item.task, worktree_id: item.worktree_id, ...reason })));
    if (included.length === 0) blockers.push({ task: null, worktree_id: null, code: 'NO_UNIQUE_INPUT', detail: '没有需要合成的唯一 feature HEAD。' });
    const repositoryId = readRepositoryIdentity(loaded.context)?.repository_id ?? null;
    const ready = blockers.length === 0;
    return {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      repository_id: repositoryId,
      // 原始 selector 全集（含随后被折叠或已在 target 的输入）。重验新鲜度必须按这一份重算：
      // 只回算 included 会把「被折叠的父分支后来前进了」这类漂移整个漏掉。
      requested_selectors: [...selectors],
      target: { ref: target.ref, sha: targetCommit.out, source: target.source },
      ready,
      fingerprint: ready ? batchFingerprint(targetCommit.out, included.map((item) => item.head)) : null,
      included,
      excluded: requested.filter((item) => item.state !== 'candidate' && item.state !== 'blocked'),
      blockers,
    };
  }


  /** @param {{positionals:string[],flags:Map<string,unknown>}} args */
  function cmdPlanBatch(args) {
    rejectUnknownFlags(args.flags, ['json', 'target', 'config', 'scan-conflicts']);
    if (args.positionals.length < 2) die('plan-batch 至少需要两个 feature selector。', 2);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const result = computeBatchPlan(loaded, args.positionals, flag(args.flags, 'target'));
    const included = result.included;
    const blockers = result.blockers;
    // 冲突矩阵是 cmdPlanBatch 的**附加输出**，不进 computeBatchPlan：后者同时是 batch-integrate
    // 的新鲜度重算口径，往里塞扫描结果会让每次合成都白跑一遍 merge-tree，也会把决策辅助信息
    // 混进"必须逐项比对"的冻结契约里。指纹只绑 SHA，加不加 --scan-conflicts 都不变。
    if (args.flags.get('scan-conflicts')) {
      result.conflict_scan = computeConflictScan(loaded.context.current_worktree, result.target, included);
    }
    if (args.flags.get('json')) console.log(JSON.stringify(result, null, 2));
    else {
      log(`batch target=${result.target.ref}@${result.target.sha.slice(0, 12)} ready=${result.ready} inputs=${included.length}`);
      for (const item of included) console.log(`  [INCLUDE] ${item.task} ${item.head.slice(0, 12)} upstream=${item.upstream_ref}`);
      for (const item of result.excluded) console.log(`  [${item.state.toUpperCase()}] ${item.task} ${item.reasons.map((reason) => reason.code).join(',')}`);
      for (const blocker of blockers) console.log(`  [BLOCK] ${blocker.task ?? '-'} ${blocker.code}: ${blocker.detail}`);
      if (result.fingerprint) console.log(`  fingerprint=${result.fingerprint}`);
      if (result.conflict_scan) printConflictScan(result.conflict_scan);
    }
    if (!result.ready) process.exitCode = 1;
  }

  return {
    batchFingerprint,
    computeBatchPlan,
    cmdPlanBatch,
  };
}
