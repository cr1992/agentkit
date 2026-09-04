// @ts-check

/**
 * Domain command factory. Dependencies are injected once by the thin CLI composition root,
 * keeping this module acyclic and independently reviewable.
 *
 * `archive` 只处理"目录已经不存在、分支已经安全"的历史 record：它只追加一条 `archived`
 * trace event，用来让 doctor/list 停止对已经确认安全的历史 record 重复报警。它与 `reclaim`
 * 完全不同——不删除分支、不删除目录、不改任何 ref、不 prune，因为它的前置条件已经要求目录
 * 不存在（不然本来就该走 reclaim），archive 只是把"已经确认过的历史"标记出来，纯粹是 trace
 * 元数据操作。
 * @param {Record<string, any>} deps
 */
export function createCommands(deps) {
  const {
    loadRepositoryProfile,
    loadRecords,
    selectRecord,
    liveGitSnapshot,
    updateRecord,
    localBranchExists,
    resolveBaseRef,
    isAncestor,
    assertHistoryOperationIdle,
    git,
    gitTry,
    log,
    die,
    flag,
    rejectUnknownFlags,
    oneLine,
  } = deps;

  /**
   * 三项前置条件全部满足才允许归档：
   *   1. worktree 目录已经不存在（否则应该走 reclaim，或先确认再手工处理）；
   *   2. 分支已经不存在，或分支 tip 可达于登记的 base ref / 当前 remote HEAD；
   *   3.（由调用方在此之前检查）worktree 不处于 ready_for_review 的武装监听状态。
   * 任一条件不满足都返回 `{ ok:false, reason }`，由调用方按 KEEP 惯例处理——不 throw、不
   * exit，保持和 reclaim 的 KEEP 语义一致。
   * @param {ReturnType<typeof loadRepositoryProfile>} loaded
   * @param {Record<string,any>} record
   */
  function evaluateArchivePreconditions(loaded, record) {
    const snapshot = liveGitSnapshot(record);
    if (snapshot.present) {
      return {
        ok: false,
        reason: 'worktree 目录仍然存在；archive 只接受目录已经不存在的历史 record（目录还在时请走 reclaim，或先确认后再手工清理）。',
      };
    }
    const branchExists = localBranchExists(loaded, record);
    if (!branchExists) {
      return { ok: true, basis: 'branch_absent', branchTipSha: record.last_head ?? null, matchedRef: null };
    }
    const branchTipSha = git(['rev-parse', `refs/heads/${record.branch}`], loaded.context.current_worktree);
    const candidateRefs = [];
    if (record.base_ref) candidateRefs.push(record.base_ref);
    const remoteHead = resolveBaseRef(loaded.context.current_worktree, loaded.profile.default_base ?? null, null);
    if (remoteHead?.ref && !candidateRefs.includes(remoteHead.ref)) candidateRefs.push(remoteHead.ref);
    for (const ref of candidateRefs) {
      const resolved = gitTry(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], loaded.context.current_worktree);
      if (resolved.ok && isAncestor(loaded.context.current_worktree, branchTipSha, resolved.out)) {
        return { ok: true, basis: 'branch_merged', branchTipSha, matchedRef: ref };
      }
    }
    return {
      ok: false,
      reason: candidateRefs.length > 0
        ? `分支 ${record.branch} 仍然存在，且未合入已知 base（${candidateRefs.join(', ')}）；请先确认已合入或删除分支后再归档。`
        : `分支 ${record.branch} 仍然存在，且没有可用于判断合入状态的 base ref；请先补登记 base 或删除分支后再归档。`,
    };
  }

  function cmdArchive(args) {
    rejectUnknownFlags(args.flags, ['reason', 'id', 'config']);
    const reasonInput = flag(args.flags, 'reason');
    if (!reasonInput) die('archive 需要 --reason "<text>"。', 2);
    const reason = oneLine(reasonInput, '--reason', 500);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const records = loadRecords(loaded.context.common_dir);
    const record = selectRecord(records, args.positionals[0] ?? null, flag(args.flags, 'id'));

    if (record.worktree_state === 'archived') {
      log(`KEEP ${record.path}: record 已经归档，拒绝重复归档。`);
      process.exitCode = 1;
      return;
    }
    if (record.worktree_state === 'reclaimed') {
      log(`KEEP ${record.path}: record 已经 reclaimed，无需归档。`);
      process.exitCode = 1;
      return;
    }
    if (record.worktree_state === 'reclaim_ready') {
      log(`KEEP ${record.path}: reclaim 流程被中断（reclaim_ready）；请先修复并完成 reclaim，不能用 archive 绕过。`);
      process.exitCode = 1;
      return;
    }
    assertHistoryOperationIdle(record, 'archive');

    const activeWatch = record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)
      ? record.auto_reclaim
      : null;
    if (activeWatch) {
      log(`KEEP ${record.path}: worktree 仍处于 ready_for_review 武装监听状态（state=${activeWatch.state}）；请先 unwatch ${record.task} 再归档。`);
      process.exitCode = 1;
      return;
    }

    const evaluation = evaluateArchivePreconditions(loaded, record);
    if (!evaluation.ok) {
      log(`KEEP ${record.path}: ${evaluation.reason}`);
      process.exitCode = 1;
      return;
    }

    const now = new Date().toISOString();
    const details = {
      reason,
      basis: evaluation.basis,
      branch: record.branch ?? null,
      branch_tip_sha: evaluation.branchTipSha,
      matched_base_ref: evaluation.matchedRef,
    };
    const updated = updateRecord(record, 'archived', (next) => {
      next.worktree_state = 'archived';
      next.archived_at = now;
      next.archive = { ...details };
    }, details, loaded.context.common_dir);

    log(`已归档 ${updated.worktree_id.slice(0, 8)} task=${updated.task}（basis=${evaluation.basis}${evaluation.matchedRef ? `, base=${evaluation.matchedRef}` : ''}）；不删除分支、不删除目录、不改 refs。`);
  }

  return { cmdArchive };
}
