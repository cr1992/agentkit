// @ts-check

/**
 * Domain command factory. Dependencies are injected once by the thin CLI composition root,
 * keeping this module acyclic and independently reviewable.
 * @param {Record<string, any>} deps
 */
export function createCommands(deps) {
  const {
    randomUUID,
    loadRepositoryProfile,
    WorktreeTraceError,
    SUBMIT_PUSH_TIMEOUT_MS,
    git,
    gitTry,
    commandFailureReason,
    removeWatcherHeartbeat,
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
    assertHistoryOperationIdle,
    gitOperationState,
    isAncestor,
  } = deps;

  function stackParentForRef(records, ref, baseSha) {
    const normalized = ref.replace(/^refs\/heads\//u, '');
    const candidates = records.filter((record) =>
      record.worktree_state !== 'reclaimed' &&
      record.branch &&
      (record.branch === normalized || normalized.endsWith(`/${record.branch}`)),
    );
    if (candidates.length > 1) die(`base ref ${ref} 同时匹配多个 tracked parent；请先清理歧义。`, 2);
    const parent = candidates[0];
    if (!parent) return null;
    return {
      worktree_id: parent.worktree_id,
      task: parent.task,
      branch: parent.branch,
      base_ref: ref,
      parent_head_sha: baseSha,
      recorded_at: new Date().toISOString(),
    };
  }

  /** @param {Record<string,any>} record @param {string} command */
  function historyChangeSnapshot(record, command) {
    if (!['active', 'blocked', 'ready_for_review'].includes(record.task_status)) {
      die(`${command} 只接受 active/blocked/ready_for_review，当前为 ${record.task_status}。`, 2);
    }
    if (record.worktree_state !== 'present') die(`${command} 要求 worktree_state=present。`, 2);
    const snapshot = liveGitSnapshot(record);
    if (!snapshot.present) die(`${command} 要求 worktree 仍存在。`, 2);
    if (snapshot.dirty !== false) die(`${command} 要求工作树干净（含 untracked）。`, 2);
    if (!snapshot.head || !record.branch) die(`${command} 不支持 detached HEAD。`, 2);
    const currentBranch = gitTry(['branch', '--show-current'], record.path);
    if (!currentBranch.ok || currentBranch.out !== record.branch) {
      die(`${command} 检测到 branch 漂移：live=${currentBranch.out || '(detached)'} record=${record.branch}`, 2);
    }
    const operation = gitOperationState(record.path);
    if (operation) die(`${command} 检测到未完成 Git 操作 ${operation}。`, 2);
    if (record.auto_reclaim?.state === 'merge_detected') {
      die(`${command} 拒绝改写已进入 merge_detected 的冻结边界。`, 2);
    }
    return snapshot;
  }

  /** @param {Record<string,any>} next @param {string} reason */
  function disarmHistoryWatcher(next, reason) {
    const watch = next.auto_reclaim;
    if (!watch || ['disarmed', 'reclaimed'].includes(watch.state)) return null;
    watch.state = 'disarmed';
    watch.disarmed_at = new Date().toISOString();
    watch.disarm_reason = reason;
    return watch.token ?? null;
  }

  /** @param {string} cwd @param {string} fromExclusive @param {string} through */
  function revisionList(cwd, fromExclusive, through) {
    const result = gitTry(['rev-list', '--reverse', `${fromExclusive}..${through}`], cwd);
    return result.ok && result.out ? result.out.split('\n').filter(Boolean) : [];
  }

  /** @param {Record<string,any>[]} records @param {string} ref @param {string} cwd */
  function resolveManagedBase(records, ref, cwd) {
    const refreshed = refreshTargetRef(ref, cwd);
    if (!refreshed.ok || !refreshed.target_sha) die(`无法解析或刷新 base ref: ${ref}`, 2);
    return {
      ref,
      sha: refreshed.target_sha,
      parent: stackParentForRef(records, ref, refreshed.target_sha),
    };
  }

  /** @param {Record<string,any>[]} records @param {Record<string,any>} record @param {Record<string,any>|null} parent @param {string} command */
  function assertStackParentAcyclic(records, record, parent, command) {
    if (!parent) return;
    const byId = new Map(records.map((candidate) => [candidate.worktree_id, candidate]));
    let cursor = parent.worktree_id;
    const seen = new Set();
    while (cursor) {
      if (cursor === record.worktree_id) die(`${command} 会形成 stack parent 环，拒绝更新。`, 2);
      if (seen.has(cursor)) die(`${command} 检测到已有 stack parent 环，拒绝扩散。`, 2);
      seen.add(cursor);
      cursor = byId.get(cursor)?.stack_parent?.worktree_id ?? null;
    }
  }

  /**
   * 只改验证/MR 目标，不改 Git 历史。新 base 必须已经是 live HEAD 的祖先；否则必须走受控 rebase。
   * @param {{positionals:string[],flags:Map<string,unknown>}} args
   */
  function cmdRetarget(args) {
    rejectUnknownFlags(args.flags, ['base', 'reason', 'expected-head', 'id', 'config']);
    const baseRef = oneLine(flag(args.flags, 'base') ?? '', 'base', 240);
    const reason = oneLine(flag(args.flags, 'reason') ?? '', 'reason', 240);
    const expectedHead = oneLine(flag(args.flags, 'expected-head') ?? '', 'expected-head', 128);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const records = loadRecords(loaded.context.common_dir);
    const record = selectRecord(records, args.positionals[0] ?? null, flag(args.flags, 'id'));
    assertHistoryOperationIdle(record, 'retarget');
    const snapshot = historyChangeSnapshot(record, 'retarget');
    if (snapshot.head !== expectedHead) die(`retarget HEAD CAS 失败：expected=${expectedHead}, actual=${snapshot.head}`, 2);
    const base = resolveManagedBase(records, baseRef, record.path);
    assertStackParentAcyclic(records, record, base.parent, 'retarget');
    if (!isAncestor(record.path, base.sha, snapshot.head)) {
      die(`retarget 不改写历史，但 ${base.sha} 不是 live HEAD 的祖先；请改用 rebase --onto ${baseRef}。`, 2);
    }
    const oldWatch = record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)
      ? structuredClone(record.auto_reclaim)
      : null;
    const updated = updateRecord(record, 'base_retargeted', (next) => {
      const live = liveGitSnapshot(next);
      if (live.head !== expectedHead) throw new WorktreeTraceError('RETARGET_HEAD_CHANGED', `retarget 期间 HEAD 已变为 ${live.head}`);
      const watcherToken = disarmHistoryWatcher(next, 'base_retargeted');
      next.base_ref = base.ref;
      next.base_sha = base.sha;
      next.base_reason = reason;
      next.stack_parent = base.parent;
      next.last_head = live.head;
      next.last_seen_at = new Date().toISOString();
      if (next.change_request) {
        const targetBranch = base.ref.includes('/') ? base.ref.slice(base.ref.indexOf('/') + 1) : base.ref;
        next.change_request.target_branch = targetBranch;
        next.change_request.target_ref = base.ref;
        next.change_request.target_sync = 'record_only';
        next.change_request.retargeted_at = new Date().toISOString();
      }
      if (watcherToken) next.task_status = 'active';
    }, {
      old_base_ref: record.base_ref,
      old_base_sha: record.base_sha,
      new_base_ref: base.ref,
      new_base_sha: base.sha,
      stack_parent_worktree_id: base.parent?.worktree_id ?? null,
      reason,
      expected_head: expectedHead,
    }, loaded.context.common_dir);
    if (oldWatch?.token) removeWatcherHeartbeat(loaded.context.common_dir, record.worktree_id, oldWatch.token);
    log(`已 retarget ${record.task}: ${record.base_ref}@${String(record.base_sha).slice(0, 12)} -> ${base.ref}@${base.sha.slice(0, 12)}`);
    if (oldWatch) log('旧 watcher 已失效；确认远端 MR 目标后重新 touch ready_for_review 以武装新 target。');
    if (updated.change_request?.target_sync === 'record_only') log('MR target 仅更新本地记录；portable core 未调用远端 provider。');
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {Record<string,any>} operation */
  function finalizeManagedRebase(loaded, record, operation) {
    const live = liveGitSnapshot(record);
    if (!live.present || live.dirty !== false || !live.head) die('rebase 完成后的 worktree 状态不可冻结。', 2);
    if (!isAncestor(record.path, operation.onto_sha, live.head)) die('rebase 后 onto SHA 不是 live HEAD 的祖先。', 2);
    const newCommits = revisionList(record.path, operation.onto_sha, live.head);
    return updateRecord(record, 'history_rebase_completed', (next) => {
      if (next.history_operation?.token !== operation.token) {
        throw new WorktreeTraceError('REBASE_OPERATION_CHANGED', 'rebase finalize 时 operation token 已变化。');
      }
      const epoch = next.ownership_epochs?.at(-1);
      if (epoch && !epoch.ended_at) {
        epoch.ended_at = new Date().toISOString();
        epoch.end_sha = operation.old_head;
      }
      next.ownership_epochs ??= [];
      next.ownership_epochs.push({ agent: next.agent, started_at: new Date().toISOString(), start_sha: operation.onto_sha, end_sha: null, ended_at: null, source: 'managed_rebase' });
      next.history_rewrites ??= [];
      next.history_rewrites.push({
        kind: 'rebase',
        token: operation.token,
        old_base_ref: operation.old_base_ref,
        old_base_sha: operation.old_base_sha,
        old_head: operation.old_head,
        old_commits: operation.old_commits,
        new_base_ref: operation.onto_ref,
        new_base_sha: operation.onto_sha,
        new_head: live.head,
        new_commits: newCommits,
        reason: operation.reason,
        completed_at: new Date().toISOString(),
      });
      next.base_ref = operation.onto_ref;
      next.base_sha = operation.onto_sha;
      next.base_reason = operation.reason;
      next.stack_parent = operation.stack_parent;
      next.last_head = live.head;
      next.last_seen_at = new Date().toISOString();
      next.history_operation = null;
      if (next.task_status === 'ready_for_review') next.task_status = 'active';
      if (next.change_request) {
        next.change_request.source_head_stale = true;
        next.change_request.rewritten_head_sha = live.head;
        next.change_request.rewritten_at = new Date().toISOString();
      }
    }, {
      token: operation.token,
      old_head: operation.old_head,
      new_head: live.head,
      old_base_sha: operation.old_base_sha,
      new_base_sha: operation.onto_sha,
      old_commit_count: operation.old_commits.length,
      new_commit_count: newCommits.length,
    }, loaded.context.common_dir);
  }

  /**
   * manager-owned history rewrite：先落 intent 并撤防，再执行 Git；崩溃后重跑同命令可 finalize。
   * @param {{positionals:string[],flags:Map<string,unknown>}} args
   */
  function cmdRebase(args) {
    rejectUnknownFlags(args.flags, ['onto', 'reason', 'expected-head', 'id', 'config', 'abort', 'continue']);
    if (args.flags.get('abort') && args.flags.get('continue')) die('rebase --abort 与 --continue 互斥。', 2);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const records = loadRecords(loaded.context.common_dir);
    let record = selectRecord(records, args.positionals[0] ?? null, flag(args.flags, 'id'));
    const pending = record.history_operation;
    if (args.flags.get('abort')) {
      if (!pending || pending.kind !== 'rebase') die('当前没有可 abort 的 managed rebase。', 2);
      const operationState = gitOperationState(record.path);
      if (operationState?.startsWith('rebase')) {
        const aborted = gitTry(['rebase', '--abort'], record.path);
        if (!aborted.ok) die(`git rebase --abort 失败: ${commandFailureReason(aborted, 'unknown error')}`);
      }
      const live = liveGitSnapshot(record);
      if (live.head !== pending.old_head || live.dirty !== false) die('rebase abort 后未恢复到原始 clean HEAD，保留 pending 供 doctor。', 2);
      updateRecord(record, 'history_rebase_aborted', (next) => {
        if (next.history_operation?.token !== pending.token) throw new WorktreeTraceError('REBASE_OPERATION_CHANGED', 'abort 时 operation token 已变化。');
        next.history_operation = null;
        next.last_head = live.head;
        next.last_seen_at = new Date().toISOString();
      }, { token: pending.token, restored_head: live.head }, loaded.context.common_dir);
      log(`已 abort managed rebase，HEAD 恢复为 ${live.head.slice(0, 12)}；watcher 保持关闭。`);
      return;
    }

    const ontoInput = flag(args.flags, 'onto');
    const reasonInput = flag(args.flags, 'reason');
    const expectedHeadInput = flag(args.flags, 'expected-head');
    let ontoRef = ontoInput ? oneLine(ontoInput, 'onto', 240) : null;
    let reason = reasonInput ? oneLine(reasonInput, 'reason', 240) : null;
    let expectedHead = expectedHeadInput ? oneLine(expectedHeadInput, 'expected-head', 128) : null;
    if (pending) {
      if (
        pending.kind !== 'rebase' ||
        (ontoRef && pending.onto_ref !== ontoRef) ||
        (expectedHead && pending.old_head !== expectedHead) ||
        (reason && pending.reason !== reason)
      ) {
        die('已有 managed history operation 与本次参数不一致；先按原参数恢复或使用 rebase --abort。', 2);
      }
      ontoRef = pending.onto_ref;
      expectedHead = pending.old_head;
      reason = pending.reason;
      let operationState = gitOperationState(record.path);
      if (operationState?.startsWith('rebase') && args.flags.get('continue')) {
        const continued = gitTry(['rebase', '--continue'], record.path, {
          timeoutMs: SUBMIT_PUSH_TIMEOUT_MS,
          env: { ...process.env, GIT_EDITOR: 'true' },
        });
        operationState = gitOperationState(record.path);
        if (!continued.ok || operationState?.startsWith('rebase')) {
          updateRecord(record, 'history_rebase_conflicted', (next) => {
            if (next.history_operation?.token !== pending.token) throw new WorktreeTraceError('REBASE_OPERATION_CHANGED', 'continue 时 operation token 已变化。');
            next.history_operation.state = 'conflicted';
            next.history_operation.last_error = commandFailureReason(continued, 'rebase conflict remains');
          }, { token: pending.token, git_state: operationState ?? 'unknown', phase: 'continue' }, loaded.context.common_dir);
          die('managed rebase --continue 未完成；继续解决冲突后重跑相同 manager 命令，或使用 rebase --abort。');
        }
      } else if (operationState?.startsWith('rebase')) {
        die('managed rebase 停在冲突态；解决文件并 git add 后，用本命令加 --continue，或使用 rebase --abort。', 2);
      }
      const live = liveGitSnapshot(record);
      if (live.head !== pending.old_head && live.head && isAncestor(record.path, pending.onto_sha, live.head)) {
        const completed = finalizeManagedRebase(loaded, record, pending);
        log(`已恢复并 finalize rebase ${record.task}: ${pending.old_head.slice(0, 12)} -> ${completed.last_head.slice(0, 12)}`);
        return;
      }
      if (live.head !== pending.old_head) die('managed rebase pending，但 live HEAD 既不是 old_head 也不是可验证的新链。', 2);
    }

    if (!ontoRef || !reason || !expectedHead) {
      die('新建 managed rebase 需要 --onto、--expected-head 与 --reason；恢复 pending 操作只需 selector + --continue。', 2);
    }

    const snapshot = historyChangeSnapshot(record, 'rebase');
    if (snapshot.head !== expectedHead) die(`rebase HEAD CAS 失败：expected=${expectedHead}, actual=${snapshot.head}`, 2);
    if (!record.base_sha || !isAncestor(record.path, record.base_sha, snapshot.head)) {
      die('record.base_sha 不是 live HEAD 的祖先；历史已在 manager 外改写，拒绝继续。', 2);
    }
    const base = resolveManagedBase(records, ontoRef, record.path);
    assertStackParentAcyclic(records, record, base.parent, 'rebase');
    if (base.sha === record.base_sha) die('onto SHA 与当前 base_sha 相同，无需 rebase。', 2);
    let operation = pending;
    if (!operation) {
      operation = {
        kind: 'rebase',
        state: 'prepared',
        token: randomUUID(),
        old_base_ref: record.base_ref,
        old_base_sha: record.base_sha,
        old_head: snapshot.head,
        old_commits: revisionList(record.path, record.base_sha, snapshot.head),
        onto_ref: base.ref,
        onto_sha: base.sha,
        stack_parent: base.parent,
        reason,
        prepared_at: new Date().toISOString(),
      };
      const oldWatch = record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)
        ? structuredClone(record.auto_reclaim)
        : null;
      record = updateRecord(record, 'history_rebase_prepared', (next) => {
        const live = liveGitSnapshot(next);
        if (live.head !== expectedHead || live.dirty !== false) throw new WorktreeTraceError('REBASE_PREPARE_DRIFT', 'rebase prepare 前 Git 状态已变化。');
        disarmHistoryWatcher(next, 'history_rebase_prepared');
        next.history_operation = operation;
        next.last_head = live.head;
        next.last_seen_at = new Date().toISOString();
      }, { ...operation, old_commits: operation.old_commits.length }, loaded.context.common_dir);
      if (oldWatch?.token) removeWatcherHeartbeat(loaded.context.common_dir, record.worktree_id, oldWatch.token);
    }

    const rebased = gitTry(['rebase', '--onto', operation.onto_sha, operation.old_base_sha, record.branch], record.path, { timeoutMs: SUBMIT_PUSH_TIMEOUT_MS });
    if (!rebased.ok) {
      const state = gitOperationState(record.path);
      if (state?.startsWith('rebase')) {
        updateRecord(record, 'history_rebase_conflicted', (next) => {
          if (next.history_operation?.token !== operation.token) throw new WorktreeTraceError('REBASE_OPERATION_CHANGED', 'conflict 记录时 token 已变化。');
          next.history_operation.state = 'conflicted';
          next.history_operation.last_error = commandFailureReason(rebased, 'rebase conflict');
        }, { token: operation.token, git_state: state }, loaded.context.common_dir);
        die('managed rebase 发生冲突；解决文件并 git add 后，用相同 manager 命令加 --continue，或使用 rebase --abort。');
      }
      const live = liveGitSnapshot(record);
      if (live.head === operation.old_head && live.dirty === false) {
        updateRecord(record, 'history_rebase_failed', (next) => {
          if (next.history_operation?.token !== operation.token) throw new WorktreeTraceError('REBASE_OPERATION_CHANGED', 'failure 记录时 token 已变化。');
          next.history_operation = null;
        }, { token: operation.token, reason: commandFailureReason(rebased, 'rebase failed before applying changes') }, loaded.context.common_dir);
      }
      die(`managed rebase 失败: ${commandFailureReason(rebased, 'unknown error')}`);
    }
    const completed = finalizeManagedRebase(loaded, record, operation);
    log(`已 rebase ${record.task}: ${operation.old_head.slice(0, 12)} -> ${completed.last_head.slice(0, 12)}，base=${operation.onto_ref}@${operation.onto_sha.slice(0, 12)}`);
    log('旧 Artifact/MR head/watcher 已失效；push 新 HEAD 后重新登记评审边界。');
  }


  return {
    stackParentForRef,
    historyChangeSnapshot,
    cmdRetarget,
    cmdRebase,
  };
}
