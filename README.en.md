# Awesome Agent Skills

[中文](./README.md) · **English**

A practical collection of reusable skills for agentic software engineering—from task orchestration and Git worktree
isolation to one-shot independent verification and explicit bounded loops.

![On-demand selection and composition of agent-engineering skills](./docs/architecture/skill-collaboration.svg)

The diagram starts from request facts and selects independent capabilities. Only multi-agent or multi-node work enters
the `orchestrate-subagents` control plane, which then chooses lightweight or full operation and evidence-driven
rerouting from effective capabilities, task scale, and local model policy. Providers remain independently usable and
compose through frozen Artifact, Binding, and Evidence envelopes.

[Detailed collaboration contracts and safety boundaries (Chinese, v1 · Pilot)](./docs/architecture/skill-system-architecture.md)

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

Install all skills:

```bash
npx skills add https://github.com/cr1992/awesome-agent-skills.git -g --agent '*'
```

Install a single skill:

```bash
npx skills add https://github.com/cr1992/awesome-agent-skills.git -g --agent '*' --skill manage-worktrees
```

Replace `manage-worktrees` with any other skill name in the table as needed. After an install or update, start a new
agent task. Some hosts cache skill discovery or contents and may require a restart.

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

## Requirements

- Git.
- Node.js 18 or newer for the deterministic runtimes and helper scripts in all four skills.
- Python 3.9 or newer for the `orchestrate-subagents` model-policy and configuration helpers; they use only the standard library.
- A host with task or sub-agent isolation primitives when actual multi-agent execution is required.

## Local validation

```bash
python3 -m unittest discover -s orchestrate-subagents/scripts -p 'test_*.py'
node --test \
  manage-worktrees/scripts/*.test.mjs \
  orchestrate-subagents/scripts/*.test.mjs \
  verify-agent-output/scripts/*.test.mjs \
  run-agent-verify-loop/scripts/*.test.mjs
```

## Repository scope

This repository contains the four distributable Skill directories and repository-level documentation. It does not
include unrelated Skills, credentials, or organization-specific configuration.
