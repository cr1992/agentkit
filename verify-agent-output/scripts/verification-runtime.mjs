#!/usr/bin/env node
// 1.x 兼容入口。本 Skill 的运行时已迁入 domains/verify/，此处只做固定转发，不含实现。
// 直接执行时行为与 domains/verify/verification-runtime.mjs 逐字节一致；被 import 时只透传导出。
import { forwardLegacyEntry } from '../../core/legacy-entry.mjs';
import { runCli } from '../../domains/verify/verification-runtime.mjs';

export * from '../../domains/verify/verification-runtime.mjs';

const status = forwardLegacyEntry(import.meta.url, runCli);
if (status !== undefined) process.exitCode = status;
