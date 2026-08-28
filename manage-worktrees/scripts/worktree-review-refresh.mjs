// @ts-check

/**
 * @param {Record<string, any>} deps
 */
export function createCommands(deps) {
  const {
    randomUUID,
    predictReviewRefresh,
    loadRepositoryProfile,
    WorktreeTraceError,
    managerScript,
    runFileCapture,
    FETCH_TIMEOUT_MS,
    SUBMIT_PUSH_TIMEOUT_MS,
    git,
    gitTry,
    commandFailureReason,
    readWatcherHeartbeat,
    watcherHealth,
    refreshTargetRef,
    log,
    die,
    flag,
    rejectUnknownFlags,
    oneLine,
    loadRecords,
    selectRecord,
    liveGitSnapshot,
    updateRecord,
    isAncestor,
    historyChangeSnapshot,
    startWatcher,
  } = deps;

  function reviewRefreshUpstream(record) {
    if (!record.branch) die('refresh-review 不支持 detached HEAD。', 2);
    const remote = gitTry(['config', '--get', `branch.${record.branch}.remote`], record.path);
    const merge = gitTry(['config', '--get', `branch.${record.branch}.merge`], record.path);
    if (!remote.ok || !remote.out || remote.out === '.' || !merge.ok || !merge.out.startsWith('refs/heads/')) {
      die('refresh-review 要求 source branch 已配置真实 remote upstream。', 2);
    }
    const branch = merge.out.slice('refs/heads/'.length);
    if (!gitTry(['check-ref-format', '--branch', branch], record.path).ok) die(`upstream branch 非法: ${branch}`, 2);
    return { remote: remote.out, branch, ref: merge.out };
  }

  /** @param {Record<string,any>} record @param {{remote:string,branch:string}} upstream */
  function readRemoteBranchHead(record, upstream) {
    const remote = gitTry(
      ['ls-remote', '--heads', upstream.remote, `refs/heads/${upstream.branch}`],
      record.path,
      { timeoutMs: FETCH_TIMEOUT_MS },
    );
    if (!remote.ok) die(`无法读取 upstream ${upstream.remote}/${upstream.branch}。`);
    return remote.out ? remote.out.split(/\s+/u)[0]?.toLowerCase() ?? null : null;
  }

  /**
   * 用新的 manager 进程执行已有 managed rebase 状态机。这样 refresh-review 不复制事务实现，
   * rebase 冲突时子进程可按既有退出语义停下，父命令保留 review_refresh marker 供续跑。
   * @param {Record<string,any>} record @param {string[]} rebaseArgs @param {string|null} configPath
   */
  function runManagedRebaseChild(record, rebaseArgs, configPath) {
    const script = managerScript;
    const childArgs = [script, 'rebase', record.task, '--id', record.worktree_id, ...rebaseArgs];
    if (configPath) childArgs.push('--config', configPath);
    return runFileCapture(process.execPath, childArgs, { cwd: record.path, timeoutMs: SUBMIT_PUSH_TIMEOUT_MS });
  }

  /** @param {Record<string,any>} record @param {Record<string,any>} refresh @param {string} newHead */
  function reviewRefreshRewrite(record, refresh, newHead) {
    const rewrite = [...(record.history_rewrites ?? [])].reverse().find((candidate) =>
      candidate.kind === 'rebase'
      && candidate.old_head === refresh.old_head
      && candidate.new_head === newHead
      && candidate.new_base_sha === refresh.target_sha);
    if (!rewrite) die('refresh-review 找不到对应的 managed rebase lineage，拒绝推进或回滚。', 2);
    if (refresh.managed_rebase_token && refresh.managed_rebase_token !== rewrite.token) {
      die('refresh-review managed rebase token 已变化，拒绝推进或回滚。', 2);
    }
    return rewrite;
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {Record<string,any>} refresh @param {Record<string,any>} snapshot */
  function recordReviewRefreshRebased(loaded, record, refresh, snapshot) {
    if (refresh.state === 'prepared') {
      const rewrite = reviewRefreshRewrite(record, refresh, snapshot.head);
      return updateRecord(record, 'review_refresh_rebased', (next) => {
        if (next.review_refresh?.token !== refresh.token) throw new WorktreeTraceError('REVIEW_REFRESH_CHANGED', 'refresh marker 已变化。');
        next.review_refresh.state = 'rebased';
        next.review_refresh.new_head = snapshot.head;
        next.review_refresh.managed_rebase_token = rewrite.token;
        next.review_refresh.rebased_at = new Date().toISOString();
      }, {
        token: refresh.token,
        old_head: refresh.old_head,
        new_head: snapshot.head,
        target_ref: refresh.target_ref,
        target_sha: refresh.target_sha,
      }, loaded.context.common_dir);
    }
    if (refresh.new_head && refresh.new_head !== snapshot.head) {
      die(`refresh-review HEAD 漂移：record=${refresh.new_head}, live=${snapshot.head}`, 2);
    }
    return record;
  }

  /** @param {Record<string,any>} record @param {Record<string,any>} refresh @param {string} newHead */
  function pushReviewRefreshBranch(record, refresh, newHead) {
    const upstream = { remote: refresh.upstream_remote, branch: refresh.upstream_branch };
    const remoteHead = readRemoteBranchHead(record, upstream);
    if (remoteHead === null) {
      die(`refresh-review upstream 分支 ${upstream.remote}/${upstream.branch} 已不存在；拒绝隐式重建或 force push。`, 2);
    }
    if (remoteHead === newHead) return;
    if (remoteHead !== refresh.upstream_sha) {
      die(`refresh-review upstream lease 已变化：expected=${refresh.upstream_sha}, actual=${remoteHead}；拒绝 force push。`, 2);
    }
    const pushed = runFileCapture('git', [
      'push',
      `--force-with-lease=refs/heads/${upstream.branch}:${refresh.upstream_sha}`,
      upstream.remote,
      `HEAD:refs/heads/${upstream.branch}`,
    ], { cwd: record.path, timeoutMs: SUBMIT_PUSH_TIMEOUT_MS });
    if (!pushed.ok) {
      die(`refresh-review force-with-lease push 失败；可修复凭证/网络后重跑 --continue。\n${(pushed.out || 'unknown error').slice(0, 1000)}`);
    }
    const confirmed = readRemoteBranchHead(record, upstream);
    if (confirmed !== newHead) die(`refresh-review push 后远端回读不一致：expected=${newHead}, actual=${confirmed ?? 'missing'}`);
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {Record<string,any>} refresh @param {string} newHead */
  function recordReviewRefreshPushed(loaded, record, refresh, newHead) {
    if (record.review_refresh.state === 'pushed') return record;
    return updateRecord(record, 'review_refresh_pushed', (next) => {
      if (next.review_refresh?.token !== refresh.token) throw new WorktreeTraceError('REVIEW_REFRESH_CHANGED', 'push 登记时 refresh marker 已变化。');
      next.review_refresh.state = 'pushed';
      next.review_refresh.pushed_at = new Date().toISOString();
      next.task_status = 'ready_for_review';
      next.last_head = newHead;
      next.last_seen_at = new Date().toISOString();
      if (next.change_request) {
        next.change_request.head_sha = newHead;
        next.change_request.source_head_stale = false;
        next.change_request.refreshed_at = new Date().toISOString();
      }
    }, {
      token: refresh.token,
      upstream_remote: refresh.upstream_remote,
      upstream_branch: refresh.upstream_branch,
      old_upstream_sha: refresh.upstream_sha,
      new_head: newHead,
    }, loaded.context.common_dir);
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {Record<string,any>} refresh @param {string} newHead */
  function ensureCompletedReviewWatcher(loaded, record, refresh, newHead) {
    const active = record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)
      ? record.auto_reclaim
      : null;
    if (active && active.head_sha === newHead && active.target_ref === refresh.target_ref) return record;
    return startWatcher(loaded, record, {
      targetRef: refresh.target_ref,
      targetSha: refresh.target_sha,
      headSha: newHead,
      intervalMs: refresh.interval_ms,
      changeRef: refresh.change_ref,
      notifyMode: refresh.notify,
      explicitConfig: refresh.explicit_config,
      previousHealth: 'review refresh completed',
      armedBy: 'review_refresh',
    }).record;
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {Record<string,any>} refresh @param {string} newHead */
  function recordReviewRefreshCompleted(loaded, record, refresh, newHead) {
    const completedAt = new Date().toISOString();
    return updateRecord(record, 'review_refresh_completed', (next) => {
      if (next.review_refresh?.token !== refresh.token) throw new WorktreeTraceError('REVIEW_REFRESH_CHANGED', '完成登记时 refresh marker 已变化。');
      next.review_refreshes ??= [];
      next.review_refreshes.push({ ...next.review_refresh, state: 'completed', completed_at: completedAt });
      next.review_refresh = null;
    }, {
      token: refresh.token,
      old_head: refresh.old_head,
      new_head: newHead,
      target_ref: refresh.target_ref,
      target_sha: refresh.target_sha,
    }, loaded.context.common_dir);
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record */
  function finishReviewRefresh(loaded, record) {
    const refresh = record.review_refresh;
    if (!refresh) die('review refresh marker 缺失，无法完成。', 2);
    if (refresh.state === 'aborting') die('review refresh 已进入回滚收口；请运行 refresh-review --abort。', 2);
    if (record.history_operation) die('managed rebase 尚未完成；先解决冲突并运行 refresh-review --continue。', 2);
    const snapshot = liveGitSnapshot(record);
    if (!snapshot.present || snapshot.dirty !== false || !snapshot.head) die('refresh-review 完成前要求 worktree clean 且 HEAD 可读。', 2);
    if (!isAncestor(record.path, refresh.target_sha, snapshot.head)) {
      die(`refresh-review live HEAD 未基于冻结 target ${refresh.target_sha}，拒绝 push。`, 2);
    }

    record = recordReviewRefreshRebased(loaded, record, refresh, snapshot);
    const current = record.review_refresh;
    const newHead = current.new_head ?? snapshot.head;
    pushReviewRefreshBranch(record, current, newHead);
    record = recordReviewRefreshPushed(loaded, record, current, newHead);
    record = ensureCompletedReviewWatcher(loaded, record, current, newHead);
    record = recordReviewRefreshCompleted(loaded, record, current, newHead);
    log(`review refresh 已完成 ${record.task}: ${current.old_head.slice(0, 12)} -> ${newHead.slice(0, 12)}；已 force-with-lease push 并重新武装 watcher。`);
  }

  /** @param {Record<string,any>} record @param {Record<string,any>} refresh */
  function reviewRefreshAbortMode(record, refresh) {
    const pendingRebase = Boolean(record.history_operation);
    const pausedRebase = refresh.state === 'rebased' && refresh.pause_before_push !== false;
    if (!pendingRebase && !pausedRebase && refresh.state !== 'aborting') {
      die('refresh-review --abort 只接受 managed rebase 冲突态或 pause-before-push 后的 rebased 状态。', 2);
    }
    return { pendingRebase };
  }

  /** @param {Record<string,any>} record @param {Record<string,any>} refresh */
  function assertReviewRefreshAbortLease(record, refresh) {
    const upstream = { remote: refresh.upstream_remote, branch: refresh.upstream_branch };
    const remoteHead = readRemoteBranchHead(record, upstream);
    if (remoteHead === null) {
      die(`refresh-review upstream 分支 ${upstream.remote}/${upstream.branch} 已不存在；无法自动恢复原 watcher。`, 2);
    }
    if (remoteHead === refresh.upstream_sha) return;
    if (refresh.new_head && remoteHead === refresh.new_head) {
      die('refresh-review rebased HEAD 已存在于 upstream；不能再 abort，请用 --continue 完成登记。', 2);
    }
    die(`refresh-review abort 前 upstream lease 已变化：expected=${refresh.upstream_sha}, actual=${remoteHead}。`, 2);
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {Record<string,any>} refresh @param {boolean} pendingRebase @param {string|null} explicitConfig */
  function restoreReviewRefreshHead(loaded, record, refresh, pendingRebase, explicitConfig) {
    if (pendingRebase) {
      const aborted = runManagedRebaseChild(record, ['--abort'], explicitConfig ? loaded.profile_path : null);
      if (!aborted.ok) die(`refresh-review abort 失败。\n${aborted.out}`);
      return selectRecord(loadRecords(loaded.context.common_dir), record.task, record.worktree_id);
    }
    const snapshot = liveGitSnapshot(record);
    const currentBranch = gitTry(['branch', '--show-current'], record.path);
    if (!snapshot.present || snapshot.dirty !== false || !snapshot.head || !currentBranch.ok || currentBranch.out !== record.branch) {
      die('refresh-review abort 要求 clean、存在且仍位于登记 branch 的 worktree。', 2);
    }
    if (snapshot.head !== refresh.old_head && snapshot.head !== refresh.new_head) {
      die(`refresh-review abort HEAD 漂移：old=${refresh.old_head}, rebased=${refresh.new_head}, live=${snapshot.head}`, 2);
    }
    if (snapshot.head !== refresh.old_head) {
      const reset = gitTry(['reset', '--hard', refresh.old_head], record.path);
      if (!reset.ok) die(`refresh-review 无法恢复原始 HEAD: ${commandFailureReason(reset, 'git reset failed')}`);
    }
    return record;
  }

  /** @param {Record<string,any>} next @param {Record<string,any>} refresh */
  function restoreReviewRefreshChangeRequest(next, refresh) {
    if ('old_change_request' in refresh) {
      if (refresh.old_change_request === null) delete next.change_request;
      else next.change_request = structuredClone(refresh.old_change_request);
      return;
    }
    if (!next.change_request) return;
    next.change_request.source_head_stale = false;
    delete next.change_request.rewritten_head_sha;
    delete next.change_request.rewritten_at;
  }

  /** @param {Record<string,any>} next @param {Record<string,any>} refresh @param {Record<string,any>} rewrite @param {string} abortedAt */
  function applyReviewRefreshRollback(next, refresh, rewrite, abortedAt) {
    if (next.base_sha !== refresh.target_sha) throw new WorktreeTraceError('REVIEW_REFRESH_BASE_CHANGED', 'abort 补偿前 base 已变化。');
    const epoch = next.ownership_epochs?.at(-1);
    if (epoch && !epoch.ended_at) {
      epoch.ended_at = abortedAt;
      epoch.end_sha = refresh.new_head;
    }
    next.ownership_epochs ??= [];
    next.ownership_epochs.push({
      agent: next.agent,
      started_at: abortedAt,
      start_sha: refresh.old_base_sha,
      end_sha: null,
      ended_at: null,
      source: 'review_refresh_abort',
    });
    next.history_rollbacks ??= [];
    next.history_rollbacks.push({
      kind: 'review_refresh_abort',
      refresh_token: refresh.token,
      managed_rebase_token: rewrite.token,
      from_head: refresh.new_head,
      restored_head: refresh.old_head,
      restored_base_ref: refresh.old_base_ref ?? rewrite.old_base_ref,
      restored_base_sha: refresh.old_base_sha,
      completed_at: abortedAt,
    });
    next.base_ref = refresh.old_base_ref ?? rewrite.old_base_ref;
    next.base_sha = refresh.old_base_sha;
    next.base_reason = refresh.old_base_reason ?? null;
    next.stack_parent = structuredClone(refresh.old_stack_parent ?? null);
    restoreReviewRefreshChangeRequest(next, refresh);
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {Record<string,any>} refresh @param {boolean} pendingRebase */
  function recordReviewRefreshAbortRestored(loaded, record, refresh, pendingRebase) {
    if (record.review_refresh?.state === 'aborting') return record;
    const abortedAt = new Date().toISOString();
    const rewrite = pendingRebase ? null : reviewRefreshRewrite(record, refresh, refresh.new_head);
    return updateRecord(record, 'review_refresh_abort_restored', (next) => {
      if (next.review_refresh?.token !== refresh.token) throw new WorktreeTraceError('REVIEW_REFRESH_CHANGED', 'abort 恢复时 refresh marker 已变化。');
      if (rewrite) applyReviewRefreshRollback(next, refresh, rewrite, abortedAt);
      next.review_refresh.state = 'aborting';
      next.review_refresh.abort_kind = rewrite ? 'rebased_before_push' : 'managed_rebase';
      next.review_refresh.restored_at = abortedAt;
      next.task_status = refresh.old_task_status ?? 'ready_for_review';
      next.last_head = refresh.old_head;
      next.last_seen_at = abortedAt;
    }, {
      token: refresh.token,
      abort_kind: rewrite ? 'rebased_before_push' : 'managed_rebase',
      restored_head: refresh.old_head,
      restored_base_ref: refresh.old_base_ref ?? rewrite?.old_base_ref ?? record.base_ref,
      restored_base_sha: refresh.old_base_sha,
      managed_rebase_token: rewrite?.token ?? null,
    }, loaded.context.common_dir);
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {Record<string,any>} refresh */
  function ensureAbortedReviewWatcher(loaded, record, refresh) {
    const active = record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)
      ? record.auto_reclaim
      : null;
    const heartbeat = readWatcherHeartbeat(loaded.context.common_dir, record.worktree_id);
    const health = watcherHealth(record, heartbeat);
    if (active && active.head_sha === refresh.old_head && active.target_ref === refresh.target_ref && health.healthy) return record;
    return startWatcher(loaded, record, {
      targetRef: refresh.target_ref,
      targetSha: refresh.target_base_sha ?? refresh.old_base_sha,
      headSha: refresh.old_head,
      intervalMs: refresh.interval_ms,
      changeRef: refresh.change_ref,
      notifyMode: refresh.notify,
      explicitConfig: refresh.explicit_config,
      previousHealth: health.reason,
      armedBy: refresh.watch_armed_by ?? 'review_refresh',
    }).record;
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {Record<string,any>} refresh */
  function recordReviewRefreshAborted(loaded, record, refresh) {
    const completedAt = new Date().toISOString();
    return updateRecord(record, 'review_refresh_aborted', (next) => {
      if (next.review_refresh?.token !== refresh.token || next.review_refresh?.state !== 'aborting') {
        throw new WorktreeTraceError('REVIEW_REFRESH_CHANGED', 'abort 收口时 refresh marker 已变化。');
      }
      next.review_refreshes ??= [];
      next.review_refreshes.push({ ...next.review_refresh, state: 'aborted', aborted_at: completedAt });
      next.review_refresh = null;
    }, { token: refresh.token, restored_head: refresh.old_head }, loaded.context.common_dir);
  }

  /**
   * 放弃评审刷新。冲突态复用 managed rebase abort；pause-before-push 已完成本地 rebase 时，
   * 以补偿 event 恢复原 base/ownership/change-request 边界，再重建原 watcher。
   * @param {ReturnType<typeof loadRepositoryProfile>} loaded
   * @param {Record<string,any>} initialRecord
   * @param {string|null} explicitConfig
   */
  function abortReviewRefresh(loaded, initialRecord, explicitConfig) {
    let record = initialRecord;
    if (!record.review_refresh) die('当前没有可 abort 的 review refresh。', 2);
    const refresh = structuredClone(record.review_refresh);
    const { pendingRebase } = reviewRefreshAbortMode(record, refresh);
    assertReviewRefreshAbortLease(record, refresh);
    record = restoreReviewRefreshHead(loaded, record, refresh, pendingRebase, explicitConfig);
    const snapshot = liveGitSnapshot(record);
    if (snapshot.head !== refresh.old_head || snapshot.dirty !== false) {
      die('refresh-review abort 后未恢复原始 clean HEAD，保留 marker 供 doctor。', 2);
    }
    record = recordReviewRefreshAbortRestored(loaded, record, refresh, pendingRebase);
    record = ensureAbortedReviewWatcher(loaded, record, refresh);
    recordReviewRefreshAborted(loaded, record, refresh);
    log(`review refresh 已 abort，HEAD 恢复 ${refresh.old_head.slice(0, 12)}，原评审 watcher 已重新武装。`);
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {string|null} explicitConfig */
  function continueReviewRefresh(loaded, record, explicitConfig) {
    if (record.history_operation) {
      const continued = runManagedRebaseChild(record, ['--continue'], explicitConfig ? loaded.profile_path : null);
      if (!continued.ok) die(`review refresh rebase --continue 尚未完成；继续解决冲突后重跑。\n${continued.out}`);
      record = selectRecord(loadRecords(loaded.context.common_dir), record.task, record.worktree_id);
    }
    finishReviewRefresh(loaded, record);
  }

  /** @param {Record<string,any>} record @param {{flags:Map<string,unknown>}} args @param {Record<string,any>} snapshot @param {Record<string,any>} watch */
  function resolveReviewRefreshTarget(record, args, snapshot, watch) {
    const targetRef = oneLine(flag(args.flags, 'target') ?? watch.target_ref ?? record.base_ref ?? '', 'target', 240);
    const refreshed = refreshTargetRef(targetRef, record.path);
    if (!refreshed.ok || !refreshed.target_sha) die(`refresh-review 无法刷新 target: ${targetRef}`);
    if (refreshed.target_sha === record.base_sha) {
      log(`target 尚未前进，无需 refresh: ${targetRef}@${refreshed.target_sha.slice(0, 12)}`);
      return null;
    }
    if (!record.base_sha || !isAncestor(record.path, record.base_sha, refreshed.target_sha)) {
      die('target 不再是登记 base 的后继（可能发生 force push）；拒绝自动选择新基线。', 2);
    }
    if (isAncestor(record.path, snapshot.head, refreshed.target_sha)) {
      log('冻结 HEAD 已进入 target；无需改写历史，现有 watcher 将继续回收。');
      return null;
    }
    return { ref: targetRef, sha: refreshed.target_sha };
  }

  /** @param {Record<string,any>} record @param {Record<string,any>} snapshot */
  function freezeReviewRefreshUpstream(record, snapshot) {
    const upstream = reviewRefreshUpstream(record);
    const sha = readRemoteBranchHead(record, upstream);
    if (sha === null) {
      die(`refresh-review upstream 分支 ${upstream.remote}/${upstream.branch} 已不存在；无法冻结 source branch 边界。`, 2);
    }
    if (sha !== snapshot.head) {
      die(`refresh-review upstream 与冻结 HEAD 不一致：expected=${snapshot.head}, actual=${sha}。`, 2);
    }
    return { ...upstream, sha };
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {Record<string,any>} preparation */
  function recordReviewRefreshPrepared(loaded, record, preparation) {
    const { token, snapshot, watch, target, upstream, reason, pauseBeforePush, explicitConfig } = preparation;
    return updateRecord(record, 'review_refresh_prepared', (next) => {
      if (next.review_refresh || next.history_operation) throw new WorktreeTraceError('REVIEW_REFRESH_ALREADY_PENDING', '刷新准备时已有操作。');
      const live = liveGitSnapshot(next);
      if (live.head !== snapshot.head || live.dirty !== false) throw new WorktreeTraceError('REVIEW_REFRESH_HEAD_CHANGED', '刷新准备时 worktree 已漂移。');
      if (next.auto_reclaim?.token !== watch.token || next.auto_reclaim?.head_sha !== snapshot.head) {
        throw new WorktreeTraceError('REVIEW_REFRESH_WATCH_CHANGED', '刷新准备时 watcher 已变化。');
      }
      next.review_refresh = {
        token,
        state: 'prepared',
        old_head: snapshot.head,
        old_task_status: next.task_status,
        old_base_ref: next.base_ref,
        old_base_sha: next.base_sha,
        old_base_reason: next.base_reason ?? null,
        old_stack_parent: structuredClone(next.stack_parent ?? null),
        old_change_request: structuredClone(next.change_request ?? null),
        target_ref: target.ref,
        target_sha: target.sha,
        target_base_sha: watch.target_base_sha ?? next.base_sha,
        upstream_remote: upstream.remote,
        upstream_branch: upstream.branch,
        upstream_sha: upstream.sha,
        interval_ms: watch.interval_ms,
        change_ref: watch.change_ref ?? null,
        notify: watch.notify ?? 'auto',
        watch_armed_by: watch.armed_by ?? 'explicit',
        pause_before_push: pauseBeforePush,
        explicit_config: explicitConfig ? loaded.profile_path : null,
        reason,
        prepared_at: new Date().toISOString(),
      };
    }, {
      token,
      old_head: snapshot.head,
      old_base_sha: record.base_sha,
      target_ref: target.ref,
      target_sha: target.sha,
      upstream_remote: upstream.remote,
      upstream_branch: upstream.branch,
      upstream_sha: upstream.sha,
      prediction: predictReviewRefresh(record.path, record.base_sha, target.sha, snapshot.head),
    }, loaded.context.common_dir);
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {Record<string,any>} preparation */
  function pauseReviewRefreshBeforePush(loaded, record, preparation) {
    const live = liveGitSnapshot(record);
    if (!live.head || record.history_operation) die('refresh-review 无法在 push 前形成稳定 rebase 结果。', 2);
    const rewrite = reviewRefreshRewrite(record, record.review_refresh, live.head);
    updateRecord(record, 'review_refresh_rebased', (next) => {
      if (next.review_refresh?.token !== preparation.token) throw new WorktreeTraceError('REVIEW_REFRESH_CHANGED', '暂停前 refresh marker 已变化。');
      next.review_refresh.state = 'rebased';
      next.review_refresh.new_head = live.head;
      next.review_refresh.managed_rebase_token = rewrite.token;
      next.review_refresh.rebased_at = new Date().toISOString();
    }, {
      token: preparation.token,
      old_head: preparation.snapshot.head,
      new_head: live.head,
      target_ref: preparation.target.ref,
      target_sha: preparation.target.sha,
    }, loaded.context.common_dir);
    log(`review refresh 已完成本地 rebase，暂停在 push 前；运行项目门禁后执行 refresh-review ${record.task} --continue。`);
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {Record<string,any>} preparation */
  function executeReviewRefresh(loaded, record, preparation) {
    const rebased = runManagedRebaseChild(record, [
      '--onto', preparation.target.ref,
      '--expected-head', preparation.snapshot.head,
      '--reason', preparation.reason,
    ], preparation.explicitConfig ? loaded.profile_path : null);
    if (!rebased.ok) {
      die(`review refresh 停在 managed rebase；解决冲突并 git add 后运行 refresh-review ${record.task} --continue，或用 --abort 放弃。\n${rebased.out}`);
    }
    record = selectRecord(loadRecords(loaded.context.common_dir), record.task, record.worktree_id);
    if (preparation.pauseBeforePush) {
      pauseReviewRefreshBeforePush(loaded, record, preparation);
      return;
    }
    finishReviewRefresh(loaded, record);
  }

  /**
   * 显式评审刷新：命令本身构成远端历史改写授权。默认完成 rebase、精确 lease push 与 watcher 重冻结；
   * 项目 wrapper 可用 --pause-before-push 在本地 rebase 后插入项目门禁，再用 --continue 收口。
   * @param {{positionals:string[],flags:Map<string,unknown>}} args
   */
  function cmdRefreshReview(args) {
    rejectUnknownFlags(args.flags, ['target', 'reason', 'continue', 'abort', 'pause-before-push', 'id', 'config']);
    if (args.flags.get('abort') && args.flags.get('continue')) die('refresh-review --abort 与 --continue 互斥。', 2);
    const explicitConfig = flag(args.flags, 'config');
    const loaded = loadRepositoryProfile({ explicitConfigPath: explicitConfig });
    let record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
    if (args.flags.get('abort')) return abortReviewRefresh(loaded, record, explicitConfig);
    if (record.review_refresh) {
      if (!args.flags.get('continue')) {
        const recovery = record.review_refresh.state === 'aborting' ? '--abort' : '--continue（或在允许状态用 --abort）';
        die(`已有 review refresh；运行 refresh-review ${record.task} ${recovery} 恢复。`, 2);
      }
      return continueReviewRefresh(loaded, record, explicitConfig);
    }
    if (args.flags.get('continue')) die('当前没有可恢复的 review refresh。', 2);
    if (record.history_operation) die('已有非 refresh-review 的 managed rebase；请先按原流程恢复或 abort。', 2);
    if (record.task_status !== 'ready_for_review' || record.worktree_state !== 'present') {
      die(`refresh-review 要求 ready_for_review/present，当前 ${record.task_status}/${record.worktree_state}。`, 2);
    }
    const snapshot = historyChangeSnapshot(record, 'refresh-review');
    const watch = record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)
      ? structuredClone(record.auto_reclaim)
      : null;
    if (!watch || watch.head_sha !== snapshot.head) die('refresh-review 要求 watcher 已冻结当前 live HEAD。', 2);
    const target = resolveReviewRefreshTarget(record, args, snapshot, watch);
    if (!target) return;
    const upstream = freezeReviewRefreshUpstream(record, snapshot);
    const reason = flag(args.flags, 'reason')
      ? oneLine(flag(args.flags, 'reason'), 'reason', 240)
      : `评审目标 ${target.ref} 前进，刷新冻结分支`;
    const preparation = {
      token: randomUUID(),
      snapshot,
      watch,
      target,
      upstream,
      reason,
      pauseBeforePush: Boolean(args.flags.get('pause-before-push')),
      explicitConfig,
    };
    record = recordReviewRefreshPrepared(loaded, record, preparation);
    executeReviewRefresh(loaded, record, preparation);
  }



  return {
    cmdRefreshReview,
  };
}
