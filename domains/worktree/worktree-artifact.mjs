// @ts-check

/**
 * Domain command factory. Dependencies are injected once by the thin CLI composition root,
 * keeping this module acyclic and independently reviewable.
 * @param {Record<string, any>} deps
 */
export function createCommands(deps) {
  const {
    resolve,
    ensureRepositoryIdentity,
    loadRepositoryProfile,
    readRepositoryIdentity,
    git,
    gitTry,
    die,
    flag,
    readJsonFileOrDie,
    rejectUnknownFlags,
    loadRecords,
    selectRecord,
    liveGitSnapshot,
    assertHistoryOperationIdle,
  } = deps;

  function worktreeEnvelopeContext(args) {
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const record = selectRecord(loadRecords(loaded.context.common_dir), args.positionals[0] ?? null, flag(args.flags, 'id'));
    const identity = ensureRepositoryIdentity(loaded.context);
    const snapshot = liveGitSnapshot(record);
    return { loaded, record, identity, snapshot };
  }

  function buildBinding(record, identity, snapshot) {
    return {
      schema_version: 1,
      provider: 'manage-worktrees',
      repository_id: identity.repository_id,
      worktree_id: record.worktree_id,
      workdir: record.path,
      branch: record.branch,
      owner: { agent: record.agent.host, agent_id: record.agent.id, epoch: record.ownership_epochs?.length ?? 0 },
      base_sha: record.base_sha,
      head_sha: snapshot.head ?? record.last_head,
      task_status: record.task_status,
      worktree_state: record.worktree_state,
    };
  }

  function buildArtifact(record, identity, snapshot, cwd) {
    if (!snapshot.present) die('Artifact 要求 worktree 当前存在。', 2);
    if (snapshot.dirty !== false) die('Artifact 要求 worktree clean。', 2);
    if (!snapshot.head) die('Artifact 无法冻结 HEAD。', 2);
    const objectFormat = git(['rev-parse', '--show-object-format'], cwd);
    return {
      schema_version: 1,
      provider: 'manage-worktrees',
      repository_id: identity.repository_id,
      object_format: objectFormat,
      base_sha: record.base_sha,
      artifact_sha: snapshot.head,
      branch_hint: record.branch ?? undefined,
      worktree_id: record.worktree_id,
      ownership_epoch: record.ownership_epochs?.length ?? 0,
    };
  }

  function cmdBinding(args) {
    rejectUnknownFlags(args.flags, ['json', 'id', 'config']);
    const { record, identity, snapshot } = worktreeEnvelopeContext(args);
    console.log(JSON.stringify(buildBinding(record, identity, snapshot), null, 2));
  }

  function cmdArtifact(args) {
    rejectUnknownFlags(args.flags, ['json', 'id', 'config']);
    const { loaded, record, identity, snapshot } = worktreeEnvelopeContext(args);
    assertHistoryOperationIdle(record, 'artifact');
    console.log(JSON.stringify(buildArtifact(record, identity, snapshot, loaded.context.current_worktree), null, 2));
  }

  function verifyArtifactEnvelope(artifact, loaded, records = loadRecords(loaded.context.common_dir)) {
    if (!artifact || artifact.schema_version !== 1 || artifact.provider !== 'manage-worktrees') throw new Error('Artifact schema/provider 无效');
    if (typeof artifact.worktree_id !== 'string' || !artifact.worktree_id) throw new Error('Artifact worktree_id 缺失');
    if (!Number.isInteger(artifact.ownership_epoch) || artifact.ownership_epoch < 1) throw new Error('Artifact ownership_epoch 缺失或无效');
    const identity = readRepositoryIdentity(loaded.context);
    if (!identity || artifact.repository_id !== identity.repository_id) throw new Error('Artifact repository_id 不匹配');
    const objectFormat = git(['rev-parse', '--show-object-format'], loaded.context.current_worktree);
    if (artifact.object_format !== objectFormat) throw new Error('Artifact object_format 不匹配');
    const length = objectFormat === 'sha256' ? 64 : objectFormat === 'sha1' ? 40 : 0;
    for (const field of ['base_sha', 'artifact_sha']) {
      if (!new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(String(artifact[field] ?? ''))) throw new Error(`${field} 不是完整 object id`);
      if (!gitTry(['cat-file', '-e', `${artifact[field]}^{commit}`], loaded.context.current_worktree).ok) throw new Error(`${field} 不是可达 commit`);
    }
    if (!gitTry(['merge-base', '--is-ancestor', artifact.base_sha, artifact.artifact_sha], loaded.context.current_worktree).ok) throw new Error('Artifact base 不是 artifact ancestor');
    const record = records.find((candidate) => candidate.worktree_id === artifact.worktree_id);
    if (!record) throw new Error('Artifact worktree_id 不存在');
    if (record.base_sha !== artifact.base_sha) throw new Error('Artifact base_sha 与 worktree record 不匹配');
    if (artifact.ownership_epoch !== (record.ownership_epochs?.length ?? 0)) throw new Error('Artifact ownership_epoch 已 stale');
    const live = liveGitSnapshot(record);
    if (!live.present) throw new Error('Artifact worktree 已不存在');
    if (live.head !== artifact.artifact_sha) throw new Error('Artifact SHA 与 live HEAD 不一致');
    if (live.dirty !== false) throw new Error('Artifact worktree 已变脏');
    return { valid: true, repository_id: artifact.repository_id, artifact_sha: artifact.artifact_sha, object_format: artifact.object_format };
  }

  function cmdVerifyArtifact(args) {
    rejectUnknownFlags(args.flags, ['json', 'config']);
    const path = args.positionals[0];
    if (!path) die('verify-artifact 需要 Artifact JSON 文件。', 2);
    const loaded = loadRepositoryProfile({ explicitConfigPath: flag(args.flags, 'config') });
    const artifact = readJsonFileOrDie(resolve(path), 'Artifact 文件');
    console.log(JSON.stringify(verifyArtifactEnvelope(artifact, loaded), null, 2));
  }


  return {
    worktreeEnvelopeContext,
    verifyArtifactEnvelope,
    cmdBinding,
    cmdArtifact,
    cmdVerifyArtifact,
  };
}
