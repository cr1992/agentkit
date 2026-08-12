import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "docs", "architecture");

test("localized diagrams preserve Skill names and protocol terms", async () => {
  const [zh, en] = await Promise.all([
    readFile(path.join(dir, "skill-collaboration.zh.svg"), "utf8"),
    readFile(path.join(dir, "skill-collaboration.en.svg"), "utf8"),
  ]);
  const fixed = [
    "run-agent-verify-loop",
    "orchestrate-subagents",
    "manage-worktrees",
    "verify-agent-output",
    "Controller / User Goal",
    "Evidence Package",
    "Convergence Report",
    "pass · fail · undecidable",
  ];
  for (const term of fixed) assert.ok(zh.includes(term) && en.includes(term), term);
  assert.match(zh, /显式有界/);
  assert.match(en, /Explicit bounded/);
});

test("generated diagrams match the single source", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "generate-skill-collaboration.mjs"), "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
