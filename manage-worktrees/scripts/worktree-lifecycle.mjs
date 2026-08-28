// @ts-check

/**
 * Domain command factory. Dependencies are injected once by the thin CLI composition root,
 * keeping this module acyclic and independently reviewable.
 * @param {Record<string, any>} deps
 */
export function createCommands(deps) {
  const {
    spawn,
    randomUUID,
    existsSync,
    readdirSync,
    realpathSync,
    tmpdir,
    dirname,
    join,
    WorktreeProfileError,
    canonicalizeFuturePath,
    claimWorktreeRepositoryRoot,
    classifyStorage,
    ensureRepositoryIdentity,
    loadRepositoryProfile,
    readRepositoryIdentity,
    resolveBaseRef,
    resolveSpawnPlan,
    validateTaskNaming,
    validateTaskSlug,
    WorktreeTraceError,
    appendTraceEvent,
    initializeTraceStore,
    inspectRecordLock,
    readEventChain,
    rebuildRecordCache,
    recoverRecordLock,
    traceLayout,
    TASK_TRANSITIONS,
    git,
    gitTry,
    commandFailureReason,
    isRootWriteDenied,
    removeWatcherHeartbeat,
    log,
    die,
    flag,
    rejectUnknownFlags,
    oneLine,
    httpUrl,
    aliasedFlag,
    resolveIdentity,
    printIdentity,
    requireFreshPrimaryProfile,
    resolveBaseOverrideReason,
    parseWorktrees,
    loadRecords,
    coexistingSessionRecords,
    resolveDeliveryRelation,
    validateSupersessionPair,
    canonicalSelectorPath,
    selectRecord,
    liveGitSnapshot,
    updateRecord,
    normalizeCodegraphMode,
    ensureWorktreeCodegraph,
    assertHistoryOperationIdle,
    stackParentForRef,
    localBranchExists,
    autoArmReviewWatch,
  } = deps;

  function cmdSupersede(args) {
    rejectUnknownFlags(args.flags, ['by', 'reason', 'id', 'by-id', 'config']);
    const bySelector = flag(args.flags, 'by');
    const reason = oneLine(flag(args.flags, 'reason') ?? '', 'reason', 240);
    if (!bySelector) die('supersede 需要 --by <replacement-selector>。', 2);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const records = loadRecords(loaded.context.common_dir);
    let superseded = selectRecord(records, args.positionals[0] ?? null, flag(args.flags, 'id'));
    let replacement = selectRecord(records, bySelector, flag(args.flags, 'by-id'));
    validateSupersessionPair(superseded, replacement);

    const existingForward = replacement.delivery_relation;
    if (existingForward && (
      existingForward.kind !== 'supersedes' ||
      existingForward.superseded_worktree_id !== superseded.worktree_id
    )) {
      die(`替代树已有冲突 delivery_relation=${existingForward.kind ?? 'unknown'}。`, 2);
    }
    const existingBack = superseded.superseded_by;
    if (existingBack && existingBack.worktree_id !== replacement.worktree_id) {
      die(`被替代树已指向另一替代树 ${existingBack.worktree_id}。`, 2);
    }
    const existingReason = existingForward?.reason ?? existingBack?.reason ?? null;
    if (existingReason && existingReason !== reason) {
      die(`替代关系已用不同原因登记：${existingReason}`, 2);
    }
    const declaredAt = existingForward?.declared_at ?? existingBack?.declared_at ?? new Date().toISOString();

    if (!existingForward) {
      replacement = updateRecord(replacement, 'delivery_relation_declared', (next) => {
        next.delivery_relation = {
          kind: 'supersedes',
          reason,
          related_worktree_ids: [superseded.worktree_id],
          superseded_worktree_id: superseded.worktree_id,
          declared_at: declaredAt,
        };
      }, {
        superseded_worktree_id: superseded.worktree_id,
        superseded_task: superseded.task,
        reason,
      }, loaded.context.common_dir);
    }
    if (!existingBack) {
      superseded = updateRecord(superseded, 'superseded_by_declared', (next) => {
        next.superseded_by = {
          worktree_id: replacement.worktree_id,
          task: replacement.task,
          reason,
          declared_at: declaredAt,
        };
      }, {
        replacement_worktree_id: replacement.worktree_id,
        replacement_task: replacement.task,
        reason,
      }, loaded.context.common_dir);
    }
    log(`替代关系已登记 ${superseded.task} -> ${replacement.task}（${superseded.worktree_id.slice(0, 8)} -> ${replacement.worktree_id.slice(0, 8)}）。`);
  }

  /** @param {string} value */

  function prepareSpawnRequest(args) {
    rejectUnknownFlags(args.flags, [
      'agent', 'agent-id', 'purpose', 'owner', 'base', 'base-reason', 'config', 'codegraph', 'root',
      'parallel-reason', 'supersedes', 'replacement-reason',
    ]);
    const task = args.positionals[0];
    if (!task) die('spawn 需要 <task>。', 2);
    validateTaskSlug(task);
    const identity = resolveIdentity(args.flags, { requirePurpose: true });
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    requireFreshPrimaryProfile(loaded);
    validateTaskNaming(task, loaded.profile.task_naming);
    let codegraphMode;
    try {
      codegraphMode = normalizeCodegraphMode(flag(args.flags, 'codegraph'));
    } catch (error) {
      die(error instanceof Error ? error.message : String(error), 2);
    }

    const existingRecords = loadRecords(loaded.context.common_dir);
    const reusable = existingRecords.find((record) =>
      record.worktree_state !== 'reclaimed' &&
      record.task === task &&
      record.agent?.host === identity.actor.host &&
      record.agent?.id === identity.actor.id);
    if (reusable) {
      const snapshot = liveGitSnapshot(reusable);
      if (!snapshot.present) die(`同一 Agent/task 的 record 已存在但 worktree missing: ${reusable.worktree_id}；请先 doctor/reclaim。`);
      updateRecord(reusable, 'spawn_reused', (next) => {
        next.last_seen_at = new Date().toISOString();
        next.last_head = snapshot.head;
      }, {}, loaded.context.common_dir);
      ensureWorktreeCodegraph(reusable.path, loaded.context.primary_worktree, codegraphMode);
      log(`复用已登记 worktree id=${reusable.worktree_id}: ${reusable.path}`);
      return { reused: true };
    }
    const coexisting = coexistingSessionRecords(existingRecords, identity.actor, task);
    return {
      reused: false,
      task,
      identity,
      loaded,
      codegraphMode,
      existingRecords,
      deliveryRelation: resolveDeliveryRelation(args.flags, existingRecords, coexisting),
    };
  }

  function planSpawn(args, request) {
    const worktreeId = randomUUID();
    const repositoryId = readRepositoryIdentity(request.loaded.context)?.repository_id ?? randomUUID();
    const cliRoot = flag(args.flags, 'root');
    const environmentRoot = process.env.WORKTREE_ROOT?.trim() || null;
    const configuredRoot = cliRoot ?? environmentRoot;
    const rootSelectionSource = cliRoot
      ? 'cli'
      : environmentRoot
        ? 'environment'
        : request.loaded.profile_source === 'defaults'
          ? 'default'
          : 'profile';
    const planOptions = {
      cwd: process.cwd(),
      task: request.task,
      host: request.identity.actor.host,
      worktreeId,
      repositoryId,
      base: flag(args.flags, 'base'),
      explicitConfigPath: flag(args.flags, 'config'),
      worktreeRootOverride: configuredRoot,
    };
    const plan = resolveSpawnPlan(planOptions);
    const baseReason = resolveBaseOverrideReason(args.flags, plan.profile.default_base, plan.base_ref, plan.base_source);
    if (plan.branch_exists) {
      die(
        `BRANCH_ALREADY_EXISTS: 本地 branch ${plan.branch} 已存在；为防同名返工静默继承旧 tip，拒绝 spawn。` +
        '请先完成或修复原 branch cleanup，或改用新的 semantic task；若它属于另一 Agent 的在飞任务，请先 handoff；若属于外部 worktree，请先 adopt。',
        2,
      );
    }
    printIdentity(request.identity, request.task, plan);
    log(`Base: ${plan.base_ref}（source=${plan.base_source}${baseReason ? `, reason=${baseReason}` : ''}）`);
    return { worktreeId, configuredRoot, rootSelectionSource, planOptions, plan, baseReason };
  }

  function claimSpawnRoot(request, planned) {
    let { plan, rootSelectionSource } = planned;
    gitTry(['worktree', 'prune'], plan.context.current_worktree);
    const baseSha = gitTry(['rev-parse', `${plan.base_ref}^{commit}`], plan.context.current_worktree);
    if (!baseSha.ok) die(`base ref 不存在: ${plan.base_ref}`);
    const repository = ensureRepositoryIdentity(plan.context, planned.planOptions.repositoryId);
    if (repository.repository_id !== plan.repository_id) {
      plan = resolveSpawnPlan({ ...planned.planOptions, repositoryId: repository.repository_id });
    }
    if (!plan.legacy_layout) {
      const claimRoot = () => claimWorktreeRepositoryRoot({
        root_base: plan.worktree_root_base,
        repo_name: plan.context.repo_name,
        repository_id: repository.repository_id,
        primary_worktree: plan.context.primary_worktree,
      });
      let claimedRoot;
      try {
        claimedRoot = claimRoot();
      } catch (error) {
        const mayFallback = planned.configuredRoot === null && request.loaded.profile_source === 'defaults' && isRootWriteDenied(error);
        if (!mayFallback) {
          throw new WorktreeProfileError(
            'WORKTREE_ROOT_UNWRITABLE',
            `无法写入 worktree_root ${plan.worktree_root_base}: ${error instanceof Error ? error.message : String(error)}。` +
            '请用 --root、WORKTREE_ROOT 或 primary Profile worktree_root 指向已授权目录。',
          );
        }
        const fallbacks = [
          { source: 'fallback:repository-sibling', root: join(dirname(plan.context.primary_worktree), '.worktrees') },
          { source: 'fallback:system-temp', root: join(tmpdir(), 'agent-worktrees') },
        ];
        let lastError = error;
        for (const fallback of fallbacks) {
          try {
            planned.planOptions.worktreeRootOverride = fallback.root;
            plan = resolveSpawnPlan({ ...planned.planOptions, repositoryId: repository.repository_id });
            claimedRoot = claimRoot();
            rootSelectionSource = fallback.source;
            log(`警告: 默认 worktree_root 不可写，降级到 ${fallback.root}（${fallback.source}）。`);
            break;
          } catch (fallbackError) {
            lastError = fallbackError;
          }
        }
        if (!claimedRoot) {
          throw new WorktreeProfileError(
            'WORKTREE_ROOT_UNWRITABLE',
            `默认 root 与安全降级 root 均不可写: ${lastError instanceof Error ? lastError.message : String(lastError)}。` +
            '请用 --root、WORKTREE_ROOT 或 primary Profile worktree_root 指向宿主已授权目录。',
          );
        }
      }
      if (claimedRoot !== plan.repository_root) {
        plan = resolveSpawnPlan({ ...planned.planOptions, repositoryId: repository.repository_id });
      }
    }
    return { ...planned, plan, rootSelectionSource, baseSha };
  }

  function inspectSpawnSlot(request, planned) {
    const { plan } = planned;
    const worktrees = parseWorktrees(plan.context.current_worktree);
    const occupant = worktrees.find((worktree) => worktree.branch === plan.branch);
    const byPath = worktrees.find((worktree) => worktree.path === plan.path);
    const currentRecords = loadRecords(plan.context.common_dir);
    const tracked = currentRecords.find((record) =>
      record.worktree_state !== 'reclaimed' && (record.path === plan.path || record.branch === plan.branch));
    if (tracked) {
      if (tracked.agent?.host !== request.identity.actor.host || tracked.agent?.id !== request.identity.actor.id) {
        die(`worktree 已由 ${tracked.agent?.host}/${tracked.agent?.id} 登记；请用 handoff，不要覆盖身份。`);
      }
      updateRecord(tracked, 'spawn_reused', (next) => {
        const snapshot = liveGitSnapshot(next);
        next.last_seen_at = new Date().toISOString();
        next.last_head = snapshot.head;
      }, {}, plan.context.common_dir);
      ensureWorktreeCodegraph(plan.path, plan.context.primary_worktree, request.codegraphMode);
      log(`复用已登记 worktree id=${tracked.worktree_id}: ${tracked.path}`);
      return { reused: true, currentRecords };
    }
    if (byPath || occupant) die(`现有 worktree 未登记（UNTRACKED）: ${(byPath ?? occupant).path}；请先 adopt。`);
    if (existsSync(plan.path)) die(`目标目录已存在但不是已登记 worktree: ${plan.path}`);
    return { reused: false, currentRecords };
  }

  function createSpawnWorktree(plan, baseSha) {
    const branchCreated = gitTry(['branch', '--', plan.branch, baseSha.out], plan.context.current_worktree);
    if (!branchCreated.ok) {
      die(`创建 branch 失败: ${plan.branch}: ${commandFailureReason(branchCreated, 'unknown git error')}`);
    }
    const added = gitTry(['worktree', 'add', plan.path, plan.branch], plan.context.current_worktree);
    if (added.ok) return;
    const branchTip = gitTry(['rev-parse', '--verify', `refs/heads/${plan.branch}^{commit}`], plan.context.current_worktree);
    const attached = parseWorktrees(plan.context.current_worktree).some(
      (worktree) => worktree.branch === plan.branch || worktree.path === plan.path,
    );
    let branchCleanup = 'branch absent';
    if (branchTip.ok && !attached && branchTip.out === baseSha.out) {
      const removed = gitTry(['branch', '-D', '--', plan.branch], plan.context.current_worktree);
      branchCleanup = removed.ok ? 'empty branch removed' : `empty branch KEEP: ${commandFailureReason(removed, 'delete failed')}`;
    } else if (branchTip.ok) {
      branchCleanup = attached ? 'branch attached; KEEP' : 'branch tip changed; KEEP';
    }
    die(`git worktree add 失败: ${plan.path}: ${commandFailureReason(added, 'unknown git error')}；${branchCleanup}`);
  }

  function recordSpawn(request, planned, currentRecords) {
    const { plan, worktreeId, baseReason, baseSha, rootSelectionSource } = planned;
    initializeTraceStore(plan.context);
    const now = new Date().toISOString();
    const record = {
      schema_version: 1,
      worktree_id: worktreeId,
      task: request.task,
      purpose: request.identity.purpose,
      path: realpathSync(plan.path),
      branch: plan.branch,
      base_ref: plan.base_ref,
      base_sha: baseSha.out,
      base_reason: baseReason,
      stack_parent: stackParentForRef(currentRecords, plan.base_ref, baseSha.out),
      agent: request.identity.actor,
      owner: request.identity.owner,
      task_status: 'active',
      worktree_state: 'present',
      storage_class: classifyStorage(plan.path, plan.profile.ephemeral_path_patterns),
      profile_source: plan.profile_source,
      profile_path: plan.profile_path,
      naming: {
        host_slug: plan.host_slug,
        task_short: plan.task_short,
        id8: worktreeId.replaceAll('-', '').slice(0, 8),
        repository_root: plan.repository_root,
        root_source: rootSelectionSource,
        task_policy: plan.profile.task_naming.mode,
      },
      created_at: now,
      updated_at: now,
      last_seen_at: now,
      last_head: git(['rev-parse', 'HEAD'], plan.path),
      ownership_epochs: [{ agent: request.identity.actor, started_at: now, start_sha: baseSha.out, end_sha: null, ended_at: null }],
      delivery_relation: request.deliveryRelation,
    };
    appendTraceEvent({
      commonDir: plan.context.common_dir,
      worktreeId,
      eventType: 'created',
      actor: request.identity.actor,
      details: {
        identity_sources: request.identity.sources,
        base_source: plan.base_source,
        base_reason: baseReason,
        stack_parent_worktree_id: record.stack_parent?.worktree_id ?? null,
        delivery_relation: request.deliveryRelation,
      },
      mutate: () => record,
    });
    if (request.deliveryRelation?.kind === 'supersedes') {
      const superseded = request.existingRecords.find(
        (candidate) => candidate.worktree_id === request.deliveryRelation.superseded_worktree_id);
      updateRecord(superseded, 'superseded_by_declared', (next) => {
        next.superseded_by = {
          worktree_id: worktreeId,
          task: request.task,
          reason: request.deliveryRelation.reason,
          declared_at: request.deliveryRelation.declared_at,
        };
      }, {
        replacement_worktree_id: worktreeId,
        replacement_task: request.task,
        reason: request.deliveryRelation.reason,
      }, plan.context.common_dir);
    }
    ensureWorktreeCodegraph(record.path, plan.context.primary_worktree, request.codegraphMode);
    log(`worktree 就绪 id=${worktreeId} branch=${plan.branch} path=${record.path}`);
  }

  function cmdSpawn(args) {
    const request = prepareSpawnRequest(args);
    if (request.reused) return;
    const planned = claimSpawnRoot(request, planSpawn(args, request));
    const slot = inspectSpawnSlot(request, planned);
    if (slot.reused) return;
    createSpawnWorktree(planned.plan, planned.baseSha);
    recordSpawn(request, planned, slot.currentRecords);
  }

  function inferTask(branch) {
    if (!branch) return null;
    const candidate = branch.split('/').at(-1);
    try { return validateTaskSlug(candidate); } catch { return null; }
  }

  function cmdAdopt(args) {
    rejectUnknownFlags(args.flags, ['agent', 'agent-id', 'purpose', 'owner', 'task', 'base', 'base-reason', 'config']);
    const rawPath = args.positionals[0];
    if (!rawPath) die('adopt 需要 <path>。', 2);
    const identity = resolveIdentity(args.flags, { requirePurpose: true });
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    requireFreshPrimaryProfile(loaded);
    const path = existsSync(rawPath) ? realpathSync(rawPath) : canonicalizeFuturePath(rawPath);
    const worktree = parseWorktrees(loaded.context.current_worktree).find((item) => item.path === path);
    if (!worktree) die(`path 不是当前仓库登记的 worktree: ${path}`);
    if (path === loaded.context.primary_worktree) die('primary worktree 不需要 adopt。');
    const task = flag(args.flags, 'task') ?? inferTask(worktree.branch);
    if (!task) die('detached 或无法从 branch 推断 task；请传 --task。', 2);
    validateTaskNaming(task, loaded.profile.task_naming);
    const records = loadRecords(loaded.context.common_dir);
    const existing = records.find((record) => record.worktree_state !== 'reclaimed' && (record.path === path || (worktree.branch && record.branch === worktree.branch)));
    if (existing) die(`worktree 已登记 id=${existing.worktree_id}。`);
    const base = resolveBaseRef(loaded.context.current_worktree, loaded.profile.default_base, flag(args.flags, 'base'));
    const baseReason = resolveBaseOverrideReason(
      args.flags,
      loaded.profile.default_base,
      base.ref,
      base.source,
    );
    const head = worktree.head ?? git(['rev-parse', 'HEAD'], path);
    const mergeBase = gitTry(['merge-base', head, base.ref], loaded.context.current_worktree);
    initializeTraceStore(loaded.context);
    const worktreeId = randomUUID();
    const now = new Date().toISOString();
    const adoptedBaseSha = mergeBase.ok ? mergeBase.out : head;
    const record = {
      schema_version: 1, worktree_id: worktreeId, task, purpose: identity.purpose, path,
      branch: worktree.branch, base_ref: base.ref, base_sha: adoptedBaseSha,
      base_reason: baseReason,
      stack_parent: stackParentForRef(records, base.ref, adoptedBaseSha),
      agent: identity.actor, owner: identity.owner, task_status: 'active', worktree_state: 'present',
      storage_class: classifyStorage(path, loaded.profile.ephemeral_path_patterns),
      profile_source: loaded.profile_source, profile_path: loaded.profile_path,
      naming: { task_policy: loaded.profile.task_naming.mode },
      created_at: now, updated_at: now, last_seen_at: now, last_head: head,
      ownership_epochs: [{ agent: identity.actor, started_at: now, start_sha: mergeBase.ok ? mergeBase.out : head, end_sha: null, ended_at: null }],
    };
    printIdentity(identity, task, loaded);
    log(`Base: ${base.ref}（source=${base.source}${baseReason ? `, reason=${baseReason}` : ''}）`);
    appendTraceEvent({
      commonDir: loaded.context.common_dir,
      worktreeId,
      eventType: 'adopted',
      actor: identity.actor,
      details: {
        task_source: flag(args.flags, 'task') ? 'explicit' : 'branch_inferred',
        base_source: base.source,
        base_reason: baseReason,
        stack_parent_worktree_id: record.stack_parent?.worktree_id ?? null,
      },
      mutate: () => record,
    });
    log(`已接管 id=${worktreeId} branch=${worktree.branch ?? '(detached)'} path=${path}`);
  }

  /** @param {ReturnType<typeof loadRepositoryProfile>} loaded @param {Record<string,any>} record */
  function hasPendingBranchCleanup(loaded, record) {
    return record.worktree_state === 'reclaimed' && (
      record.branch_cleanup?.status === 'failed' || localBranchExists(loaded, record)
    );
  }

  function buildListing(includeAll = false, loaded = loadRepositoryProfile()) {
    const worktrees = parseWorktrees(loaded.context.current_worktree);
    const records = loadRecords(loaded.context.common_dir);
    const mainPath = loaded.context.primary_worktree;
    const rows = worktrees.map((worktree) => {
      const record = records.find((candidate) => candidate.worktree_state !== 'reclaimed' && canonicalSelectorPath(candidate.path) === worktree.path);
      const status = worktree.bare ? null : gitTry(['status', '--porcelain'], worktree.path);
      return {
        kind: worktree.path === mainPath ? 'MAIN' : record ? 'TRACKED' : 'UNTRACKED',
        path: worktree.path, branch: worktree.branch, head: worktree.head,
        dirty: status?.ok ? status.out !== '' : null, record: record ?? null,
      };
    });
    const livePaths = new Set(worktrees.map((worktree) => worktree.path));
    const historical = records
      .filter((record) => {
        if (livePaths.has(canonicalSelectorPath(record.path))) return false;
        return includeAll || record.worktree_state !== 'reclaimed' || hasPendingBranchCleanup(loaded, record);
      })
      .map((record) => ({ ...record, branch_cleanup_pending: hasPendingBranchCleanup(loaded, record) }));
    return { loaded, rows, historical, records };
  }

  /** @param {Record<string,any>} record */
  function reclaimSummaryFor(record) {
    if (record.worktree_state !== 'reclaimed') return null;
    const fallback = {
      worktree_id: record.worktree_id,
      task: record.task,
      change_ref: record.auto_reclaim?.change_ref ?? null,
      source_sha: record.auto_reclaim?.head_sha ?? record.last_head ?? null,
      target_ref: record.auto_reclaim?.target_ref ?? record.base_ref ?? null,
      target_sha: record.auto_reclaim?.target_sha ?? null,
      completed_at: record.reclaimed_at ?? record.auto_reclaim?.completed_at ?? null,
    };
    return {
      ...fallback,
      ...(record.reclaim_summary ?? {}),
      branch_cleanup: record.branch_cleanup ?? record.reclaim_summary?.branch_cleanup ?? null,
    };
  }

  /** @param {Record<string,any>[]} records */
  function latestReclaim(records) {
    return records.map(reclaimSummaryFor).filter(Boolean).sort((left, right) => String(right.completed_at ?? '').localeCompare(String(left.completed_at ?? '')))[0] ?? null;
  }

  function cmdList(args) {
    rejectUnknownFlags(args.flags, ['json', 'all', 'config']);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const listing = buildListing(Boolean(args.flags.get('all')), loaded);
    const summary = {
      worktrees: listing.rows.length,
      tracked: listing.rows.filter((row) => row.kind === 'TRACKED').length,
      untracked: listing.rows.filter((row) => row.kind === 'UNTRACKED').length,
      historical: listing.historical.length,
    };
    const lastReclaim = latestReclaim(listing.records);
    if (args.flags.get('json')) {
      console.log(JSON.stringify({ profile: { source: listing.loaded.profile_source, path: listing.loaded.profile_path }, summary, last_reclaim: lastReclaim, worktrees: listing.rows, records: listing.historical }, null, 2));
      return;
    }
    log(`worktrees=${summary.worktrees} TRACKED=${summary.tracked} UNTRACKED=${summary.untracked} history=${summary.historical}`);
    if (lastReclaim) {
      console.log(`  [LAST_RECLAIM] ${lastReclaim.completed_at ?? '?'} task=${lastReclaim.task} change=${lastReclaim.change_ref ?? '-'} target=${lastReclaim.target_sha?.slice(0, 12) ?? '-'} branch=${lastReclaim.branch_cleanup?.status ?? 'legacy'}`);
    }
    for (const row of listing.rows) {
      console.log(`  [${row.kind}] [${row.dirty === null ? '?' : row.dirty ? 'DIRTY' : 'CLEAN'}] ${row.branch ?? '(detached)'}  ${row.path}`);
      if (row.record) console.log(`    ${row.record.agent.host}/${row.record.agent.id}  task=${row.record.task}  status=${row.record.task_status}/${row.record.worktree_state}\n    ${row.record.purpose}`);
    }
    for (const record of listing.historical) {
      const label = record.branch_cleanup_pending
        ? 'BRANCH_PENDING'
        : record.worktree_state === 'reclaimed'
          ? 'HISTORY'
          : 'MISSING';
      const cleanup = record.worktree_state === 'reclaimed' ? ` branch=${record.branch_cleanup?.status ?? 'legacy'}` : '';
      console.log(`  [${label}] ${record.worktree_id.slice(0, 8)} ${record.task} ${record.agent.host}/${record.agent.id}${cleanup} ${record.path}`);
    }
  }

  /** @param {Record<string,any>} record @param {string} command */

  function cmdTouch(args) {
    rejectUnknownFlags(args.flags, ['status', 'note', 'id', 'config', 'no-watch', 'target', 'watch-target', 'change-ref', 'mr', 'interval-ms', 'notify']);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
    assertHistoryOperationIdle(record, 'touch');
    if (record.worktree_state === 'reclaimed') {
      die('已回收 record 是不可变历史，不能 touch；同名返工请重新 spawn。');
    }
    const requested = flag(args.flags, 'status') ?? record.task_status;
    if (!TASK_TRANSITIONS[record.task_status]?.has(requested)) die(`非法状态流转: ${record.task_status} -> ${requested}`);
    const note = flag(args.flags, 'note') ? oneLine(flag(args.flags, 'note'), 'note', 240) : null;
    const targetRef = aliasedFlag(args.flags, 'target', 'watch-target');
    const registeredTargetRef = targetRef ?? record.base_ref ?? null;
    const mrUrl = flag(args.flags, 'mr') ? httpUrl(flag(args.flags, 'mr'), 'mr') : null;
    const changeRef = aliasedFlag(args.flags, 'change-ref', 'mr');
    const snapshot = liveGitSnapshot(record);
    const activeWatch = record.auto_reclaim && !['disarmed', 'reclaimed'].includes(record.auto_reclaim.state)
      ? record.auto_reclaim
      : null;
    // HEAD 已前进时，旧冻结证据必须在 touch 的第一条 event 内原子失效。若先写 status_updated、
    // 再另写 disarm，后台 watcher 就能在两条 event 之间用旧 SHA 抢先推进 merge_detected/done。
    const staleWatch = requested === 'ready_for_review'
      && activeWatch
      && activeWatch.state !== 'merge_detected'
      && Boolean(snapshot.head)
      && activeWatch.head_sha !== snapshot.head
      ? activeWatch
      : null;
    const updated = updateRecord(record, staleWatch ? 'auto_reclaim_disarmed' : 'status_updated', (next) => {
      if (next.task_status !== record.task_status) {
        throw new WorktreeTraceError(
          'TOUCH_STATE_CHANGED',
          `touch 期间 task_status 已由 ${record.task_status} 变为 ${next.task_status}；请重新读取状态后重试。`,
        );
      }
      if (staleWatch) {
        const currentWatch = next.auto_reclaim;
        if (
          currentWatch?.token !== staleWatch.token
          || ['merge_detected', 'disarmed', 'reclaimed'].includes(currentWatch?.state)
        ) {
          throw new WorktreeTraceError(
            'WATCHER_CHANGED',
            '旧 watcher 已被并发 rearm、解除或推进到 merge_detected；拒绝用陈旧快照覆盖当前状态。',
          );
        }
        currentWatch.state = 'disarmed';
        currentWatch.disarmed_at = new Date().toISOString();
        currentWatch.disarm_reason = 'stale_frozen_head';
      }
      next.task_status = requested;
      if (next.worktree_state === 'present' && !snapshot.present) next.worktree_state = 'missing';
      else if (next.worktree_state === 'missing' && snapshot.present) next.worktree_state = 'present';
      next.last_seen_at = new Date().toISOString();
      next.last_head = snapshot.head;
      if (mrUrl) {
        const targetBranch = registeredTargetRef?.includes('/') ? registeredTargetRef.slice(registeredTargetRef.indexOf('/') + 1) : registeredTargetRef;
        next.change_request = {
          provider: loaded.profile.change_request?.provider ?? 'external',
          state: 'registered',
          change_ref: mrUrl,
          url: mrUrl,
          source_branch: next.branch,
          target_branch: targetBranch,
          target_ref: registeredTargetRef,
          head_sha: snapshot.head,
          registered_at: new Date().toISOString(),
        };
      }
    }, {
      note,
      git: snapshot,
      ...(staleWatch ? {
        source: 'auto_touch_head_drift',
        reason: 'live HEAD 已偏离冻结 SHA；在检查新 HEAD 是否可武装前先原子失效旧 watcher。',
        stale_head_sha: staleWatch.head_sha,
        live_head: snapshot.head,
        target_ref: staleWatch.target_ref,
        token: staleWatch.token,
      } : {}),
    }, loaded.context.common_dir);
    log(`已更新 ${updated.worktree_id.slice(0, 8)} ${record.task_status} -> ${updated.task_status}`);
    if (staleWatch) {
      removeWatcherHeartbeat(loaded.context.common_dir, record.worktree_id, staleWatch.token);
      log(`watch 已解除（原冻结 head=${staleWatch.head_sha.slice(0, 12)} 已过期，当前 HEAD=${snapshot.head.slice(0, 12)}）。`);
    }
    if (requested === 'ready_for_review') autoArmReviewWatch(loaded, updated, args, snapshot);
  }

  /**
   * 进入 ready_for_review 时默认武装合入监听。
   *
   * 纪律来源：监听绑定的是「内容进主干」这一事实，与内容经哪个载体（自建 change request、
   * 聚合 change request、他人代推）无关。靠人在建 change request 时手工挂 watch，一旦中途改成
   * 由别的载体合入，监听就会漏挂、合入后无人回收——默认武装把这个洞堵死。
   *
   * 失败一律 fail-soft：touch 的主职是状态流转，不因为没有 remote / 未推送而失败，
   * 但必须把未武装的原因说清楚，避免「以为挂上了」。
   * @param {ReturnType<typeof loadRepositoryProfile>} loaded
   * @param {Record<string,any>} record
   * @param {{flags:Map<string,unknown>}} args
   * @param {{present:boolean,head:string|null,dirty:boolean|null,upstream:string|null}} snapshot
   */

  function cmdHandoff(args) {
    rejectUnknownFlags(args.flags, ['to-agent', 'to-agent-id', 'note', 'id', 'config']);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
    assertHistoryOperationIdle(record, 'handoff');
    const target = resolveIdentity(args.flags, { target: true });
    const note = oneLine(flag(args.flags, 'note') ?? '', 'note', 240);
    const snapshot = liveGitSnapshot(record);
    if (!snapshot.present) die('handoff 要求 worktree 存在。');
    if (snapshot.dirty !== false) die('handoff 要求工作树干净；请先 WIP commit + push。');
    const now = new Date().toISOString();
    const from = record.agent;
    const updated = appendTraceEvent({
      commonDir: loaded.context.common_dir, worktreeId: record.worktree_id, eventType: 'handed_off', actor: from,
      details: { from, to: target.actor, boundary_sha: snapshot.head, note },
      mutate(current) {
        const next = structuredClone(current);
        const epoch = next.ownership_epochs.at(-1);
        if (epoch && !epoch.ended_at) { epoch.ended_at = now; epoch.end_sha = snapshot.head; }
        next.agent = target.actor;
        next.ownership_epochs.push({ agent: target.actor, started_at: now, start_sha: snapshot.head, end_sha: null, ended_at: null });
        next.updated_at = now; next.last_seen_at = now; next.last_head = snapshot.head;
        return next;
      },
    }).record;
    log(`已交接 ${updated.worktree_id.slice(0, 8)}: ${from.host}/${from.id} -> ${target.actor.host}/${target.actor.id}`);
  }

  function commitsForEpoch(cwd, epoch, endSha) {
    if (!epoch.start_sha || !endSha) return { degraded: true, reason: 'missing boundary', commits: [] };
    if (!gitTry(['cat-file', '-e', `${epoch.start_sha}^{commit}`], cwd).ok || !gitTry(['cat-file', '-e', `${endSha}^{commit}`], cwd).ok) return { degraded: true, reason: 'boundary unreachable', commits: [] };
    if (!gitTry(['merge-base', '--is-ancestor', epoch.start_sha, endSha], cwd).ok) return { degraded: true, reason: 'boundary rewritten (amend/rebase)', commits: [] };
    const revs = gitTry(['rev-list', '--reverse', `${epoch.start_sha}..${endSha}`], cwd);
    const commits = revs.ok && revs.out ? revs.out.split('\n').map((sha) => {
      const meta = git(['show', '-s', '--format=%H%x09%an%x09%s', sha], cwd).split('\t');
      const files = gitTry(['show', '--pretty=format:', '--name-only', sha], cwd);
      return { sha: meta[0], author: meta[1], subject: meta.slice(2).join('\t'), files: files.ok ? files.out.split('\n').filter(Boolean) : [] };
    }) : [];
    return { degraded: false, reason: null, commits };
  }

  function cmdAudit(args) {
    rejectUnknownFlags(args.flags, ['json', 'id', 'config']);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const records = loadRecords(loaded.context.common_dir);
    const record = selectRecord(records, args.positionals[0] ?? null, flag(args.flags, 'id'));
    const chain = readEventChain(loaded.context.common_dir, record.worktree_id);
    const epochs = (record.ownership_epochs ?? []).map((epoch) => ({ ...epoch, attribution: commitsForEpoch(loaded.context.current_worktree, epoch, epoch.end_sha ?? record.last_head) }));
    const result = { record, events: chain.map(({ snapshot, ...event }) => event), ownership_epochs: epochs };
    if (args.flags.get('json')) { console.log(JSON.stringify(result, null, 2)); return; }
    log(`${record.worktree_id} task=${record.task} ${record.task_status}/${record.worktree_state}`);
    for (const epoch of epochs) {
      console.log(`  ${epoch.agent.host}/${epoch.agent.id} ${epoch.start_sha?.slice(0, 12)}..${(epoch.end_sha ?? record.last_head)?.slice(0, 12)}`);
      if (epoch.attribution.degraded) console.log(`    ATTRIBUTION_DEGRADED: ${epoch.attribution.reason}`);
      for (const commit of epoch.attribution.commits) console.log(`    ${commit.sha.slice(0, 12)} ${commit.subject} (${commit.files.length} files)`);
    }
    for (const event of result.events) console.log(`  ${event.occurred_at} ${event.event_type} ${event.actor ? `${event.actor.host}/${event.actor.id}` : '-'}`);
  }

  /** @param {unknown} value */

  function cmdRebuild(args) {
    rejectUnknownFlags(args.flags, ['id', 'recover-lock', 'config']);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const records = loadRecords(loaded.context.common_dir);
    const eventsDir = traceLayout(loaded.context.common_dir).events;
    const eventIds = existsSync(eventsDir)
      ? readdirSync(eventsDir).filter((name) => /^[0-9a-f-]{36}$/i.test(name))
      : [];
    let targetIds;
    const explicitId = flag(args.flags, 'id');
    if (explicitId) {
      if (!/^(?:[0-9a-f]{8,32}|[0-9a-f-]{36})$/i.test(explicitId)) die('--id 需要完整 UUID 或至少 8 位十六进制前缀。', 2);
      targetIds = eventIds.filter((id) => id.toLowerCase().startsWith(explicitId.toLowerCase()));
      if (targetIds.length !== 1) die(`--id 在 event store 中匹配 ${targetIds.length} 条 chain。`, 2);
    } else if (args.positionals[0]) {
      targetIds = [selectRecord(records, args.positionals[0], null).worktree_id];
    } else {
      targetIds = eventIds;
    }
    for (const worktreeId of targetIds) {
      if (args.flags.get('recover-lock')) {
        const finding = inspectRecordLock(loaded.context.common_dir, worktreeId);
        if (finding.state !== 'absent' && finding.state !== 'held') recoverRecordLock(loaded.context.common_dir, worktreeId, { forceMalformed: true });
      }
      rebuildRecordCache(loaded.context.common_dir, worktreeId);
      log(`rebuilt ${worktreeId}`);
    }
  }


  return {
    cmdSupersede,
    cmdSpawn,
    cmdAdopt,
    buildListing,
    cmdList,
    cmdTouch,
    cmdHandoff,
    cmdAudit,
    cmdRebuild,
  };
}
