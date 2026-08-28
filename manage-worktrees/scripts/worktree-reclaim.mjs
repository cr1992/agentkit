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
    rmSync,
    statSync,
    join,
    resolve,
    loadRepositoryProfile,
    WorktreeTraceError,
    appendTraceEvent,
    TERMINAL_TASK_STATES,
    git,
    gitTry,
    commandFailureReason,
    deliverReclaimNotification,
    log,
    die,
    flag,
    rejectUnknownFlags,
    oneLine,
    parseWorktrees,
    loadRecords,
    sameAgentSession,
    canonicalSelectorPath,
    selectRecord,
    liveGitSnapshot,
    exactCommitOid,
    resolvableCommitOid,
    gitOperationState,
  } = deps;

  function appendReclaimEvent(commonDir, record, type, update, details = {}) {
    return appendTraceEvent({ commonDir, worktreeId: record.worktree_id, eventType: type, actor: record.agent, details, mutate(current) { const next = structuredClone(current); update(next); next.updated_at = new Date().toISOString(); return next; } }).record;
  }

  /**
   * watcher 与 unwatch 以同一条 record lock 为裁决边界：谁先写入 event，谁赢。
   * 这样即使两个进程同时动作，已解除的 token 也不能靠旧 record 快照复活。
   * @param {string} commonDir
   * @param {Record<string,any>} record
   * @param {string} token
   * @param {string} type
   * @param {(next:Record<string,any>)=>void} update
   * @param {Record<string,any>} [details]
   */
  function appendWatchedEvent(commonDir, record, token, type, update, details = {}) {
    return appendTraceEvent({
      commonDir,
      worktreeId: record.worktree_id,
      eventType: type,
      actor: record.agent,
      details,
      mutate(current) {
        if (current.auto_reclaim?.token !== token || ['disarmed', 'reclaimed'].includes(current.auto_reclaim?.state)) {
          throw new WorktreeTraceError('WATCHER_CANCELLED', `watch token 已失效: ${record.worktree_id}`);
        }
        const next = structuredClone(current);
        update(next);
        next.updated_at = new Date().toISOString();
        return next;
      },
    }).record;
  }

  /** @param {Record<string,any>} record */
  function supersededArchiveRef(record) {
    return `refs/worktree-archive/superseded/${record.worktree_id}`;
  }

  /** @param {Record<string,any>} record */
  function evidenceArchiveRef(record) {
    return `refs/worktree-archive/evidence/${record.worktree_id}`;
  }

  /**
   * 归档只用于已冻结终态的本地批次证据候选；它保存精确 Git object，不伪装成已推送或已合入。
   * @param {ReturnType<typeof loadRepositoryProfile>} loaded
   * @param {Record<string,any>} candidate
   * @param {string} candidateInput
   * @param {string} reasonInput
   */
  function prepareEvidenceArchiveReclaim(loaded, candidate, candidateInput, reasonInput) {
    const batch = candidate.batch_integration;
    const result = candidate.batch_result;
    if (!batch || batch.state !== 'composed') die('reclaim --archive-evidence 只接受已合成的 batch integration candidate。', 2);
    if (!result || !['passed', 'failed', 'stale'].includes(result.outcome)) {
      die('候选尚未通过 batch-result 冻结 passed/failed/stale，拒绝归档回收。', 2);
    }
    if (candidate.task_status !== 'done') die(`证据候选必须处于 done；当前 ${candidate.task_status}。`, 2);
    const sourceSha = exactCommitOid(loaded.context.current_worktree, candidateInput, '--archive-evidence');
    const reason = oneLine(reasonInput, '--reason', 500);
    const snapshot = liveGitSnapshot(candidate);
    const liveHead = snapshot.head ?? candidate.last_head ?? candidate.reclaim_summary?.source_sha ?? null;
    if (!liveHead || liveHead.toLowerCase() !== sourceSha) die(`--archive-evidence 与候选 HEAD 不一致：expected ${liveHead ?? 'unknown'}`, 2);
    if (result.candidate_sha !== sourceSha) die(`--archive-evidence 与 batch_result.candidate_sha 不一致：expected ${result.candidate_sha}`, 2);
    const preflight = reclaimPreflight(loaded, candidate, sourceSha);
    if (preflight.reason) die(`证据候选尚未达到归档前置条件：${preflight.reason}`, 2);

    const archiveRef = evidenceArchiveRef(candidate);
    if (candidate.evidence_archive && (
      candidate.evidence_archive.source_sha !== sourceSha ||
      candidate.evidence_archive.archive_ref !== archiveRef ||
      candidate.evidence_archive.batch_result_digest !== result.result_digest ||
      candidate.evidence_archive.reason !== reason
    )) die('该候选已经登记不同的证据归档，拒绝改写。', 2);
    const existing = gitTry(['rev-parse', '--verify', archiveRef], loaded.context.current_worktree);
    if (existing.ok && existing.out.toLowerCase() !== sourceSha) die(`归档 ref 已指向其他提交：${archiveRef} -> ${existing.out}`, 2);
    if (!existing.ok) {
      const archived = gitTry(['update-ref', archiveRef, sourceSha, '0'.repeat(sourceSha.length)], loaded.context.current_worktree);
      if (!archived.ok) die(commandFailureReason(archived, `无法创建归档 ref ${archiveRef}`));
    }
    const verified = gitTry(['rev-parse', '--verify', archiveRef], loaded.context.current_worktree);
    if (!verified.ok || verified.out.toLowerCase() !== sourceSha) die(`归档 ref 校验失败：${archiveRef}`, 2);
    const evidence = {
      kind: 'batch_evidence_archive',
      source_sha: sourceSha,
      archive_ref: archiveRef,
      outcome: result.outcome,
      fingerprint: batch.fingerprint,
      target_sha: batch.target_sha,
      ordered_input_shas: (batch.ordered_inputs ?? []).map((item) => item.head),
      batch_result_digest: result.result_digest,
      evidence_manifest_digest: result.evidence_manifest_digest,
      reason,
    };
    let record = candidate;
    if (!record.evidence_archive) {
      record = appendReclaimEvent(loaded.context.common_dir, record, 'batch_evidence_head_archived', (next) => {
        next.evidence_archive = { ...evidence, archived_at: new Date().toISOString() };
      }, evidence);
    }
    return { record, sourceSha, evidence };
  }

  /**
   * superseded reclaim 比普通 pushed reclaim 多两层证据：双向替代关系必须完整，且替代树不能脏。
   * 旧树的普通干净/stash/submodule 检查仍统一交给 reclaimPreflight。
   * @param {ReturnType<typeof loadRepositoryProfile>} loaded
   * @param {Record<string,any>} superseded
   * @param {Record<string,any>} replacement
   * @param {string|null} discardSha
   */
  function prepareSupersededReclaim(loaded, superseded, replacement, discardSha) {
    if (superseded.task_status !== 'abandoned') {
      die(`reclaim --superseded-by 只接受 abandoned 旧树；当前 ${superseded.task_status}。`, 2);
    }
    if (!sameAgentSession(superseded, replacement)) die('旧树与替代树不属于同一 Agent 会话。', 2);
    if (superseded.owner && replacement.owner && superseded.owner !== replacement.owner) {
      die(`旧树与替代树 owner 不一致：${superseded.owner} != ${replacement.owner}。`, 2);
    }
    if (
      superseded.superseded_by?.worktree_id !== replacement.worktree_id ||
      replacement.delivery_relation?.kind !== 'supersedes' ||
      replacement.delivery_relation.superseded_worktree_id !== superseded.worktree_id ||
      !replacement.delivery_relation.related_worktree_ids?.includes(superseded.worktree_id)
    ) {
      die('替代关系未双向登记；先运行 supersede <old> --by <new> --reason <原因>。', 2);
    }
    const replacementSnapshot = liveGitSnapshot(replacement);
    if (replacement.worktree_state !== 'reclaimed') {
      if (!replacementSnapshot.present) die(`替代 worktree missing: ${replacement.path}`, 2);
      if (replacementSnapshot.dirty !== false) die(`替代 worktree 必须干净：${replacement.path}`, 2);
    }
    const supersededSnapshot = liveGitSnapshot(superseded);
    const sourceSha = supersededSnapshot.head ?? superseded.last_head ?? superseded.reclaim_summary?.source_sha ?? null;
    if (!sourceSha) die('无法确定被替代树的精确 HEAD，拒绝回收。', 2);
    exactCommitOid(loaded.context.current_worktree, sourceSha, '旧树 HEAD');
    const preflight = reclaimPreflight(loaded, superseded, sourceSha);
    if (preflight.reason) {
      die(`被替代树尚未达到归档/丢弃前置条件：${preflight.reason}`, 2);
    }

    let record = superseded;
    let evidence;
    if (discardSha) {
      if (!new RegExp(`^[0-9a-f]{${sourceSha.length}}$`, 'i').test(discardSha)) {
        die(`--discard 必须填写 ${sourceSha.length} 位旧树精确 HEAD。`, 2);
      }
      if (discardSha.toLowerCase() !== sourceSha.toLowerCase()) {
        die(`--discard SHA 与旧树 HEAD 不一致：expected ${sourceSha}`, 2);
      }
      if (record.superseded_recovery && (
        record.superseded_recovery.mode !== 'discard' ||
        record.superseded_recovery.source_sha !== sourceSha
      )) {
        die('该旧树已经登记不同的恢复策略，拒绝改写。', 2);
      }
      evidence = {
        kind: 'superseded_discard',
        source_sha: sourceSha,
        replacement_worktree_id: replacement.worktree_id,
        replacement_task: replacement.task,
      };
      if (!record.superseded_recovery) {
        record = appendReclaimEvent(loaded.context.common_dir, record, 'superseded_head_discard_authorized', (next) => {
          next.superseded_recovery = { mode: 'discard', ...evidence, authorized_at: new Date().toISOString() };
        }, evidence);
      }
    } else {
      const archiveRef = supersededArchiveRef(record);
      if (record.superseded_recovery && (
        record.superseded_recovery.mode !== 'archive_ref' ||
        record.superseded_recovery.source_sha !== sourceSha ||
        record.superseded_recovery.archive_ref !== archiveRef
      )) {
        die('该旧树已经登记不同的恢复策略，拒绝改写。', 2);
      }
      const existing = gitTry(['rev-parse', '--verify', archiveRef], loaded.context.current_worktree);
      if (existing.ok && existing.out !== sourceSha) {
        die(`归档 ref 已指向其他提交：${archiveRef} -> ${existing.out}`, 2);
      }
      if (!existing.ok) {
        const archived = gitTry(['update-ref', archiveRef, sourceSha, '0'.repeat(sourceSha.length)], loaded.context.current_worktree);
        if (!archived.ok) die(commandFailureReason(archived, `无法创建归档 ref ${archiveRef}`));
      }
      const verified = gitTry(['rev-parse', '--verify', archiveRef], loaded.context.current_worktree);
      if (!verified.ok || verified.out !== sourceSha) die(`归档 ref 校验失败：${archiveRef}`, 2);
      evidence = {
        kind: 'superseded_archive',
        source_sha: sourceSha,
        archive_ref: archiveRef,
        replacement_worktree_id: replacement.worktree_id,
        replacement_task: replacement.task,
      };
      if (!record.superseded_recovery) {
        record = appendReclaimEvent(loaded.context.common_dir, record, 'superseded_head_archived', (next) => {
          next.superseded_recovery = { mode: 'archive_ref', ...evidence, archived_at: new Date().toISOString() };
        }, evidence);
      }
    }
    return { record, sourceSha, evidence };
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {string} pushed */
  function reclaimPreflight(loaded, record, pushed) {
    const stash = gitTry(['stash', 'list'], loaded.context.current_worktree);
    const live = parseWorktrees(loaded.context.current_worktree).find((worktree) => worktree.path === canonicalSelectorPath(record.path));
    const dangling = live ? inspectDanglingSubmodulePointers(live.path) : { reason: null };
    const status = live ? gitTry(['status', '--porcelain'], live.path) : { ok: true, out: '' };
    const operation = live ? gitOperationState(live.path) : null;
    const commit = record.branch && gitTry(['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`], loaded.context.current_worktree).ok
      ? record.branch
      : record.last_head;
    const merged = commit ? gitTry(['merge-base', '--is-ancestor', commit, pushed], loaded.context.current_worktree).ok : false;
    const reason = dangling.reason
      ? dangling.reason
      : stash.ok && stash.out
      ? 'repository has stash entries'
      : operation
        ? `git operation in progress: ${operation}`
      : !status.ok || status.out
        ? 'worktree dirty/unreadable'
        : !merged
          ? 'branch/head not merged into pushed sha'
          : null;
    return { reason, live };
  }

  /**
   * `--pushed` 必须由候选自身分支之外的持久 ref 保护，否则传入 HEAD 自己会在删分支后丢失证据。
   * @param {ReturnType<typeof loadRepositoryProfile>} loaded
   * @param {Record<string,any>} record
   * @param {string} pushed
   */
  function protectingRefsForPushed(loaded, record, pushed) {
    const refs = gitTry([
      'for-each-ref', '--format=%(refname)', '--contains', pushed,
      'refs/heads', 'refs/remotes', 'refs/tags', 'refs/worktree-archive',
    ], loaded.context.current_worktree);
    if (!refs.ok) die(commandFailureReason(refs, '无法枚举保护 --pushed SHA 的 refs。'));
    const ownBranch = record.branch ? `refs/heads/${record.branch}` : null;
    return refs.out.split('\n').filter(Boolean).filter((ref) => ref !== ownBranch).sort();
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record */
  function localBranchExists(loaded, record) {
    return Boolean(record.branch) && gitTry(
      ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`],
      loaded.context.current_worktree,
    ).ok;
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {string} pushed */
  function attemptLocalBranchCleanup(loaded, record, pushed) {
    const checkedAt = new Date().toISOString();
    const previousAttempts = Number(record.branch_cleanup?.attempts ?? 0);
    if (!record.branch || !localBranchExists(loaded, record)) {
      return {
        status: 'absent',
        branch: record.branch ?? null,
        attempts: previousAttempts,
        checked_at: checkedAt,
        reason: null,
      };
    }
    if (!gitTry(['merge-base', '--is-ancestor', record.branch, pushed], loaded.context.current_worktree).ok) {
      return {
        status: 'failed',
        branch: record.branch,
        attempts: previousAttempts + 1,
        checked_at: checkedAt,
        reason: `local branch tip is not merged into pushed sha: ${pushed}`,
      };
    }
    const removed = gitTry(['branch', '-D', '--', record.branch], loaded.context.current_worktree);
    if (removed.ok) {
      return {
        status: 'deleted',
        branch: record.branch,
        attempts: previousAttempts + 1,
        checked_at: checkedAt,
        reason: null,
      };
    }
    return {
      status: 'failed',
      branch: record.branch,
      attempts: previousAttempts + 1,
      checked_at: checkedAt,
      reason: commandFailureReason(removed, 'git branch -D failed'),
    };
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record @param {string} pushed */
  function reconcileReclaimedBranchCleanup(loaded, record, pushed) {
    const branchExists = localBranchExists(loaded, record);
    if (['deleted', 'absent'].includes(record.branch_cleanup?.status) && !branchExists) {
      return { record, branch_cleanup: record.branch_cleanup, changed: false };
    }
    const cleanup = attemptLocalBranchCleanup(loaded, record, pushed);
    const updated = appendReclaimEvent(loaded.context.common_dir, record, 'branch_cleanup_retried', (next) => {
      next.branch_cleanup = cleanup;
      if (next.reclaim_summary) next.reclaim_summary.branch_cleanup = cleanup;
    }, { pushed, branch_cleanup: cleanup });
    return { record: updated, branch_cleanup: cleanup, changed: true };
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record */
  function reconcileReclaimedTerminalState(loaded, record) {
    const finalEpoch = record.ownership_epochs?.at(-1);
    const needsStatus = !TERMINAL_TASK_STATES.has(record.task_status);
    const needsEpoch = Boolean(finalEpoch && !finalEpoch.ended_at);
    if (!needsStatus && !needsEpoch) return { record, changed: false };
    const branchHead = record.branch
      ? gitTry(['rev-parse', '--verify', record.branch], loaded.context.current_worktree)
      : { ok: false, out: '' };
    const endSha = branchHead.ok
      ? branchHead.out
      : record.last_head ?? record.reclaim_summary?.source_sha ?? null;
    const completedAt = record.reclaimed_at ?? new Date().toISOString();
    const updated = appendReclaimEvent(loaded.context.common_dir, record, 'reclaim_terminal_reconciled', (next) => {
      if (next.task_status !== 'abandoned') next.task_status = 'done';
      const epoch = next.ownership_epochs?.at(-1);
      if (epoch && !epoch.ended_at && endSha) {
        epoch.end_sha = endSha;
        epoch.ended_at = completedAt;
      }
    }, { task_status: needsStatus ? 'done' : record.task_status, end_sha: endSha });
    return { record: updated, changed: true };
  }

  /**
   * 从 .gitmodules 枚举登记的 submodule 路径。不打开任何 submodule 仓库——
   * `git submodule status` 在 .git 指针悬空（指向已删元数据）时整条命令 fatal，
   * 残骸清理阶段只能走这条纯文件读取的枚举。
   * @param {string} worktreePath
   */
  function registeredSubmodulePaths(worktreePath) {
    const config = gitTry(['config', '-f', '.gitmodules', '--get-regexp', String.raw`^submodule\..*\.path$`], worktreePath);
    if (!config.ok || !config.out) return [];
    return config.out.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/).slice(1).join(' '))
      .filter(Boolean);
  }

  /**
   * 读 submodule 工作目录 .git 指针文件的 gitdir 目标（绝对路径）。
   * 缺失、真目录（嵌入式仓库）或格式不符时返回 null。
   * @param {string} submoduleDir
   */
  function submoduleGitPointerTarget(submoduleDir) {
    const gitPointer = join(submoduleDir, '.git');
    if (!existsSync(gitPointer) || statSync(gitPointer).isDirectory()) return null;
    let content;
    try {
      content = readFileSync(gitPointer, 'utf8');
    } catch {
      return null;
    }
    const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
    return match ? resolve(submoduleDir, match[1]) : null;
  }

  /**
   * 检测悬空 .git 指针。元数据缺失时无法证明目录内容干净，因此必须 fail-closed 返回 KEEP，
   * 由人工检查并修复；不能把不可审计内容当作残骸自动删除。
   * @param {string} worktreePath
   */
  function inspectDanglingSubmodulePointers(worktreePath) {
    for (const submodulePath of registeredSubmodulePaths(worktreePath)) {
      const submoduleDir = join(worktreePath, submodulePath);
      const target = submoduleGitPointerTarget(submoduleDir);
      if (!target || existsSync(target)) continue;
      return { reason: `submodule has dangling .git pointer and cannot be audited safely: ${submodulePath}` };
    }
    return { reason: null };
  }

  /**
   * `git submodule status` 每行前缀标出初始化状态：'-' = 未初始化，其余（空格/'+'/'U'）均已初始化。
   * 未初始化的也要列出：它可能留有历史清理残骸（树私有 modules/ 元数据、工作目录里的
   * .git 指针文件），同样会让 `git worktree remove` 拒绝或 fatal。
   * @param {string} worktreePath
   * @returns {Array<{path:string,initialized:boolean}>}
   */
  function listSubmoduleEntries(worktreePath) {
    const status = gitTry(['submodule', 'status'], worktreePath);
    if (!status.ok || !status.out) return [];
    return status.out.split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => ({ initialized: line[0] !== '-', path: line.trim().split(/\s+/)[1] }))
      .filter((entry) => Boolean(entry.path));
  }

  /**
   * deinit 完成（或本就未初始化）的 submodule 工作目录必须为空；任何残留都无法被 Git
   * 可靠审计，保守返回 KEEP，不执行递归删除。
   * @param {string} worktreePath @param {string} submodulePath
   */
  function ensureSubmoduleWorkdirEmpty(worktreePath, submodulePath) {
    const submoduleDir = join(worktreePath, submodulePath);
    if (!existsSync(submoduleDir)) return { reason: null };
    try {
      const entries = readdirSync(submoduleDir);
      if (entries.length > 0) return { reason: `uninitialized submodule workdir is not empty: ${submodulePath}` };
    } catch (error) {
      return { reason: `failed to inspect submodule workdir: ${submodulePath}: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { reason: null };
  }

  /**
   * 含 submodule 的树即使标准四项审计（台账/干净/已合入/无 stash）通过，`git worktree remove`
   * 非 force 仍会因树私有的 submodule 克隆元数据（$GIT_COMMON_DIR/worktrees/<id>/modules/）拒绝。
   * 逐个校验已初始化 submodule 工作区干净后 deinit，再清理该元数据与各 submodule 工作目录
   * 残骸，为后续 remove 让路；任一 submodule 脏则不动它，原样返回让调用方 KEEP。
   * 清理触发看「元数据/残骸是否存在」而非初始化状态：submodule 已被 deinit 但元数据或
   * .git 指针残留时（历史清理中断的产物），同样要收拾干净。
   * @param {string} worktreePath
   */
  function reclaimSubmodules(worktreePath) {
    const entries = listSubmoduleEntries(worktreePath);
    const gitDir = gitTry(['rev-parse', '--absolute-git-dir'], worktreePath);
    const modulesDir = gitDir.ok && gitDir.out ? join(gitDir.out, 'modules') : null;
    const hasModulesMetadata = modulesDir !== null && existsSync(modulesDir);
    if (entries.length === 0 && !hasModulesMetadata) return { reason: null };
    for (const entry of entries) {
      if (entry.initialized) {
        const status = gitTry(['status', '--porcelain'], join(worktreePath, entry.path));
        if (!status.ok || status.out) return { reason: `submodule dirty/unreadable: ${entry.path}` };
      } else {
        const gitPointer = join(worktreePath, entry.path, '.git');
        if (existsSync(gitPointer) && statSync(gitPointer).isDirectory()) {
          return { reason: `submodule workdir has embedded .git directory, refusing residue cleanup: ${entry.path}` };
        }
        const empty = ensureSubmoduleWorkdirEmpty(worktreePath, entry.path);
        if (empty.reason) return empty;
      }
    }
    if (entries.some((entry) => entry.initialized)) {
      const deinit = gitTry(['submodule', 'deinit', '--all', '-f'], worktreePath);
      if (!deinit.ok) return { reason: commandFailureReason(deinit, 'git submodule deinit failed') };
    }
    if (hasModulesMetadata) {
      try {
        rmSync(modulesDir, { recursive: true, force: true });
      } catch (error) {
        return { reason: `failed to remove submodule metadata: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    for (const entry of entries) {
      const empty = ensureSubmoduleWorkdirEmpty(worktreePath, entry.path);
      if (empty.reason) return empty;
    }
    return { reason: null };
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} initialRecord @param {string} pushed @param {{recordBlocked?:boolean,evidence?:Record<string,any>}} [options] */
  function reclaimRecord(loaded, initialRecord, pushed, options = {}) {
    let record = initialRecord;
    if (record.worktree_state === 'reclaimed') {
      const terminal = reconcileReclaimedTerminalState(loaded, record);
      const reconciled = reconcileReclaimedBranchCleanup(loaded, terminal.record, pushed);
      return {
        reclaimed: true,
        reason: reconciled.branch_cleanup?.status === 'failed' ? reconciled.branch_cleanup.reason : null,
        record: reconciled.record,
        branch_cleanup: reconciled.branch_cleanup,
        branch_cleanup_changed: terminal.changed || reconciled.changed,
      };
    }
    const registeredAtStart = parseWorktrees(loaded.context.current_worktree)
      .find((worktree) => worktree.path === canonicalSelectorPath(record.path));
    if (!registeredAtStart && existsSync(record.path)) {
      return {
        reclaimed: false,
        reason: 'physical directory remains without Git worktree registration; refusing to mark reclaimed before manual recovery',
        record,
      };
    }
    if (record.worktree_state !== 'reclaim_ready') {
      const preflight = reclaimPreflight(loaded, record, pushed);
      if (preflight.reason) {
        if (options.recordBlocked ?? true) {
          record = appendReclaimEvent(loaded.context.common_dir, record, 'reclaim_blocked', () => {}, { reason: preflight.reason, pushed, evidence: options.evidence ?? null });
        }
        return { reclaimed: false, reason: preflight.reason, record };
      }
      const finalHead = preflight.live?.head ?? record.last_head;
      record = appendReclaimEvent(loaded.context.common_dir, record, 'final_snapshot', (next) => {
        next.last_head = finalHead;
        next.last_seen_at = new Date().toISOString();
      }, { pushed, evidence: options.evidence ?? null });
      record = appendReclaimEvent(loaded.context.common_dir, record, 'reclaim_ready', (next) => {
        next.worktree_state = 'reclaim_ready';
      }, { pushed, evidence: options.evidence ?? null });
    }

    const live = parseWorktrees(loaded.context.current_worktree).find((worktree) => worktree.path === canonicalSelectorPath(record.path));
    if (live) {
      const submodules = reclaimSubmodules(live.path);
      if (submodules.reason) return { reclaimed: false, reason: submodules.reason, record };
      const removed = gitTry(['worktree', 'remove', live.path], loaded.context.current_worktree);
      if (!removed.ok) {
        const detail = commandFailureReason(removed, 'git worktree remove refused');
        const stillRegistered = parseWorktrees(loaded.context.current_worktree)
          .some((worktree) => worktree.path === canonicalSelectorPath(record.path));
        const residue = !stillRegistered && existsSync(record.path)
          ? '; Git registration was removed but the physical directory remains'
          : '';
        const reason = `${detail}${residue}`;
        record = appendReclaimEvent(loaded.context.common_dir, record, 'reclaim_failed', (next) => {
          next.last_reclaim_error = {
            reason,
            attempted_at: new Date().toISOString(),
            registration_present: stillRegistered,
            physical_directory_present: existsSync(record.path),
          };
        }, { pushed, evidence: options.evidence ?? null, reason, registration_present: stillRegistered, physical_directory_present: existsSync(record.path) });
        return { reclaimed: false, reason, record };
      }
      if (existsSync(record.path)) {
        return {
          reclaimed: false,
          reason: 'git worktree remove returned success but the physical directory remains',
          record,
        };
      }
    }
    gitTry(['worktree', 'prune'], loaded.context.current_worktree);
    const branchCleanup = attemptLocalBranchCleanup(loaded, record, pushed);
    record = appendReclaimEvent(loaded.context.common_dir, record, 'reclaimed', (next) => {
      const completedAt = new Date().toISOString();
      const finalEpoch = next.ownership_epochs?.at(-1);
      if (finalEpoch && !finalEpoch.ended_at) {
        finalEpoch.end_sha = next.last_head;
        finalEpoch.ended_at = completedAt;
      }
      if (next.task_status !== 'abandoned') next.task_status = 'done';
      next.worktree_state = 'reclaimed';
      next.reclaimed_at = completedAt;
      next.branch_cleanup = branchCleanup;
      next.reclaim_summary = {
        worktree_id: next.worktree_id,
        task: next.task,
        change_ref: next.auto_reclaim?.change_ref ?? null,
        source_sha: next.auto_reclaim?.head_sha ?? next.last_head ?? null,
        target_ref: options.evidence?.archive_ref ?? next.auto_reclaim?.target_ref ?? next.base_ref ?? null,
        target_sha: pushed,
        completed_at: completedAt,
        branch_cleanup: branchCleanup,
        reclaim_evidence: options.evidence ?? { kind: 'pushed', target_sha: pushed },
      };
      if (next.auto_reclaim) {
        next.auto_reclaim.state = 'reclaimed';
        next.auto_reclaim.completed_at = next.reclaimed_at;
      }
    }, { pushed, evidence: options.evidence ?? null, branch_cleanup: branchCleanup });
    if (record.auto_reclaim) {
      const notification = deliverReclaimNotification(record);
      record = appendReclaimEvent(loaded.context.common_dir, record, 'reclaim_notification', (next) => {
        next.reclaim_notification = { ...notification, recorded_at: new Date().toISOString() };
      }, notification);
    }
    return {
      reclaimed: true,
      reason: branchCleanup.status === 'failed' ? branchCleanup.reason : null,
      record,
      branch_cleanup: branchCleanup,
      branch_cleanup_changed: true,
    };
  }

  /** @param {string} commonDir @param {Record<string,any>} record @param {string} token @param {string} eventType @param {string} targetSha */

  function cmdReclaim(args) {
    rejectUnknownFlags(args.flags, ['pushed', 'superseded-by', 'replacement-id', 'discard', 'archive-evidence', 'reason', 'id', 'config']);
    const pushed = flag(args.flags, 'pushed');
    const supersededBy = flag(args.flags, 'superseded-by');
    const discardSha = flag(args.flags, 'discard');
    const archiveEvidence = flag(args.flags, 'archive-evidence');
    const reason = flag(args.flags, 'reason');
    const modes = [Boolean(pushed), Boolean(supersededBy), Boolean(archiveEvidence)].filter(Boolean).length;
    if (modes !== 1) die('reclaim 必须且只能选择 --pushed、--superseded-by 或 --archive-evidence 之一。', 2);
    if (discardSha && !supersededBy) die('--discard 只能与 --superseded-by 一起使用。', 2);
    if (reason && !archiveEvidence) die('--reason 仅用于 --archive-evidence。', 2);
    if (archiveEvidence && !reason) die('--archive-evidence 需要 --reason <归档原因>。', 2);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const records = loadRecords(loaded.context.common_dir);
    let record = selectRecord(records, args.positionals[0] ?? null, flag(args.flags, 'id'));
    let evidenceSha = pushed;
    let evidence = null;
    if (supersededBy) {
      const replacement = selectRecord(records, supersededBy, flag(args.flags, 'replacement-id'));
      const prepared = prepareSupersededReclaim(loaded, record, replacement, discardSha);
      record = prepared.record;
      evidenceSha = prepared.sourceSha;
      evidence = prepared.evidence;
    } else if (archiveEvidence) {
      const prepared = prepareEvidenceArchiveReclaim(loaded, record, archiveEvidence, reason);
      record = prepared.record;
      evidenceSha = prepared.sourceSha;
      evidence = prepared.evidence;
    } else {
      evidenceSha = resolvableCommitOid(loaded.context.current_worktree, pushed, '--pushed');
      const protectingRefs = protectingRefsForPushed(loaded, record, evidenceSha);
      if (protectingRefs.length === 0) {
        die('--pushed SHA 只由待删除候选分支保护；请先推送/合入到其他持久 ref，或对已冻结批次结果使用 --archive-evidence。', 2);
      }
      evidence = { kind: 'pushed', target_sha: evidenceSha, protecting_refs: protectingRefs };
    }
    const result = reclaimRecord(loaded, record, evidenceSha, { evidence });
    if (!result.reclaimed) {
      log(`KEEP ${record.path}: ${result.reason}`);
      process.exitCode = 1;
      return;
    }
    if (result.branch_cleanup?.status === 'failed') {
      log(`目录已回收 ${result.record.worktree_id.slice(0, 8)}；本地分支 ${result.record.branch} 清理待重试: ${result.branch_cleanup.reason}`);
      return;
    }
    const recovery = result.record.evidence_archive?.archive_ref
      ? `，证据归档=${result.record.evidence_archive.archive_ref}`
      : result.record.superseded_recovery?.mode === 'archive_ref'
      ? `，归档=${result.record.superseded_recovery.archive_ref}`
      : result.record.superseded_recovery?.mode === 'discard'
        ? '，旧 HEAD 已按精确 SHA 授权丢弃'
        : '';
    log(`已回收 ${result.record.worktree_id.slice(0, 8)} ${result.record.branch ?? '(detached)'}；branch=${result.branch_cleanup?.status ?? 'legacy'}${recovery}，审计历史保留。`);
  }


  return {
    appendReclaimEvent,
    appendWatchedEvent,
    reclaimPreflight,
    localBranchExists,
    reclaimRecord,
    cmdReclaim,
  };
}
