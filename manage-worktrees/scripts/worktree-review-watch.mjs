// @ts-check

/**
 * @param {Record<string, any>} deps
 */
export function createCommands(deps) {
  const {
    spawn,
    randomUUID,
    predictReviewRefresh,
    loadRepositoryProfile,
    gitlabSubmitPushArgs,
    parseGitlabMergeRequestUrl,
    WorktreeTraceError,
    appendTraceEvent,
    managerScript,
    runFileCapture,
    PREFIX,
    FETCH_TIMEOUT_MS,
    SUBMIT_PUSH_TIMEOUT_MS,
    WATCH_MIN_INTERVAL_MS,
    WATCH_MAX_INTERVAL_MS,
    WATCH_TARGET_CACHE_MAX_AGE_MS,
    git,
    gitTry,
    sleep,
    readWatcherHeartbeat,
    writeWatcherHeartbeat,
    removeWatcherHeartbeat,
    parseWatchInterval,
    watcherHealth,
    refreshTargetRef,
    refreshTargetRefCached,
    parseNotifyMode,
    log,
    die,
    flag,
    rejectUnknownFlags,
    oneLine,
    aliasedFlag,
    loadRecords,
    selectRecord,
    liveGitSnapshot,
    assertHistoryOperationIdle,
    appendReclaimEvent,
    appendWatchedEvent,
    reclaimPreflight,
    reclaimRecord,
  } = deps;

  function autoArmReviewWatch(loaded, record, args, snapshot) {
    if (args.flags.get('no-watch')) {
      log('watch 未武装：--no-watch 显式退出；合入后需要人工回收。');
      return;
    }
    const existing = record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)
      ? record.auto_reclaim
      : null;
    // 原子失效旧 watcher 后仍沿用它的 target/interval/change-ref 默认值，避免自动重冻结
    // 把人工显式选择的 target 静默改回该树登记的 base。
    const previous = record.auto_reclaim ?? null;
    if (existing?.state === 'merge_detected') {
      log('watch 保持原冻结 SHA：目标分支已确认包含该 head，自动回收已进入提交阶段。');
      return;
    }
    const skip = (reason) => log(`watch 未武装：${reason}；自动回收保持关闭，可补齐前提后重新 touch。`);
    const targetRef = aliasedFlag(args.flags, 'target', 'watch-target') ?? previous?.target_ref ?? record.base_ref ?? loaded.profile.default_base;
    if (!targetRef || !targetRef.includes('/')) {
      skip(`无法确定远端主干 target（Profile default_base=${loaded.profile.default_base ?? 'null'}）`);
      return;
    }
    if (!snapshot.present) { skip('worktree 不存在'); return; }
    if (snapshot.dirty !== false) { skip('工作树非干净'); return; }
    if (!snapshot.head) { skip('无法读取 HEAD'); return; }
    const upstream = gitTry(['rev-parse', '@{upstream}^{commit}'], record.path);
    if (!upstream.ok || upstream.out !== snapshot.head) {
      skip('当前 HEAD 尚未完整 push 到 upstream');
      return;
    }
    const refreshedTarget = refreshTargetRef(targetRef, loaded.context.current_worktree);
    if (!refreshedTarget.ok) { skip(`目标 ref 不存在或无法刷新: ${targetRef}`); return; }
    // auto_touch 是可重算的默认动作，可在当轮直接改 target；人工显式 watch（以及没有来源字段的
    // legacy watcher）是用户指令，touch 不能静默改写。即使它刚因 HEAD 漂移被原子撤防，也保留
    // 这条 provenance 边界；此时改目标应显式执行 watch --target 重新建立指令。
    if (previous && previous.target_ref !== targetRef && previous.armed_by !== 'auto_touch') {
      skip(
        `人工武装 target=${previous.target_ref} 与请求的 ${targetRef} 不同；` +
        `${previous.state === 'disarmed' ? '请显式执行 watch --target 建立新监听' : '换目标请先 unwatch'}`,
      );
      return;
    }

    const heartbeat = readWatcherHeartbeat(loaded.context.common_dir, record.worktree_id);
    const health = watcherHealth(record, heartbeat);
    // 已武装且 HEAD 未变、watcher 健康：保持原样，不重复起进程。
    if (existing && health.healthy && existing.head_sha === snapshot.head && existing.target_ref === targetRef) {
      log(`watch 已在运行 pid=${heartbeat.state.pid} target=${targetRef} head=${snapshot.head.slice(0, 12)}`);
      return;
    }
    try {
      const started = startWatcher(loaded, record, {
        targetRef,
        targetSha: refreshedTarget.target_sha,
        headSha: snapshot.head,
        intervalMs: parseWatchInterval(flag(args.flags, 'interval-ms') ?? previous?.interval_ms),
        changeRef: aliasedFlag(args.flags, 'change-ref', 'mr')
          ? oneLine(aliasedFlag(args.flags, 'change-ref', 'mr'), 'change-ref', 1000)
          : previous?.change_ref ?? null,
        notifyMode: parseNotifyMode(flag(args.flags, 'notify') ?? previous?.notify),
        explicitConfig: flag(args.flags, 'config') ? loaded.profile_path : null,
        previousHealth: health.reason,
        armedBy: 'auto_touch',
      });
      const rearming = Boolean(existing) || (
        previous?.state === 'disarmed' && previous.disarm_reason === 'stale_frozen_head'
      );
      const refroze = rearming && previous?.head_sha !== snapshot.head;
      log(
        `watch 已${rearming ? '重新' : ''}武装 pid=${started.pid} target=${targetRef} head=${snapshot.head.slice(0, 12)}` +
        `${refroze ? `（HEAD 变化，已从 ${previous.head_sha.slice(0, 12)} 重冻结）` : ''}`,
      );
    } catch (error) {
      skip(`watcher 启动失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }


  function appendAutoStatus(commonDir, record, token, eventType, targetSha) {
    return appendWatchedEvent(commonDir, record, token, eventType, (next) => {
      next.task_status = eventType === 'auto_integrating' ? 'integrating' : 'done';
      next.last_seen_at = new Date().toISOString();
    }, { source: 'auto_reclaim_watcher', target_sha: targetSha });
  }

  /**
   * @param {ReturnType<typeof loadRepositoryProfile>} loaded
   * @param {Record<string,any>} initialRecord
   * @param {{targetRef:string,targetSha?:string|null,headSha:string,intervalMs:number,changeRef:string|null,notifyMode:string,explicitConfig:string|null,previousHealth:string|null,armedBy?:string}} options
   */
  function startWatcher(loaded, initialRecord, options) {
    let record = initialRecord;
    const reviveStaleAutoTouch = options.armedBy === 'auto_touch'
      && record.auto_reclaim?.state === 'disarmed'
      && record.auto_reclaim?.disarm_reason === 'stale_frozen_head';
    const existing = record.auto_reclaim && (
      !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state) || reviveStaleAutoTouch
    ) ? record.auto_reclaim : null;
    const token = randomUUID();
    const now = new Date().toISOString();
    const eventType = existing ? 'auto_reclaim_rearmed' : 'auto_reclaim_armed';
    const resumeAfterMerge = existing?.state === 'merge_detected';
    record = appendTraceEvent({
      commonDir: loaded.context.common_dir,
      worktreeId: record.worktree_id,
      eventType,
      actor: record.agent,
      details: {
        target_ref: options.targetRef,
        head_sha: options.headSha,
        interval_ms: options.intervalMs,
        change_ref: options.changeRef,
        notify: options.notifyMode,
        previous_health: options.previousHealth,
      },
      mutate(current) {
        if (existing) {
          const revivableCurrent = reviveStaleAutoTouch
            && current.auto_reclaim?.state === 'disarmed'
            && current.auto_reclaim?.disarm_reason === 'stale_frozen_head';
          if (
            current.auto_reclaim?.token !== existing.token
            || current.auto_reclaim?.state === 'reclaimed'
            || (current.auto_reclaim?.state === 'disarmed' && !revivableCurrent)
          ) {
            throw new WorktreeTraceError('WATCHER_CANCELLED', `watch token 已被并发更新或解除: ${record.worktree_id}`);
          }
        } else if (current.auto_reclaim && !['disarmed', 'reclaimed'].includes(current.auto_reclaim.state)) {
          throw new WorktreeTraceError('WATCHER_ALREADY_ARMED', `watcher 已被另一进程 arm: ${record.worktree_id}`);
        }
        const next = structuredClone(current);
        next.auto_reclaim = {
          ...existing,
          state: resumeAfterMerge ? 'merge_detected' : 'armed',
          // 记录武装来源：自动武装是默认动作，人工显式武装是当轮指引，二者的改目标权限不同。
          armed_by: options.armedBy ?? existing?.armed_by ?? 'explicit',
          target_ref: options.targetRef,
          target_base_sha: options.targetSha ?? existing?.target_base_sha ?? current.base_sha ?? null,
          head_sha: options.headSha,
          interval_ms: options.intervalMs,
          change_ref: options.changeRef,
          notify: options.notifyMode,
          target_advance: null,
          token,
          armed_at: existing?.armed_at ?? now,
          rearmed_at: existing ? now : null,
          disarmed_at: null,
          disarm_reason: null,
          pid: null,
        };
        next.updated_at = now;
        return next;
      },
    }).record;

    const script = managerScript;
    const workerArgs = [script, 'watch-worker', '--id', record.worktree_id, '--token', token];
    if (options.explicitConfig) workerArgs.push('--config', options.explicitConfig);
    const child = spawn(process.execPath, workerArgs, {
      cwd: loaded.context.primary_worktree,
      detached: true,
      stdio: 'ignore',
    });
    if (!child.pid) throw new WorktreeTraceError('WATCHER_START_FAILED', '无法启动 auto-reclaim watcher。');
    try {
      record = appendWatchedEvent(loaded.context.common_dir, record, token, 'auto_reclaim_watcher_started', (next) => {
        next.auto_reclaim.state = resumeAfterMerge ? 'merge_detected' : 'watching';
        next.auto_reclaim.pid = child.pid;
        next.auto_reclaim.started_at = new Date().toISOString();
      }, { pid: child.pid, token });
    } catch (error) {
      try { process.kill(child.pid, 'SIGTERM'); } catch {}
      throw error;
    }
    writeWatcherHeartbeat(loaded.context.common_dir, {
      schema_version: 1,
      worktree_id: record.worktree_id,
      pid: child.pid,
      token,
      target_ref: options.targetRef,
      head_sha: options.headSha,
      state: 'starting',
      blocked_reason: null,
      started_at: record.auto_reclaim.started_at,
    });
    child.unref();
    return { record, pid: child.pid, token };
  }

  /** @param {string|null} configured @param {string} remote @param {string|null} baseRef */
  function resolveSubmitTargetBranch(configured, remote, baseRef) {
    const candidate = configured ?? (baseRef?.startsWith(`${remote}/`) ? baseRef.slice(remote.length + 1) : null);
    if (!candidate) die('无法从 Profile change_request.target_branch 或 base_ref 推断 MR target branch。');
    return oneLine(candidate, 'target', 240);
  }

  function cmdSubmit(args) {
    rejectUnknownFlags(args.flags, [
      'title',
      'description',
      'target',
      'remote',
      'interval-ms',
      'notify',
      'id',
      'config',
    ]);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const provider = loaded.profile.change_request;
    if (provider.provider !== 'gitlab') {
      die('当前 Profile 未启用 GitLab change_request provider；请配置 provider=gitlab 或继续人工创建 MR。');
    }
    let record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
    assertHistoryOperationIdle(record, 'submit');
    if (!['active', 'ready_for_review'].includes(record.task_status)) {
      die(`submit 只接受 active/ready_for_review，当前为 ${record.task_status}。`);
    }
    if (record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)) {
      die('record 已有 watcher；更新 MR 前先确认旧冻结 SHA，必要时 unwatch 后再 submit。');
    }

    const snapshot = liveGitSnapshot(record);
    if (!snapshot.present) die('submit 要求 worktree 仍存在。');
    if (snapshot.dirty !== false) die('submit 要求工作树干净（含 untracked 必须为空）。');
    if (!record.branch || !snapshot.head) die('submit 不支持 detached HEAD，且必须能解析有效 HEAD。');
    const currentBranch = gitTry(['branch', '--show-current'], record.path);
    if (!currentBranch.ok || currentBranch.out !== record.branch) {
      die(`worktree 当前 branch 与 record 不一致: current=${currentBranch.out || '(detached)'} record=${record.branch}`);
    }
    if (!gitTry(['check-ref-format', '--branch', record.branch], record.path).ok) {
      die(`非法 source branch: ${record.branch}`);
    }

    const remote = oneLine(flag(args.flags, 'remote') ?? provider.remote, 'remote', 120);
    if (!gitTry(['remote', 'get-url', remote], record.path).ok) die(`Git remote 不存在: ${remote}`);
    const targetBranch = resolveSubmitTargetBranch(
      flag(args.flags, 'target') ?? provider.target_branch,
      remote,
      record.base_ref ?? null,
    );
    if (!gitTry(['check-ref-format', '--branch', targetBranch], record.path).ok) {
      die(`非法 target branch: ${targetBranch}`);
    }
    const targetRef = `${remote}/${targetBranch}`;
    const refreshed = refreshTargetRef(targetRef, record.path);
    if (!refreshed.ok) die(`目标 ref 不存在或 fetch 失败: ${targetRef}`);

    const upstreamHead = gitTry(['rev-parse', '@{upstream}^{commit}'], record.path);
    const remoteHead = gitTry(
      ['ls-remote', '--heads', remote, `refs/heads/${record.branch}`],
      record.path,
      { timeoutMs: FETCH_TIMEOUT_MS },
    );
    const remoteHeadSha = remoteHead.ok && remoteHead.out ? remoteHead.out.split(/\s+/)[0] : null;
    if ((upstreamHead.ok && upstreamHead.out === snapshot.head) || remoteHeadSha === snapshot.head) {
      die('当前 HEAD 已完整存在于 remote；GitLab 只在实际 push 时处理 MR push-options。请使用 API/UI 创建 MR 后运行 watch，工具不会为触发 push-option 改写历史或 force push。');
    }

    const title = flag(args.flags, 'title')
      ? oneLine(flag(args.flags, 'title'), 'title', 240)
      : oneLine(git(['show', '-s', '--format=%s', snapshot.head], record.path), 'title', 240);
    const description = flag(args.flags, 'description')
      ? oneLine(flag(args.flags, 'description'), 'description', 1000)
      : null;
    const pushArgs = gitlabSubmitPushArgs({
      remote,
      sourceBranch: record.branch,
      targetBranch,
      title,
      description,
      removeSourceBranch: provider.remove_source_branch,
    });
    const pushed = runFileCapture('git', pushArgs, { cwd: record.path, timeoutMs: SUBMIT_PUSH_TIMEOUT_MS });
    if (!pushed.ok) {
      const detail = pushed.out || pushed.error?.message || `exit=${pushed.status}`;
      die(`GitLab MR push 失败；trace/watcher 未更新。\n${detail}`);
    }

    const submittedAt = new Date().toISOString();
    const mergeRequestUrl = parseGitlabMergeRequestUrl(pushed.out);
    const changeRef = mergeRequestUrl ?? `GitLab MR ${record.branch} -> ${targetBranch}`;
    record = appendTraceEvent({
      commonDir: loaded.context.common_dir,
      worktreeId: record.worktree_id,
      eventType: 'change_submitted',
      actor: record.agent,
      details: {
        provider: 'gitlab',
        change_ref: changeRef,
        source_branch: record.branch,
        target_branch: targetBranch,
        head_sha: snapshot.head,
        title,
      },
      mutate(current) {
        if (!['active', 'ready_for_review'].includes(current.task_status)) {
          throw new WorktreeTraceError('SUBMIT_STATE_CHANGED', `submit 期间 task_status 变为 ${current.task_status}`);
        }
        const next = structuredClone(current);
        next.task_status = 'ready_for_review';
        next.last_seen_at = submittedAt;
        next.last_head = snapshot.head;
        next.change_request = {
          provider: 'gitlab',
          state: 'submitted',
          change_ref: changeRef,
          url: mergeRequestUrl,
          source_branch: record.branch,
          target_branch: targetBranch,
          head_sha: snapshot.head,
          title,
          submitted_at: submittedAt,
        };
        next.updated_at = submittedAt;
        return next;
      },
    }).record;

    const intervalMs = parseWatchInterval(flag(args.flags, 'interval-ms'));
    const notifyMode = parseNotifyMode(flag(args.flags, 'notify'));
    try {
      const started = startWatcher(loaded, record, {
        targetRef,
        targetSha: refreshed.target_sha,
        headSha: snapshot.head,
        intervalMs,
        changeRef,
        notifyMode,
        explicitConfig: flag(args.flags, 'config') ? loaded.profile_path : null,
        previousHealth: null,
        armedBy: 'explicit',
      });
      log(`GitLab MR 已提交: ${changeRef}`);
      log(`auto-reclaim watcher 已启动 pid=${started.pid} id=${record.worktree_id.slice(0, 8)} head=${snapshot.head.slice(0, 12)} target=${targetRef}`);
    } catch (error) {
      console.error(`${PREFIX} MR 已成功 push 且 trace 已标记 ready_for_review，但 watcher 启动失败；请运行 watch/resume-all 恢复。`);
      throw error;
    }
  }

  /** @param {Record<string,any>} record */

  function cmdWatch(args) {
    rejectUnknownFlags(args.flags, ['target', 'interval-ms', 'change-ref', 'notify', 'id', 'config']);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    let record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
    assertHistoryOperationIdle(record, 'watch');
    if (record.worktree_state === 'reclaimed') { log(`已回收，无需 watch: ${record.worktree_id}`); return; }
    const existing = record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)
      ? record.auto_reclaim
      : null;
    if (!existing && record.task_status !== 'ready_for_review') {
      die(`首次 watch 要求 task_status=ready_for_review，当前为 ${record.task_status}。`);
    }
    if (existing && !['ready_for_review', 'integrating', 'done'].includes(record.task_status)) {
      die(`恢复 watch 要求状态为 ready_for_review/integrating/done，当前为 ${record.task_status}。`);
    }

    const snapshot = liveGitSnapshot(record);
    if (!snapshot.present) die('watch 要求 worktree 仍存在。');
    if (!existing && snapshot.dirty !== false) die('首次 watch 要求工作树干净（含 untracked 必须为空）。');
    const headSha = existing?.head_sha ?? snapshot.head;
    if (!headSha || !gitTry(['cat-file', '-e', `${headSha}^{commit}`], loaded.context.current_worktree).ok) {
      die('无法冻结有效的 MR head SHA。');
    }
    if (!existing) {
      const upstream = gitTry(['rev-parse', '@{upstream}^{commit}'], record.path);
      if (!upstream.ok || upstream.out !== headSha) {
        die('watch 前必须把当前 HEAD 完整 push 到 upstream；本地 HEAD 与 upstream SHA 不一致。');
      }
    }

    const targetRef = oneLine(flag(args.flags, 'target') ?? existing?.target_ref ?? record.base_ref, 'target', 240);
    if (existing && flag(args.flags, 'target') && targetRef !== existing.target_ref) {
      // 人工显式武装过的目标不被静默改写；但 touch 的自动武装只是默认动作，
      // 调用者当轮显式给出的 target 优先，直接改指而不是要求先 unwatch。
      if (existing.armed_by !== 'auto_touch') {
        die(`已 arm 的 target=${existing.target_ref}；先 unwatch 再更换目标。`);
      }
      log(`自动武装的 target=${existing.target_ref} 按当轮显式指引改为 ${targetRef}。`);
    }
    const intervalMs = parseWatchInterval(flag(args.flags, 'interval-ms') ?? existing?.interval_ms);
    const changeRef = flag(args.flags, 'change-ref')
      ? oneLine(flag(args.flags, 'change-ref'), 'change-ref', 240)
      : existing?.change_ref ?? null;
    const notifyMode = parseNotifyMode(flag(args.flags, 'notify') ?? existing?.notify);
    const refreshed = refreshTargetRef(targetRef, loaded.context.current_worktree);
    if (!refreshed.ok) die(`目标 ref 不存在: ${targetRef}`);

    const heartbeat = readWatcherHeartbeat(loaded.context.common_dir, record.worktree_id);
    const health = watcherHealth(record, heartbeat);
    if (existing && health.healthy && existing.head_sha === headSha && existing.target_ref === targetRef && (existing.change_ref ?? null) === changeRef && (existing.notify ?? 'auto') === notifyMode) {
      log(`watcher 已运行 pid=${heartbeat.state.pid} id=${record.worktree_id.slice(0, 8)} target=${targetRef}`);
      return;
    }
    try {
      const started = startWatcher(loaded, record, {
        targetRef,
        targetSha: refreshed.target_sha,
        headSha,
        intervalMs,
        changeRef,
        notifyMode,
        explicitConfig: flag(args.flags, 'config') ? loaded.profile_path : null,
        previousHealth: health.reason,
        armedBy: 'explicit',
      });
      record = started.record;
      log(`auto-reclaim watcher 已启动 pid=${started.pid} id=${record.worktree_id.slice(0, 8)} head=${headSha.slice(0, 12)} target=${targetRef}`);
    } catch (error) {
      if (error instanceof WorktreeTraceError && error.code === 'WATCHER_CANCELLED') {
        die('watcher 启动期间被另一进程解除，请重新检查 record 状态。');
      }
      throw error;
    }
  }

  function cmdResumeAll(args) {
    rejectUnknownFlags(args.flags, ['json', 'config']);
    if (args.positionals.length) die('resume-all 不接受 selector；它只扫描已 arm record。', 2);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const result = { resumed: [], healthy: [], skipped: [] };
    const records = loadRecords(loaded.context.common_dir).filter((record) =>
      record.auto_reclaim &&
      !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state) &&
      // archive 的前置条件本身已经要求 watcher 先 disarm，正常路径不会走到这里；这里保留
      // 一道防线，避免归档记录被任何遗留/异常状态误当作待恢复 watcher。
      record.worktree_state !== 'reclaimed' && record.worktree_state !== 'archived');
    for (const record of records) {
      const heartbeat = readWatcherHeartbeat(loaded.context.common_dir, record.worktree_id);
      const health = watcherHealth(record, heartbeat);
      if (health.healthy) {
        result.healthy.push({ worktree_id: record.worktree_id, task: record.task, pid: heartbeat.state.pid });
        continue;
      }
      const auto = record.auto_reclaim;
      const intervalMs = Number(auto.interval_ms);
      const snapshot = liveGitSnapshot(record);
      let reason = null;
      if (!['ready_for_review', 'integrating', 'done'].includes(record.task_status)) reason = `task_status=${record.task_status}`;
      else if (!snapshot.present && record.worktree_state !== 'reclaim_ready') reason = 'worktree missing';
      else if (!auto.head_sha || !gitTry(['cat-file', '-e', `${auto.head_sha}^{commit}`], loaded.context.current_worktree).ok) reason = 'frozen head unreachable';
      else if (!auto.target_ref || typeof auto.target_ref !== 'string') reason = 'target ref missing';
      else if (!Number.isInteger(intervalMs) || intervalMs < WATCH_MIN_INTERVAL_MS || intervalMs > WATCH_MAX_INTERVAL_MS) reason = 'interval invalid';
      if (reason) {
        result.skipped.push({ worktree_id: record.worktree_id, task: record.task, reason });
        continue;
      }
      try {
        const started = startWatcher(loaded, record, {
          targetRef: auto.target_ref,
          targetSha: auto.target_base_sha ?? record.base_sha ?? null,
          headSha: auto.head_sha,
          intervalMs,
          changeRef: auto.change_ref ?? null,
          notifyMode: auto.notify ?? 'auto',
          explicitConfig: flag(args.flags, 'config') ? loaded.profile_path : null,
          previousHealth: health.reason,
          armedBy: auto.armed_by ?? 'explicit',
        });
        result.resumed.push({ worktree_id: record.worktree_id, task: record.task, pid: started.pid, previous_health: health.reason, dirty: snapshot.dirty });
      } catch (error) {
        result.skipped.push({ worktree_id: record.worktree_id, task: record.task, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (args.flags.get('json')) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    log(`resume-all resumed=${result.resumed.length} healthy=${result.healthy.length} skipped=${result.skipped.length}`);
    for (const item of result.resumed) console.log(`  [RESUMED] ${item.worktree_id.slice(0, 8)} ${item.task} pid=${item.pid} previous=${item.previous_health}${item.dirty ? ' dirty=blocked-until-clean' : ''}`);
    for (const item of result.healthy) console.log(`  [HEALTHY] ${item.worktree_id.slice(0, 8)} ${item.task} pid=${item.pid}`);
    for (const item of result.skipped) console.log(`  [SKIPPED] ${item.worktree_id.slice(0, 8)} ${item.task} ${item.reason}`);
  }

  function cmdUnwatch(args) {
    rejectUnknownFlags(args.flags, ['id', 'config']);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    let record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
    const token = record.auto_reclaim?.token;
    if (!token || ['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)) {
      log(`watcher 未 arm: ${record.worktree_id.slice(0, 8)}`);
      return;
    }
    if (record.auto_reclaim.state === 'merge_detected') {
      die('目标分支已确认包含冻结的 MR head，自动回收已进入提交阶段，不能再 unwatch。');
    }
    record = appendReclaimEvent(loaded.context.common_dir, record, 'auto_reclaim_disarmed', (next) => {
      next.auto_reclaim.state = 'disarmed';
      next.auto_reclaim.disarmed_at = new Date().toISOString();
    });
    removeWatcherHeartbeat(loaded.context.common_dir, record.worktree_id, token);
    log(`auto-reclaim watcher 已解除: ${record.worktree_id.slice(0, 8)}`);
  }

  function cmdWatchWorker(args) {
    rejectUnknownFlags(args.flags, ['id', 'token', 'config']);
    const worktreeId = flag(args.flags, 'id');
    const token = flag(args.flags, 'token');
    if (!worktreeId || !token) die('watch-worker 需要 --id 与 --token。', 2);
    while (true) {
      const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
      let record = loadRecords(loaded.context.common_dir).find((candidate) => candidate.worktree_id === worktreeId);
      if (!record || record.worktree_state === 'reclaimed' || record.auto_reclaim?.token !== token || record.auto_reclaim?.state === 'disarmed') {
        removeWatcherHeartbeat(loaded.context.common_dir, worktreeId, token);
        return;
      }
      const baseHeartbeat = {
        schema_version: 1,
        worktree_id: worktreeId,
        pid: process.pid,
        token,
        target_ref: record.auto_reclaim.target_ref,
        head_sha: record.auto_reclaim.head_sha,
        started_at: record.auto_reclaim.started_at ?? record.auto_reclaim.armed_at,
      };
      const cacheMaxAgeMs = Math.min(WATCH_TARGET_CACHE_MAX_AGE_MS, Math.max(Math.floor(record.auto_reclaim.interval_ms / 2), WATCH_MIN_INTERVAL_MS));
      const refreshed = refreshTargetRefCached(loaded.context.common_dir, record.auto_reclaim.target_ref, loaded.context.current_worktree, cacheMaxAgeMs);
      if (!refreshed.fetch_ok || !refreshed.ok) {
        writeWatcherHeartbeat(loaded.context.common_dir, { ...baseHeartbeat, state: 'waiting', blocked_reason: 'target fetch/ref unavailable', fetch_cache_hit: refreshed.cache_hit ?? false });
        sleep(record.auto_reclaim.interval_ms);
        continue;
      }
      const headMerged = gitTry(['merge-base', '--is-ancestor', record.auto_reclaim.head_sha, refreshed.target_sha], loaded.context.current_worktree).ok;
      if (!headMerged) {
        const targetBaseSha = record.auto_reclaim.target_base_sha ?? record.base_sha ?? null;
        const targetAdvanced = refreshed.target_sha !== targetBaseSha;
        let advance = record.auto_reclaim.target_advance ?? null;
        if (targetAdvanced && advance?.target_sha !== refreshed.target_sha) {
          const prediction = predictReviewRefresh(record.path, targetBaseSha, refreshed.target_sha, record.auto_reclaim.head_sha);
          try {
            record = appendWatchedEvent(loaded.context.common_dir, record, token, 'target_advanced', (next) => {
              next.auto_reclaim.target_advance = {
                target_sha: refreshed.target_sha,
                recorded_base_sha: targetBaseSha,
                prediction,
                detected_at: new Date().toISOString(),
              };
            }, {
              target_ref: record.auto_reclaim.target_ref,
              target_sha: refreshed.target_sha,
              recorded_base_sha: targetBaseSha,
              head_sha: record.auto_reclaim.head_sha,
              prediction,
            });
            advance = record.auto_reclaim.target_advance;
          } catch (error) {
            if (error instanceof WorktreeTraceError && error.code === 'WATCHER_CANCELLED') {
              removeWatcherHeartbeat(loaded.context.common_dir, worktreeId, token);
              return;
            }
            throw error;
          }
        }
        const predictionState = advance?.prediction?.state ?? null;
        const blockedReason = predictionState
          ? `target advanced; refresh prediction=${predictionState}`
          : null;
        writeWatcherHeartbeat(loaded.context.common_dir, { ...baseHeartbeat, state: 'waiting', blocked_reason: blockedReason, target_sha: refreshed.target_sha, refresh_prediction: predictionState, fetch_cache_hit: refreshed.cache_hit ?? false, fetch_count: refreshed.fetch_count ?? null });
        sleep(record.auto_reclaim.interval_ms);
        continue;
      }
      try {
        if (record.auto_reclaim.state !== 'merge_detected') {
          record = appendWatchedEvent(loaded.context.common_dir, record, token, 'merge_detected', (next) => {
            next.auto_reclaim.state = 'merge_detected';
            next.auto_reclaim.target_sha = refreshed.target_sha;
            next.auto_reclaim.detected_at = new Date().toISOString();
          }, { target_ref: record.auto_reclaim.target_ref, target_sha: refreshed.target_sha, head_sha: record.auto_reclaim.head_sha });
        }
        if (record.task_status === 'ready_for_review') record = appendAutoStatus(loaded.context.common_dir, record, token, 'auto_integrating', refreshed.target_sha);
        if (record.task_status === 'integrating') record = appendAutoStatus(loaded.context.common_dir, record, token, 'auto_done', refreshed.target_sha);
      } catch (error) {
        if (error instanceof WorktreeTraceError && error.code === 'WATCHER_CANCELLED') {
          removeWatcherHeartbeat(loaded.context.common_dir, worktreeId, token);
          return;
        }
        throw error;
      }
      if (record.task_status !== 'done') {
        writeWatcherHeartbeat(loaded.context.common_dir, { ...baseHeartbeat, state: 'blocked', blocked_reason: `task_status=${record.task_status}`, target_sha: refreshed.target_sha, fetch_cache_hit: refreshed.cache_hit ?? false });
        sleep(record.auto_reclaim.interval_ms);
        continue;
      }
      const preflight = reclaimPreflight(loaded, record, refreshed.target_sha);
      if (preflight.reason) {
        writeWatcherHeartbeat(loaded.context.common_dir, { ...baseHeartbeat, state: 'blocked', blocked_reason: preflight.reason, target_sha: refreshed.target_sha, fetch_cache_hit: refreshed.cache_hit ?? false });
        sleep(record.auto_reclaim.interval_ms);
        continue;
      }
      const result = reclaimRecord(loaded, record, refreshed.target_sha, { recordBlocked: false });
      if (result.reclaimed) {
        removeWatcherHeartbeat(loaded.context.common_dir, worktreeId, token);
        return;
      }
      writeWatcherHeartbeat(loaded.context.common_dir, { ...baseHeartbeat, state: 'blocked', blocked_reason: result.reason, target_sha: refreshed.target_sha, fetch_cache_hit: refreshed.cache_hit ?? false });
      sleep(record.auto_reclaim.interval_ms);
    }
  }



  return {
    autoArmReviewWatch,
    startWatcher,
    cmdSubmit,
    cmdWatch,
    cmdResumeAll,
    cmdUnwatch,
    cmdWatchWorker,
  };
}
