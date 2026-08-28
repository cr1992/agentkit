// @ts-check

import { gitTry, isAncestor } from './worktree-core.mjs';
import { runFileCapture } from './worktree-process.mjs';

const MERGE_TREE_TIMEOUT_MS = 60_000;
const CONFLICT_SCAN_FILES_CAP = 50;
const CONFLICT_SCAN_NOTES_CAP = 20;
const CONFLICT_SCAN_PRINT_CAP = 10;

/**
 * "只有在合成态重新生成一次才对"的产物路径。这类文件被多个分支各自重生成后必然冲突，
 * 而且挑任何一边都是错的——所以矩阵命中它们时要提示的是"合成后重跑生成步骤"，
 * 不是"谁先合谁后合"。
 *
 * 命中只是**提示**，不是判定：仓库到底该跑什么命令由 Profile 的 `post_integrate_steps`
 * 声明，portable core 既不猜命令也不代跑（与 batch-integrate 是同一条边界）。
 */
const REGENERATED_PATH_RULES = [
  { kind: 'lockfile', pattern: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|pubspec\.lock|Podfile\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock|go\.sum|flake\.lock)$/u },
  { kind: 'golden', pattern: /(^|\/)(goldens?|__snapshots__|snapshots)\//u },
  { kind: 'golden', pattern: /\.(golden|snap|ambr)$/u },
  { kind: 'codegen', pattern: /(^|\/)(__generated__|generated)\//u },
  { kind: 'codegen', pattern: /\.(g|gen|generated|freezed|pb)\.[a-z0-9]+$/u },
  { kind: 'codegen', pattern: /_pb2(_grpc)?\.pyi?$/u },
  { kind: 'build_output', pattern: /(^|\/)dist\//u },
];

/**
 * 路径是否属于"合成后需重生成"的产物类；返回粗分类别或 null。
 * @param {string} path
 */
export function regeneratedPathKind(path) {
  if (typeof path !== 'string' || !path) return null;
  for (const rule of REGENERATED_PATH_RULES) if (rule.pattern.test(path)) return rule.kind;
  return null;
}

/**
 * 解析 `git --version` 的前三段版本号。
 * @param {string|null} text
 */
export function parseGitVersion(text) {
  if (typeof text !== 'string') return null;
  const matched = text.match(/(\d+)\.(\d+)(?:\.(\d+))?/u);
  if (!matched) return null;
  return [Number(matched[1]), Number(matched[2]), Number(matched[3] ?? 0)];
}

/**
 * 冲突预测要求 Git ≥ 2.39。
 *
 * `merge-tree --write-tree` 本身 2.38 就有，但本扫描依赖的是 `-z` 信息段里那条**结构化 NUL
 * 记录**（`<路径数>NUL<路径>...NUL<conflict-type>NUL<message>NUL`，其中 conflict-type 是
 * git-merge-tree(1) 明说的 stable string）。2.38 的 `-z` 信息段还是自由文本，按结构化格式去解
 * 会把消息当成类型，冲突类型粗分随之错判。
 *
 * 与其写一段本机无法实测的 2.38 兼容分支，不如把支持线抬到 2.39 并 fail-closed 降级：
 * 低版本回报 `supported: false`，计划本身照常冻结，绝不给出一份可能错的矩阵。
 * @param {string|null} versionText
 */
export function mergeTreeScanSupported(versionText) {
  const version = parseGitVersion(versionText);
  if (!version) return false;
  const [major, minor] = version;
  return major > 2 || (major === 2 && minor >= 39);
}

/**
 * 成对状态分类。**冲突判定只认 merge-tree 退出码**，不认文件条目数量。
 *
 * git-merge-tree(1) MISTAKES TO AVOID 原文：「Do NOT interpret an empty Conflicted file info
 * list as a clean merge; check the exit status.」——目录重命名类冲突可以退出码为 1 却没有任何
 * unmerged 文件条目。按条目数判 clean 会把真冲突报成干净。
 *
 * 相邻面算不出来（diff 失败/超时）时报 `incomplete`，不静默降级成 `clean`。
 * @param {{mergeTreeOk:boolean, conflicted:boolean, adjacentFiles:number|null}} input
 */
export function classifyPairState({ mergeTreeOk, conflicted, adjacentFiles }) {
  if (!mergeTreeOk) return 'error';
  if (conflicted) return 'conflict';
  if (adjacentFiles === null) return 'incomplete';
  return adjacentFiles > 0 ? 'adjacent' : 'clean';
}

/**
 * 写树式干跑 merge：`git merge-tree --write-tree` 在**对象库**里算出合并结果，
 * 只写未被任何 ref 引用的临时 tree/blob（随 gc 回收），不动工作区、index、HEAD 和任何 ref。
 * 因此它可以在 plan-batch 的只读语义下跑，也不需要先建候选树。
 *
 * 退出码语义（git-merge-tree(1) EXIT STATUS）：0=可自动合并，1=有冲突，其他=Git 自身失败。
 * `conflicted` 一律取自退出码；文件条目只是明细，可能为空。
 * @param {string} cwd @param {string} a @param {string} b
 */
function mergeTreeDryRun(cwd, a, b) {
  const result = runFileCapture(
    'git',
    ['merge-tree', '--write-tree', '-z', '--name-only', a, b],
    { cwd, timeoutMs: MERGE_TREE_TIMEOUT_MS },
  );
  if (result.status === 0 && result.ok) return { ok: true, conflicted: false, files: [], notes: [], reason: null };
  if (result.status !== 1) {
    return { ok: false, conflicted: null, files: [], notes: [], reason: (result.stderr || result.stdout || 'git merge-tree 执行失败').slice(0, 300) };
  }
  // -z 输出：<冲突树 OID>NUL <冲突文件名>NUL... NUL（段结束）
  // 之后是结构化信息记录：<路径数>NUL <路径>NUL... <conflict-type>NUL <人读 message>NUL
  const fields = result.stdout.split('\0');
  let cursor = 1;
  const paths = [];
  while (cursor < fields.length && fields[cursor] !== '') paths.push(fields[cursor++]);
  cursor += 1;
  const types = new Map();
  const notes = [];
  while (cursor < fields.length) {
    const count = Number.parseInt(fields[cursor++], 10);
    if (!Number.isInteger(count) || count < 0 || cursor + count >= fields.length) break;
    const entryPaths = fields.slice(cursor, cursor + count);
    cursor += count;
    const conflictType = fields[cursor++];
    const message = fields[cursor++] ?? '';
    if (!conflictType || !conflictType.startsWith('CONFLICT')) continue;
    for (const path of entryPaths) if (!types.has(path)) types.set(path, conflictType);
    if (notes.length < CONFLICT_SCAN_NOTES_CAP) {
      notes.push({ paths: entryPaths, conflict_type: conflictType, message: message.trim().slice(0, 300) });
    }
  }
  return {
    ok: true,
    conflicted: true,
    files: paths.map((path) => ({ path, conflict_type: types.get(path) ?? 'CONFLICT (unknown)' })),
    notes,
    reason: null,
  };
}

/**
 * watcher 的只读 refresh 预判。它回答“把当前 target 与冻结 feature head 做三方合并是否出现
 * 文本/树冲突”，不承诺逐 commit rebase 一定同样成功；调用方必须把 method/limitation 一并展示。
 * @param {string} cwd @param {string|null} recordedBaseSha @param {string} targetSha @param {string} headSha
 */
export function predictReviewRefresh(cwd, recordedBaseSha, targetSha, headSha) {
  if (!recordedBaseSha) return { state: 'unknown', method: 'merge-tree', reason: 'recorded base SHA missing' };
  if (recordedBaseSha === targetSha) return { state: 'unchanged', method: 'merge-tree', reason: null };
  if (!isAncestor(cwd, recordedBaseSha, targetSha)) {
    return { state: 'diverged', method: 'ancestry', reason: 'target no longer descends from recorded base' };
  }
  const version = gitTry(['--version'], cwd);
  if (!mergeTreeScanSupported(version.ok ? version.out : null)) {
    return { state: 'unknown', method: 'merge-tree', reason: 'Git 2.39+ required for structured merge-tree prediction' };
  }
  const preview = mergeTreeDryRun(cwd, targetSha, headSha);
  if (!preview.ok) return { state: 'unknown', method: 'merge-tree', reason: preview.reason };
  return {
    state: preview.conflicted ? 'conflict' : 'clean',
    method: 'merge-tree',
    reason: null,
    conflict_files: preview.files.slice(0, CONFLICT_SCAN_PRINT_CAP).map((item) => item.path),
    files_truncated: preview.files.length > CONFLICT_SCAN_PRINT_CAP,
    limitation: 'merge-tree is a merge preview; per-commit rebase may still differ',
  };
}

/** @param {string} cwd @param {string} from @param {string} to */
function changedPathsBetween(cwd, from, to) {
  const diff = gitTry(['diff', '--name-only', '-z', from, to], cwd, { timeoutMs: MERGE_TREE_TIMEOUT_MS });
  if (!diff.ok) return null;
  return new Set(diff.out.split('\0').filter(Boolean));
}

/**
 * 干跑一对提交，产出冲突文件清单和"同文件相邻"清单。
 *
 * 两类必须分开报，因为处置完全不同：
 * - `overlapping` / `structural`：Git 自己合不了，合成时一定要人裁决。
 * - `adjacent`：Git 能自动合，但两支确实改了同一个文件——语义冲突（哨兵语义、
 *   同一常量两种含义）正好躲在这里，机器判不出来，只能靠人看清单。
 * @param {string} cwd @param {string} a @param {string} b
 */
function scanCommitPair(cwd, a, b) {
  const base = gitTry(['merge-base', a, b], cwd);
  const dryRun = mergeTreeDryRun(cwd, a, b);
  if (!dryRun.ok) {
    return {
      state: classifyPairState({ mergeTreeOk: false, conflicted: false, adjacentFiles: 0 }),
      merge_base: base.ok ? base.out : null,
      conflict_files: 0,
      adjacent_files: null,
      files: [],
      files_total: 0,
      files_truncated: false,
      conflict_notes: [],
      regenerated: [],
      reason: dryRun.reason,
    };
  }
  const conflicted = new Map(dryRun.files.map((item) => [item.path, item.conflict_type]));
  // 相邻面算不出来时保持 null（未知），绝不退化成空数组——空数组会被读成"确认没有相邻文件"。
  let adjacent = null;
  let adjacentReason = null;
  if (!base.ok || !base.out) {
    adjacentReason = '无法解析 merge base，同文件相邻面未知。';
  } else {
    const changedA = changedPathsBetween(cwd, base.out, a);
    const changedB = changedPathsBetween(cwd, base.out, b);
    if (changedA && changedB) adjacent = [...changedA].filter((path) => changedB.has(path) && !conflicted.has(path)).sort();
    else adjacentReason = 'git diff 失败或超时，同文件相邻面未知。';
  }
  // 全量清单：REGEN 汇总、计数都基于它；截断只发生在展示用的 files 上。
  const allFiles = [
    ...[...conflicted.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, conflictType]) => ({
        path,
        class: conflictType === 'CONFLICT (contents)' ? 'overlapping' : 'structural',
        conflict_type: conflictType,
        regenerated: regeneratedPathKind(path),
      })),
    ...(adjacent ?? []).map((path) => ({ path, class: 'adjacent', conflict_type: null, regenerated: regeneratedPathKind(path) })),
  ];
  return {
    state: classifyPairState({
      mergeTreeOk: true,
      conflicted: dryRun.conflicted,
      adjacentFiles: adjacent === null ? null : adjacent.length,
    }),
    merge_base: base.ok ? base.out : null,
    conflict_files: conflicted.size,
    adjacent_files: adjacent === null ? null : adjacent.length,
    files: allFiles.slice(0, CONFLICT_SCAN_FILES_CAP),
    files_total: allFiles.length,
    files_truncated: allFiles.length > CONFLICT_SCAN_FILES_CAP,
    conflict_notes: dryRun.notes,
    regenerated: allFiles.filter((file) => file.regenerated).map((file) => ({ path: file.path, kind: file.regenerated, class: file.class })),
    reason: adjacentReason,
  };
}

/**
 * 冻结前的冲突矩阵：对 included 输入两两干跑，并各自对 target 干跑一次。
 *
 * 目的是把"哪两支会打架、打在哪些文件上"提前到**规划期**，让合并排序和"同构双生
 * 该不该并支"有依据；否则这些信息只有在 batch-integrate 真的合到冲突时才暴露。
 *
 * 已知边界（不要当成保证）：两两干跑预测的是**成对**冲突。实际合成是顺序累积的三方
 * 合并，两两都干净不等于合成一定干净；矩阵是决策输入，不替代 batch-integrate 的实合。
 * @param {string} cwd
 * @param {{ref:string,sha:string}} target
 * @param {Record<string,any>[]} inputs
 */
export function computeConflictScan(cwd, target, inputs) {
  const unsupported = (reason) => ({
    schema_version: 1,
    supported: false,
    reason,
    pairs: [],
    against_target: [],
    summary: null,
  });
  const versionText = gitTry(['--version'], cwd);
  if (!mergeTreeScanSupported(versionText.ok ? versionText.out : null)) {
    return unsupported(
      `冲突预测要求 Git ≥ 2.39（本机：${versionText.ok ? versionText.out : '版本不可读'}）：` +
      '2.38 的 `merge-tree -z` 信息段还不是结构化 NUL 记录，按新格式解会错判冲突类型。' +
      '本次跳过冲突预测，不影响计划本身。',
    );
  }
  const probe = runFileCapture(
    'git',
    ['merge-tree', '--write-tree', '-z', '--name-only', target.sha, target.sha],
    { cwd, timeoutMs: MERGE_TREE_TIMEOUT_MS },
  );
  if (probe.status !== 0) {
    return unsupported(`本机 \`git merge-tree --write-tree\` 自检未通过：${(probe.stderr || probe.stdout || '原因未知').slice(0, 200)}；本次跳过冲突预测，不影响计划本身。`);
  }
  const identify = (item) => ({ task: item.task, worktree_id: item.worktree_id, head: item.head });
  const againstTarget = inputs.map((item) => ({
    input: identify(item),
    target: { ref: target.ref, sha: target.sha },
    ...scanCommitPair(cwd, target.sha, item.head),
  }));
  const pairs = [];
  for (let left = 0; left < inputs.length; left++) {
    for (let right = left + 1; right < inputs.length; right++) {
      pairs.push({
        a: identify(inputs[left]),
        b: identify(inputs[right]),
        ...scanCommitPair(cwd, inputs[left].head, inputs[right].head),
      });
    }
  }
  // 每个输入的"冲突面"：直接支撑"冲突面大的压轴"这条排序口径。
  // conflicting_peers 排在 conflict_files 前面，是因为没有文件条目的目录重命名类冲突
  // 同样是真冲突，不能因为 conflict_files=0 被排到干净输入后面。
  const load = inputs.map((item) => {
    const related = pairs.filter((pair) => pair.a.worktree_id === item.worktree_id || pair.b.worktree_id === item.worktree_id);
    return {
      task: item.task,
      worktree_id: item.worktree_id,
      conflicting_peers: related.filter((pair) => pair.state === 'conflict').length,
      conflict_files: related.reduce((sum, pair) => sum + pair.conflict_files, 0),
      adjacent_files: related.reduce((sum, pair) => sum + (pair.adjacent_files ?? 0), 0),
      incomplete_peers: related.filter((pair) => pair.state === 'incomplete' || pair.state === 'error' || pair.adjacent_files === null).length,
      target_conflict_files: againstTarget.find((row) => row.input.worktree_id === item.worktree_id)?.conflict_files ?? 0,
    };
  }).sort((left, right) =>
    right.conflicting_peers - left.conflicting_peers ||
    right.conflict_files - left.conflict_files ||
    right.adjacent_files - left.adjacent_files ||
    left.task.localeCompare(right.task));
  // 汇总跑在**未截断**的全量命中上：先截 50 再统计会让排在后面的 lock/golden 从汇总消失。
  const regenerated = new Map();
  for (const pair of [...pairs, ...againstTarget]) {
    for (const hit of pair.regenerated) {
      const entry = regenerated.get(hit.path) ?? { path: hit.path, kind: hit.kind, pairs: 0, classes: new Set() };
      entry.pairs += 1;
      entry.classes.add(hit.class);
      regenerated.set(hit.path, entry);
    }
  }
  const allRows = [...pairs, ...againstTarget];
  return {
    schema_version: 1,
    supported: true,
    reason: null,
    pairs,
    against_target: againstTarget,
    summary: {
      pair_count: pairs.length,
      conflicting_pairs: pairs.filter((pair) => pair.state === 'conflict').length,
      adjacent_only_pairs: pairs.filter((pair) => pair.state === 'adjacent').length,
      incomplete_pairs: pairs.filter((pair) => pair.state === 'incomplete').length,
      failed_pairs: pairs.filter((pair) => pair.state === 'error').length,
      // 相邻面未知的格子：conflict 态也可能相邻面算不出来，单独计数，不许被 state 掩盖。
      unknown_adjacency_rows: allRows.filter((row) => row.adjacent_files === null).length,
      pathless_conflict_pairs: pairs.filter((pair) => pair.state === 'conflict' && pair.conflict_files === 0).length,
      max_pair_conflict_files: pairs.reduce((max, pair) => Math.max(max, pair.conflict_files), 0),
      inputs: load,
      regenerated_paths: [...regenerated.values()]
        .map((hit) => ({ path: hit.path, kind: hit.kind, pairs: hit.pairs, classes: [...hit.classes].sort() }))
        .sort((left, right) => right.pairs - left.pairs || left.path.localeCompare(right.path)),
    },
  };
}

/** @param {Record<string,any>} row */
function formatPairCounts(row) {
  const adjacent = row.adjacent_files === null ? '未知' : String(row.adjacent_files);
  return `conflict=${row.conflict_files} adjacent=${adjacent}`;
}

/** @param {Record<string,any>} row @param {string} indent */
function printPairDetail(row, indent) {
  for (const file of row.files.slice(0, CONFLICT_SCAN_PRINT_CAP)) {
    console.log(`${indent}${file.class.padEnd(12)} ${file.path}${file.conflict_type ? ` ${file.conflict_type}` : ''}${file.regenerated ? ` [${file.regenerated}]` : ''}`);
  }
  if (row.files_total > CONFLICT_SCAN_PRINT_CAP) {
    console.log(`${indent}… 共 ${row.files_total} 项${row.files_truncated ? `（--json 亦按 ${CONFLICT_SCAN_FILES_CAP} 项上限截断；计数与产物类汇总仍是全量）` : ''}`);
  }
  // 冲突但没有文件条目时，信息性记录是唯一线索，必须打出来。
  if (row.state === 'conflict' && row.conflict_files === 0) {
    for (const note of row.conflict_notes) {
      console.log(`${indent}[NOTE] ${note.conflict_type} → ${note.paths.join(', ')}`);
      if (note.message) console.log(`${indent}       ${note.message}`);
    }
  }
  if (row.reason) console.log(`${indent}[DEGRADED] ${row.reason}`);
}

/** @param {ReturnType<typeof computeConflictScan>} scan */
export function printConflictScan(scan) {
  if (!scan.supported) {
    console.log(`  [SCAN] 跳过：${scan.reason}`);
    return;
  }
  const summary = scan.summary;
  console.log(
    `  [SCAN] pairs=${summary.pair_count} conflicting=${summary.conflicting_pairs} adjacent_only=${summary.adjacent_only_pairs}` +
    ` incomplete=${summary.incomplete_pairs} failed=${summary.failed_pairs} unknown_adjacency=${summary.unknown_adjacency_rows}`,
  );
  const ordered = [...scan.pairs].sort((left, right) =>
    (right.state === 'conflict' ? 1 : 0) - (left.state === 'conflict' ? 1 : 0) ||
    right.conflict_files - left.conflict_files ||
    (right.adjacent_files ?? 0) - (left.adjacent_files ?? 0));
  for (const pair of ordered) {
    if (pair.state === 'error') {
      console.log(`    [PAIR] ${pair.a.task} × ${pair.b.task} 扫描失败：${pair.reason}`);
      continue;
    }
    console.log(`    [PAIR] ${pair.a.task} × ${pair.b.task} ${formatPairCounts(pair)} state=${pair.state}`);
    printPairDetail(pair, '        ');
  }
  for (const row of scan.against_target) {
    if (row.state === 'error') {
      console.log(`    [TARGET] ${row.input.task} → ${row.target.ref} 扫描失败：${row.reason}`);
      continue;
    }
    console.log(`    [TARGET] ${row.input.task} → ${row.target.ref} ${formatPairCounts(row)} state=${row.state}`);
    if (row.state !== 'clean') printPairDetail(row, '        ');
  }
  for (const row of summary.inputs) {
    console.log(`    [LOAD] ${row.task} conflict=${row.conflict_files} adjacent=${row.adjacent_files} peers=${row.conflicting_peers} vs_target=${row.target_conflict_files}`);
  }
  for (const hit of summary.regenerated_paths) {
    console.log(`    [REGEN] ${hit.path} (${hit.kind}) 命中 ${hit.pairs} 处；这类产物只能在合成态重新生成，见 Profile post_integrate_steps`);
  }
  if (summary.incomplete_pairs > 0 || summary.failed_pairs > 0 || summary.unknown_adjacency_rows > 0) {
    console.log('    [WARN] 存在未完成的格子：矩阵不完整，不能据它断言"没有冲突"。');
  }
}
