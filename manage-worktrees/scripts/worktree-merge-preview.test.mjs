import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyPairState,
  mergeTreeScanSupported,
  parseGitVersion,
  regeneratedPathKind,
} from './worktree-merge-preview.mjs';

test('产物类路径粗分只认「必须在合成态重生成」的那几类，不误伤普通源码', () => {
  assert.equal(regeneratedPathKind('pnpm-lock.yaml'), 'lockfile');
  assert.equal(regeneratedPathKind('app/moii_app/pubspec.lock'), 'lockfile');
  assert.equal(regeneratedPathKind('test/goldens/home.png'), 'golden');
  assert.equal(regeneratedPathKind('src/__snapshots__/view.test.ts.snap'), 'golden');
  assert.equal(regeneratedPathKind('lib/models/user.freezed.dart'), 'codegen');
  assert.equal(regeneratedPathKind('api/service.pb.go'), 'codegen');
  assert.equal(regeneratedPathKind('dist/bundle.js'), 'build_output');
  assert.equal(regeneratedPathKind('lib/models/user.dart'), null);
  assert.equal(regeneratedPathKind('src/lock.rs'), null);
  assert.equal(regeneratedPathKind(''), null);
  assert.equal(regeneratedPathKind(null), null);
});

test('成对状态分类 fail-closed：相邻面算不出来时只能报 incomplete，不能默认 clean', () => {
  assert.equal(classifyPairState({ mergeTreeOk: false, conflicted: false, adjacentFiles: 0 }), 'error');
  assert.equal(classifyPairState({ mergeTreeOk: true, conflicted: true, adjacentFiles: 0 }), 'conflict');
  assert.equal(classifyPairState({ mergeTreeOk: true, conflicted: true, adjacentFiles: null }), 'conflict');
  assert.equal(classifyPairState({ mergeTreeOk: true, conflicted: false, adjacentFiles: 3 }), 'adjacent');
  assert.equal(classifyPairState({ mergeTreeOk: true, conflicted: false, adjacentFiles: 0 }), 'clean');
  assert.equal(classifyPairState({ mergeTreeOk: true, conflicted: false, adjacentFiles: null }), 'incomplete');
});

test('冲突预测的 Git 版本闸按 ≥2.39 判定，低版本走 supported:false 而不是错解旧格式', () => {
  assert.deepEqual(parseGitVersion('git version 2.50.1 (Apple Git-155)'), [2, 50, 1]);
  assert.deepEqual(parseGitVersion('git version 2.39.0'), [2, 39, 0]);
  assert.equal(parseGitVersion('not a version'), null);
  assert.equal(mergeTreeScanSupported('git version 2.39.0'), true);
  assert.equal(mergeTreeScanSupported('git version 2.50.1 (Apple Git-155)'), true);
  assert.equal(mergeTreeScanSupported('git version 3.0.0'), true);
  // 2.38 有 --write-tree，但 -z 信息段还不是结构化 NUL 记录，按新格式解会错判冲突类型。
  assert.equal(mergeTreeScanSupported('git version 2.38.5'), false);
  assert.equal(mergeTreeScanSupported('git version 2.30.1'), false);
  assert.equal(mergeTreeScanSupported(null), false);
});
