#!/usr/bin/env node
// 1.x 兼容入口。本 Skill 的运行时已迁入 domains/orchestrate/，此处只做固定转发，不含实现。
// 直接执行时行为与 domains/orchestrate/orchestration-ledger.mjs 逐字节一致；被 import 时只透传导出。
import { forwardLegacyEntry } from '../../core/legacy-entry.mjs';
import { runCli } from '../../domains/orchestrate/orchestration-ledger.mjs';

export * from '../../domains/orchestrate/orchestration-ledger.mjs';

const status = forwardLegacyEntry(import.meta.url, runCli);
if (status !== undefined) process.exitCode = status;
