# agentkit

[中文](./README.md) · **English**

A zero-dependency Node.js CLI with four thin skills for agentic software engineering—from task orchestration and Git
worktree isolation to one-shot independent verification and explicit bounded loops.

![On-demand selection and composition of agent-engineering skills](./docs/architecture/skill-collaboration.svg)

The diagram starts from request facts and selects independent capabilities. Only multi-agent or multi-node work enters
the `orchestrate-subagents` control plane, which then chooses lightweight or full operation and evidence-driven
rerouting from effective capabilities, task scale, and local model policy. Providers remain independently usable and
compose through frozen Artifact, Binding, and Evidence envelopes.

[Detailed collaboration contracts and safety boundaries (Chinese, v1.4.0)](./docs/architecture/skill-system-architecture.md)

## Included skills

| Skill | Purpose |
| --- | --- |
| [`orchestrate-subagents`](./orchestrate-subagents/) | Decides whether a task should be delegated, builds dependency-aware task contracts, selects suitable agent capabilities, and keeps final acceptance with the controller agent. |
| [`manage-worktrees`](./manage-worktrees/) | Detects write collisions, creates auditable Git worktrees, produces commit-pinned batch integration plans, and safely reclaims worktrees. |
| [`verify-agent-output`](./verify-agent-output/) | Independently verifies one frozen Git Artifact through L0/L1/L0 and emits digest-bound, reviewable Evidence without modifying or retrying the Artifact. |
| [`run-agent-verify-loop`](./run-agent-verify-loop/) | Runs an implementer/verifier loop with isolated context, deterministic checks, evidence tracking, circuit breakers, and human gates. |

This group currently contains four skills. Each works independently and composes through frozen JSON envelopes.
Ordinary tasks need none of them. Use `verify-agent-output` for one-shot verification of a fixed Artifact, and use the
Loop only when bounded repeated implementation and independent re-verification are explicitly requested. Add
orchestration and worktrees only when the task actually needs multiple nodes or Git isolation.

## Installation

### CLI

The CLI requires Node.js 22 or newer:

```bash
npm install -g @cr1992/agentkit
agentkit doctor
```

On macOS, explicitly install the per-repository user service when worktree merge watchers must recover across agent
sessions and restarts:

```bash
agentkit worktree watch-service install
agentkit worktree watch-service status
```

The npm install does not create a persistent service. The service pins the Node and agentkit paths present at install
time; rerun `watch-service install` after moving either installation, and inspect `program_available` in
`status --json`. Other platforms currently use `agentkit worktree resume-all` for manual recovery.

### Skills

Install all four skills:

```bash
npx skills add https://github.com/cr1992/agentkit.git -g --agent '*'
```

Install a single skill:

```bash
npx skills add https://github.com/cr1992/agentkit.git -g --agent '*' --skill manage-worktrees
```

Replace `manage-worktrees` with any other skill name in the table as needed. After an install or update, start a new
agent task. Some hosts cache skill discovery or contents and may require a restart.

## CLI

The skills only define triggers and invariants. Their deterministic runtime is provided by `agentkit`. Existing 1.x
script entry points remain as compatibility forwarders; new integrations should call the CLI directly:

```bash
agentkit capabilities --json
agentkit status --json
agentkit doctor --json
agentkit worktree --help
agentkit contract --help
agentkit orchestrate ledger --help
agentkit verify --help
agentkit docs
```

## Usage

Invoke a skill in natural language and state the intended workflow explicitly:

```text
Use orchestrate-subagents to split this feature across multiple agents.
Use manage-worktrees to prepare batch integration acceptance for these feature branches.
Use verify-agent-output to independently verify this fixed commit once and emit Evidence.
Use run-agent-verify-loop so one agent implements and another independently verifies until it passes or a stop condition fires.
```

Each skill adapts to the agents, terminal, Git, and task-control primitives available in the current host. When a
capability is unavailable, follow the documented fallback path instead of assuming a specific agent product or tool
exists.

## Five-minute run

To see a real Evidence package right after installing, run the quickstart example in this
repository. It builds a minimal git repo in a temporary directory and runs one full
`agentkit verify` over a defective and a fixed pinned commit, printing both Evidence paths and
verdicts:

```bash
# Requires an installed agentkit (see Installation), plus git and Node.js 22+
# Inside a clone of this repository:
node examples/quickstart/run.mjs
# With only the package installed globally (the example ships with it):
node "$(npm root -g)/@cr1992/agentkit/examples/quickstart/run.mjs"
```

The script calls the global `agentkit` by default; point `AGENTKIT_BIN` at a JS entry to use a
specific runtime instead (`npm test` uses this to pin this repo's `bin/agentkit.mjs`). It runs
fully offline, needs no agent host, and finishes in seconds.

The defective commit fails L0 with a `fail` verdict; the fixed commit runs L0→L1→L0 and passes;
both Evidence packages pass `agentkit verify validate`. The example also demonstrates the
"frozen Artifact" invariant: when the workdir HEAD drifts away from the frozen `artifact_sha`,
`prepare-run` refuses with `stale_precondition` instead of silently verifying the wrong thing.

Three honesty notes (also printed by the script): `--isolation-assurance user_relayed` is the
isolation level the caller asserts, not one the runtime proves; in real use the L1 review is
produced by a separate reviewer agent in an isolated context — the example substitutes preset
text and agentkit does not review code itself; the `limitations` in Evidence (such as
`l1_not_run`) are capability boundaries the runtime declares, not bugs. See
[`examples/quickstart/`](./examples/quickstart/) for details.

## Requirements

- macOS or Linux. `agentkit worktree watch-service` is macOS-only; on other platforms, use
  `agentkit worktree resume-all` for manual recovery. Windows is not supported.
- Git.
- Node.js 22 or newer.
- A globally available `agentkit` command; run `agentkit doctor` to validate the package version, entry points, and runtime manifest.
- A host with task or sub-agent isolation primitives when actual multi-agent execution is required.

## Local validation

```bash
npm test
npm run pack:check
```

## Repository scope

This repository is the sole source of truth for the `agentkit` CLI, all four skills, canonical schemas, tests, and
architecture documentation. It is no longer generated or overwritten by another repository. See
[source-of-truth and release maintenance](./docs/maintenance/source-of-truth.md) for the ownership boundary.
