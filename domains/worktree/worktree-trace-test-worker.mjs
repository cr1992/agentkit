#!/usr/bin/env node

import { appendTraceEvent } from './worktree-trace.mjs';

const [commonDir, worktreeId, countRaw, workerId] = process.argv.slice(2);
const count = Number.parseInt(countRaw, 10);
if (!commonDir || !worktreeId || !Number.isInteger(count) || count < 1 || !workerId) {
  process.exit(2);
}

for (let index = 0; index < count; index++) {
  appendTraceEvent({
    commonDir,
    worktreeId,
    eventType: 'worker_tick',
    actor: { host: 'node-test-worker', id: workerId },
    details: { worker_id: workerId, index },
    mutate(current) {
      if (!current) throw new Error('missing initial snapshot');
      return { ...current, counter: Number(current.counter ?? 0) + 1 };
    },
  });
}
