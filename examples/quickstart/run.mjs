#!/usr/bin/env node
// agentkit quickstart: drive one full `verify-agent-output` run over two frozen
// commits — one defective, one fixed — and print both Evidence packages.
//
// This script only calls the public `agentkit verify ...` CLI. It never imports
// agentkit internals, so it doubles as a regression test of the CLI contract.
//
// Finding the CLI:
//   - Default: the globally installed `agentkit` command (from `npm i -g @cr1992/agentkit`).
//   - Override: set AGENTKIT_BIN to a JS entry (e.g. this repo's bin/agentkit.mjs);
//     it is then launched with the current `node`. `npm test` uses this to pin the
//     in-tree runtime instead of whatever `agentkit` happens to be on PATH.
//
// External commands used: `git` and `node` (this process re-invokes itself for the
// CLI and for the L0 check). No network access, no agent host required.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(HERE, 'fixture.json'), 'utf8'));

// ── agentkit CLI plumbing ──────────────────────────────────────────────────
const AGENTKIT_BIN = process.env.AGENTKIT_BIN;
function agentkit(args, { allowFailure = false } = {}) {
  const command = AGENTKIT_BIN ? process.execPath : 'agentkit';
  const argv = AGENTKIT_BIN ? [AGENTKIT_BIN, ...args] : args;
  try {
    const stdout = execFileSync(command, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, status: 0, stdout, stderr: '' };
  } catch (error) {
    if (allowFailure) return { ok: false, status: error.status ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    throw error;
  }
}
const agentkitJson = (args) => JSON.parse(agentkit(args).stdout);
// `verify digest` prints the re-sealed envelope to stdout; it never edits in place.
const seal = (kind, path) => writeFileSync(path, agentkit(['verify', 'digest', '--kind', kind, '--input', path]).stdout);
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

// ── git plumbing (explicit identity: the target machine may have none) ───────
const GIT_ID = ['-c', 'user.name=agentkit quickstart', '-c', 'user.email=quickstart@agentkit.example'];
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commitAll(cwd, message) {
  git(cwd, ['add', '-A']);
  execFileSync('git', [...GIT_ID, 'commit', '-m', message], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  return git(cwd, ['rev-parse', 'HEAD']);
}
const checkout = (cwd, sha) => git(cwd, ['-c', 'advice.detachedHead=false', 'checkout', '-q', sha]);

const line = (text = '') => process.stdout.write(`${text}\n`);
const header = (text) => { line(); line(`── ${text} ${'─'.repeat(Math.max(0, 60 - text.length))}`); };

// ── the example repository ───────────────────────────────────────────────────
const repo = mkdtempSync(join(tmpdir(), 'agentkit-quickstart-repo-'));
const work = mkdtempSync(join(tmpdir(), 'agentkit-quickstart-work-'));

function buildRepo() {
  git(repo, ['init', '-b', 'main']);
  writeFileSync(join(repo, 'test.mjs'), fixture.repo_files['test.mjs']);
  writeFileSync(join(repo, 'sum.mjs'), fixture.repo_files.sum_base);
  const base = commitAll(repo, 'chore: test harness + unimplemented sum()');
  writeFileSync(join(repo, 'sum.mjs'), fixture.repo_files.sum_buggy);
  const buggy = commitAll(repo, 'feat: implement sum() (defective: subtracts)');
  writeFileSync(join(repo, 'sum.mjs'), fixture.repo_files.sum_fixed);
  const fixed = commitAll(repo, 'fix: sum() adds instead of subtracts');
  return { base, buggy, fixed };
}

// Freeze contract + profile for one target commit. Scaffolds carry machine-specific
// values (absolute repo path, node path, per-run UUIDs, digests); we overlay only the
// machine-independent fixture text, drop the stale digests, then re-seal.
function freezeInputs(dir, base) {
  const contract = agentkitJson(['verify', 'scaffold', '--kind', 'contract', '--workdir', repo, '--base-sha', base]);
  Object.assign(contract, fixture.contract_patch);
  delete contract.contract_digest;
  const contractPath = join(dir, 'contract.json');
  writeJson(contractPath, contract);
  seal('contract', contractPath);

  const profile = agentkitJson(['verify', 'scaffold', '--kind', 'profile']);
  Object.assign(profile, fixture.profile_patch);
  delete profile.verification_profile_digest;
  const profilePath = join(dir, 'profile.json');
  writeJson(profilePath, profile);
  seal('profile', profilePath);

  return { contractPath, profilePath };
}

// One full verification of a single frozen commit.
function verify(label, target, base) {
  const dir = join(work, label);
  mkdirSync(dir, { recursive: true });
  const { contractPath, profilePath } = freezeInputs(dir, base);

  // The Artifact Ref freezes artifact_sha = workdir HEAD, so check out the target first.
  checkout(repo, target);
  const artifactPath = join(dir, 'artifact.json');
  writeJson(artifactPath, agentkitJson(['verify', 'scaffold', '--kind', 'artifact', '--workdir', repo, '--base-sha', base]));

  const prepared = agentkitJson(['verify', 'prepare-run',
    '--contract', contractPath, '--profile', profilePath, '--artifact', artifactPath,
    '--workdir', repo, '--isolation-assurance', 'user_relayed', '--state-root', join(dir, 'state')]);
  const runDir = prepared.run_dir;
  line(`[${label}] prepare-run  -> status=${prepared.status} run_id=${prepared.run_id}`);

  const smoke = agentkitJson(['verify', 'run-smoke', '--run', runDir]);
  line(`[${label}] run-smoke    -> status=${smoke.status}${smoke.failed_checks.length ? ` failed_checks=${smoke.failed_checks.join(',')}` : ''}`);

  if (smoke.status === 'smoke_passed') {
    // L1 is where an *isolated reviewer agent* would falsify the artifact. This example
    // has no agent host, so it substitutes the preset Review Result from fixture.json.
    const reviewInputPath = join(dir, 'review-input.json');
    writeJson(reviewInputPath, agentkitJson(['verify', 'review-input', '--run', runDir]));
    const review = agentkitJson(['verify', 'scaffold', '--kind', 'review', '--review-input', reviewInputPath]);
    review.verdict = fixture.review_fixed.verdict;
    review.findings = fixture.review_fixed.findings;
    review.forensics = fixture.review_fixed.forensics;
    delete review.review_result_digest;
    const reviewPath = join(dir, 'review.json');
    writeJson(reviewPath, review);
    seal('review', reviewPath);
    const recorded = agentkitJson(['verify', 'record-review', '--run', runDir,
      '--review', reviewPath, '--verifier-run-id', `preset-reviewer-${label}`, '--isolation-assurance', 'user_relayed']);
    line(`[${label}] record-review-> status=${recorded.status} (preset L1 verdict=${review.verdict})`);
    const final = agentkitJson(['verify', 'run-final', '--run', runDir]);
    line(`[${label}] run-final    -> status=${final.status}${final.failed_checks.length ? ` failed_checks=${final.failed_checks.join(',')}` : ''}`);
  } else {
    line(`[${label}] L0 smoke failed, so L1 review and run-final are skipped (Evidence records limitation l1_not_run).`);
  }

  // Read the immutable Evidence and independently re-validate it.
  const evidence = JSON.parse(readFileSync(join(runDir, 'evidence.json'), 'utf8'));
  const validation = agentkitJson(['verify', 'validate', '--run', runDir]);
  line(`[${label}] Evidence path      : ${join(runDir, 'evidence.json')}`);
  line(`[${label}] terminal_outcome = ${evidence.terminal_outcome}`);
  line(`[${label}] limitations        : ${evidence.provenance.limitations.length ? evidence.provenance.limitations.join(', ') : '(none)'}`);
  line(`[${label}] verify validate: valid = ${validation.valid}`);
  return { evidence, validation };
}

// The "frozen Artifact" invariant, demonstrated live: an Artifact Ref is bound to one
// SHA. If the workdir HEAD drifts away from it, prepare-run refuses rather than silently
// verifying whatever happens to be checked out.
function demoFrozenArtifact(base, fixed, buggy) {
  const dir = join(work, 'frozen-demo');
  mkdirSync(dir, { recursive: true });
  const { contractPath, profilePath } = freezeInputs(dir, base);
  checkout(repo, fixed);
  const artifactPath = join(dir, 'artifact.json');
  writeJson(artifactPath, agentkitJson(['verify', 'scaffold', '--kind', 'artifact', '--workdir', repo, '--base-sha', base]));
  // Artifact frozen at `fixed`; now move HEAD to `buggy` before running.
  checkout(repo, buggy);
  const result = agentkit(['verify', 'prepare-run',
    '--contract', contractPath, '--profile', profilePath, '--artifact', artifactPath,
    '--workdir', repo, '--isolation-assurance', 'user_relayed', '--state-root', join(dir, 'state')], { allowFailure: true });
  line(`[frozen] prepare-run exit code = ${result.status} (non-zero: refused)`);
  line(`[frozen] stderr: ${result.stderr.trim()}`);
}

try {
  header('agentkit quickstart: independent verification of a frozen Git artifact');
  line('This runs `agentkit verify` end to end against a throwaway git repo in your temp dir.');
  line('Honesty notes:');
  line('  - --isolation-assurance user_relayed = the CALLER asserts the isolation level; it is');
  line('    NOT proven by the runtime. A real host uses host_reported. This example has no host.');
  line('  - L1 review is preset text from fixture.json. agentkit does NOT review code itself; in');
  line('    real use an isolated reviewer agent produces the Review Result.');
  line('  - Evidence.limitations (e.g. l1_not_run) are capabilities the runtime declines to claim,');
  line('    not bugs. l1_not_run appears when L0 fails first and L1 never runs.');

  const { base, buggy, fixed } = buildRepo();
  header('example repo built (throwaway, in temp dir)');
  line(`base : ${base}`);
  line(`buggy: ${buggy}  (sum returns a - b)`);
  line(`fixed: ${fixed}  (sum returns a + b)`);

  header('1/2 verify the DEFECTIVE commit -> expect fail');
  const buggyRun = verify('buggy', buggy, base);

  header('2/2 verify the FIXED commit -> expect pass');
  const fixedRun = verify('fixed', fixed, base);

  header('invariant: a frozen Artifact refuses a drifted HEAD');
  demoFrozenArtifact(base, fixed, buggy);

  header('summary');
  line(`defective commit: terminal_outcome=${buggyRun.evidence.terminal_outcome}, Evidence validate.valid=${buggyRun.validation.valid}`);
  line(`fixed commit    : terminal_outcome=${fixedRun.evidence.terminal_outcome}, Evidence validate.valid=${fixedRun.validation.valid}`);
  line('Both Evidence packages are digest-bound and pass `agentkit verify validate`.');
  line('"Verification ran to completion" and "the verdict" are separate facts: the defective run');
  line('completed successfully and produced a fail verdict with valid Evidence.');
} finally {
  rmSync(repo, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
