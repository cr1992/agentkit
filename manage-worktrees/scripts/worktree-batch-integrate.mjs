// @ts-check

/**
 * @param {Record<string, any>} deps
 */
export function createCommands(deps) {
  const {
    spawn,
    existsSync,
    readFileSync,
    loadRepositoryProfile,
    validateTaskNaming,
    validateTaskSlug,
    WorktreeTraceError,
    runFileCapture,
    PREFIX,
    SUBMIT_PUSH_TIMEOUT_MS,
    git,
    gitTry,
    commandFailureReason,
    log,
    die,
    flag,
    rejectUnknownFlags,
    resolveIdentity,
    loadRecords,
    isActiveRecord,
    coexistingSessionRecords,
    liveGitSnapshot,
    updateRecord,
    gitOperationState,
    isAncestor,
    cmdSpawn,
    computeBatchPlan,
  } = deps;

  /**
   * 在一次性集成候选树上开启 rerere，让多轮候选之间同一冲突自动重放已录解法。
   *
   * 作用域是 worktree 级（`git config --worktree`），不写全局、也不改其他 worktree 的行为；
   * 但 Git 的 rerere **解法缓存位于共享 common dir 的 `rr-cache/`**，因此同一仓库任何
   * worktree 录下的解法都会被这里复用——这正是「上一轮候选解过的冲突，下一轮不再手解」
   * 的机制，同时也意味着一个错误解法会跨候选扩散，需要时用 `git rerere forget <path>` 清除。
   *
   * `--worktree` 依赖仓库 `extensions.worktreeConfig`。未启用时按 Git 的要求先确认
   * `core.bare` / `core.worktree` 仍是默认值再启用；否则 fail-open 成「不启用 rerere」
   * 并回报原因，绝不擅自搬动这两个键。
   * @param {ReturnType<typeof loadRepositoryProfile>} loaded
   * @param {string} candidatePath
   */
  function enableCandidateRerere(loaded, candidatePath) {
    const read = (key, cwd) => {
      const got = gitTry(['config', '--get', key], cwd);
      return got.ok ? got.out : null;
    };
    const readBool = (key, cwd) => {
      const got = gitTry(['config', '--bool', '--get', key], cwd);
      if (!got.ok) return null;
      return got.out === 'true';
    };
    const inherited = {
      enabled: readBool('rerere.enabled', candidatePath) === true,
      autoUpdate: readBool('rerere.autoUpdate', candidatePath) === true,
    };
    // 必须两项都已生效才算「继承即可」。只有 rerere.enabled 而没有 autoUpdate 时，rerere 会把
    // 已录解法写回工作区却**不更新 index**，冲突路径依然是 unmerged，合成循环会把它当成真冲突，
    // 重放形同失效。因此这里不能因为 enabled 已是 true 就提前返回。
    if (inherited.enabled && inherited.autoUpdate) {
      return {
        enabled: true,
        auto_update: true,
        scope: 'inherited',
        worktree_config_extension: 'not_needed',
        worktree_config_previous: read('extensions.worktreeConfig', loaded.context.primary_worktree),
        reason: null,
      };
    }
    const partialScope = inherited.enabled ? 'inherited-partial' : 'none';
    const primary = loaded.context.primary_worktree;
    const extensionPrevious = read('extensions.worktreeConfig', primary);
    let extensionProvenance = 'already_enabled';
    if (readBool('extensions.worktreeConfig', primary) !== true) {
      const bare = readBool('core.bare', primary);
      const coreWorktree = read('core.worktree', primary);
      if (bare === true || (coreWorktree !== null && coreWorktree !== '')) {
        return {
          enabled: inherited.enabled,
          auto_update: inherited.autoUpdate,
          scope: partialScope,
          worktree_config_extension: 'refused',
          worktree_config_previous: extensionPrevious,
          reason: 'core.bare/core.worktree 非默认值；按 Git 要求需人工先迁移这两个键，拒绝自动启用 extensions.worktreeConfig。',
        };
      }
      const enabled = gitTry(['config', 'extensions.worktreeConfig', 'true'], primary);
      if (!enabled.ok) {
        return {
          enabled: inherited.enabled,
          auto_update: inherited.autoUpdate,
          scope: partialScope,
          worktree_config_extension: 'failed',
          worktree_config_previous: extensionPrevious,
          reason: commandFailureReason(enabled, '无法启用 extensions.worktreeConfig'),
        };
      }
      extensionProvenance = 'enabled_by_this_command';
    }
    for (const [key, value] of [['rerere.enabled', 'true'], ['rerere.autoUpdate', 'true']]) {
      const set = gitTry(['config', '--worktree', key, value], candidatePath);
      if (!set.ok) {
        return {
          enabled: false,
          auto_update: false,
          scope: 'none',
          worktree_config_extension: extensionProvenance,
          worktree_config_previous: extensionPrevious,
          reason: commandFailureReason(set, `无法设置 ${key}`),
        };
      }
    }
    return {
      enabled: true,
      auto_update: true,
      scope: 'worktree',
      worktree_config_extension: extensionProvenance,
      worktree_config_previous: extensionPrevious,
      reason: null,
    };
  }

  /** @param {string} cwd */
  function unmergedPaths(cwd) {
    const unmerged = gitTry(['diff', '--name-only', '--diff-filter=U'], cwd);
    return unmerged.ok && unmerged.out ? unmerged.out.split('\n').filter(Boolean) : [];
  }

  /** @param {string} path */
  function readBatchPlanFile(path) {
    if (!existsSync(path)) die(`--plan 文件不存在: ${path}`, 2);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      die(`--plan 文件不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`, 2);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) die('--plan 文件根节点必须是 object。', 2);
    if (parsed.schema_version !== 1) die(`--plan schema_version 必须是 1，当前 ${parsed.schema_version}。`, 2);
    if (parsed.ready !== true) die('--plan 是未就绪计划（ready=false）；请先让 plan-batch 返回 ready=true。', 2);
    if (!parsed.fingerprint || !parsed.target?.sha || !parsed.target?.ref) die('--plan 缺少 fingerprint 或 target。', 2);
    if (!Array.isArray(parsed.included) || parsed.included.length === 0) die('--plan 缺少 included 输入。', 2);
    for (const item of parsed.included) {
      if (!item?.worktree_id || !item?.head) die('--plan included 每项都需要 worktree_id 与 head。', 2);
    }
    if (parsed.excluded !== undefined && !Array.isArray(parsed.excluded)) die('--plan excluded 必须是 array。', 2);
    for (const item of parsed.excluded ?? []) {
      if (!item?.worktree_id) die('--plan excluded 每项都需要 worktree_id。', 2);
    }
    if (parsed.requested_selectors !== undefined) {
      if (!Array.isArray(parsed.requested_selectors) || parsed.requested_selectors.some((item) => typeof item !== 'string' || !item)) {
        die('--plan requested_selectors 必须是非空字符串数组。', 2);
      }
    }
    return parsed;
  }

  /**
   * 冻结计划只有在 target 与全部输入 HEAD 都没漂移时才可继续合成。
   * 任何一处变化都必须回到 plan-batch 重新冻结，而不是就地放行。
   * @param {Record<string,any>} frozen
   * @param {ReturnType<typeof computeBatchPlan>} fresh
   */
  function assertBatchPlanFresh(frozen, fresh) {
    const drifts = [];
    if (frozen.repository_id && fresh.repository_id && frozen.repository_id !== fresh.repository_id) {
      drifts.push(`repository_id: plan=${frozen.repository_id} live=${fresh.repository_id}`);
    }
    if (frozen.target.ref !== fresh.target.ref) drifts.push(`target ref: plan=${frozen.target.ref} live=${fresh.target.ref}`);
    if (frozen.target.sha !== fresh.target.sha) drifts.push(`target SHA: plan=${frozen.target.sha} live=${fresh.target.sha}`);
    const frozenInputs = frozen.included.map((item) => `${item.worktree_id}@${item.head}`);
    const freshInputs = fresh.included.map((item) => `${item.worktree_id}@${item.head}`);
    if (frozenInputs.join(',') !== freshInputs.join(',')) {
      drifts.push(`有序输入: plan=[${frozenInputs.join(' ')}] live=[${freshInputs.join(' ')}]`);
    }
    // 被折叠（COVERED_BY_DESCENDANT / DUPLICATE_HEAD）或已在 target 的输入同样是批次决策的一部分：
    // 它们后来前进、或不再被覆盖，都意味着这份计划描述的合成边界已经变了。不比对这一段，
    // 「父分支被折叠后又推了新提交」会在指纹不变的假象下被静默漏出合成结果。
    const summarizeExcluded = (plan) => (plan.excluded ?? [])
      .map((item) => `${item.worktree_id}@${item.state}@${item.head ?? 'null'}`)
      .sort()
      .join(',');
    const frozenExcluded = summarizeExcluded(frozen);
    const freshExcluded = summarizeExcluded(fresh);
    if (frozenExcluded !== freshExcluded) {
      drifts.push(`折叠/已合入输入: plan=[${frozenExcluded}] live=[${freshExcluded}]`);
    }
    if (fresh.blockers.length > 0) {
      drifts.push(`重算出现 blocker: ${fresh.blockers.map((item) => `${item.task ?? '-'}:${item.code}`).join(' ')}`);
    }
    if (frozen.fingerprint !== fresh.fingerprint) {
      drifts.push(`fingerprint: plan=${frozen.fingerprint} live=${fresh.fingerprint}`);
    }
    if (drifts.length > 0) {
      die(
        `BATCH_PLAN_STALE: 冻结计划与当前仓库状态不一致，拒绝按旧计划合成。\n  - ${drifts.join('\n  - ')}\n` +
        '请重新执行 plan-batch 冻结新计划（新指纹会自动走替代登记），不要在旧计划上继续。',
      );
    }
  }

  /**
   * 在候选树上按冻结顺序 merge 精确 SHA。冲突时 fail-closed：停在冲突处、不自动解、不自动 abort。
   * @param {Record<string,any>} record
   * @param {ReturnType<typeof computeBatchPlan>} plan
   * @param {{abortOnConflict:boolean,recomposeExpectedHead:string|null}} options
   */
  function composeBatchCandidate(record, plan, options) {
    const path = record.path;
    const liveHead = gitTry(['rev-parse', 'HEAD'], path);
    if (!liveHead.ok) die(`无法读取候选树 HEAD: ${path}`);
    if (options.recomposeExpectedHead && liveHead.out !== options.recomposeExpectedHead) {
      die(
        `RECOMPOSE_HEAD_STALE: 候选 HEAD 已从授权值 ${options.recomposeExpectedHead} 变化为 ${liveHead.out}，拒绝重置。\n` +
        '请重新核对候选树并用当前完整 HEAD 重新授权。',
      );
    }
    if (liveHead.out !== plan.target.sha) {
      const reset = gitTry(['reset', '--hard', plan.target.sha], path);
      if (!reset.ok) die(`无法把候选树重置到批次 target: ${commandFailureReason(reset, 'reset 失败')}`);
    }

    const steps = [];
    for (const item of plan.included) {
      const message = `integrate(batch): ${item.task} ${item.head.slice(0, 12)}`;
      const merged = runFileCapture(
        'git',
        ['merge', '--no-ff', '--no-edit', '-m', message, item.head],
        { cwd: path, timeoutMs: SUBMIT_PUSH_TIMEOUT_MS },
      );
      if (!merged.ok) {
        const unresolved = unmergedPaths(path);
        // rerere 重放了全部解法时只差落 commit：这正是多轮候选免于重复手解的收口。
        if (unresolved.length === 0 && gitOperationState(path) === 'merge_head') {
          const committed = gitTry(['commit', '--no-edit'], path);
          if (committed.ok) {
            steps.push({
              task: item.task,
              worktree_id: item.worktree_id,
              input_sha: item.head,
              merge_commit: gitTry(['rev-parse', 'HEAD'], path).out || null,
              rerere_replayed: true,
            });
            continue;
          }
        }
        const conflict = {
          task: item.task,
          worktree_id: item.worktree_id,
          input_sha: item.head,
          onto_sha: liveHead.out === plan.target.sha && steps.length === 0
            ? plan.target.sha
            : (steps.at(-1)?.merge_commit ?? plan.target.sha),
          files: unresolved,
          candidate_path: path,
          detail: (merged.out || '').slice(0, 1000),
          aborted: false,
        };
        if (options.abortOnConflict) {
          gitTry(['merge', '--abort'], path);
          const reset = gitTry(['reset', '--hard', plan.target.sha], path);
          conflict.aborted = reset.ok;
        }
        return { state: 'conflict', steps, conflict, composed_sha: null };
      }
      steps.push({
        task: item.task,
        worktree_id: item.worktree_id,
        input_sha: item.head,
        merge_commit: gitTry(['rev-parse', 'HEAD'], path).out || null,
        rerere_replayed: false,
      });
    }
    return { state: 'composed', steps, conflict: null, composed_sha: gitTry(['rev-parse', 'HEAD'], path).out || null };
  }

  /**
   * 把 plan-batch 之后的手工仪式（建候选树、按序 merge、指纹落账）收进一条可重跑命令。
   *
   * 边界：**不执行任何门禁命令**。合成完成后只回显 Profile 声明的 post_integrate_steps
   * 清单，由 controller 逐条执行并用 `batch-step` 登记结果；portable core 永不跑 Profile 内容。
   * @param {{positionals:string[],flags:Map<string,unknown>}} args
   */
  function prepareBatchIntegration(args) {
    rejectUnknownFlags(args.flags, [
      'plan', 'target', 'candidate-task', 'agent', 'agent-id', 'purpose', 'owner',
      'abort-on-conflict', 'no-rerere', 'recompose', 'recompose-head', 'json', 'config', 'root', 'codegraph',
    ]);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const identity = resolveIdentity(args.flags);
    const asJson = Boolean(args.flags.get('json'));
    // --json 的 stdout 必须只有 JSON；诊断类回显在 JSON 模式下一律走 stderr。
    const notice = (message) => (asJson ? console.error(`${PREFIX} ${message}`) : log(message));

    const planPath = flag(args.flags, 'plan');
    let frozenPlan = null;
    let selectors = args.positionals;
    let targetOverride = flag(args.flags, 'target');
    if (planPath) {
      if (args.positionals.length > 0) die('--plan 与 selector 位置参数互斥；冻结计划已经带有输入清单。', 2);
      frozenPlan = readBatchPlanFile(planPath);
      // 必须用原始 selector 全集重算，而不是只用 included：被折叠或已在 target 的输入
      // 若随后前进，只回算 included 会让旧计划继续判定「新鲜」，把那部分改动静默漏出合成。
      selectors = Array.isArray(frozenPlan.requested_selectors) && frozenPlan.requested_selectors.length > 0
        ? frozenPlan.requested_selectors
        : [...frozenPlan.included, ...(frozenPlan.excluded ?? [])].map((item) => item.worktree_id);
      targetOverride = targetOverride ?? frozenPlan.target.ref;
    } else if (selectors.length < 2) {
      die('batch-integrate 需要 --plan <plan.json>，或至少两个 feature selector（即时规划）。', 2);
    }

    const plan = computeBatchPlan(loaded, selectors, targetOverride);
    if (!plan.ready) {
      for (const blocker of plan.blockers) console.error(`  [BLOCK] ${blocker.task ?? '-'} ${blocker.code}: ${blocker.detail}`);
      die('批次输入未就绪，拒绝合成；请先修复上述 blocker 再重新规划。');
    }
    if (frozenPlan) assertBatchPlanFresh(frozenPlan, plan);

    const candidateTask = flag(args.flags, 'candidate-task') ?? 'batch-integration-candidate';
    validateTaskSlug(candidateTask);
    validateTaskNaming(candidateTask, loaded.profile.task_naming);
    const records = loadRecords(loaded.context.common_dir);
    const liveCandidates = records.filter((record) => record.batch_integration && isActiveRecord(record));
    // 已冻结 batch_result 的候选 task_status=done，不再属于普通 active record，但同指纹仍必须作为
    // read-only already_composed 命中；否则重跑会误以为候选不存在，甚至尝试新建同身份候选。
    const reusable = records.find((record) => (
      record.batch_integration?.fingerprint === plan.fingerprint &&
      record.worktree_state !== 'reclaimed' &&
      record.task_status !== 'abandoned'
    ));
    const recompose = Boolean(args.flags.get('recompose'));
    const recomposeHead = flag(args.flags, 'recompose-head');
    if (recomposeHead && !recompose) die('--recompose-head 只能与 --recompose 一起使用。', 2);
    if (recompose && !recomposeHead) {
      die('--recompose 是破坏性操作，必须同时提供 --recompose-head <候选当前完整 HEAD> 进行精确授权。', 2);
    }
    return {
      args,
      loaded,
      identity,
      asJson,
      notice,
      frozenPlan,
      plan,
      candidateTask,
      records,
      reusable,
      superseded: liveCandidates.filter((record) => record.batch_integration.fingerprint !== plan.fingerprint),
      recompose,
      recomposeHead,
    };
  }

  function printAlreadyComposed(context, candidate, snapshot, batch) {
    const advanced = snapshot.head !== batch.composed_sha
      && Boolean(snapshot.head)
      && isAncestor(candidate.path, batch.composed_sha, snapshot.head);
    if (snapshot.head !== batch.composed_sha && !advanced) {
      die(
        `候选 HEAD=${snapshot.head?.slice(0, 12) ?? 'unreadable'} 既不等于已落账 composed_sha=` +
        `${batch.composed_sha.slice(0, 12)}，也不是它的后继提交，无法判定候选树处于何种状态。\n` +
        '请人工核对候选树历史；确需按同一计划重新合成，加 --recompose（会丢弃合成之后的提交）。',
      );
    }
    const result = {
      schema_version: 1,
      outcome: 'already_composed',
      fingerprint: context.plan.fingerprint,
      candidate: { worktree_id: candidate.worktree_id, task: candidate.task, path: candidate.path, branch: candidate.branch },
      target: context.plan.target,
      composed_sha: batch.composed_sha,
      head_sha: snapshot.head,
      advanced_beyond_composition: advanced,
      dirty: snapshot.dirty,
      steps: batch.steps,
      rerere: batch.rerere ?? null,
      post_integrate_steps: batch.post_integrate_steps ?? [],
    };
    if (context.asJson) console.log(JSON.stringify(result, null, 2));
    else {
      log(`同指纹候选已合成，幂等返回 fingerprint=${context.plan.fingerprint.slice(7, 19)} composed=${result.composed_sha.slice(0, 12)}`);
      if (advanced) {
        console.log(`  候选已在合成之上前进到 ${snapshot.head.slice(0, 12)}（通常是合成后再生成步骤的提交）；未重置、未改动步骤状态。`);
        console.log('  确需按同一计划重新合成请加 --recompose，它会丢弃这些提交。');
      }
      if (snapshot.dirty) console.log('  注意：候选树当前非干净，验收前请先处理未提交改动。');
      printPostIntegrateSteps(result.post_integrate_steps, candidate.task);
    }
  }

  function reuseBatchCandidate(context) {
    let candidate = context.reusable;
    const snapshot = liveGitSnapshot(candidate);
    if (!snapshot.present) die(`同指纹候选 record 存在但 worktree missing: ${candidate.path}；请先 doctor/reclaim。`);
    const batch = candidate.batch_integration;
    const composedBefore = batch.state === 'composed' && Boolean(batch.composed_sha);
    if (candidate.batch_result && context.recompose) die('batch_result 已冻结，禁止重合成；输入或合同变化必须另起候选。', 2);
    const ownedByController = candidate.agent?.host === context.identity.actor.host
      && candidate.agent?.id === context.identity.actor.id;
    // 跨会话可只读查询一棵已完成候选，但任何会移动 HEAD、续合冲突或改写台账的路径都必须
    // 先显式 handoff。否则另一个 controller 仅凭同一 fingerprint 就能重置原 owner 的提交。
    if (!ownedByController && (!composedBefore || context.recompose)) {
      die(
        `候选属于 ${candidate.agent?.host ?? 'unknown'}/${candidate.agent?.id ?? 'unknown'}，` +
        `当前会话是 ${context.identity.actor.host}/${context.identity.actor.id}；跨会话只允许读取 already_composed。\n` +
        '需要继续合成或重合成时，请先执行 handoff 转移所有权。',
      );
    }
    // 已合成的候选**默认永不重置**。合成之后候选树通常还会前进：controller 执行 Profile 声明的
    // 合成后再生成步骤（golden / codegen / lock）并提交，HEAD 就不再等于 composed_sha。
    // 旧实现只认「HEAD == composed_sha」为幂等，于是同指纹重跑会落进重新合成路径，
    // reset --hard 把这些生成提交连同已登记的步骤状态一起抹掉。
    if (composedBefore && !context.recompose) {
      printAlreadyComposed(context, candidate, snapshot, batch);
      return { done: true, candidate, recomposeContext: null };
    }
    if (snapshot.dirty !== false) {
      die(
        `候选树非干净，拒绝重置重合成: ${candidate.path}\n` +
        '若上一轮冲突已手工解出，请先提交该 merge（rerere 会录下解法），再重跑本命令；' +
        '若要放弃，请在候选树执行 git merge --abort。',
      );
    }
    if (!composedBefore && context.recompose) die('--recompose 只适用于已落账为 composed 的同指纹候选。');
    if (!context.recompose) return { done: false, candidate, recomposeContext: null };
    if (context.recomposeHead !== snapshot.head) {
      die(
        `RECOMPOSE_HEAD_STALE: --recompose-head=${context.recomposeHead} 与候选当前完整 HEAD=${snapshot.head ?? 'unreadable'} 不一致，拒绝重置。\n` +
        '请重新核对候选树，并用当前完整 HEAD 明示授权。',
      );
    }
    const recomposeContext = {
      authorized_head_sha: context.recomposeHead,
      discarded_head_sha: snapshot.head,
      previous_composed_sha: batch.composed_sha,
    };
    candidate = updateRecord(candidate, 'batch_candidate_recompose_authorized', (next) => {
      if (next.agent?.host !== context.identity.actor.host || next.agent?.id !== context.identity.actor.id) {
        throw new WorktreeTraceError('RECOMPOSE_OWNER_CHANGED', '候选所有权已变化，拒绝重置。');
      }
      if (
        next.batch_integration?.fingerprint !== context.plan.fingerprint
        || next.batch_integration?.state !== 'composed'
        || next.batch_integration?.composed_sha !== batch.composed_sha
      ) {
        throw new WorktreeTraceError('RECOMPOSE_RECORD_CHANGED', '候选合成台账已变化，拒绝按陈旧快照授权重置。');
      }
      next.last_seen_at = new Date().toISOString();
    }, {
      fingerprint: context.plan.fingerprint,
      target_sha: context.plan.target.sha,
      ...recomposeContext,
      requested_by: context.identity.actor,
    }, context.loaded.context.common_dir);
    context.notice(`--recompose：已按精确 HEAD ${context.recomposeHead.slice(0, 12)} 授权，将丢弃候选后续提交并重新合成。`);
    return { done: false, candidate, recomposeContext };
  }

  function prepareSupersededCandidate(context) {
    if (context.recompose) die('--recompose 未找到已落账为 composed 的同指纹候选，拒绝新建候选。');
    if (context.superseded.length > 1) {
      die(
        `存在 ${context.superseded.length} 棵旧指纹集成候选，自动替代登记只处理一棵，拒绝猜测：\n  - ` +
        context.superseded.map((record) => `${record.task}(${record.batch_integration.fingerprint.slice(7, 19)})=${record.path}`).join('\n  - ') +
        '\n请先回收多余候选，只保留一棵待替代的。',
      );
    }
    const previous = context.superseded[0] ?? null;
    if (previous && previous.task === context.candidateTask) {
      die(
        `候选 task ${context.candidateTask} 已绑定旧指纹 ${previous.batch_integration.fingerprint.slice(7, 19)}，` +
        `新指纹为 ${context.plan.fingerprint.slice(7, 19)}。\n` +
        '一次性候选不复用身份：请用 --candidate-task <新的 semantic slug> 建立替代候选（工具会自动登记替代关系），' +
        '或先回收旧候选再重跑。',
      );
    }
    if (!previous) return null;
    const snapshot = liveGitSnapshot(previous);
    if (!snapshot.present) die(`旧候选 worktree missing: ${previous.path}；请先 doctor/reclaim。`);
    if (snapshot.dirty !== false) die(`旧候选必须干净才能登记替代: ${previous.path}`);
    if (previous.agent?.host !== context.identity.actor.host || previous.agent?.id !== context.identity.actor.id) {
      die(
        `旧候选属于 ${previous.agent?.host}/${previous.agent?.id}，与当前会话不同；` +
        '跨会话不自动登记替代关系，请先人工回收旧候选。',
      );
    }
    if (previous.task_status !== 'abandoned') {
      updateRecord(previous, 'status_updated', (next) => {
        next.task_status = 'abandoned';
        next.last_seen_at = new Date().toISOString();
      }, {
        note: `批次输入变化，指纹 ${previous.batch_integration.fingerprint.slice(7, 19)} 已失效`,
      }, context.loaded.context.common_dir);
    }
    return previous;
  }

  function spawnBatchCandidate(context) {
    const previous = prepareSupersededCandidate(context);
    const spawnFlags = new Map();
    for (const key of ['agent', 'agent-id', 'owner', 'config', 'root', 'codegraph']) {
      const value = flag(context.args.flags, key);
      if (value) spawnFlags.set(key, value);
    }
    spawnFlags.set(
      'purpose',
      flag(context.args.flags, 'purpose') ?? `一次性批次集成候选 fingerprint=${context.plan.fingerprint.slice(7, 19)}`,
    );
    spawnFlags.set('base', context.plan.target.ref);
    spawnFlags.set('base-reason', `集成候选必须从批次冻结 target ${context.plan.target.ref} 起步`);
    if (previous) {
      spawnFlags.set('supersedes', previous.worktree_id);
      spawnFlags.set(
        'replacement-reason',
        `批次输入变化：${previous.batch_integration.fingerprint.slice(7, 19)} -> ${context.plan.fingerprint.slice(7, 19)}`,
      );
    } else if (coexistingSessionRecords(context.records, context.identity.actor, context.candidateTask).length > 0) {
      spawnFlags.set('parallel-reason', '一次性批次集成候选，与各 feature 交付可独立评审、合入和回退');
    }
    // spawn 的身份/路径回显对人有用，但 --json 的 stdout 必须只有 JSON；
    // 转存到 stderr，既不污染机器可读输出，也不丢诊断信息。
    const spawnChatter = [];
    const originalLog = console.log;
    if (context.asJson) console.log = (...parts) => spawnChatter.push(parts.join(' '));
    try {
      cmdSpawn({ positionals: [context.candidateTask], flags: spawnFlags });
    } finally {
      console.log = originalLog;
    }
    if (spawnChatter.length > 0) console.error(spawnChatter.join('\n'));

    const candidate = loadRecords(context.loaded.context.common_dir).find((record) =>
      record.task === context.candidateTask &&
      record.agent?.host === context.identity.actor.host &&
      record.agent?.id === context.identity.actor.id &&
      isActiveRecord(record));
    if (!candidate) die('集成候选 spawn 后未能定位到对应 record；请运行 doctor 复查。');
    const candidateHead = gitTry(['rev-parse', 'HEAD'], candidate.path);
    if (!candidateHead.ok || candidateHead.out !== context.plan.target.sha) {
      die(
        `候选树 HEAD=${candidateHead.out || 'unreadable'} 与冻结 target SHA=${context.plan.target.sha} 不一致；` +
        'target ref 可能在建树期间移动，请重新 plan-batch。',
      );
    }
    return { done: false, candidate, recomposeContext: null };
  }

  function configureBatchRerere(context, candidate) {
    const rerere = context.args.flags.get('no-rerere')
      ? {
          enabled: false,
          auto_update: false,
          scope: 'none',
          worktree_config_extension: 'not_needed',
          worktree_config_previous: null,
          reason: '--no-rerere 显式关闭',
        }
      : enableCandidateRerere(context.loaded, candidate.path);
    // 自动写共享 config（extensions.worktreeConfig）是本命令唯一会碰仓库级配置的动作，
    // 必须留下独立、可区分「本轮写入」与「原本已启用」的审计事件。
    if (rerere.worktree_config_extension === 'enabled_by_this_command') {
      updateRecord(candidate, 'repository_config_extension_enabled', (next) => {
        next.last_seen_at = new Date().toISOString();
      }, {
        key: 'extensions.worktreeConfig',
        value: 'true',
        previous: rerere.worktree_config_previous ?? 'unset',
        scope: 'shared_repository_config',
        written_by: 'batch-integrate',
        purpose: '为集成候选启用 worktree 级 rerere（rerere.enabled + rerere.autoUpdate）',
      }, context.loaded.context.common_dir);
      context.notice('已在共享仓库 config 启用 extensions.worktreeConfig（本轮写入，已记审计事件）。');
    }
    return rerere;
  }

  function recordBatchComposition(context, candidate, recomposeContext, rerere, composed) {
    const orderedInputs = context.plan.included.map((item) => ({
      task: item.task,
      worktree_id: item.worktree_id,
      branch: item.branch,
      head: item.head,
      upstream_ref: item.upstream_ref,
    }));
    const declaredSteps = (context.loaded.profile.post_integrate_steps ?? []).map((step) => ({
      name: step.name,
      hint: step.hint,
      state: 'pending',
      note: null,
      recorded_at: null,
    }));
    const now = new Date().toISOString();
    const batchState = {
      fingerprint: context.plan.fingerprint,
      target_ref: context.plan.target.ref,
      target_sha: context.plan.target.sha,
      plan_generated_at: context.frozenPlan?.generated_at ?? context.plan.generated_at,
      plan_source: context.frozenPlan ? 'frozen_plan_file' : 'inline_plan',
      ordered_inputs: orderedInputs,
      state: composed.state,
      steps: composed.steps,
      composed_sha: composed.composed_sha,
      composed_at: composed.state === 'composed' ? now : null,
      conflict: composed.conflict,
      rerere,
      recompose: recomposeContext,
      post_integrate_steps: composed.state === 'composed' ? declaredSteps : [],
    };
    const updated = updateRecord(
      candidate,
      composed.state === 'composed' ? 'batch_candidate_composed' : 'batch_candidate_conflict',
      (next) => {
        next.batch_integration = batchState;
        next.task_status = composed.state === 'composed' ? 'integrating' : next.task_status;
        next.last_seen_at = now;
        next.last_head = composed.composed_sha ?? next.last_head;
      },
      {
        fingerprint: context.plan.fingerprint,
        target_sha: context.plan.target.sha,
        ordered_input_shas: orderedInputs.map((item) => item.head),
        merge_commits: composed.steps.map((step) => step.merge_commit),
        rerere,
        recompose: recomposeContext,
        conflict: composed.conflict,
      },
      context.loaded.context.common_dir,
    );
    return {
      schema_version: 1,
      outcome: composed.state,
      fingerprint: context.plan.fingerprint,
      candidate: {
        worktree_id: updated.worktree_id,
        task: updated.task,
        path: updated.path,
        branch: updated.branch,
      },
      target: context.plan.target,
      ordered_inputs: orderedInputs,
      steps: composed.steps,
      composed_sha: composed.composed_sha,
      rerere,
      recompose: recomposeContext,
      conflict: composed.conflict,
      post_integrate_steps: batchState.post_integrate_steps,
    };
  }

  function printBatchComposition(context, result) {
    if (context.asJson) console.log(JSON.stringify(result, null, 2));
    else if (result.outcome === 'composed') {
      log(`批次合成完成 candidate=${result.candidate.task} sha=${result.composed_sha.slice(0, 12)} fingerprint=${context.plan.fingerprint.slice(7, 19)}`);
      for (const step of result.steps) {
        console.log(`  [MERGED] ${step.task} ${step.input_sha.slice(0, 12)} -> ${step.merge_commit?.slice(0, 12)}${step.rerere_replayed ? ' (rerere 重放)' : ''}`);
      }
      console.log(`  rerere=${result.rerere.enabled ? result.rerere.scope : `off(${result.rerere.reason})`}`);
      console.log(`  候选树: ${result.candidate.path}`);
      printPostIntegrateSteps(result.post_integrate_steps, result.candidate.task);
      console.log('  下一步由 controller 执行门禁；本命令不跑任何验收命令。');
    } else {
      log(`批次合成冲突，停在 ${result.conflict.task} ${result.conflict.input_sha.slice(0, 12)}`);
      console.log(`  候选树: ${result.conflict.candidate_path}`);
      console.log(`  合入侧(ours): ${result.conflict.onto_sha.slice(0, 12)}  待并侧(theirs): ${result.conflict.input_sha.slice(0, 12)}`);
      for (const file of result.conflict.files) console.log(`  [CONFLICT] ${file}`);
      console.log(result.conflict.aborted
        ? '  已按 --abort-on-conflict 回滚到干净 target。'
        : '  已停在冲突处（未自动解、未自动 abort）：请裁决后手工解并提交该 merge，再重跑本命令由 rerere 重放。');
    }
    if (result.outcome !== 'composed') process.exitCode = 1;
  }

  function cmdBatchIntegrate(args) {
    const context = prepareBatchIntegration(args);
    const resolved = context.reusable ? reuseBatchCandidate(context) : spawnBatchCandidate(context);
    if (resolved.done) return;
    const rerere = configureBatchRerere(context, resolved.candidate);
    const composed = composeBatchCandidate(resolved.candidate, context.plan, {
      abortOnConflict: Boolean(args.flags.get('abort-on-conflict')),
      recomposeExpectedHead: resolved.recomposeContext?.authorized_head_sha ?? null,
    });
    const result = recordBatchComposition(
      context,
      resolved.candidate,
      resolved.recomposeContext,
      rerere,
      composed,
    );
    printBatchComposition(context, result);
  }

  /** @param {Record<string,any>[]} steps @param {string} task */
  function printPostIntegrateSteps(steps, task) {
    if (!steps || steps.length === 0) return;
    console.log('  Profile 声明的合成后再生成步骤（只回显、不代跑）：');
    for (const step of steps) {
      console.log(`  [${step.state.toUpperCase()}] ${step.name}: ${step.hint}`);
    }
    console.log(`  执行后登记：batch-step ${task} --step <name> --state done|skipped|failed`);
  }

  return {
    cmdBatchIntegrate,
  };
}
