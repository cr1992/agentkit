#!/usr/bin/env node
// 1.x 兼容入口。本 Skill 的运行时已迁入 domains/worktree/，此处只做固定转发，不含实现。
// 直接执行时行为与 domains/worktree/worktree-scan.mjs 逐字节一致；被 import 时只透传导出。
import { forwardLegacyEntry } from '../../core/legacy-entry.mjs';
import { runCli } from '../../domains/worktree/worktree-scan.mjs';

export * from '../../domains/worktree/worktree-scan.mjs';

const status = forwardLegacyEntry(import.meta.url, runCli);
if (status !== undefined) process.exitCode = status;
